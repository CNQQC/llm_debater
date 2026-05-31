"""辩论编排：主持人(MainAgent) 出题 + 随机分配立场 + 并行派发首轮陈述。

事件流（异步生成器逐个 yield dict）：
    {"type": "topic",      "topic": str}
    {"type": "roster",     "debaters": [public_debater, ...]}
    {"type": "turn_start", "debater_id", "round", "round_name"}
    {"type": "chunk",      "debater_id", "text"}
    {"type": "turn_end",   "debater_id"}
    {"type": "error",      "message", "debater_id"?}
    {"type": "done"}

设计成可扩展：后续“驳论 / 自由辩论 / 总结陈词 / 评委打分”都可以
复用 DebateState.transcript，再追加新的轮次函数即可。
"""
from __future__ import annotations

import asyncio
import random
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


def public_debater(d: Debater) -> dict:
    return {
        "id": d.id,
        "name": d.name,
        "model": d.model,
        "provider": d.provider,
        "side": d.side,
        "side_label": SIDE_LABEL[d.side],
    }


# --------------------------------------------------------------------------- #
# MainAgent（主持人）：出题 + 分配立场
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
# 第一轮：开篇陈述
# --------------------------------------------------------------------------- #
def opening_messages(topic: str, side: str) -> list[dict]:
    side_cn = SIDE_LABEL[side]
    stance = "支持该观点，论证它成立" if side == "pro" else "反对该观点，论证它不成立"
    system = (
        f"你是一位逻辑严密、富有感染力的辩手，现在代表【{side_cn}】参加一场正式辩论。"
        "你需要坚定地为本方立场辩护。"
    )
    user = f"""辩题：{topic}

你的立场：{side_cn}（即{stance}）。

现在进行【开篇陈述】环节，请发表你的开篇立论：
1. 开门见山，明确亮出本方立场；
2. 提出 2-3 个核心论点，并对每个论点作简要论证；
3. 语言有逻辑、有力量、有感染力，控制在 250-350 字。

直接开始陈述，不要复述辩题，也不要写“开篇陈述”之类的小标题。"""
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# --------------------------------------------------------------------------- #
# 编排主流程
# --------------------------------------------------------------------------- #
async def run_debate(
    llm: LLMClient,
    config: Config,
    *,
    topic: str | None = None,
    num_debaters: int | None = None,
):
    """异步生成器：跑完“出题 → 分配 → 首轮陈述”，逐事件 yield。"""
    available = config.available_debaters()
    if not available:
        yield {
            "type": "error",
            "message": "没有可用的辩手：请在 .env 中至少配置一个提供商的 API Key。",
        }
        return

    # 选取上场辩手（指定人数时随机抽取子集）
    pool = available
    if num_debaters and 0 < num_debaters < len(pool):
        pool = random.sample(pool, num_debaters)

    # 1) 出题（用户未提供则由主持人生成）
    if not topic or not topic.strip():
        try:
            topic = await generate_topic(llm, config)
        except Exception as exc:  # noqa: BLE001
            yield {"type": "error", "message": f"生成辩题失败：{exc}"}
            return
    topic = topic.strip()
    yield {"type": "topic", "topic": topic}

    # 2) 随机分配立场
    assigned = assign_sides(pool)
    debaters = [
        Debater(id=d.id, name=d.name, provider=d.provider, model=d.model, side=side)
        for d, side in assigned
    ]
    state = DebateState(topic=topic, debaters=debaters)
    yield {"type": "roster", "debaters": [public_debater(d) for d in debaters]}

    # 3) 并行进行开篇陈述，通过队列把各路流汇聚到单一事件流
    queue: asyncio.Queue = asyncio.Queue()

    async def run_one(dbt: Debater):
        await queue.put(
            {
                "type": "turn_start",
                "debater_id": dbt.id,
                "round": 1,
                "round_name": "开篇陈述",
            }
        )
        collected: list[str] = []
        try:
            async for piece in llm.stream(
                dbt.provider, dbt.model, opening_messages(topic, dbt.side)
            ):
                collected.append(piece)
                await queue.put({"type": "chunk", "debater_id": dbt.id, "text": piece})
        except Exception as exc:  # noqa: BLE001
            await queue.put(
                {"type": "error", "debater_id": dbt.id, "message": str(exc)}
            )
        finally:
            state.transcript.append(
                Turn(dbt.id, 1, "开篇陈述", "".join(collected))
            )
            await queue.put({"type": "turn_end", "debater_id": dbt.id})

    tasks = [asyncio.create_task(run_one(d)) for d in debaters]

    async def closer():
        await asyncio.gather(*tasks, return_exceptions=True)
        await queue.put(None)  # 结束哨兵

    asyncio.create_task(closer())

    while True:
        item = await queue.get()
        if item is None:
            break
        yield item

    yield {"type": "done"}
