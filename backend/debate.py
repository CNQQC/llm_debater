"""辩论编排：主持人(MainAgent) 出题 + 随机分配立场 + 并行派发各轮发言。

轮次：
  第一轮 开篇陈述  run_debate    —— 出题、随机分边、各自立论
  第二轮 驳论      run_rebuttal  —— 正反随机两两【锁定配对】，
                                   每个辩手继承(辩题+立场+自己 R1+对手 R1)后逐条反驳

服务端用 DEBATES 保存每场辩论状态（debate_id 寻址），因此第二轮能继承第一轮上下文。

事件流（异步生成器逐个 yield dict）：
  {"type":"debate_id","debate_id":str}
  {"type":"topic","topic":str}
  {"type":"roster","debaters":[pub,...]}
  {"type":"round_start","round":int,"round_name":str}          # 第二轮起
  {"type":"pairings","pairs":[{"pro":pub,"con":pub}],"unpaired":[id]}  # 仅驳论
  {"type":"turn_start","debater_id","round","round_name","opponent_id"?}
  {"type":"chunk","debater_id","text"}
  {"type":"turn_end","debater_id"}
  {"type":"info","message"}
  {"type":"error","message","debater_id"?}
  {"type":"done","round":int}
"""
from __future__ import annotations

import asyncio
import random
import uuid
from dataclasses import dataclass, field

from .config import Config
from .llm_client import LLMClient

SIDE_LABEL = {"pro": "正方", "con": "反方"}


# --------------------------------------------------------------------------- #
# 数据结构
# --------------------------------------------------------------------------- #
@dataclass
class Debater:
    id: str
    name: str
    provider: str
    model: str
    side: str  # "pro" | "con"
    style: str = ""


@dataclass
class Turn:
    debater_id: str
    round: int
    round_name: str
    content: str


@dataclass
class DebateState:
    topic: str
    debaters: list[Debater]
    transcript: list[Turn] = field(default_factory=list)
    pairings: dict[str, str] = field(default_factory=dict)  # debater_id -> 对手 id（双向）


def public_debater(d: Debater) -> dict:
    return {
        "id": d.id,
        "name": d.name,
        "model": d.model,
        "provider": d.provider,
        "side": d.side,
        "side_label": SIDE_LABEL[d.side],
        "style": d.style,
    }


# --------------------------------------------------------------------------- #
# 服务端状态存储（内存版，足够本地使用；重启即清空）
# --------------------------------------------------------------------------- #
DEBATES: dict[str, DebateState] = {}


def _store(debate_id: str, state: DebateState) -> None:
    DEBATES[debate_id] = state
    while len(DEBATES) > 50:  # 简单上限，丢弃最旧的
        DEBATES.pop(next(iter(DEBATES)), None)


def get_state(debate_id: str) -> DebateState | None:
    return DEBATES.get(debate_id)


def _round_content(state: DebateState, debater_id: str, round_no: int) -> str:
    for t in reversed(state.transcript):
        if t.debater_id == debater_id and t.round == round_no:
            return t.content
    return ""


# --------------------------------------------------------------------------- #
# 提示词
# --------------------------------------------------------------------------- #
def _system_prompt(debater: Debater) -> str:
    side_cn = SIDE_LABEL[debater.side]
    style = f"你的辩论风格：{debater.style}。" if debater.style else ""
    return (
        f"你是一位逻辑严密、富有感染力的辩手，代号「{debater.name}」，"
        f"现在代表【{side_cn}】参加一场正式辩论。{style}"
        "你必须始终坚定地为本方立场辩护，言之有据、针锋相对。"
    )


def opening_messages(topic: str, debater: Debater) -> list[dict]:
    side_cn = SIDE_LABEL[debater.side]
    stance = "支持该观点，论证它成立" if debater.side == "pro" else "反对该观点，论证它不成立"
    user = f"""辩题：{topic}

你的立场：{side_cn}（即{stance}）。

现在进行【开篇陈述】环节，请发表你的开篇立论：
1. 开门见山，明确亮出本方立场；
2. 提出 2-3 个核心论点，并对每个论点作简要论证；
3. 语言有逻辑、有力量、有感染力，控制在 250-350 字。

直接开始陈述，不要复述辩题，也不要写“开篇陈述”之类的小标题。"""
    return [
        {"role": "system", "content": _system_prompt(debater)},
        {"role": "user", "content": user},
    ]


