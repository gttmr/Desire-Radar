"""Fetch trending Reddit posts through the official OAuth Data API."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Callable

import httpx

from ..config import (
    REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET,
    REDDIT_PASSWORD,
    REDDIT_REFRESH_TOKEN,
    REDDIT_REQUEST_LIMIT,
    REDDIT_SUBREDDITS,
    REDDIT_USER_AGENT,
    REDDIT_USERNAME,
)
from .base import BaseConnector, ConnectorWarning, FetchResult, RawPayload

logger = logging.getLogger(__name__)

_DEFAULT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
_DEFAULT_API_BASE_URL = "https://oauth.reddit.com"


@dataclass(slots=True)
class _AccessToken:
    token: str
    expires_at: float
    auth_mode: str


def _default_subreddits() -> list[str]:
    return [item.strip() for item in REDDIT_SUBREDDITS.split(",") if item.strip()]


class RedditMentionsConnector(BaseConnector):
    name = "reddit_mentions"
    cadence_seconds = 3600
    source_tier = 2
    fetch_strategy = "incremental"

    def __init__(
        self,
        subreddits: list[str] | None = None,
        *,
        request_limit: int | None = None,
        user_agent: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        username: str | None = None,
        password: str | None = None,
        refresh_token: str | None = None,
        token_url: str = _DEFAULT_TOKEN_URL,
        api_base_url: str = _DEFAULT_API_BASE_URL,
        timeout_seconds: float = 15.0,
        sleep_fn: Callable[[float], asyncio.Future] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.subreddits = subreddits or _default_subreddits()
        self.request_limit = request_limit or REDDIT_REQUEST_LIMIT
        self.user_agent = user_agent or REDDIT_USER_AGENT
        self.client_id = client_id or REDDIT_CLIENT_ID
        self.client_secret = client_secret or REDDIT_CLIENT_SECRET
        self.username = username or REDDIT_USERNAME
        self.password = password or REDDIT_PASSWORD
        self.refresh_token = refresh_token or REDDIT_REFRESH_TOKEN
        self.token_url = token_url
        self.api_base_url = api_base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.sleep_fn = sleep_fn or asyncio.sleep
        self.transport = transport
        self._token_cache: _AccessToken | None = None

    async def fetch(self) -> list[RawPayload] | FetchResult:
        payloads: list[RawPayload] = []
        warnings: list[ConnectorWarning] = []

        token = await self._get_access_token()
        if token is None:
            return FetchResult(
                payloads=[],
                warnings=[
                    ConnectorWarning(
                        kind="auth_not_configured",
                        target=self.name,
                        message="Reddit OAuth credentials are not configured; skipping reddit pull.",
                        recoverable=False,
                    )
                ],
            )

        headers = {
            "User-Agent": self.user_agent,
            "Authorization": f"Bearer {token.token}",
        }

        async with httpx.AsyncClient(
            headers=headers,
            timeout=self.timeout_seconds,
            transport=self.transport,
        ) as client:
            for subreddit in self.subreddits:
                url = f"{self.api_base_url}/r/{subreddit}/hot"
                try:
                    resp = await client.get(url, params={"limit": self.request_limit})
                    if resp.status_code == 429:
                        warnings.append(
                            ConnectorWarning(
                                kind="rate_limited",
                                target=subreddit,
                                message=f"Reddit rate limited r/{subreddit}; backing off and stopping this run.",
                            )
                        )
                        break
                    resp.raise_for_status()
                    data = resp.json()
                    children = data.get("data", {}).get("children", [])
                    rate_limit = self._rate_limit_snapshot(resp)
                    for child in children:
                        post = child.get("data", {})
                        payloads.append(
                            RawPayload(
                                source=self.name,
                                data=post,
                                request_params={
                                    "subreddit": subreddit,
                                    "limit": self.request_limit,
                                    "auth_mode": token.auth_mode,
                                    **rate_limit,
                                },
                                url_or_ref=f"https://www.reddit.com{post.get('permalink', '')}",
                            )
                        )

                    await self._maybe_backoff(resp)
                except httpx.HTTPStatusError as exc:
                    status_code = exc.response.status_code
                    kind = self._http_warning_kind(status_code)
                    warnings.append(
                        ConnectorWarning(
                            kind=kind,
                            target=subreddit,
                            message=f"Failed to fetch r/{subreddit}: HTTP {status_code}",
                        )
                    )
                    logger.exception("Failed to fetch r/%s", subreddit)
                    if status_code in {401, 403}:
                        break
                except Exception as exc:
                    warnings.append(
                        ConnectorWarning(
                            kind="fetch_failed",
                            target=subreddit,
                            message=f"Failed to fetch r/{subreddit}: {exc}",
                        )
                    )
                    logger.exception("Failed to fetch r/%s", subreddit)

        if warnings:
            return FetchResult(payloads=payloads, warnings=warnings)
        return payloads

    def readiness(self) -> tuple[str, str | None]:
        auth_payload, _auth_mode = self._build_auth_payload()
        if not self.client_id or auth_payload is None:
            return "missing_credentials", "Reddit OAuth credentials are not configured."
        return "ready", None

    def payload_identity(self, payload: RawPayload) -> str | None:
        data = payload.data if isinstance(payload.data, dict) else {}
        identifier = str(data.get("name") or data.get("id") or "").strip()
        return identifier or None

    async def _get_access_token(self) -> _AccessToken | None:
        if self._token_cache is not None and self._token_cache.expires_at > time.time() + 30:
            return self._token_cache

        auth_payload, auth_mode = self._build_auth_payload()
        if auth_payload is None or not self.client_id:
            return None

        headers = {"User-Agent": self.user_agent}
        auth = httpx.BasicAuth(self.client_id, self.client_secret or "")
        async with httpx.AsyncClient(
            headers=headers,
            timeout=self.timeout_seconds,
            transport=self.transport,
        ) as client:
            resp = await client.post(self.token_url, data=auth_payload, auth=auth)
            resp.raise_for_status()
            data = resp.json()

        access_token = str(data.get("access_token") or "").strip()
        expires_in = int(data.get("expires_in") or 3600)
        if not access_token:
            raise RuntimeError("Reddit OAuth response did not include access_token")

        self._token_cache = _AccessToken(
            token=access_token,
            expires_at=time.time() + max(60, expires_in),
            auth_mode=auth_mode,
        )
        return self._token_cache

    def _build_auth_payload(self) -> tuple[dict[str, str] | None, str]:
        if self.refresh_token:
            return {
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
            }, "oauth_refresh"

        if self.username and self.password:
            return {
                "grant_type": "password",
                "username": self.username,
                "password": self.password,
            }, "oauth_password"

        return None, "unconfigured"

    def _http_warning_kind(self, status_code: int) -> str:
        if status_code == 401:
            return "auth_failed"
        if status_code == 403:
            return "http_403_blocked"
        if status_code == 429:
            return "rate_limited"
        return f"http_{status_code}"

    def _rate_limit_snapshot(self, response: httpx.Response) -> dict[str, int]:
        snapshot: dict[str, int] = {}
        for header, key in (
            ("x-ratelimit-used", "ratelimit_used"),
            ("x-ratelimit-remaining", "ratelimit_remaining"),
            ("x-ratelimit-reset", "ratelimit_reset_seconds"),
        ):
            raw = response.headers.get(header)
            if raw is None:
                continue
            try:
                snapshot[key] = int(float(raw))
            except ValueError:
                continue
        return snapshot

    async def _maybe_backoff(self, response: httpx.Response) -> None:
        remaining = response.headers.get("x-ratelimit-remaining")
        reset_seconds = response.headers.get("x-ratelimit-reset")
        try:
            remaining_value = float(remaining) if remaining is not None else None
            reset_value = float(reset_seconds) if reset_seconds is not None else None
        except ValueError:
            return
        if remaining_value is None or reset_value is None:
            return
        if remaining_value > 1:
            return
        await self.sleep_fn(min(max(reset_value, 0.0), 2.0))
