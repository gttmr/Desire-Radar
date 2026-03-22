"""
RedditSentimentAgent — social sentiment from Reddit public JSON.

Fetches recent posts from r/wallstreetbets, r/stocks, and r/investing
and uses an LLM to assess overall retail investor sentiment.
Falls back to keyword-based heuristics when LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
from typing import Any
from urllib import error, request

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_ENDPOINTS = [
    ("wsb", "https://www.reddit.com/r/wallstreetbets/new.json?limit=25"),
    ("stocks", "https://www.reddit.com/r/stocks/new.json?limit=15"),
    ("investing", "https://www.reddit.com/r/investing/new.json?limit=15"),
]

_USER_AGENT = "discord-investment-bot/1.0"

_BULLISH_WORDS = {"bull", "moon", "calls", "squeeze", "breakout", "rally", "pump", "gains", "buy"}
_BEARISH_WORDS = {"crash", "puts", "short", "recession", "dump", "sell", "bear", "collapse", "tank"}


def _fetch_reddit(url: str, timeout: float = 10.0) -> list[str]:
    """Fetch post titles from a Reddit JSON endpoint."""
    req = request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 429:
                logger.warning("[reddit_sentiment] rate limited (429) for %s", url)
                return []
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        posts = (data.get("data") or {}).get("children") or []
        titles: list[str] = []
        for post in posts:
            post_data = (post.get("data") or {})
            title = post_data.get("title", "")
            selftext = post_data.get("selftext", "")[:200]
            if title:
                titles.append(f"{title} {selftext}".strip())
        return titles
    except error.HTTPError as exc:
        if exc.code == 429:
            logger.warning("[reddit_sentiment] rate limited (429) for %s", url)
        else:
            logger.warning("[reddit_sentiment] HTTP error %s for %s: %s", exc.code, url, exc)
        return []
    except Exception as exc:
        logger.warning("[reddit_sentiment] fetch failed for %s: %s", url, exc)
        return []


class RedditSentimentAgent(BaseAgent):
    name = "reddit_sentiment"
    ttl_seconds = 3600  # 1h

    def __init__(self, llm_client: Any) -> None:
        self._llm = llm_client

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        result: dict[str, Any] = {"wsb": [], "stocks": [], "investing": [], "total_posts": 0}
        for key, url in _ENDPOINTS:
            titles = _fetch_reddit(url)
            result[key] = titles
        result["total_posts"] = (
            len(result["wsb"]) + len(result["stocks"]) + len(result["investing"])
        )
        return result

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a social sentiment analyst. "
            "Analyze Reddit posts from investment communities. "
            "Return JSON: "
            "signal (bullish/caution/bearish/neutral based on overall mood), "
            "horizon ('1d' or '1w'), "
            "confidence (0-1), "
            "summary (Korean, 1-2 sentences), "
            "key_factors (array of Korean strings, max 5), "
            "hot_topics (array of strings — tickers or themes being discussed, max 5)"
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
                horizon=str(result.get("horizon", "1d")),
                confidence=max(0.0, min(1.0, float(result.get("confidence", 0.5)))),
                summary=str(result.get("summary", "")),
                key_factors=[str(f) for f in result.get("key_factors", [])[:5]],
                raw_data_snapshot={
                    "total_posts": data.get("total_posts", 0),
                    "hot_topics": [str(t) for t in result.get("hot_topics", [])[:5]],
                },
            )
        except Exception as exc:
            logger.warning("[reddit_sentiment] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        all_titles = " ".join(
            data.get("wsb", []) + data.get("stocks", []) + data.get("investing", [])
        ).lower()
        words = set(all_titles.split())
        bull_count = len(words & _BULLISH_WORDS)
        bear_count = len(words & _BEARISH_WORDS)

        if bull_count > bear_count:
            signal_val = "bullish"
            summary = f"레딧 긍정 키워드 우세 (강세 {bull_count} vs 약세 {bear_count}) — 매수 심리"
        elif bear_count > bull_count:
            signal_val = "bearish"
            summary = f"레딧 부정 키워드 우세 (약세 {bear_count} vs 강세 {bull_count}) — 매도 심리"
        else:
            signal_val = "neutral"
            summary = "레딧 감성 혼재 — 명확한 방향성 없음"

        return AgentSignal(
            agent=self.name,
            signal=signal_val,
            horizon="1d",
            confidence=0.3,
            summary=summary,
            key_factors=["키워드 빈도 기반 단순 헤리스틱 분석"],
            raw_data_snapshot={"total_posts": data.get("total_posts", 0)},
        )
