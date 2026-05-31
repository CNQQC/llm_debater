"""FastAPI 服务：提供配置查询、辩论流式接口，并托管前端静态页面。"""
from __future__ import annotations

import json
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import debate as debate_mod
from .config import Config
from .llm_client import LLMClient

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

config = Config(ROOT / "config.yaml")
llm = LLMClient(config)

app = FastAPI(title="LLM Debater")


@app.get("/api/config")
async def get_config():
    """返回名册：哪些辩手可用（已配 Key）、哪些待配置。"""
    debaters = []
    for d in config.debaters:
        debaters.append(
            {
                "id": d.id,
                "name": d.name,
                "model": d.model,
                "provider": d.provider,
                "available": config.has_key(d.provider),
            }
        )
    available = [d for d in debaters if d["available"]]
    return {
        "debaters": debaters,
        "available_count": len(available),
        "main_agent": {
            "provider": config.main_agent.provider,
            "model": config.main_agent.model,
            "available": config.has_key(config.main_agent.provider),
        },
    }


@app.post("/api/debate")
async def post_debate(req: Request):
    body = await req.json()
    topic = body.get("topic")
    num = body.get("num_debaters")
    try:
        num = int(num) if num is not None else None
    except (TypeError, ValueError):
        num = None

    async def gen():
        async for event in debate_mod.run_debate(
            llm, config, topic=topic, num_debaters=num
        ):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
