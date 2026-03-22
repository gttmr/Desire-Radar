"""
SupplyChainAgent — shipping, energy, and job market signals.

Collects Fear & Greed Index data and optional EIA electricity data
to assess macro supply chain and risk sentiment.
Uses contrarian heuristics when LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib import error, request

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_FNG_URL = "https://api.alternative.me/fng/?limit=3"
_GOOGLE_TRENDS_URL = (
    "https://trends.google.com/trends/api/dailytrends?hl=ko&tz=-540&geo=KR"
)
_EIA_URL = (
    "https://api.eia.gov/v2/electricity/electric-power-operational-data/data/"
    "?api_key={key}&frequency=monthly&data[0]=generation&start=2024-01&length=3"
)


def _fetch_fear_greed(timeout: float = 10.0) -> dict[str, Any] | None:
    """Fetch the CNN Fear & Greed Index from alternative.me."""
    req = request.Request(_FNG_URL, headers={"Accept": "application/json"})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 429:
                logger.warning("[supply_chain] Fear & Greed API rate limited (429)")
                return None
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        entries = data.get("data") or []
        if entries:
            entry = entries[0]
            return {
                "value": int(entry.get("value", 50)),
                "classification": str(entry.get("value_classification", "Neutral")),
            }
    except error.HTTPError as exc:
        if exc.code == 429:
            logger.warning("[supply_chain] Fear & Greed API rate limited (429)")
        else:
            logger.warning("[supply_chain] Fear & Greed HTTP error %s: %s", exc.code, exc)
    except Exception as exc:
        logger.warning("[supply_chain] Fear & Greed fetch failed: %s", exc)
    return None


def _fetch_google_trends(timeout: float = 10.0) -> bool:
    """Attempt to fetch Google Trends daily data. Returns True if successful."""
    req = request.Request(
        _GOOGLE_TRENDS_URL,
        headers={"Accept": "application/json", "User-Agent": "discord-investment-bot/1.0"},
    )
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        # Google Trends returns JSONP-like data starting with ")]}'\n"
        # Strip the prefix if present and try to parse
        stripped = raw.lstrip()
        if stripped.startswith(")]}"):
            newline_idx = stripped.find("\n")
            if newline_idx != -1:
                stripped = stripped[newline_idx + 1:]
        json.loads(stripped)
        return True
    except Exception as exc:
        logger.warning("[supply_chain] Google Trends fetch failed (non-critical): %s", exc)
        return False


def _fetch_eia(key: str, timeout: float = 10.0) -> bool:
    """Fetch EIA electricity generation data. Returns True if successful."""
    url = _EIA_URL.format(key=key)
    req = request.Request(url, headers={"Accept": "application/json"})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 429:
                logger.warning("[supply_chain] EIA API rate limited (429)")
                return False
            resp.read()
        return True
    except error.HTTPError as exc:
        if exc.code == 429:
            logger.warning("[supply_chain] EIA API rate limited (429)")
        else:
            logger.warning("[supply_chain] EIA HTTP error %s: %s", exc.code, exc)
        return False
    except Exception as exc:
        logger.warning("[supply_chain] EIA fetch failed: %s", exc)
        return False


class SupplyChainAgent(BaseAgent):
    name = "supply_chain"
    ttl_seconds = 43200  # 12h

    def __init__(self, llm_client: Any) -> None:
        self._llm = llm_client
        self._eia_key = os.getenv("EIA_API_KEY", "")

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        fear_greed = _fetch_fear_greed()
        google_trends_available = _fetch_google_trends()

        eia_available = False
        if self._eia_key:
            eia_available = _fetch_eia(self._eia_key)

        return {
            "fear_greed": fear_greed,
            "google_trends_available": google_trends_available,
            "eia_available": eia_available,
        }

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a supply chain and macro sentiment analyst. "
            "Analyze market fear/greed, energy data, and economic sentiment to assess investment risk levels. "
            "Return JSON: "
            "signal (bullish/caution/bearish/neutral), "
            "horizon ('1w' to '1-3m'), "
            "confidence (0-1), "
            "summary (Korean), "
            "key_factors (Korean array max 5)"
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
                horizon=str(result.get("horizon", "1w")),
                confidence=max(0.0, min(1.0, float(result.get("confidence", 0.5)))),
                summary=str(result.get("summary", "")),
                key_factors=[str(f) for f in result.get("key_factors", [])[:5]],
                raw_data_snapshot=data,
            )
        except Exception as exc:
            logger.warning("[supply_chain] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback (contrarian Fear & Greed)
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        fg = data.get("fear_greed")
        if fg is None:
            return AgentSignal(
                agent=self.name,
                signal="neutral",
                horizon="1w",
                confidence=0.2,
                summary="공포/탐욕 지수 데이터 없음 — 중립 판단",
                key_factors=["데이터 부족"],
                raw_data_snapshot=data,
            )

        value = fg.get("value", 50)
        classification = fg.get("classification", "Neutral")

        if value < 25:
            signal_val = "bullish"
            summary = f"극단적 공포 구간 ({value}, {classification}) — 역발상 매수 기회"
        elif value < 45:
            signal_val = "caution"
            summary = f"공포 구간 ({value}, {classification}) — 시장 불안 지속, 주의 필요"
        elif value <= 55:
            signal_val = "neutral"
            summary = f"중립 구간 ({value}, {classification}) — 명확한 방향성 없음"
        elif value <= 75:
            signal_val = "caution"
            summary = f"탐욕 구간 ({value}, {classification}) — 과열 주의"
        else:
            signal_val = "bearish"
            summary = f"극단적 탐욕 구간 ({value}, {classification}) — 역발상 매도 신호"

        return AgentSignal(
            agent=self.name,
            signal=signal_val,
            horizon="1w",
            confidence=0.4,
            summary=summary,
            key_factors=[
                f"공포/탐욕 지수: {value} ({classification})",
                "역발상 투자 원칙 기반 헤리스틱 분석",
            ],
            raw_data_snapshot=data,
        )
