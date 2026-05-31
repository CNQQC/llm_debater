"""端到端验证：真实调用 DeepSeek 跑第一轮+第二轮，断言配对锁定与上下文继承。"""
import asyncio
from dotenv import load_dotenv

load_dotenv()

from backend.config import Config
from backend import debate as D
from backend.llm_client import LLMClient

TOPIC = "远程办公比传统办公室办公更高效"


async def collect(gen):
    events = []
    async for ev in gen:
        events.append(ev)
    return events


async def main():
    cfg = Config("config.yaml")
    llm = LLMClient(cfg)
    print("available debaters:", [d.name for d in cfg.available_debaters()])

    # —— 第一轮 ——（固定辩题、4 人 => 2v2）
    ev1 = await collect(D.run_debate(llm, cfg, topic=TOPIC, num_debaters=4))
    types1 = [e["type"] for e in ev1]
    debate_id = next(e["debate_id"] for e in ev1 if e["type"] == "debate_id")
    roster = next(e["debaters"] for e in ev1 if e["type"] == "roster")
    print("\n=== 第一轮 ===")
    print("debate_id:", debate_id)
    for d in roster:
        print(f"  {d['side_label']}  {d['name']}")
    pros = [d for d in roster if d["side"] == "pro"]
    cons = [d for d in roster if d["side"] == "con"]
    assert len(pros) >= 1 and len(cons) >= 1, "应同时有正反方"
    assert types1[-1] == "done" and ev1[-1]["round"] == 1

    state = D.get_state(debate_id)
    for d in state.debaters:
        c = D._round_content(state, d.id, 1)
        assert c.strip(), f"{d.name} 第一轮内容为空"
    print("R1 内容均非空 ✓")
    # 抽样打印一段第一轮陈述
    sample = state.debaters[0]
    print(f"\n[{sample.name} · {D.SIDE_LABEL[sample.side]} 开篇节选]")
    print("  " + D._round_content(state, sample.id, 1)[:120].replace("\n", " ") + " …")

    # —— 第二轮 ——
    ev2 = await collect(D.run_rebuttal(llm, cfg, debate_id))
    print("\n=== 第二轮 ===")
    pairings_ev = next(e for e in ev2 if e["type"] == "pairings")
    pairs = pairings_ev["pairs"]
    print(f"锁定配对 {len(pairs)} 对：")
    for p in pairs:
        print(f"  {p['pro']['name']}（正） ⚔ {p['con']['name']}（反）")

    # 断言1：配对双向唯一锁定
    pm = state.pairings
    seen = set()
    for a, b in pm.items():
        assert pm[b] == a, f"配对非双向: {a}->{b} 但 {b}->{pm.get(b)}"
        assert a not in seen, f"{a} 出现在多个配对中（未锁定唯一）"
        seen.add(a)
    # 每对必为一正一反
    by_id = {d.id: d for d in state.debaters}
    for a, b in pm.items():
        assert by_id[a].side != by_id[b].side, "配对双方应一正一反"
    print("配对双向唯一锁定 ✓；每对一正一反 ✓")

    # 断言2：turn_start 的 opponent_id 与锁定配对一致
    starts = [e for e in ev2 if e["type"] == "turn_start"]
    for s in starts:
        assert pm[s["debater_id"]] == s["opponent_id"], "驳论对手与锁定配对不符"
    print("驳论对手 = 锁定对手 ✓")

    # 断言3：第二轮内容非空
    for d in state.debaters:
        if d.id in pm:
            assert D._round_content(state, d.id, 2).strip(), f"{d.name} 驳论为空"
    print("R2 内容均非空 ✓")

    # 断言4：上下文继承——驳论的 prompt 必须包含 辩题 + 自己R1 + 对手R1
    me = by_id[pairs[0]["pro"]["id"]]
    opp = by_id[pm[me.id]]
    my_r1 = D._round_content(state, me.id, 1)
    opp_r1 = D._round_content(state, opp.id, 1)
    msgs = D.rebuttal_messages(state.topic, me, opp, my_r1, opp_r1)
    user = msgs[1]["content"]
    assert TOPIC in user, "辩题未继承进第二轮上下文"
    assert D.SIDE_LABEL[me.side] in user, "立场未继承"
    assert my_r1[:40] in user, "自己第一轮陈述未继承"
    assert opp_r1[:40] in user, "对手第一轮陈述未继承"
    assert opp.name in user, "对手身份未带入"
    print("上下文继承（辩题+立场+己方R1+对手R1+对手身份）✓")

    # 抽样打印一段驳论
    print(f"\n[{me.name} 驳 {opp.name} · 节选]")
    print("  " + D._round_content(state, me.id, 2)[:140].replace("\n", " ") + " …")

    print("\n全部断言通过 ✅")


asyncio.run(main())
