"""Fetch trending posts from specified subreddits using public JSON API."""

import logging

import httpx

from ..config import REDDIT_USER_AGENT
from .base import BaseConnector, ConnectorWarning, FetchResult, RawPayload

logger = logging.getLogger(__name__)

DEFAULT_SUBREDDITS = [
    "technology",
    "gadgets",
    "gaming",
    "apps",
    "business",
]


class RedditMentionsConnector(BaseConnector):
    name = "reddit_mentions"
    cadence_seconds = 3600
    source_tier = 2

    def __init__(self, subreddits: list[str] | None = None) -> None:
        self.subreddits = subreddits or DEFAULT_SUBREDDITS

    async def fetch(self) -> list[RawPayload] | FetchResult:
        payloads: list[RawPayload] = []
        warnings: list[ConnectorWarning] = []
        headers = {"User-Agent": REDDIT_USER_AGENT}

        async with httpx.AsyncClient(headers=headers, timeout=15.0) as client:
            for subreddit in self.subreddits:
                url = f"https://www.reddit.com/r/{subreddit}/hot.json?limit=25"
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    data = resp.json()
                    children = data.get("data", {}).get("children", [])
                    for child in children:
                        post = child.get("data", {})
                        payloads.append(
                            RawPayload(
                                source=self.name,
                                data=post,
                                request_params={
                                    "subreddit": subreddit,
                                    "limit": 25,
                                },
                                url_or_ref=f"https://www.reddit.com{post.get('permalink', '')}",
                            )
                        )
                except httpx.HTTPStatusError as exc:
                    status_code = exc.response.status_code
                    kind = (
                        f"http_{status_code}_blocked"
                        if status_code == 403
                        else f"http_{status_code}"
                    )
                    warnings.append(
                        ConnectorWarning(
                            kind=kind,
                            target=subreddit,
                            message=f"Failed to fetch r/{subreddit}: HTTP {status_code}",
                        )
                    )
                    logger.exception("Failed to fetch r/%s", subreddit)
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
