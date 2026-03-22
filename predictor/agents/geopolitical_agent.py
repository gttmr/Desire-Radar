"""
GeopoliticalAgent — monitors geopolitical risk for financial markets.

Uses the free GDELT doc API (no key required) to fetch recent news about
conflict, sanctions, and geopolitical tensions. Optionally augments with
Naver Korean-language news. LLM assigns a risk signal; heuristic fallback
returns neutral when the LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib import error, parse, request

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_GDELT_URL = (
    "https://api.gdeltproject.org/api/v2/doc/doc"
    "?query=war+conflict+sanctions+geopolitical"
    "&mode=artlist&maxrecords=10&format=json&timespan=1d"
)
_NAVER_QUERY = "전쟁 지정학 제재 분쟁"


def _fetch_gdelt(timeout: float = 10.0) -> list[str]:
    """Return a list of article titles from GDELT. Empty list on any error."""
    try:
        req = request.Request(_GDELT_URL, headers={"Accept": "application/json"})
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        articles = data.get("articles") or []
        titles: list[str] = []
        for article in articles[:10]:
            title = str(article.get("title", "")).strip()
            if title:
                titles.append(title)
        return titles
    except Exception as exc:
        logger.warning("[geopolitical] GDELT fetch failed: %s", exc)
        return []


class GeopoliticalAgent(BaseAgent):
    name = "geopolitical"
    ttl_seconds = 21600  # 6h

    def __init__(self, llm_client: Any, naver_client: Any = None) -> None:
        self._llm = llm_client
        self._naver = naver_client

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        gdelt_titles = _fetch_gdelt()

        naver_news: list[str] = []
        naver_configured = (
            self._naver is not None
            and os.getenv("NAVER_CLIENT_ID", "")
            and os.getenv("NAVER_CLIENT_SECRET", "")
        )
        if naver_configured:
            try:
                naver_news = self._naver.fetch_news(_NAVER_QUERY) or []
            except Exception as exc:
                logger.warning("[geopolitical] Naver fetch failed: %s", exc)

        return {
            "gdelt_headlines": gdelt_titles,
            "naver_korean_news": naver_news,
            "source": "gdelt" + ("+naver" if naver_news else ""),
        }

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a geopolitical risk analyst for financial markets. "
            "Return JSON with keys: "
            "signal (bullish=low_risk/neutral/caution=medium_risk/bearish=high_risk), "
            "horizon (e.g. '1-3m'), "
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
                horizon=str(result.get("horizon", "1-3m")),
                confidence=max(0.0, min(1.0, float(result.get("confidence", 0.5)))),
                summary=str(result.get("summary", "")),
                key_factors=[str(f) for f in result.get("key_factors", [])[:5]],
                raw_data_snapshot=data,
            )
        except Exception as exc:
            logger.warning("[geopolitical] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        return AgentSignal(
            agent=self.name,
            signal="neutral",
            horizon="1-3m",
            confidence=0.3,
            summary="지정학적 리스크 LLM 분석 불가 — 중립 판단",
            key_factors=["지정학 데이터 수집 완료, LLM 분석 실패"],
            raw_data_snapshot=data,
        )