def rebuttal_messages(
    topic: str, me: Debater, opp: Debater, my_r1: str, opp_r1: str
) -> list[dict]:
    my_side = SIDE_LABEL[me.side]
    opp_side = SIDE_LABEL[opp.side]
    my_r1 = my_r1.strip() or "（你上一轮未能完成陈述）"
    opp_r1 = opp_r1.strip() or "（对方上一轮未能完成陈述）"
    user = f"""辩题：{topic}
你的立场：{my_side}

【你在上一轮的开篇陈述】
{my_r1}

【你的对手「{opp.name}」（{opp_side}）的开篇陈述】
{opp_r1}

现在进入【驳论】环节，请针对你这位对手的开篇陈述展开反驳：
1. 找出对方论证中的漏洞、矛盾或薄弱环节，逐条有力反驳；
2. 在反驳的同时，进一步巩固并强化你自己（{my_side}）的立场；
3. 直接点名回应对方的具体论点，使交锋感强烈；
4. 控制在 250-350 字，逻辑清晰、针锋相对。

直接开始驳论，不要复述辩题或对方全文，也不要写“驳论”之类的小标题。"""
    return [
        {"role": "system", "content": _system_prompt(me)},
        {"role": "user", "content": user},
    ]


# --------------------------------------------------------------------------- #
# MainAgent：出题 + 随机分边
# --------------------------------------------------------------------------- #
TOPIC_SYSTEM = "你是一位资深的辩论赛主持人，擅长设计兼具思辨性与趣味性的辩题。"
TOPIC_PROMPT = """请生成一个适合多方辩论的辩题。
要求：
1. 是一句立场鲜明的陈述句——正方支持它，反方反对它；
2. 正反双方都有充分论据，具有思辨空间；
3. 避免过于敏感的政治、宗教、种族话题。
只输出辩题本身，不要任何解释、引号或编号。"""


async def generate_topic(llm: LLMClient, config: Config) -> str:
    topic = await llm.complete(
        config.main_agent.provider,
        config.main_agent.model,
        [
            {"role": "system", "content": TOPIC_SYSTEM},
            {"role": "user", "content": TOPIC_PROMPT},
        ],
        temperature=1.0,
    )
    return topic.strip().strip("《》\"'“”")


def assign_sides(debaters: list) -> list[tuple]:
    """随机打乱并尽量均衡地分配正/反方；奇数人时多出来的一席随机归属。"""
    pool = list(debaters)
    random.shuffle(pool)
    n = len(pool)
    n_pro = n // 2 + (random.randint(0, 1) if n % 2 else 0)
    sides = ["pro"] * n_pro + ["con"] * (n - n_pro)
    random.shuffle(sides)
    return list(zip(pool, sides))


# --------------------------------------------------------------------------- #
# 通用：单个辩手的流式发言 + 多路汇聚
# --------------------------------------------------------------------------- #
async def _stream_turn(
    llm: LLMClient,
    queue: asyncio.Queue,
    state: DebateState,
    dbt: Debater,
    round_no: int,
    round_name: str,
    messages: list[dict],
    extra_start: dict | None = None,
):
    start = {
        "type": "turn_start",
        "debater_id": dbt.id,
        "round": round_no,
        "round_name": round_name,
    }
    if extra_start:
        start.update(extra_start)
    await queue.put(start)

    collected: list[str] = []
    try:
        async for piece in llm.stream(dbt.provider, dbt.model, messages):
            collected.append(piece)
            await queue.put({"type": "chunk", "debater_id": dbt.id, "text": piece})
    except Exception as exc:  # noqa: BLE001
        await queue.put({"type": "error", "debater_id": dbt.id, "message": str(exc)})
    finally:
        state.transcript.append(Turn(dbt.id, round_no, round_name, "".join(collected)))
        await queue.put({"type": "turn_end", "debater_id": dbt.id})


async def _drain(queue: asyncio.Queue, tasks: list):
    """等所有发言任务跑完，把队列里的事件逐个产出，结束后收尾。"""
    async def closer():
        await asyncio.gather(*tasks, return_exceptions=True)
        await queue.put(None)

    asyncio.create_task(closer())
    while True:
        item = await queue.get()
        if item is None:
            break
        yield item


