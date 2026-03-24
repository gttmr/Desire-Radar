"""
LLM abstraction layer.

Provides a single LLMClient interface so agents are decoupled from the
underlying provider. Currently supports:
  - AzureOpenAIProvider  (production, requires Azure creds)
  - MockProvider         (local dev/test, returns deterministic stubs)

Usage:
    client = build_llm_client(config)
    result = client.chat_json(system="...", user="...")
    text   = client.chat_text(system="...", user="...")
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Protocol

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Provider protocol — any class implementing these two methods qualifies
# ------------------------------------------------------------------

class LLMClient(Protocol):
    def chat_json(self, *, system: str, user: str) -> dict[str, Any]:
        """Call LLM with json_object response_format. Returns parsed dict."""
        ...

    def chat_text(self, *, system: str, user: str) -> str:
        """Call LLM and return raw text content."""
        ...


# ------------------------------------------------------------------
# Azure OpenAI provider (production)
# ------------------------------------------------------------------

class AzureOpenAIProvider:
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        deployment: str,
        timeout: float = 30.0,
        temperature: float = 0.2,
    ):
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._deployment = deployment
        self._timeout = timeout
        self._temperature = temperature

    def _base_url(self) -> str:
        ep = self._endpoint
        if ep.endswith("/openai/v1"):
            return ep
        if ep.endswith("/openai"):
            return f"{ep}/v1"
        return f"{ep}/openai/v1"

    def _call(self, messages: list[dict[str, str]], *, json_mode: bool) -> str:
        from urllib import request as urllib_request

        payload: dict[str, Any] = {
            "model": self._deployment,
            "messages": messages,
            "temperature": self._temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        body = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(
            f"{self._base_url()}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "api-key": self._api_key,
            },
            method="POST",
        )
        with urllib_request.urlopen(req, timeout=self._timeout) as resp:
            raw = resp.read().decode("utf-8")

        data = json.loads(raw)
        choices = data.get("choices") or []
        if not choices:
            raise ValueError("empty chat completion response")
        return (choices[0].get("message") or {}).get("content", "").strip()

    def chat_json(self, *, system: str, user: str) -> dict[str, Any]:
        content = self._call(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            json_mode=True,
        )
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON from LLM: {content[:200]}") from exc

    def chat_text(self, *, system: str, user: str) -> str:
        return self._call(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            json_mode=False,
        )


# ------------------------------------------------------------------
# Mock provider (local dev / unit tests)
# ------------------------------------------------------------------

class MockProvider:
    """Returns deterministic stub responses — no network calls."""

    def chat_json(self, *, system: str, user: str) -> dict[str, Any]:
        logger.debug("[mock_llm] chat_json called")
        return {
            "signal": "neutral",
            "horizon": "1-3m",
            "confidence": 0.5,
            "summary": "[MOCK] LLM 미설정 — 모의 응답입니다.",
            "key_factors": ["mock factor 1", "mock factor 2"],
        }

    def chat_text(self, *, system: str, user: str) -> str:
        logger.debug("[mock_llm] chat_text called")
        return "[MOCK] LLM 미설정 — 모의 텍스트 응답입니다."


# ------------------------------------------------------------------
# Factory
# ------------------------------------------------------------------

def build_llm_client(
    endpoint: str = "",
    api_key: str = "",
    deployment: str = "",
    timeout: float = 30.0,
) -> LLMClient:
    """
    Return a real AzureOpenAIProvider when credentials are present,
    otherwise fall back to MockProvider.
    """
    if endpoint and api_key and deployment:
        logger.info("[llm] using AzureOpenAI provider (deployment=%s)", deployment)
        return AzureOpenAIProvider(endpoint, api_key, deployment, timeout=timeout)

    logger.warning("[llm] credentials missing — using MockProvider")
    return MockProvider()
