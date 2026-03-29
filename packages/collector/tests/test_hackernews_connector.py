import httpx
import pytest

from src.connectors.base import FetchResult
from src.connectors.hackernews import HackerNewsConnector


@pytest.mark.asyncio
async def test_hackernews_connector_fetches_and_enriches_threads():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/search_by_date":
            tag = request.url.params.get("tags")
            if tag == "show_hn":
                return httpx.Response(
                    200,
                    json={
                        "hits": [
                            {
                                "objectID": "1001",
                                "story_id": 1001,
                                "title": "Show HN: Acme AI Copilot",
                                "author": "alice",
                                "points": 42,
                                "num_comments": 11,
                                "created_at": "2026-03-29T10:00:00Z",
                                "created_at_i": 1774778400,
                                "url": "https://example.com/acme",
                            }
                        ]
                    },
                )
            if tag == "story":
                return httpx.Response(
                    200,
                    json={
                        "hits": [
                            {
                                "objectID": "1001",
                                "story_id": 1001,
                                "title": "Show HN: Acme AI Copilot",
                                "author": "alice",
                                "points": 42,
                                "num_comments": 11,
                                "created_at": "2026-03-29T10:00:00Z",
                                "created_at_i": 1774778400,
                                "url": "https://example.com/acme",
                            },
                            {
                                "objectID": "1002",
                                "story_id": 1002,
                                "title": "New compiler cuts cloud spend",
                                "author": "bob",
                                "points": 30,
                                "num_comments": 7,
                                "created_at": "2026-03-29T11:00:00Z",
                                "created_at_i": 1774782000,
                                "url": "https://example.com/compiler",
                            },
                        ]
                    },
                )
        if request.url.path == "/api/v1/items/1001":
            return httpx.Response(
                200,
                json={
                    "children": [
                        {
                            "author": "charlie",
                            "text": "<p>We switched last week. Setup was easy.</p>",
                            "points": 12,
                        },
                        {
                            "author": "dana",
                            "text": "Pricing still looks high.",
                            "points": 5,
                        },
                    ]
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    connector = HackerNewsConnector(
        tags=["show_hn", "story"],
        hits_per_tag=5,
        comment_enrich_limit=1,
        transport=httpx.MockTransport(handler),
    )

    result = await connector.fetch()
    payloads = result.payloads if isinstance(result, FetchResult) else result

    assert len(payloads) == 2
    assert payloads[0].data["object_id"] == "1001"
    assert payloads[0].data["top_comments"][0]["author"] == "charlie"
    assert payloads[0].data["comment_insights"][0] == "We switched last week"
    assert payloads[1].data["object_id"] == "1002"
    assert connector.payload_identity(payloads[0]) == "1001"


@pytest.mark.asyncio
async def test_hackernews_connector_returns_structured_warning_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/search_by_date":
            return httpx.Response(429, json={"message": "rate limited"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    connector = HackerNewsConnector(
        tags=["show_hn"],
        comment_enrich_limit=0,
        transport=httpx.MockTransport(handler),
    )

    result = await connector.fetch()

    assert isinstance(result, FetchResult)
    assert result.payloads == []
    assert result.warnings[0].kind == "rate_limited"
    assert result.warnings[0].target == "show_hn"
