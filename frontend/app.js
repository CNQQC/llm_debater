"use strict";

/* ═══════════════════════════════════════════════════════════════════════════
   思辨场 · THE DISCOURSE — frontend controller
   Drives the backend NDJSON streams for two rounds:
     Round I  开篇陈述   POST /api/debate                         (two camps)
     Round II 驳论       POST /api/debate/{debate_id}/round2      (locked 1v1 bouts)
   Events: debate_id · topic · roster · round_start · pairings · info ·
           turn_start{round,opponent_id?} · chunk · turn_end · error · done{round}
   A fully local 观摩演示 / Demo replays BOTH rounds through the same pipeline,
   so the whole gazette works before any API key is configured.
   ═══════════════════════════════════════════════════════════════════════════ */

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  topic: "",
  debateId: null,
  phase: 1,            // round currently streaming (1 | 2)
  roundName: "开篇陈述",
  meta: {},            // id -> { name, model, provider, side, side_label, style, seat }
  d1: {},              // round-1 card refs: id -> { card, statement, stateEl, wc, text }
  d2: {},              // round-2 card refs
  order: [],           // round-1 roster order
  pairs: [],           // [{ proId, conId }]
  seat: { pro: 0, con: 0 },
  running: false,
  isDemo: false,
  roundShown: false,
};

// ───────────────────────────────────────────────────────────── boot ────────
function boot() {
  renderDateline();
  renderEdition();
  loadConfig();

  el("start").addEventListener("click", () => run(false));
  el("demo").addEventListener("click", () => run(true));
  el("to-round2").addEventListener("click", advance);
  el("stop-here").addEventListener("click", stopHere);
  el("again").addEventListener("click", rematch);
  el("copy").addEventListener("click", copyTranscript);
}

