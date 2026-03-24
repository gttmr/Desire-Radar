"""
MacroAgent — monitors macroeconomic indicators.

Fetches key FRED series (fed funds rate, yield curve, unemployment, CPI)
and uses an LLM to assess the macro environment for equity markets.
Falls back to heuristic analysis when LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib import error, parse, request

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_FRED_SERIES = {
    "DFF": "fed_funds_rate",
    "T10Y2Y": "yield_curve_10y2y",
    "UNRATE": "unemployment_rate",
    "CPIAUCSL": "cpi",
}

_MOCK_DATA = {
    "fed_funds_rate": 5.33,
    "yield_curve_10y2y": -0.20,
    "unemployment_rate": 3.9,
    "cpi": 314.2,
    "source": "mock",
}


def _fetch_fred_series(series_id: str, api_key: str, timeout: float = 10.0) -> float | None:
    """Fetch the most recent observation value for a FRED series."""
    url = (
        "https://api.stlouisfed.org/fred/series/observations"
        f"?series_id={parse.quote(series_id)}"
        f"&api_key={parse.quote(api_key)}"
        "&limit=2&sort_order=desc&file_type=json"
    )
    req = request.Request(url, headers={"Accept": "application/json"})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        observations = data.get("observations") or []
        for obs in observations:
            val = obs.get("value", ".")
            if val != ".":
                return float(val)
    except Exception as exc:
        logger.warning("[macro] FRED fetch failed for %s: %s", series_id, exc)
    return None


class MacroAgent(BaseAgent):
    name = "macro"
    ttl_seconds = 86400  # 24h

    def __init__(self, llm_client: Any, knowledge_context: str = "") -> None:
        self._llm = llm_client
        self._knowledge_context = knowledge_context

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        fred_key = os.getenv("FRED_API_KEY", "")
        if not fred_key:
            logger.info("[macro] FRED_API_KEY not set — using mock data")
            return dict(_MOCK_DATA)

        result: dict[str, Any] = {"source": "fred"}
        for series_id, field_name in _FRED_SERIES.items():
            value = _fetch_fred_series(series_id, fred_key)
            if value is not None:
                result[field_name] = value
            else:
                # Fall back to mock value for missing series
                result[field_name] = _MOCK_DATA.get(field_name)

        return result

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a macroeconomic analyst. "
            "Return JSON with keys: "
            "signal (bullish/caution/bearish/neutral), "
            "horizon (e.g. '3-6m'), "
            "confidence (0-1), "
            "summary (Korean), "
            "key_factors (array of Korean strings, max 5)"
        )
        if self._knowledge_context:
            system_prompt += f"\n\n{self._knowledge_context}"
        elif knowledge:
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
            logger.warning("[macro] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        yield_curve = data.get("yield_curve_10y2y")
        if yield_curve is None:
            signal_val = "neutral"
            summary = "수익률 곡선 데이터 없음 — 중립 판단"
        elif float(yield_curve) < 0:
            signal_val = "bearish"
            summary = f"수익률 곡선 역전 ({yield_curve:.2f}) — 경기 침체 신호"
        elif float(yield_curve) > 0.5:
            signal_val = "bullish"
            summary = f"수익률 곡선 정상화 ({yield_curve:.2f}) — 경기 확장 우호"
        else:
            signal_val = "neutral"
            summary = f"수익률 곡선 중립 구간 ({yield_curve:.2f})"

        return AgentSignal(
            agent=self.name,
            signal=signal_val,
            horizon="3-6m",
            confidence=0.4,
            summary=summary,
            key_factors=["수익률 곡선 기반 단순 헤리스틱 분석"],
            raw_data_snapshot=data,
        )
