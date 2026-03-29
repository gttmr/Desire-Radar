import httpx
import pytest

from src.connectors.base import FetchResult
from src.connectors.polymarket_markets import PolymarketMarketsConnector


@pytest.mark.asyncio
async def test_polymarket_connector_fetches_active_markets():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/public-search":
            assert request.url.params.get("q") == "ai"
            return httpx.Response(
                200,
                json={
                    "events": [
                        {
                            "id": "evt-1",
                            "title": "Which company has the best AI model?",
                            "slug": "best-ai-model",
                            "liquidity": 250000.0,
                            "volume": 1200000.0,
                            "volume24hr": 25000.0,
                            "openInterest": 550000.0,
                            "competitive": 0.81,
                            "commentCount": 3,
                            "tags": [
                                {"label": "OpenAI"},
                                {"label": "Tech"},
                            ],
                            "markets": [
                                {
                                    "id": "mkt-1",
                                    "question": "Will OpenAI have the best AI model by June 2026?",
                                    "slug": "openai-best-ai-model",
                                    "outcomes": "[\"Yes\", \"No\"]",
                                    "outcomePrices": "[\"0.61\", \"0.39\"]",
                                    "liquidity": "150000.0",
                                    "volume": "650000.0",
                                    "oneDayPriceChange": 0.07,
                                    "oneWeekPriceChange": 0.12,
                                    "oneMonthPriceChange": 0.2,
                                    "closed": False,
                                    "endDate": "2026-06-30T00:00:00Z",
                                }
                            ],
                        }
                    ],
                    "pagination": {"hasMore": False},
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    connector = PolymarketMarketsConnector(
        queries=["ai"],
        pages_per_query=1,
        transport=httpx.MockTransport(handler),
    )

    result = await connector.fetch()
    payloads = result.payloads if isinstance(result, FetchResult) else result

    assert len(payloads) == 1
    payload = payloads[0]
    assert payload.data["market_id"] == "mkt-1"
    assert payload.data["probability_yes"] == 61.0
    assert payload.data["best_outcome_name"] == "Yes"
    assert payload.data["price_change_1d"] == 7.0
    assert payload.request_params["query"] == "ai"
    assert connector.payload_identity(payload) == "mkt-1"


@pytest.mark.asyncio
async def test_polymarket_connector_returns_structured_warning_on_block():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/public-search":
            return httpx.Response(403, json={"message": "blocked"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    connector = PolymarketMarketsConnector(
        queries=["ai"],
        pages_per_query=1,
        transport=httpx.MockTransport(handler),
    )

    result = await connector.fetch()

    assert isinstance(result, FetchResult)
    assert result.payloads == []
    assert result.warnings[0].kind == "http_403_blocked"
    assert result.warnings[0].target == "ai"
