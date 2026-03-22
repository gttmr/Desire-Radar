"""
EntertainmentAgent — K-entertainment and global content trends.

Fetches Korean box office data from KOBIS to assess the health of Korean
entertainment stocks (HYBE, SM, JYP, YG, CJ ENM, NEW).
Falls back to mock data when KOBIS API key is absent.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib import error, request

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_KOBIS_URL = (
    "https://www.kobis.or.kr/kobisopenapi/webservice/rest/boxoffice"
    "/searchDailyBoxOfficeList.json?key={key}&targetDt={date}"
)

_MOCK_BOX_OFFICE = [
    {"rank": 1, "title": "범죄도시4", "audience": 210000},
    {"rank": 2, "title": "파묘", "audience": 95000},
    {"rank": 3, "title": "서울의 봄", "audience": 62000},
    {"rank": 4, "title": "위키드", "audience": 41000},
    {"rank": 5, "title": "인사이드 아웃 2", "audience": 27000},
]


def _fetch_kobis(key: str, timeout: float = 10.0) -> list[dict[str, Any]]:
    """Fetch yesterday's daily box office from KOBIS."""
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y%m%d")
    url = _KOBIS_URL.format(key=key, date=yesterday)
    req = request.Request(url, headers={"Accept": "application/json"})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 429:
                logger.warning("[entertainment] KOBIS rate limited (429)")
                return []
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        box_office_result = (data.get("boxOfficeResult") or {})
        daily_list = box_office_result.get("dailyBoxOfficeList") or []
        results: list[dict[str, Any]] = []
        for entry in daily_list[:5]:
            try:
                results.append({
                    "rank": int(entry.get("rank", 0)),
                    "title": str(entry.get("movieNm", "")),
                    "audience": int(entry.get("audiCnt", 0)),
                })
            except Exception as exc:
                logger.warning("[entertainment] KOBIS entry parse error: %s", exc)
        return results
    except error.HTTPError as exc:
        if exc.code == 429:
            logger.warning("[entertainment] KOBIS rate limited (429)")
        else:
            logger.warning("[entertainment] KOBIS HTTP error %s: %s", exc.code, exc)
        return []
    except Exception as exc:
        logger.warning("[entertainment] KOBIS fetch failed: %s", exc)
        return []


class EntertainmentAgent(BaseAgent):
    name = "entertainment"
    ttl_seconds = 86400  # 24h

    def __init__(self, llm_client: Any, kobis_api_key: str = "") -> None:
        self._llm = llm_client
        self._kobis_key = kobis_api_key or os.getenv("KOBIS_API_KEY", "")

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        if self._kobis_key:
            box_office = _fetch_kobis(self._kobis_key)
            if box_office:
                return {"box_office": box_office, "data_source": "kobis"}
            logger.warning("[entertainment] KOBIS returned empty, falling back to mock")

        logger.info("[entertainment] using mock box office data")
        return {"box_office": _MOCK_BOX_OFFICE, "data_source": "mock"}

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are an entertainment industry analyst for Korean financial markets. "
            "Analyze box office and content trends to assess impact on Korean entertainment stocks "
            "(HYBE, SM, JYP, YG, CJ ENM, NEW). "
            "Return JSON: "
            "signal (bullish/caution/bearish/neutral), "
            "horizon ('1-3m'), "
            "confidence (0-1), "
            "summary (Korean), "
            "key_factors (Korean array max 5), "
            "affected_stocks (array of Korean stock names max 3)"
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
                raw_data_snapshot={
                    "data_source": data.get("data_source", "unknown"),
                    "top_movie": data.get("box_office", [{}])[0] if data.get("box_office") else {},
                    "affected_stocks": [str(s) for s in result.get("affected_stocks", [])[:3]],
                },
            )
        except Exception as exc:
            logger.warning("[entertainment] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        box_office = data.get("box_office") or []
        if not box_office:
            return AgentSignal(
                agent=self.name,
                signal="neutral",
                horizon="1-3m",
                confidence=0.2,
                summary="박스오피스 데이터 없음 — 중립 판단",
                key_factors=["데이터 부족"],
                raw_data_snapshot=data,
            )

        top_audience = box_office[0].get("audience", 0)
        if top_audience > 100000:
            signal_val = "bullish"
            summary = f"1위 영화 관객 {top_audience:,}명 — 엔터테인먼트 섹터 강세"
        elif top_audience > 50000:
            signal_val = "neutral"
            summary = f"1위 영화 관객 {top_audience:,}명 — 보통 수준의 흥행"
        else:
            signal_val = "bearish"
            summary = f"1위 영화 관객 {top_audience:,}명 — 박스오피스 부진"

        return AgentSignal(
            agent=self.name,
            signal=signal_val,
            horizon="1-3m",
            confidence=0.35,
            summary=summary,
            key_factors=["박스오피스 관객수 기반 단순 헤리스틱 분석"],
            raw_data_snapshot={
                "data_source": data.get("data_source", "unknown"),
                "top_movie": box_office[0] if box_office else {},
            },
        )
