# LLM 辩论场 (LLM Debater)

接入多个大模型的辩论系统：一个 **主持人(MainAgent)** 给出辩题，随机给各路 LLM 分配
**正/反方**，多个不同的模型并行给出第一轮**开篇陈述**，并在网页上实时流式呈现。

```
用户/主持人出题 ──▶ 随机分配正反方 ──▶ 并行派发 ──▶ 各 LLM 流式陈述 ──▶ 前端可视化
```

## 特性

- **统一接入**：DeepSeek / Kimi(Moonshot) / SiliconFlow / OpenRouter 等任意 OpenAI 兼容服务，只需在配置里加一行。
- **主持人 AI**：未填辩题时自动生成一个有思辨性的辩题。
- **随机分边**：每次开赛随机、均衡地分配正反方。
- **并行流式**：多个模型同时作答，前端打字机式实时显示。
- **按 Key 自动选员**：只有配置了 API Key 的模型才会上场。
- **可扩展**：`backend/debate.py` 已预留 `transcript`，后续可加“驳论 / 自由辩论 / 总结 / 评委打分”等轮次。

## 快速开始（Windows PowerShell）

```powershell
# 在项目根目录下
./run.ps1
```

首次运行会自动建虚拟环境、装依赖，并生成 `.env`。
打开 `.env` 填入你拥有的任意一个或多个 Key，然后再次 `./run.ps1`，
浏览器访问 http://localhost:8000 。

### 手动启动（任意平台）

```bash
python -m venv .venv
# Windows: .\.venv\Scripts\python.exe 直接当作 python 用
pip install -r requirements.txt
cp .env.example .env   # 然后编辑 .env 填 Key
python -m uvicorn backend.server:app --reload --port 8000
```

> 若 PowerShell 不让运行 `Activate.ps1`，可跳过激活，直接用 `.\.venv\Scripts\python.exe -m uvicorn ...`。

## 配置

- `.env`：各提供商的 API Key（缺哪个就跳过哪个辩手）。
- `config.yaml`：
  - `providers`：接入点与对应的 Key 变量名；
  - `main_agent`：主持人用哪个模型出题；
  - `debaters`：辩手名册，每个绑定一个 `(provider, model)`。

> 注意：**SiliconFlow / OpenRouter 的 model id 会随平台更新**，如果某个辩手报错，
> 多半是该 model id 需要按平台最新目录改一下。

## 项目结构

```
backend/
  config.py      # 读取 config.yaml + .env，判断可用辩手
  llm_client.py  # OpenAI 兼容的统一异步客户端（流式/非流式）
  debate.py      # 主持人出题 + 随机分边 + 并行首轮陈述（事件流）
  server.py      # FastAPI：/api/config、/api/debate(流式)、托管前端
frontend/
  index.html / style.css / app.js   # 单页可视化界面
config.yaml      # 提供商与辩手名册
run.ps1          # 一键启动
```

## 接口

- `GET  /api/config` —— 返回辩手名册及可用状态。
- `POST /api/debate` —— body `{ "topic"?: string, "num_debaters"?: int }`，
  返回 **NDJSON 事件流**：`topic` → `roster` → 多路 `turn_start/chunk/turn_end` → `done`。

## 下一步可扩展

第一轮（开篇陈述）已完成。后续可在 `debate.py` 中追加：
驳论轮（让模型看到对方陈述再反驳）、自由辩论、总结陈词、以及由主持人或独立评委模型**打分裁决**。
需要的话我可以接着实现。
