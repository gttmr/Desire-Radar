"""
SemiconductorAgent — monitors the semiconductor cycle.

Collects Naver news about inventory/demand trends and DART disclosures
for key Korean semiconductor companies (SK하이닉스, 삼성전자).
Uses LLM to assess cycle phase; heuristic fallback when unavailable.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_SEMI_TICKERS = ["000660", "005930"]  # SK하이닉스, 삼성전자

_MOCK_DATA = {
    "news_inventory_demand": [
        "반도체 재고 정상화 진행 중 — 업계 관측",
        "TSMC 파운드리 가동률 소폭 회복",
    ],
    "news_cycle": [
        "반도체 다운사이클 바닥 논쟁 지속",
    ],
    "dart_disclosures": {
        "000660": [],
        "005930": [],
    },
    "source": "mock",
}


class SemiconductorAgent(BaseAgent):
    name = "semiconductor"
    ttl_seconds = 86400  # 24h

    def __init__(
        self,
        llm_client: Any,
        naver_client: Any = None,
        dart_client: Any = None,
    ) -> None:
        self._llm = llm_client
        self._naver = naver_client
        self._dart = dart_client

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        naver_configured = (
            self._naver is not None
            and os.getenv("NAVER_CLIENT_ID", "")
            and os.getenv("NAVER_CLIENT_SECRET", "")
        )
        dart_configured = (
            self._dart is not None
            and os.getenv("DART_API_KEY", "")
        )

        if not naver_configured and not dart_configured:
            logger.info("[semiconductor] Naver/DART not configured — using mock data")
            return dict(_MOCK_DATA)

        result: dict[str, Any] = {"source": "live"}

        # Naver news
        news_inventory: list[str] = []
        news_cycle: list[str] = []
        if naver_configured:
            try:
                news_inventory = self._naver.fetch_news("반도체 재고 수요 TSMC") or []
            except Exception as exc:
                logger.warning("[semiconductor] Naver fetch (inventory) failed: %s", exc)
            try:
                news_cycle = self._naver.fetch_news("반도체 사이클") or []
            except Exception as exc:
                logger.warning("[semiconductor] Naver fetch (cycle) failed: %s", exc)

        result["news_inventory_demand"] = news_inventory
        result["news_cycle"] = news_cycle

        # DART disclosures for key tickers
        disclosures: dict[str, list[str]] = {}
        if dart_configured:
            for ticker in _SEMI_TICKERS:
                try:
                    disclosures[ticker] = self._dart.fetch_disclosures(ticker) or []
                except Exception as exc:
                    logger.warning("[semiconductor] DART fetch failed for %s: %s", ticker, exc)
                    disclosures[ticker] = []
        else:
            for ticker in _SEMI_TICKERS:
                disclosures[ticker] = []

        result["dart_disclosures"] = disclosures

        # Fall back to mock news if nothing was retrieved
        if not news_inventory and not news_cycle:
            result["news_inventory_demand"] = _MOCK_DATA["news_inventory_demand"]
            result["news_cycle"] = _MOCK_DATA["news_cycle"]
            result["source"] = "partial_mock"

        return result

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a semiconductor industry analyst specializing in inventory cycles, "
            "DRAM/NAND pricing, and fab utilization. "
            "Return JSON with keys: "
            "signal (bullish/caution/bearish/neutral), "
            "horizon (e.g. '3-6m'), "
            "confidence (0-1), "
            "summary (Korean), "
            "key_factors (array of Korean strings, max 5)"
        )
        if knowledge:
            context_lines = ["## 사용자 투자 관점 메모"] + [f"- {k}" for k in knowledge]
            system_prompt += "\n\n" + "\n".join(context_lines)

        try:
            result = self._llm.chat_json(
                system=system_prompt,
                user=json.dumps(data, ensure_ascii=False),
            )
            signal_val = str(result.get("signal", "neutral")).lower()
            if signal_val not in {"bullish", "caution", "bearish", "neutral"}:
                signal_val = "neutral"
            return AgentSignal(
                agent=self.name,
                signal=signal_val,
                horizon=str(result.get("horizon", "3-6m")),
                confidence=max(0.0, min(1.0, float(result.get("confidence", 0.5)))),
                summary=str(result.get("summary", "")),
                key_factors=[str(f) for f in result.get("key_factors", [])[:5]],
                raw_data_snapshot=data,
            )
        except Exception as exc:
            logger.warning("[semiconductor] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        return AgentSignal(
            agent=self.name,
            signal="neutral",
            horizon="3-6m",
            confidence=0.3,
            summary="반도체 사이클 분석 데이터 부족 — 중립 판단",
            key_factors=["반도체 사이클 분석 데이터 부족"],
            raw_data_snapshot=data,
        )