function renderDateline() {
  const d = new Date();
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  el("dateline").textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 星期${days[d.getDay()]}`;
}
function renderEdition() {
  const n = parseInt(localStorage.getItem("discourse_edition") || "0", 10) || 0;
  el("edition").textContent = `第 ${toRoman(n + 1)} 场`;
}
function bumpEdition() {
  let n = parseInt(localStorage.getItem("discourse_edition") || "0", 10) || 0;
  n += 1;
  localStorage.setItem("discourse_edition", String(n));
  el("edition").textContent = `第 ${toRoman(n)} 场`;
}

// ───────────────────────────────────────────────────── config / roster ─────
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    renderBench(cfg);
    renderNum(cfg);
    renderHost(cfg);
  } catch (e) {
    setStatus("无法连接后端配置：" + e.message + "（仍可点「观摩演示」）", "error");
  }
}
function renderHost(cfg) {
  const m = cfg.main_agent;
  const line = `主持人 · ${m.model} ${m.available ? "✓" : "· 待配置"}`;
  el("host-line").textContent = line;
  el("colophon-host").textContent = line;
}
function renderBench(cfg) {
  const grid = el("roster-preview");
  grid.innerHTML = "";
  cfg.debaters.forEach((d, i) => {
    const seat = document.createElement("div");
    seat.className = "seat " + (d.available ? "seat--on" : "seat--off");
    seat.style.animationDelay = i * 0.045 + "s";
    seat.innerHTML =
      `<span class="seat__provider"></span>` +
      `<span class="seat__name"></span>` +
      `<span class="seat__model"></span>` +
      (d.style ? `<span class="seat__style"></span>` : "") +
      `<span class="seat__status"><span class="dot"></span><span class="seat__txt"></span></span>`;
    seat.querySelector(".seat__provider").textContent = d.provider;
    seat.querySelector(".seat__name").textContent = d.name;
    seat.querySelector(".seat__model").textContent = d.model;
    if (d.style) seat.querySelector(".seat__style").textContent = d.style;
    seat.querySelector(".seat__txt").textContent = d.available ? "就座" : "待入席 · 未配置 Key";
    grid.appendChild(seat);
  });
  el("bench-count").textContent = `就座 ${cfg.available_count} · 共 ${cfg.debaters.length} 席`;
}
function renderNum(cfg) {
  const num = el("num");
  num.innerHTML = "";
  const max = cfg.available_count;
  if (max < 1) {
    const opt = document.createElement("option");
    opt.textContent = "暂无在席辩手";
    num.appendChild(opt);
    num.disabled = true;
    el("start").disabled = true;
    setStatus("尚未配置任何 API Key —— 点「观摩演示」即可一览全程，或在 .env 填入 Key 后刷新。", "");
    return;
  }
  num.disabled = false;
  el("start").disabled = false;
  for (let i = Math.min(2, max); i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = i + " 位";
    num.appendChild(opt);
  }
  num.value = max;
  setStatus(`${max} 位辩手已就座，随时可开庭。`, "");
}

// ───────────────────────────────────────────────────────── run (round 1) ───
async function run(isDemo) {
  if (state.running) return;
  state.isDemo = isDemo;
  beginRun();
  if (isDemo) return runDemoRound1();

  setStatus("主持人正在拟题、分配立场……");
  try {
    await streamInto("/api/debate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: el("topic").value.trim(),
        num_debaters: parseInt(el("num").value, 10) || null,
      }),
    });
  } catch (e) {
    setStatus("出错：" + e.message, "error");
    el("onair").hidden = true;
  } finally {
    if (!state.isDemo) state.running = false;
    refreshButtons();
  }
}

// ───────────────────────────────────────────────────────── round 2 ─────────
function advance() {
  if (state.running) return;
  if (state.isDemo) return runDemoRound2();
  startRound2();
}
async function startRound2() {
  if (!state.debateId) return;
  state.running = true;
  el("intermission").classList.add("hidden");
  el("onair").hidden = false;
  setStatus("锁定配对，驳论开始……");
  try {
    await streamInto(`/api/debate/${state.debateId}/round2`, { method: "POST" });
  } catch (e) {
    setStatus("出错：" + e.message, "error");
    el("onair").hidden = true;
  } finally {
    state.running = false;
    refreshButtons();
  }
}

// shared NDJSON reader → handleEvent
async function streamInto(url, init) {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) throw new Error("请求失败：" + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) handleEvent(JSON.parse(line));
    }
  }
}

// ───────────────────────────────────────────────────────── event router ────
function activeCard(id) {
  return (state.phase === 2 ? state.d2 : state.d1)[id];
}

function handleEvent(ev) {
  switch (ev.type) {
    case "debate_id":
      state.debateId = ev.debate_id;
      break;

    case "topic":
      state.topic = ev.topic;
      renderMotion(ev.topic);
      el("onair").hidden = false;
      setStatus("立场已定，各方开始陈词。");
      break;

    case "roster":
      ev.debaters.forEach(createRound1Card);
      updateBout();
      el("boutbar").hidden = false;
      break;

    case "round_start":
      state.phase = ev.round;
      state.roundName = ev.round_name || "驳论";
      el("bout-round").textContent = state.roundName;
      el("bout-phase").textContent = "REBUTTAL";
      el("round2").classList.remove("hidden");
      el("onair").hidden = false;
      setStatus("第二轮 · " + state.roundName + " —— 锁定对决进行中。");
      break;

    case "pairings":
      buildBouts(ev.pairs || []);
      break;

    case "info":
      showR2Note(ev.message);
      break;

    case "turn_start": {
      if (ev.round) state.phase = ev.round;
      const d = activeCard(ev.debater_id);
      if (!d) break;
      d.card.classList.add("is-thinking");
      d.stateEl.textContent = state.phase === 2 ? "酝酿反击" : "拟稿中";
      d.statement.classList.add("placeholder");
      d.statement.textContent = state.phase === 2 ? "正在拆解对方论证……" : "正在斟酌措辞……";
      break;
    }

    case "chunk": {
      const d = activeCard(ev.debater_id);
      if (!d) break;
      if (d.statement.classList.contains("placeholder")) {
        d.statement.classList.remove("placeholder");
        d.statement.textContent = "";
        d.card.classList.remove("is-thinking");
        d.card.classList.add("is-speaking");
        d.stateEl.textContent = state.phase === 2 ? "驳论中" : "陈词中";
      }
      d.text += ev.text;
      d.statement.textContent = d.text;
      break;
    }

    case "turn_end": {
      const d = activeCard(ev.debater_id);
      if (!d || d.card.classList.contains("is-failed")) break;
      d.card.classList.remove("is-thinking", "is-speaking");
      d.card.classList.add("is-done");
      d.stateEl.textContent = state.phase === 2 ? "已驳论" : "已陈词";
      d.wc.innerHTML = `<span class="card__tick">✓</span> 共 ${countChars(d.text)} 字`;
      break;
    }

    case "error": {
      const d = ev.debater_id && activeCard(ev.debater_id);
      if (d) {
        d.card.classList.remove("is-thinking", "is-speaking");
        d.card.classList.add("is-failed");
        d.stateEl.textContent = "失语";
        d.statement.classList.remove("placeholder");
        d.statement.textContent = "⚠ " + ev.message;
      } else {
        setStatus("⚠ " + ev.message, "error");
        el("onair").hidden = true;
      }
      break;
    }

    case "done":
      el("onair").hidden = true;
      if (ev.round === 1) {
        setStatus("第一轮「开篇陈述」已毕。", "");
        el("intermission").classList.remove("hidden");
        refreshButtons();
      } else {
        setStatus("两轮辩论已毕。", "");
        showCurtain();
      }
      break;
  }
}

// ──────────────────────────────────────────────────────────── rendering ────
function renderMotion(topic) {
  const b = el("topic-banner");
  b.innerHTML =
    `<span class="motion__kicker">本场命题 · THE MOTION</span>` +
    `<p class="motion__text"></p>` +
    `<span class="motion__stance">` +
    `<span class="s-pro">正方</span> 申论<b>支持</b> &nbsp;·&nbsp; ` +
    `<span class="s-con">反方</span> 申论<b>反对</b></span>`;
  b.querySelector(".motion__text").textContent = topic;
}

// build a card element; opponentName present => round-2 (adds reply line)
function buildCard(id, opponentName) {
  const m = state.meta[id];
  const card = document.createElement("article");
  card.className = "card card--" + m.side;
  const reply = opponentName ? `<div class="card__reply">⚔ 回应 <b></b></div>` : "";
  const ph = opponentName ? "待对方落定，即起反驳……" : "静候入席……";
  card.innerHTML =
    `<span class="card__accent" aria-hidden="true"></span>` +
    `<div class="card__head">` +
      `<span class="card__seat"></span>` +
      `<div class="card__id"><span class="card__name"></span><span class="card__model"></span></div>` +
      `<span class="card__status"><span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` +
        `<span class="card__state">候场</span></span>` +
    `</div>` + reply +
    `<div class="card__body"><p class="statement placeholder">${ph}</p></div>` +
    `<div class="card__foot"><span class="card__wc"></span></div>`;
  card.querySelector(".card__seat").textContent = String(m.seat).padStart(2, "0");
  card.querySelector(".card__name").textContent = m.name;
  card.querySelector(".card__model").textContent = m.model + " · " + m.provider;
  if (opponentName) card.querySelector(".card__reply b").textContent = opponentName;
  return {
    card,
    statement: card.querySelector(".statement"),
    stateEl: card.querySelector(".card__state"),
    wc: card.querySelector(".card__wc"),
    text: "",
  };
}

function createRound1Card(d) {
  const seatNo = (state.seat[d.side] += 1);
  state.meta[d.id] = {
    name: d.name, model: d.model, provider: d.provider,
    side: d.side, side_label: d.side_label || (d.side === "pro" ? "正方" : "反方"),
    style: d.style || "", seat: seatNo,
  };
  state.order.push(d.id);
  const refs = buildCard(d.id);
  el(d.side === "pro" ? "col-pro" : "col-con").appendChild(refs.card);
  state.d1[d.id] = refs;
}

function buildBouts(pairs) {
  const wrap = el("bouts");
  wrap.innerHTML = "";
  state.pairs = [];
  pairs.forEach((p, i) => {
    const proId = p.pro.id, conId = p.con.id;
    // ensure meta exists (real flow already has it from roster; demo too)
    state.pairs.push({ proId, conId });

    const bout = document.createElement("div");
    bout.className = "bout";
    bout.style.animationDelay = i * 0.06 + "s";
    bout.innerHTML = `<span class="bout__seam" aria-hidden="true"></span>`;

    const proRefs = buildCard(proId, state.meta[conId].name);
    const vs = document.createElement("div");
    vs.className = "bout__vs";
    vs.innerHTML = `<span class="bout__swords" aria-hidden="true">⚔</span>` +
                   `<span class="bout__label">第 ${i + 1} 对决</span>`;
    const conRefs = buildCard(conId, state.meta[proId].name);

    bout.appendChild(proRefs.card);
    bout.appendChild(vs);
    bout.appendChild(conRefs.card);
    wrap.appendChild(bout);

    state.d2[proId] = proRefs;
    state.d2[conId] = conRefs;
  });
}

function showR2Note(msg) {
  const n = el("r2-note");
  n.textContent = "※ " + msg;
  n.classList.remove("hidden");
}

function updateBout() {
  let pro = 0, con = 0;
  for (const id of state.order) (state.meta[id].side === "pro" ? pro++ : con++);
  el("bout-pro").textContent = pro;
  el("bout-con").textContent = con;
}

function showCurtain() { el("curtain").classList.remove("hidden"); }

// ───────────────────────────────────────────────────────── run lifecycle ───
function beginRun() {
  state.running = true;
  bumpEdition();
  resetArena();
  el("setup").classList.add("hidden");
  el("arena").classList.remove("hidden");
  refreshButtons();
  el("arena").scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "start" });
}
function refreshButtons() {
  el("start").disabled = state.running || el("num").disabled;
  el("demo").disabled = state.running;
  el("to-round2").disabled = state.running;
}
function resetArena() {
  el("col-pro").innerHTML = "";
  el("col-con").innerHTML = "";
  el("bouts").innerHTML = "";
  el("topic-banner").innerHTML =
    `<span class="motion__kicker">本场命题 · THE MOTION</span>` +
    `<p class="motion__text" style="color:var(--ink-faint);font-style:italic;">主持人 AI 正在落笔拟题……</p>`;
  el("boutbar").hidden = true;
  el("bout-round").textContent = "开篇陈述";
  el("bout-phase").textContent = "OPENING STATEMENTS";
  el("intermission").classList.add("hidden");
  el("round2").classList.add("hidden");
  el("r2-note").classList.add("hidden");
  el("curtain").classList.add("hidden");
  Object.assign(state, {
    topic: "", debateId: null, phase: 1, roundName: "开篇陈述",
    meta: {}, d1: {}, d2: {}, order: [], pairs: [],
    seat: { pro: 0, con: 0 }, roundShown: false,
  });
}
function stopHere() {
  el("intermission").classList.add("hidden");
  el("onair").hidden = true;
  setStatus("已休庭于第一轮。", "");
  showCurtain();
}
function rematch() {
  resetArena();
  el("arena").classList.add("hidden");
  el("setup").classList.remove("hidden");
  state.running = false;
  state.isDemo = false;
  refreshButtons();
  window.scrollTo({ top: 0, behavior: REDUCE ? "auto" : "smooth" });
}

// ──────────────────────────────────────────────────────── transcript ───────
function copyTranscript() {
  let out = `思辨场 · THE DISCOURSE\n辩题：${state.topic}\n${"—".repeat(26)}\n\n【第一轮 · 开篇陈述】\n\n`;
  for (const id of state.order) {
    const m = state.meta[id], r = state.d1[id];
    out += `〔${m.side_label}〕${m.name}（${m.model}）\n${((r && r.text) || "（无内容）").trim()}\n\n`;
  }
  if (state.pairs.length) {
    out += `\n【第二轮 · 驳论 · 锁定对决】\n\n`;
    state.pairs.forEach((p, i) => {
      const pm = state.meta[p.proId], cm = state.meta[p.conId];
      const pr = state.d2[p.proId], cr = state.d2[p.conId];
      out += `── 第 ${i + 1} 对决：${pm.name}（正） ⚔ ${cm.name}（反） ──\n`;
      out += `〔正·${pm.name}〕\n${((pr && pr.text) || "（无内容）").trim()}\n\n`;
      out += `〔反·${cm.name}〕\n${((cr && cr.text) || "（无内容）").trim()}\n\n`;
    });
  }
  out = out.trim();
  const done = () => setStatus("全场实录已誊抄至剪贴板。", "toast");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(out).then(done).catch(() => fallbackCopy(out, done));
  } else fallbackCopy(out, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); }
  catch { setStatus("复制失败，请手动选择文本。", "error"); }
  document.body.removeChild(ta);
}

// ───────────────────────────────────────────────────────────── helpers ─────
function setStatus(msg, kind) {
  const s = el("status");
  s.textContent = msg;
  s.className = "status" + (kind ? " " + kind : "");
}
function countChars(s) { return (s || "").replace(/\s/g, "").length; }
function toRoman(n) {
  if (!n || n < 1) return "I";
  if (n > 3999) return String(n);
  const map = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],
    [50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let out = "";
  for (const [v, sym] of map) while (n >= v) { out += sym; n -= v; }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   观摩演示 / DEMO — scripted two-round bout, streamed locally via handleEvent().
   No network, no API key.
   ═══════════════════════════════════════════════════════════════════════════ */
const DEMO_TOPIC = "人工智能的发展利大于弊";
const DEMO_CAST = [
  { id: "demo-deepseek", name: "DeepSeek-V3", model: "deepseek-chat", provider: "deepseek", side: "pro" },
  { id: "demo-claude", name: "Claude 3.5 Sonnet", model: "anthropic/claude-3.5-sonnet", provider: "openrouter", side: "pro" },
  { id: "demo-gpt", name: "GPT-4o", model: "openai/gpt-4o", provider: "openrouter", side: "con" },
  { id: "demo-qwen", name: "通义千问 2.5", model: "Qwen/Qwen2.5-72B-Instruct", provider: "siliconflow", side: "con" },
];
const DEMO_R1 = {
  "demo-deepseek":
    "我方坚信，人工智能的发展利远大于弊。其一，它把人类从重复劳动中解放出来——工厂的质检、医院的影像初筛、" +
    "写字楼里的报表，AI 接手之后，人方能投身真正需要创造力的事业。其二，在科研前沿，AlphaFold 让悬置数十年的" +
    "蛋白质折叠一夜成图，新药研发就此提速。工具本无善恶，关键在善用，而善用的前景，足够光明。",
  "demo-claude":
    "对方或将渲染风险，但请注意：每一次技术跃迁都伴随阵痛，蒸汽机如此，互联网亦然，历史最终站在进步一边。" +
    "今天，山村的孩子能借大模型获得名师级辅导，盲人能用它“看见”街道，渐冻症患者能重新“开口”。当技术把尊严与" +
    "机会还给最脆弱的人，我们有什么理由因噎废食？利大于弊，不只是事实，更是责任。",
  "demo-gpt":
    "我方不否认 AI 的便利，却必须指出：它带来的弊，正在结构性地侵蚀社会。首当其冲的是就业——当模型足以替代客服、" +
    "文案、初级程序员，数以亿计的岗位悬于一线，而再培训的速度远赶不上替代的速度。技术红利集中于少数巨头，代价却" +
    "由普通人承担。一个加剧不平等的进步，称得上“利大”吗？",
  "demo-qwen":
    "更深的隐忧在于失控。AI 吞噬海量个人数据，深度伪造让“眼见为实”成为往事，算法在我们不知情时塑造着认知与选择。" +
    "我们尚未学会驾驭它，它的能力却已一日千里。把方向盘交给一个我们看不懂、也停不下的系统，这不是利大于弊，" +
    "而是用未来的安全，赌眼前的便利。",
};
// demo pairings (pro ⚔ con) and their rebuttals
const DEMO_PAIRS = [["demo-deepseek", "demo-gpt"], ["demo-claude", "demo-qwen"]];
const DEMO_R2 = {
  "demo-deepseek":
    "对方把就业阵痛说成结构性灾难，却忽视了历史规律：每轮技术革命短期替代、长期创造更多岗位。汽车取代了马车夫，" +
    "却催生出整个现代交通业。AI 同样在催生提示工程、模型审计、AI 训练师等全新职业。真正加剧不平等的，从来不是" +
    "技术本身，而是不肯及时再分配、再培训的制度——把账算到 AI 头上，是找错了对象。",
  "demo-gpt":
    "对方描绘的“解放”过于乐观。被解放的人去哪了？质检员、客服、初级程序员不会自动变成科学家。AlphaFold 的光环" +
    "属于少数顶尖实验室，而流水线上失业的人，等不到那份红利。技术的果实集中在塔尖，代价却摊给塔基——这不是解放，" +
    "是转移；而你方始终没有回答：转移之后，他们怎么办？",
  "demo-claude":
    "对方渲染“失控”，却把“尚未完美治理”偷换成了“必然失控”。深度伪造确实存在，但应对它的，恰恰是 AI 驱动的检测；" +
    "隐私风险需要的是立法与加密，而非停止发展。因噎废食地停下，只会把方向盘交给最不负责任的人。我们要的是为它系上" +
    "安全带，而不是拒绝上车——停滞，才是最大的失控。",
  "demo-qwen":
    "对方诉诸“尊严与责任”，动人，却回避了核心：我们能否控制它。让盲人“看见”的同一套系统，也能在无人知晓时操纵" +
    "千万人的认知。把希望寄托于“善用”，等于假设权力不会被滥用——而这恰恰是最不安全的假设。责任，不在于赞美技术的" +
    "善意，而在于承认：我们尚无力为它的失控兜底。",
};

async function runDemoRound1() {
  setStatus("〔演示〕主持人正在拟题、分配立场……", "toast");
  await sleep(REDUCE ? 200 : 650);
  handleEvent({ type: "debate_id", debate_id: "demo" });
  handleEvent({ type: "topic", topic: DEMO_TOPIC });
  setStatus("〔演示〕立场已定，各方开始陈词。", "toast");
  await sleep(REDUCE ? 150 : 450);
  handleEvent({
    type: "roster",
    debaters: DEMO_CAST.map((c) => ({
      ...c, side_label: c.side === "pro" ? "正方" : "反方",
    })),
  });
  await sleep(REDUCE ? 150 : 500);
  await Promise.all(DEMO_CAST.map((c, i) => streamScripted(c.id, DEMO_R1[c.id], i)));
  handleEvent({ type: "done", round: 1 });
  state.running = false;
  refreshButtons();
  setStatus("〔演示〕第一轮已毕 —— 点「进入第二轮 · 驳论」看锁定对决。", "toast");
}

async function runDemoRound2() {
  if (state.running) return;
  state.running = true;
  el("intermission").classList.add("hidden");
  setStatus("〔演示〕锁定配对，驳论开始……", "toast");
  await sleep(REDUCE ? 120 : 400);
  handleEvent({ type: "round_start", round: 2, round_name: "驳论" });
  await sleep(REDUCE ? 120 : 350);
  handleEvent({
    type: "pairings",
    pairs: DEMO_PAIRS.map(([pro, con]) => ({
      pro: { id: pro }, con: { id: con },
    })),
    unpaired: [],
  });
  await sleep(REDUCE ? 150 : 500);
  const all = [];
  DEMO_PAIRS.forEach(([pro, con], bi) => {
    all.push(streamScripted(pro, DEMO_R2[pro], bi * 2, con));
    all.push(streamScripted(con, DEMO_R2[con], bi * 2 + 1, pro));
  });
  await Promise.all(all);
  handleEvent({ type: "done", round: 2 });
  state.running = false;
  refreshButtons();
  setStatus("〔演示〕两轮演示已毕 —— 配置 API Key 后即可上演真实辩论。", "toast");
}

async function streamScripted(id, text, i, opponentId) {
  await sleep(REDUCE ? 0 : 250 + (i % 2) * 380 + Math.random() * 240);
  const evt = { type: "turn_start", debater_id: id, round: state.phase, round_name: state.roundName };
  if (opponentId) evt.opponent_id = opponentId;
  handleEvent(evt);
  await sleep(REDUCE ? 60 : 600 + Math.random() * 500);
  const step = REDUCE ? 8 : 1 + (i % 2);
  const base = REDUCE ? 6 : 26 + (i % 2) * 8;
  for (let p = 0; p < text.length; p += step) {
    handleEvent({ type: "chunk", debater_id: id, text: text.slice(p, p + step) });
    await sleep(base + Math.random() * 24);
  }
  handleEvent({ type: "turn_end", debater_id: id });
}

// ─────────────────────────────────────────────────────────────── start ─────
boot();
