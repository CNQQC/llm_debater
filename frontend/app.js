"use strict";

const el = (id) => document.getElementById(id);
const cards = {}; // debater_id -> { card, statement }

// ---------------------------------------------------------------------------
// 初始化：读取后端名册，填充人数选项与预览
// ---------------------------------------------------------------------------
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    renderRoster(cfg);
    renderAgentInfo(cfg);
  } catch (e) {
    setStatus("无法加载配置：" + e.message, true);
  }
}

function renderAgentInfo(cfg) {
  const m = cfg.main_agent;
  el("agent-info").innerHTML =
    `主持人(MainAgent)：${m.model} ` +
    (m.available ? "✅" : "⚠️ 未配置 Key") +
    `<br>可用辩手：${cfg.available_count} / ${cfg.debaters.length}`;
}

function renderRoster(cfg) {
  const preview = el("roster-preview");
  preview.innerHTML = "";
  cfg.debaters.forEach((d) => {
    const chip = document.createElement("span");
    chip.className = "chip" + (d.available ? "" : " off");
    chip.innerHTML = `<span class="dot"></span>${d.name}`;
    chip.title = d.available ? `${d.provider} · ${d.model}` : "未配置 API Key";
    preview.appendChild(chip);
  });

  const num = el("num");
  num.innerHTML = "";
  const max = cfg.available_count;
  if (max < 1) {
    const opt = document.createElement("option");
    opt.textContent = "无可用辩手";
    num.appendChild(opt);
    num.disabled = true;
    el("start").disabled = true;
    setStatus("请先在 .env 中配置至少一个提供商的 API Key", true);
    return;
  }
  for (let i = Math.min(2, max); i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = i + " 位";
    num.appendChild(opt);
  }
  num.value = max; // 默认全部上场
}

// ---------------------------------------------------------------------------
// 开始辩论：POST 流式接口，逐行解析 NDJSON 事件
// ---------------------------------------------------------------------------
async function startDebate() {
  el("start").disabled = true;
  setStatus("主持人正在准备辩题与分配立场…");
  resetArena();

  const payload = {
    topic: el("topic").value.trim(),
    num_debaters: parseInt(el("num").value, 10) || null,
  };

  try {
    const res = await fetch("/api/debate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
  } catch (e) {
    setStatus("出错：" + e.message, true);
  } finally {
    el("start").disabled = false;
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case "topic":
      el("arena").classList.remove("hidden");
      el("topic-banner").innerHTML =
        `<span class="label">本场辩题</span>${escapeHtml(ev.topic)}`;
      setStatus("立场已分配，辩手开始陈述…");
      break;

    case "roster":
      ev.debaters.forEach(createCard);
      break;

    case "turn_start": {
      const c = cards[ev.debater_id];
      if (c) {
        c.card.classList.add("thinking");
        c.statement.classList.add("placeholder");
        c.statement.textContent = "思考中…";
      }
      break;
    }

    case "chunk": {
      const c = cards[ev.debater_id];
      if (!c) break;
      if (c.statement.classList.contains("placeholder")) {
        c.statement.classList.remove("placeholder");
        c.statement.textContent = "";
        c.card.classList.remove("thinking");
        c.card.classList.add("speaking");
      }
      c.statement.textContent += ev.text;
      break;
    }

    case "turn_end": {
      const c = cards[ev.debater_id];
      if (c && !c.card.classList.contains("failed")) {
        c.card.classList.remove("thinking", "speaking");
        c.card.classList.add("done");
      }
      break;
    }

    case "error": {
      if (ev.debater_id && cards[ev.debater_id]) {
        const c = cards[ev.debater_id];
        c.card.classList.remove("thinking", "speaking");
        c.card.classList.add("failed");
        c.statement.classList.remove("placeholder");
        c.statement.textContent = "⚠️ " + ev.message;
      } else {
        setStatus("⚠️ " + ev.message, true);
      }
      break;
    }

    case "done":
      setStatus("本轮辩论（开篇陈述）已完成 ✅");
      break;
  }
}

function createCard(d) {
  const col = el(d.side === "pro" ? "col-pro" : "col-con");
  const card = document.createElement("div");
  card.className = "card " + d.side;
  card.innerHTML = `
    <div class="card-head">
      <span class="card-name">${escapeHtml(d.name)}
        <span class="model-badge">${escapeHtml(d.model)}</span>
      </span>
      <span class="state-dot"></span>
    </div>
    <div class="statement placeholder">等待发言…</div>`;
  col.appendChild(card);
  cards[d.id] = { card, statement: card.querySelector(".statement") };
}

function resetArena() {
  el("col-pro").innerHTML = "";
  el("col-con").innerHTML = "";
  el("topic-banner").innerHTML = "";
  for (const k in cards) delete cards[k];
}

function setStatus(msg, isError) {
  const s = el("status");
  s.textContent = msg;
  s.className = "status" + (isError ? " error" : "");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

el("start").addEventListener("click", startDebate);
loadConfig();
