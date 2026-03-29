"""Hacker News pull connector via the public Algolia API."""

from __future__ import annotations

import asyncio
import html
import logging
import re
import time
from typing import Any

import httpx

from ..config import (
    HACKERNEWS_COMMENT_ENRICH_LIMIT,
    HACKERNEWS_HITS_PER_TAG,
    HACKERNEWS_TAGS,
)
from .base import BaseConnector, ConnectorWarning, FetchResult, RawPayload

logger = logging.getLogger(__name__)

_SEARCH_BY_DATE_URL = "https://hn.algolia.com/api/v1/search_by_date"
_ITEM_URL = "https://hn.algolia.com/api/v1/items"
_DEFAULT_USER_AGENT = "agentic-collector/0.1 (public-source polling)"
_LOOKBACK_SECONDS = 72 * 3600
_COMMENT_LIMIT = 3
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_TAG_THRESHOLDS = {
    "show_hn": {"min_points": 2, "min_comments": 0},
    "ask_hn": {"min_points": 0, "min_comments": 2},
    "story": {"min_points": 10, "min_comments": 2},
}


def _default_tags() -> list[str]:
    tags = [item.strip() for item in HACKERNEWS_TAGS.split(",") if item.strip()]
    return tags or ["show_hn", "ask_hn", "story"]


def _strip_html(text: str) -> str:
    normalized = html.unescape(text or "")
    normalized = normalized.replace("<p>", "\n")
    normalized = _HTML_TAG_RE.sub("", normalized)
    return normalized.strip()