# --------------------------------------------------------------------------- #
# 第一轮：开篇陈述
# --------------------------------------------------------------------------- #
async def run_debate(
    llm: LLMClient,
    config: Config,
    *,
    topic: str | None = None,
    num_debaters: int | None = None,
):
    available = config.available_debaters()
    if not available:
        yield {
            "type": "error",
            "message": "没有可用的辩手：请在 .env 中至少配置一个提供商的 API Key。",
        }
        return

    pool = available
    if num_debaters and 0 < num_debaters < len(pool):
        pool = random.sample(pool, num_debaters)

    # 出题（用户未提供则由主持人生成）
    if not topic or not topic.strip():
        try:
            topic = await generate_topic(llm, config)
        except Exception as exc:  # noqa: BLE001
            yield {"type": "error", "message": f"生成辩题失败：{exc}"}
            return
    topic = topic.strip()

    # 随机分边
    assigned = assign_sides(pool)
    debaters = [
        Debater(
            id=d.id, name=d.name, provider=d.provider, model=d.model,
            style=d.style, side=side,
        )
        for d, side in assigned
    ]
    debate_id = uuid.uuid4().hex[:8]
    state = DebateState(topic=topic, debaters=debaters)
    _store(debate_id, state)

    yield {"type": "debate_id", "debate_id": debate_id}
    yield {"type": "topic", "topic": topic}
    yield {"type": "roster", "debaters": [public_debater(d) for d in debaters]}

    queue: asyncio.Queue = asyncio.Queue()
    tasks = [
        asyncio.create_task(
            _stream_turn(llm, queue, state, d, 1, "开篇陈述", opening_messages(topic, d))
        )
        for d in debaters
    ]
    async for ev in _drain(queue, tasks):
        yield ev

    yield {"type": "done", "round": 1}


# --------------------------------------------------------------------------- #
# 第二轮：驳论（正反随机两两锁定配对）
# --------------------------------------------------------------------------- #
def _build_pairings(state: DebateState) -> tuple[list[tuple[Debater, Debater]], list[Debater]]:
    """把正方与反方随机两两绑定（双向锁死）。返回 (pairs[(pro,con)], 轮空者)。

    配对结果写入 state.pairings 并持久化——一旦绑定，后续轮次复用同一配对。
    """
    by_id = {d.id: d for d in state.debaters}

    if not state.pairings:
        pros = [d for d in state.debaters if d.side == "pro"]
        cons = [d for d in state.debaters if d.side == "con"]
        random.shuffle(pros)
        random.shuffle(cons)
        for pro, con in zip(pros, cons):
            state.pairings[pro.id] = con.id
            state.pairings[con.id] = pro.id

    pairs: list[tuple[Debater, Debater]] = []
    seen: set[str] = set()
    for a_id, b_id in state.pairings.items():
        if a_id in seen or b_id in seen:
            continue
        seen.add(a_id)
        seen.add(b_id)
        a, b = by_id[a_id], by_id[b_id]
        if a.side != "pro":  # 统一让正方在前
            a, b = b, a
        pairs.append((a, b))

    unpaired = [d for d in state.debaters if d.id not in state.pairings]
    return pairs, unpaired


async def run_rebuttal(llm: LLMClient, config: Config, debate_id: str):
    state = get_state(debate_id)
    if state is None:
        yield {
            "type": "error",
            "message": "找不到该场辩论（服务可能已重启）。请重新开始第一轮。",
        }
        return

    pairs, unpaired = _build_pairings(state)

    yield {"type": "round_start", "round": 2, "round_name": "驳论"}
    yield {
        "type": "pairings",
        "pairs": [{"pro": public_debater(a), "con": public_debater(b)} for a, b in pairs],
        "unpaired": [d.id for d in unpaired],
    }
    if unpaired:
        names = "、".join(d.name for d in unpaired)
        yield {"type": "info", "message": f"{len(unpaired)} 位辩手（{names}）没有对手，本轮轮空。"}

    if not pairs:
        yield {"type": "info", "message": "正反双方至少各需 1 位辩手才能展开驳论。"}
        yield {"type": "done", "round": 2}
        return

    queue: asyncio.Queue = asyncio.Queue()
    tasks = []
    for pro, con in pairs:
        for me, opp in ((pro, con), (con, pro)):
            msgs = rebuttal_messages(
                state.topic, me, opp,
                _round_content(state, me.id, 1),
                _round_content(state, opp.id, 1),
            )
            tasks.append(
                asyncio.create_task(
                    _stream_turn(
                        llm, queue, state, me, 2, "驳论", msgs,
                        extra_start={"opponent_id": opp.id},
                    )
                )
            )

    async for ev in _drain(queue, tasks):
        yield ev

    yield {"type": "done", "round": 2}
