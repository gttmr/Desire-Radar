import httpx
import pytest

from src.connectors.base import FetchResult
from src.connectors.reddit_mentions import RedditMentionsConnector


@pytest.mark.asyncio
async def test_reddit_connector_requires_oauth_configuration():
    connector = RedditMentionsConnector(
        subreddits=["technology"],
        client_id="",
        client_secret="",
        username="",
        password="",
        refresh_token="",
    )

    result = await connector.fetch()

    assert isinstance(result, FetchResult)
    assert result.payloads == []
    assert result.warnings[0].kind == "auth_not_configured"
    assert result.warnings[0].recoverable is False


@pytest.mark.asyncio
async def test_reddit_connector_fetches_with_refresh_token():
    seen = {"auth": None, "listing_auth": None, "user_agent": None}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/access_token":
            seen["auth"] = request.headers.get("authorization")
            seen["user_agent"] = request.headers.get("user-agent")
            body = request.content.decode()
            assert "grant_type=refresh_token" in body
            assert "refresh_token=refresh-token" in body
            return httpx.Response(
                200,
                json={"access_token": "test-token", "expires_in": 3600},
            )
        if request.url.path == "/r/technology/hot":
            seen["listing_auth"] = request.headers.get("authorization")
            return httpx.Response(
                200,
                json={
                    "data": {
                        "children": [
                            {
                                "data": {
                                    "title": "OpenAI demand is rising",
                                    "permalink": "/r/technology/comments/abc123/openai_demand_is_rising/",
                                }
                            }
                        ]
                    }
                },
                headers={
                    "x-ratelimit-used": "1",
                    "x-ratelimit-remaining": "99",
                    "x-ratelimit-reset": "60",
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    connector = RedditMentionsConnector(
        subreddits=["technology"],
        request_limit=10,
        user_agent="linux:agentic-world:v0.1.0 (by /u/tester)",
        client_id="client-id",
        client_secret="client-secret",
        refresh_token="refresh-token",
        token_url="https://www.reddit.com/api/v1/access_token",
        api_base_url="https://oauth.reddit.com",
        transport=httpx.MockTransport(handler),
        sleep_fn=lambda _: _noop_sleep(),
    )

    result = await connector.fetch()
    payloads = result.payloads if isinstance(result, FetchResult) else result

    assert len(payloads) == 1
    assert seen["auth"] is not None
    assert seen["listing_auth"] == "Bearer test-token"
    assert seen["user_agent"] == "linux:agentic-world:v0.1.0 (by /u/tester)"
    assert payloads[0].request_params["auth_mode"] == "oauth_refresh"
    assert payloads[0].request_params["ratelimit_remaining"] == 99


@pytest.mark.asyncio
async def test_reddit_connector_returns_structured_warning_on_blocked_subreddit():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/access_token":
            return httpx.Response(
                200,
                json={"access_token": "test-token", "expires_in": 3600},
            )
        if request.url.path == "/r/gadgets/hot":
            return httpx.Response(403, json={"message": "Blocked"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    connector = RedditMentionsConnector(
        subreddits=["gadgets"],
        client_id="client-id",
        client_secret="client-secret",
        refresh_token="refresh-token",
        transport=httpx.MockTransport(handler),
        sleep_fn=lambda _: _noop_sleep(),
    )

    result = await connector.fetch()

    assert isinstance(result, FetchResult)
    assert result.payloads == []
    assert result.warnings[0].kind == "http_403_blocked"
    assert result.warnings[0].target == "gadgets"


async def _noop_sleep() -> None:
    return None