class HackerNewsConnector(BaseConnector):
    name = "hackernews"
    cadence_seconds = 3600
    source_tier = 2
    fetch_strategy = "incremental"

    def __init__(
        self,
        tags: list[str] | None = None,
        *,
        hits_per_tag: int | None = None,
        comment_enrich_limit: int | None = None,
        user_agent: str = _DEFAULT_USER_AGENT,
        search_by_date_url: str = _SEARCH_BY_DATE_URL,
        item_url: str = _ITEM_URL,
        timeout_seconds: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.tags = tags or _default_tags()
        self.hits_per_tag = max(1, hits_per_tag or HACKERNEWS_HITS_PER_TAG)
        self.comment_enrich_limit = max(
            0,
            comment_enrich_limit
            if comment_enrich_limit is not None
            else HACKERNEWS_COMMENT_ENRICH_LIMIT,
        )
        self.user_agent = user_agent
        self.search_by_date_url = search_by_date_url
        self.item_url = item_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.transport = transport

    async def fetch(self) -> list[RawPayload] | FetchResult:
        payloads: list[RawPayload] = []
        warnings: list[ConnectorWarning] = []
        seen_ids: set[str] = set()

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
        }

        async with httpx.AsyncClient(
            headers=headers,
            timeout=self.timeout_seconds,
            transport=self.transport,
        ) as client:
            for tag in self.tags:
                try:
                    hits = await self._fetch_tag_hits(client, tag)
                    for rank, hit in enumerate(hits, start=1):
                        object_id = str(hit.get("objectID") or "").strip()
                        title = str(hit.get("title") or "").strip()
                        if not object_id or not title or object_id in seen_ids:
                            continue

                        seen_ids.add(object_id)
                        discussion_url = f"https://news.ycombinator.com/item?id={object_id}"
                        payloads.append(
                            RawPayload(
                                source=self.name,
                                data={
                                    "object_id": object_id,
                                    "story_id": hit.get("story_id") or hit.get("objectID"),
                                    "title": title,
                                    "author": hit.get("author", ""),
                                    "article_url": hit.get("url") or "",
                                    "discussion_url": discussion_url,
                                    "points": hit.get("points") or 0,
                                    "num_comments": hit.get("num_comments") or 0,
                                    "created_at": hit.get("created_at", ""),
                                    "created_at_i": hit.get("created_at_i"),
                                    "bucket": tag,
                                    "bucket_rank": rank,
                                    "top_comments": [],
                                    "comment_insights": [],
                                },
                                request_params={
                                    "tag": tag,
                                    "hits_per_page": self.hits_per_tag,
                                    "rank": rank,
                                },
                                url_or_ref=discussion_url,
                            )
                        )
                except httpx.HTTPStatusError as exc:
                    warnings.append(
                        ConnectorWarning(
                            kind=self._http_warning_kind(exc.response.status_code),
                            target=tag,
                            message=f"Failed to fetch Hacker News tag {tag}: HTTP {exc.response.status_code}",
                        )
                    )
                    logger.warning("Failed to fetch Hacker News tag %s", tag, exc_info=True)
                except Exception as exc:
                    warnings.append(
                        ConnectorWarning(
                            kind="fetch_failed",
                            target=tag,
                            message=f"Failed to fetch Hacker News tag {tag}: {exc}",
                        )
                    )
                    logger.warning("Failed to fetch Hacker News tag %s", tag, exc_info=True)

            await self._enrich_top_threads(client, payloads)

        if warnings:
            return FetchResult(payloads=payloads, warnings=warnings)
        return payloads

    def payload_identity(self, payload: RawPayload) -> str | None:
        data = payload.data if isinstance(payload.data, dict) else {}
        object_id = str(data.get("object_id") or "").strip()
        return object_id or None

    async def _fetch_tag_hits(
        self,
        client: httpx.AsyncClient,
        tag: str,
    ) -> list[dict[str, Any]]:
        thresholds = _TAG_THRESHOLDS.get(tag, {"min_points": 0, "min_comments": 0})
        since = int(time.time()) - _LOOKBACK_SECONDS
        numeric_filters = [f"created_at_i>{since}"]
        if thresholds["min_points"] > 0:
            numeric_filters.append(f"points>{thresholds['min_points']}")
        if thresholds["min_comments"] > 0:
            numeric_filters.append(f"num_comments>{thresholds['min_comments']}")

        response = await client.get(
            self.search_by_date_url,
            params={
                "tags": tag,
                "hitsPerPage": self.hits_per_tag,
                "numericFilters": ",".join(numeric_filters),
            },
        )
        response.raise_for_status()
        return response.json().get("hits", [])

    async def _enrich_top_threads(
        self,
        client: httpx.AsyncClient,
        payloads: list[RawPayload],
    ) -> None:
        if self.comment_enrich_limit <= 0 or not payloads:
            return

        targets = sorted(
            payloads,
            key=lambda item: (
                int(item.data.get("points") or 0) + int(item.data.get("num_comments") or 0),
                int(item.data.get("num_comments") or 0),
            ),
            reverse=True,
        )[: self.comment_enrich_limit]

        results = await asyncio.gather(
            *(self._fetch_comments(client, target.data["object_id"]) for target in targets),
            return_exceptions=True,
        )

        for target, result in zip(targets, results):
            if isinstance(result, Exception):
                logger.debug(
                    "Failed to enrich Hacker News comments for %s",
                    target.data.get("object_id"),
                    exc_info=result,
                )
                continue
            target.data["top_comments"] = result["comments"]
            target.data["comment_insights"] = result["comment_insights"]

    async def _fetch_comments(
        self,
        client: httpx.AsyncClient,
        object_id: str,
    ) -> dict[str, list[dict[str, Any]] | list[str]]:
        response = await client.get(f"{self.item_url}/{object_id}")
        response.raise_for_status()
        data = response.json()
        children = data.get("children", [])

        real_comments = [
            child
            for child in children
            if child.get("text") and child.get("author")
        ]
        real_comments.sort(key=lambda item: item.get("points") or 0, reverse=True)

        comments: list[dict[str, Any]] = []
        insights: list[str] = []
        for child in real_comments[:_COMMENT_LIMIT]:
            text = _strip_html(str(child.get("text") or ""))
            if not text:
                continue
            excerpt = text[:300] + "..." if len(text) > 300 else text
            comments.append(
                {
                    "author": child.get("author", ""),
                    "text": excerpt,
                    "points": child.get("points") or 0,
                }
            )
            first_sentence = text.split(". ")[0].split("\n")[0].strip()
            if first_sentence:
                insights.append(first_sentence[:200])

        return {
            "comments": comments,
            "comment_insights": insights,
        }

    def _http_warning_kind(self, status_code: int) -> str:
        if status_code == 403:
            return "http_403_blocked"
        if status_code == 429:
            return "rate_limited"
        return f"http_{status_code}"
