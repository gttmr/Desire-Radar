"""TikTok trending data connector — uses public embed endpoints."""

import logging
import re

import httpx

from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)

# Public TikTok trending page (no auth required)
TRENDING_PAGE_URL = "https://www.tiktok.com/api/trending/item/list/"
# Fallback: discover page
DISCOVER_URL = "https://www.tiktok.com/node/share/discover"


class TiktokCreativeCenterConnector(BaseConnector):
    name = "tiktok_creative_center"
    cadence_seconds = 3600
    source_tier = 2

    async def fetch(self) -> list[RawPayload]:
        payloads: list[RawPayload] = []

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json, text/plain, */*",
        }

        async with httpx.AsyncClient(
            headers=headers, timeout=25.0, follow_redirects=True
        ) as client:
            # Try TikTok discover/trending endpoint
            await self._fetch_discover(client, payloads)

            # Try Creative Center API (may fail with 401)
            await self._fetch_creative_center(client, payloads)

        logger.info("tiktok_creative_center collected %d payloads", len(payloads))
        return payloads

    async def _fetch_discover(
        self, client: httpx.AsyncClient, payloads: list[RawPayload]
    ) -> None:
        """Fetch from TikTok discover page (public, no auth)."""
        try:
            # noIndex=1 gives JSON response for some regions
            params = {"noUser": 1, "userCount": 30, "scene": 0}
            resp = await client.get(DISCOVER_URL, params=params)

            if resp.status_code != 200:
                logger.info(
                    "TikTok discover returned %d, trying HTML parse",
                    resp.status_code,
                )
                return

            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}

            # Parse user list from discover
            user_list = body.get("body", body).get("userInfoList", [])
            for rank, item in enumerate(user_list[:30], start=1):
                user = item.get("subTitle", "") or item.get("title", "")
                desc = item.get("description", "")
                payloads.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "type": "discover_creator",
                            "nickname": user,
                            "description": desc,
                            "rank": rank,
                        },
                        request_params={"scene": 0},
                        url_or_ref=f"https://www.tiktok.com/@{user}" if user else DISCOVER_URL,
                    )
                )

            # Parse keyword/hashtag list
            keyword_list = body.get("body", body).get("keywordList", [])
            for rank, item in enumerate(keyword_list[:50], start=1):
                keyword = item.get("keyword", "") or item.get("title", "")
                if not keyword:
                    continue
                payloads.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "type": "discover_keyword",
                            "hashtag_name": keyword,
                            "rank": rank,
                        },
                        request_params={"scene": 0},
                        url_or_ref=f"https://www.tiktok.com/tag/{keyword}",
                    )
                )

            if user_list or keyword_list:
                logger.info(
                    "Fetched %d creators + %d keywords from TikTok discover",
                    len(user_list),
                    len(keyword_list),
                )

        except Exception:
            logger.warning("TikTok discover fetch failed", exc_info=True)

    async def _fetch_creative_center(
        self, client: httpx.AsyncClient, payloads: list[RawPayload]
    ) -> None:
        """Try the Creative Center API — requires no auth for some endpoints."""
        hashtag_url = "https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list"
        params = {
            "page": 1,
            "limit": 50,
            "period": 7,
            "country_code": "KR",
            "sort_by": "popular",
        }

        try:
            resp = await client.get(
                hashtag_url,
                params=params,
                headers={"Referer": "https://ads.tiktok.com/business/creativecenter/"},
            )

            if resp.status_code in (401, 403):
                logger.info("TikTok Creative Center requires auth — skipping")
                return

            resp.raise_for_status()
            body = resp.json()

            code = body.get("code", -1)
            if code != 0:
                logger.info(
                    "TikTok Creative Center code=%s — skipping", code
                )
                return

            items = body.get("data", {}).get("list", [])
            for rank, item in enumerate(items, start=1):
                hashtag_name = item.get("hashtag_name", "") or item.get("name", "")
                payloads.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "type": "hashtag",
                            "hashtag_name": hashtag_name,
                            "video_count": item.get("video_count", 0),
                            "view_count": item.get("publish_cnt", 0)
                            or item.get("video_views", 0),
                            "trend_direction": item.get("trend", 0),
                            "rank": rank,
                        },
                        request_params={"period": 7, "country_code": "KR"},
                        url_or_ref=f"https://www.tiktok.com/tag/{hashtag_name}" if hashtag_name else hashtag_url,
                    )
                )

            logger.info("Fetched %d hashtags from TikTok Creative Center", len(items))

        except httpx.HTTPStatusError:
            logger.info("TikTok Creative Center API unavailable")
        except Exception:
            logger.warning("TikTok Creative Center fetch failed", exc_info=True)
