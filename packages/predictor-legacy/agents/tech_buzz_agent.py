"""
TechBuzzAgent — technology trend signals from HackerNews + arXiv.

Fetches HackerNews top stories and recent arXiv AI/ML papers to assess
technology sector momentum for equity market analysis.
Falls back to keyword heuristics when LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from typing import Any
from urllib import error, request

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)

_HN_TOP_STORIES = "https://hacker-news.firebaseio.com/v0/topstories.json"
_HN_ITEM = "https://hacker-news.firebaseio.com/v0/item/{id}.json"
_ARXIV_RSS = "https://export.arxiv.org/rss/cs.AI"

_TECH_KEYWORDS = {
    "ai", "gpu", "semiconductor", "cloud", "nvidia", "chip", "llm",
    "openai", "ml", "inference", "data center", "transformer", "model",
}


def _fetch_json(url: str, timeout: float = 10.0) -> Any:
    """Fetch and parse JSON from a URL."""
    req = request.Request(url, headers={"Accept": "application/json"})
    with request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_hn_stories(timeout: float = 10.0) -> list[dict[str, Any]]:
    """Fetch top 15 HackerNews stories with title, score, url."""
    try:
        story_ids: list[int] = _fetch_json(_HN_TOP_STORIES, timeout=timeout)
        stories: list[dict[str, Any]] = []
        for story_id in story_ids[:15]:
            try:
                item = _fetch_json(_HN_ITEM.format(id=story_id), timeout=timeout)
                if item and item.get("title"):
                    stories.append({
                        "title": str(item.get("title", "")),
                        "score": int(item.get("score") or 0),
                        "url": str(item.get("url", "")),
                    })
            except Exception as exc:
                logger.warning("[tech_buzz] HN item %s fetch failed: %s", story_id, exc)
        return stories
    except Exception as exc:
        logger.warning("[tech_buzz] HN top stories fetch failed: %s", exc)
        return []


def _fetch_arxiv_papers(timeout: float = 10.0) -> list[str]:
    """Fetch top 10 arXiv AI paper titles from RSS feed."""
    try:
        req = request.Request(_ARXIV_RSS, headers={"Accept": "application/rss+xml"})
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        root = ET.fromstring(raw)
        titles: list[str] = []
        channel = root.find("channel")
        if channel is None:
            return []
        for item in channel.findall("item"):
            title_el = item.find("title")
            if title_el is not None and title_el.text:
                titles.append(title_el.text.strip())
            if len(titles) >= 10:
                break
        return titles
    except Exception as exc:
        logger.warning("[tech_buzz] arXiv RSS fetch failed: %s", exc)
        return []


class TechBuzzAgent(BaseAgent):
    name = "tech_buzz"
    ttl_seconds = 14400  # 4h

    def __init__(self, llm_client: Any) -> None:
        self._llm = llm_client

    # ------------------------------------------------------------------
    # collect
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        hn_stories = _fetch_hn_stories()
        arxiv_papers = _fetch_arxiv_papers()
        return {
            "hn_top_stories": hn_stories,
            "arxiv_papers": arxiv_papers,
        }

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a technology trend analyst for financial markets. "
            "Analyze HackerNews stories and recent AI research papers to assess tech sector momentum. "
            "Focus on: AI/GPU demand signals, semiconductor mentions, cloud/infra trends, breakthrough technologies. "
            "Return JSON: "
            "signal (bullish/caution/bearish/neutral for tech sector), "
            "horizon ('1-3m'), "
            "confidence (0-1), "
            "summary (Korean), "
            "key_factors (Korean array max 5), "
            "tech_themes (array of identified technology themes in English, max 5)"
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
                    "hn_story_count": len(data.get("hn_top_stories", [])),
                    "arxiv_paper_count": len(data.get("arxiv_papers", [])),
                    "tech_themes": [str(t) for t in result.get("tech_themes", [])[:5]],
                },
            )
        except Exception as exc:
            logger.warning("[tech_buzz] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        hn_titles = " ".join(
            s.get("title", "") for s in data.get("hn_top_stories", [])
        ).lower()
        keyword_hits = sum(1 for kw in _TECH_KEYWORDS if kw in hn_titles)

        if keyword_hits >= 5:
            signal_val = "bullish"
            summary = f"HN 상위 기사에서 기술 키워드 {keyword_hits}건 감지 — 테크 섹터 강세"
        elif keyword_hits >= 2:
            signal_val = "neutral"
            summary = f"HN 기술 키워드 {keyword_hits}건 — 보통 수준의 테크 모멘텀"
        else:
            signal_val = "caution"
            summary = "HN 기술 관련 기사 적음 — 테크 섹터 모멘텀 약화 주의"

        return AgentSignal(
            agent=self.name,
            signal=signal_val,
            horizon="1-3m",
            confidence=0.3,
            summary=summary,
            key_factors=["HN 기술 키워드 빈도 기반 단순 헤리스틱 분석"],
            raw_data_snapshot={
                "hn_story_count": len(data.get("hn_top_stories", [])),
                "keyword_hits": keyword_hits,
            },
        )
