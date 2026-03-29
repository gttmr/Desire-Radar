"""Polymarket pull connector via the public Gamma search API."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from ..config import POLYMARKET_PAGES_PER_QUERY, POLYMARKET_SEARCH_QUERIES
from .base import BaseConnector, ConnectorWarning, FetchResult, RawPayload

logger = logging.getLogger(__name__)

_SEARCH_URL = "https://gamma-api.polymarket.com/public-search"
_DEFAULT_USER_AGENT = "agentic-collector/0.1 (public-source polling)"
_MAX_MARKETS_PER_EVENT = 5


def _default_queries() -> list[str]:
    queries = [item.strip() for item in POLYMARKET_SEARCH_QUERIES.split(",") if item.strip()]
    return queries or ["ai", "openai", "nvidia", "tesla", "bitcoin", "tiktok", "ipo"]


def _as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _parse_outcome_probabilities(market: dict[str, Any]) -> list[dict[str, float | str]]:
    outcomes = _parse_list(market.get("outcomes"))
    prices = _parse_list(market.get("outcomePrices"))

    pairs: list[dict[str, float | str]] = []
    for index, raw_price in enumerate(prices):
        probability = _as_float(raw_price)
        if probability is None:
            continue
        outcome_name = str(outcomes[index]) if index < len(outcomes) else f"Outcome {index + 1}"
        pairs.append(
            {
                "name": outcome_name,
                "probability": round(probability * 100, 2),
            }
        )
    return pairs


class PolymarketMarketsConnector(BaseConnector):
    name = "polymarket_markets"
    cadence_seconds = 3600
    source_tier = 2

    def __init__(
        self,
        queries: list[str] | None = None,
        *,
        pages_per_query: int | None = None,
        user_agent: str = _DEFAULT_USER_AGENT,
        search_url: str = _SEARCH_URL,
        timeout_seconds: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.queries = queries or _default_queries()
        self.pages_per_query = max(1, pages_per_query or POLYMARKET_PAGES_PER_QUERY)
        self.user_agent = user_agent
        self.search_url = search_url
        self.timeout_seconds = timeout_seconds
        self.transport = transport

    async def fetch(self) -> list[RawPayload] | FetchResult:
        payloads: list[RawPayload] = []
        warnings: list[ConnectorWarning] = []
        seen_market_ids: set[str] = set()

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
        }

        async with httpx.AsyncClient(
            headers=headers,
            timeout=self.timeout_seconds,
            transport=self.transport,
        ) as client:
            for query in self.queries:
                for page in range(1, self.pages_per_query + 1):
                    try:
                        events = await self._fetch_events(client, query, page)
                    except httpx.HTTPStatusError as exc:
                        warnings.append(
                            ConnectorWarning(
                                kind=self._http_warning_kind(exc.response.status_code),
                                target=query,
                                message=f"Failed to fetch Polymarket query {query}: HTTP {exc.response.status_code}",
                            )
                        )
                        logger.warning("Failed to fetch Polymarket query %s", query, exc_info=True)
                        break
                    except Exception as exc:
                        warnings.append(
                            ConnectorWarning(
                                kind="fetch_failed",
                                target=query,
                                message=f"Failed to fetch Polymarket query {query}: {exc}",
                            )
                        )
                        logger.warning("Failed to fetch Polymarket query %s", query, exc_info=True)
                        break

                    if not events:
                        break

                    for event_rank, event in enumerate(events, start=1):
                        event_slug = str(event.get("slug") or "").strip()
                        event_title = str(event.get("title") or "").strip()
                        tags = [
                            str(tag.get("label") or "").strip()
                            for tag in event.get("tags", [])
                            if isinstance(tag, dict) and str(tag.get("label") or "").strip()
                        ]
                        event_url = (
                            f"https://polymarket.com/event/{event_slug}"
                            if event_slug
                            else self.search_url
                        )

                        for market_rank, market in enumerate(event.get("markets", [])[:_MAX_MARKETS_PER_EVENT], start=1):
                            market_id = str(market.get("id") or "").strip()
                            if not market_id or market_id in seen_market_ids:
                                continue
                            if market.get("closed") is True:
                                continue

                            seen_market_ids.add(market_id)
                            outcomes = _parse_outcome_probabilities(market)
                            best_outcome = max(
                                outcomes,
                                key=lambda item: float(item["probability"]),
                                default=None,
                            )
                            yes_probability = next(
                                (
                                    float(item["probability"])
                                    for item in outcomes
                                    if str(item["name"]).lower() == "yes"
                                ),
                                None,
                            )

                            payloads.append(
                                RawPayload(
                                    source=self.name,
                                    data={
                                        "event_id": str(event.get("id") or ""),
                                        "event_title": event_title,
                                        "event_slug": event_slug,
                                        "event_url": event_url,
                                        "query": query,
                                        "question": market.get("question") or event_title,
                                        "market_id": market_id,
                                        "market_slug": market.get("slug") or "",
                                        "outcomes": outcomes,
                                        "probability_yes": yes_probability,
                                        "best_outcome_name": (
                                            str(best_outcome["name"])
                                            if best_outcome is not None
                                            else ""
                                        ),
                                        "best_outcome_probability": (
                                            float(best_outcome["probability"])
                                            if best_outcome is not None
                                            else None
                                        ),
                                        "liquidity": _as_float(market.get("liquidity")) or _as_float(event.get("liquidity")),
                                        "volume": _as_float(market.get("volume")) or _as_float(event.get("volume")),
                                        "volume24hr": _as_float(event.get("volume24hr")),
                                        "open_interest": _as_float(event.get("openInterest")),
                                        "competitive": _as_float(event.get("competitive")),
                                        "comment_count": event.get("commentCount") or 0,
                                        "price_change_1d": _percent_value(market.get("oneDayPriceChange")),
                                        "price_change_1wk": _percent_value(market.get("oneWeekPriceChange")),
                                        "price_change_1mo": _percent_value(market.get("oneMonthPriceChange")),
                                        "end_date": market.get("endDate") or event.get("endDate") or "",
                                        "tags": tags,
                                        "event_rank": event_rank,
                                        "market_rank": market_rank,
                                    },
                                    request_params={
                                        "query": query,
                                        "page": page,
                                        "events_status": "active",
                                        "keep_closed_markets": 0,
                                        "event_rank": event_rank,
                                        "market_rank": market_rank,
                                    },
                                    url_or_ref=event_url,
                                )
                            )

        if warnings:
            return FetchResult(payloads=payloads, warnings=warnings)
        return payloads

    def payload_identity(self, payload: RawPayload) -> str | None:
        data = payload.data if isinstance(payload.data, dict) else {}
        identifier = str(data.get("market_id") or "").strip()
        return identifier or None

    async def _fetch_events(
        self,
        client: httpx.AsyncClient,
        query: str,
        page: int,
    ) -> list[dict[str, Any]]:
        response = await client.get(
            self.search_url,
            params={
                "q": query,
                "page": page,
                "events_status": "active",
                "keep_closed_markets": 0,
            },
        )
        response.raise_for_status()
        body = response.json()
        if isinstance(body, dict):
            return body.get("events", [])
        return body if isinstance(body, list) else []

    def _http_warning_kind(self, status_code: int) -> str:
        if status_code == 403:
            return "http_403_blocked"
        if status_code == 429:
            return "rate_limited"
        return f"http_{status_code}"


def _percent_value(value: Any) -> float | None:
    numeric = _as_float(value)
    if numeric is None:
        return None
    return round(numeric * 100, 2)
