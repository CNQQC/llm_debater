"""加载并解析 config.yaml，并结合 .env 判断哪些辩手实际可用。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class Provider:
    name: str
    base_url: str
    api_key_env: str


@dataclass
class DebaterConfig:
    id: str
    name: str
    provider: str
    model: str
    style: str = ""  # 可选：人格/风格提示，会注入到该辩手的 system prompt


@dataclass
class MainAgentConfig:
    provider: str
    model: str


class Config:
    def __init__(self, path: str | Path):
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        self.providers: dict[str, Provider] = {
            key: Provider(name=key, **value) for key, value in data["providers"].items()
        }
        self.main_agent = MainAgentConfig(**data["main_agent"])
        self.debaters: list[DebaterConfig] = [DebaterConfig(**d) for d in data["debaters"]]

    def has_key(self, provider_name: str) -> bool:
        provider = self.providers.get(provider_name)
        return bool(provider and os.getenv(provider.api_key_env))

    def available_debaters(self) -> list[DebaterConfig]:
        """只返回 API Key 已配置、因而可以真正上场的辩手。"""
        return [d for d in self.debaters if self.has_key(d.provider)]
