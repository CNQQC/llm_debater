"""统一的 OpenAI 兼容客户端：按 provider 懒加载，支持流式与非流式调用。"""
from __future__ import annotations

import os
from typing import AsyncIterator

from openai import AsyncOpenAI

from .config import Config


class LLMClient:
    def __init__(self, config: Config):
        self.config = config
        self._clients: dict[str, AsyncOpenAI] = {}

    def _client(self, provider_name: str) -> AsyncOpenAI:
        if provider_name not in self._clients:
            provider = self.config.providers.get(provider_name)
            if provider is None:
                raise RuntimeError(f"未知的提供商: {provider_name}")
            api_key = os.getenv(provider.api_key_env, "")
            if not api_key:
                raise RuntimeError(
                    f"缺少 API Key：请在 .env 中设置 {provider.api_key_env}"
                )
            headers = None
            if provider_name == "openrouter":
                # OpenRouter 建议（非必须）带上来源标识
                headers = {"HTTP-Referer": "http://localhost", "X-Title": "LLM Debater"}
            self._clients[provider_name] = AsyncOpenAI(
                api_key=api_key,
                base_url=provider.base_url,
                default_headers=headers,
                timeout=120.0,
            )
        return self._clients[provider_name]

    async def stream(
        self,
        provider: str,
        model: str,
        messages: list[dict],
        temperature: float = 0.8,
    ) -> AsyncIterator[str]:
        """逐段产出文本增量。"""
        client = self._client(provider)
        completion = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            stream=True,
        )
        async for chunk in completion:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            piece = getattr(delta, "content", None)
            if piece:
                yield piece

    async def complete(
        self,
        provider: str,
        model: str,
        messages: list[dict],
        temperature: float = 0.8,
    ) -> str:
        client = self._client(provider)
        resp = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
        )
        return (resp.choices[0].message.content or "").strip()
