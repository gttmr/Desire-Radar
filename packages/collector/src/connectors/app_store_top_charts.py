"""Fetch App Store Top Charts via Apple's public RSS feed."""

import logging

import httpx

from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)

TOP_FREE_URL = (
    "https://rss.applemarketingtools.com/api/v2/kr/apps/top-free/25/apps.json"
)
TOP_PAID_URL = (
    "https://rss.applemarketingtools.com/api/v2/kr/apps/top-paid/25/apps.json"
)


class AppStoreTopChartsConnector(BaseConnector):
    name = "app_store_top_charts"
    cadence_seconds = 3600
    source_tier = 1

    async def fetch(self) -> list[RawPayload]:
        payloads: list[RawPayload] = []

        charts = [
            ("top-free", TOP_FREE_URL),
            ("top-paid", TOP_PAID_URL),
        ]

        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            for chart_type, url in charts:
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    data = resp.json()

                    feed = data.get("feed", {})
                    results = feed.get("results", [])

                    for position, app in enumerate(results, start=1):
                        app_name = app.get("name", "")
                        artist = app.get("artistName", "")
                        genres = [
                            g.get("name", "")
                            for g in app.get("genres", [])
                        ]
                        app_url = app.get("url", "")
                        artwork_url = app.get("artworkUrl100", "")
                        app_id = app.get("id", "")

                        payloads.append(
                            RawPayload(
                                source=self.name,
                                data={
                                    "app_id": app_id,
                                    "name": app_name,
                                    "artist": artist,
                                    "genres": genres,
                                    "artwork_url": artwork_url,
                                    "chart_type": chart_type,
                                    "position": position,
                                    "release_date": app.get("releaseDate", ""),
                                },
                                request_params={
                                    "chart_type": chart_type,
                                    "country": "kr",
                                    "limit": 25,
                                },
                                url_or_ref=app_url or url,
                            )
                        )

                    logger.info(
                        "Fetched %d apps from %s chart", len(results), chart_type
                    )

                except httpx.HTTPStatusError as exc:
                    logger.warning(
                        "HTTP %d fetching %s chart: %s",
                        exc.response.status_code,
                        chart_type,
                        exc,
                    )
                except Exception:
                    logger.exception("Failed to fetch %s chart", chart_type)

        return payloads
