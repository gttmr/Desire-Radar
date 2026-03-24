"""Steam Top Sellers connector — fetches featured categories and top sellers."""

import logging
from datetime import datetime

import httpx

from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)

FEATURED_CATEGORIES_URL = "https://store.steampowered.com/api/featuredcategories/"
MOST_PLAYED_URL = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/"


class SteamdbTopSellersConnector(BaseConnector):
    name = "steamdb_top_sellers"
    cadence_seconds = 3600  # 1h
    source_tier = 2

    async def fetch(self) -> list[RawPayload]:
        payloads: list[RawPayload] = []

        async with httpx.AsyncClient(timeout=20.0) as client:
            # 1) Featured categories — top sellers
            top_sellers = await self._fetch_top_sellers(client)
            payloads.extend(top_sellers)

            # 2) Most played games
            most_played = await self._fetch_most_played(client)
            payloads.extend(most_played)

        logger.info("steamdb_top_sellers collected %d payloads", len(payloads))
        return payloads

    # ------------------------------------------------------------------
    # Top Sellers from featured categories
    # ------------------------------------------------------------------

    async def _fetch_top_sellers(
        self, client: httpx.AsyncClient
    ) -> list[RawPayload]:
        results: list[RawPayload] = []
        try:
            resp = await client.get(FEATURED_CATEGORIES_URL)
            resp.raise_for_status()
            data = resp.json()

            # The response has numeric keys; "top_sellers" is typically under key "top_sellers"
            # or embedded inside one of the category objects.
            top_sellers_section = data.get("top_sellers", {})
            items = top_sellers_section.get("items", [])

            if not items:
                # Fallback: iterate all categories looking for items
                for key, value in data.items():
                    if isinstance(value, dict) and "items" in value:
                        cat_name = value.get("name", key)
                        if "seller" in cat_name.lower() or "top" in cat_name.lower():
                            items = value["items"]
                            break

            for position, item in enumerate(items, start=1):
                app_id = item.get("id")
                name = item.get("name", "Unknown")
                price_raw = item.get("final_price", 0)  # in cents
                original_price = item.get("original_price", 0)
                discount_pct = item.get("discount_percent", 0)
                large_capsule = item.get("large_capsule_image", "")

                results.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "title": name,
                            "app_id": app_id,
                            "price_cents": price_raw,
                            "original_price_cents": original_price,
                            "discount_percent": discount_pct,
                            "position": position,
                            "image_url": large_capsule,
                            "type": "top_seller",
                            "fetched_at": datetime.utcnow().isoformat(),
                        },
                        request_params={"type": "top_sellers"},
                        url_or_ref=f"https://store.steampowered.com/app/{app_id}",
                    )
                )
        except Exception:
            logger.exception("Failed to fetch Steam featured categories / top sellers")

        return results

    # ------------------------------------------------------------------
    # Most Played Games
    # ------------------------------------------------------------------

    async def _fetch_most_played(
        self, client: httpx.AsyncClient
    ) -> list[RawPayload]:
        results: list[RawPayload] = []
        try:
            resp = await client.get(MOST_PLAYED_URL)
            resp.raise_for_status()
            data = resp.json()

            ranks = data.get("response", {}).get("ranks", [])
            for position, entry in enumerate(ranks, start=1):
                app_id = entry.get("appid")
                peak_in_game = entry.get("peak_in_game", 0)
                current_in_game = entry.get("last_week_avg", 0)

                results.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "title": f"appid:{app_id}",  # name resolved downstream
                            "app_id": app_id,
                            "peak_in_game": peak_in_game,
                            "current_in_game": current_in_game,
                            "position": position,
                            "type": "most_played",
                            "fetched_at": datetime.utcnow().isoformat(),
                        },
                        request_params={"type": "most_played"},
                        url_or_ref=f"https://store.steampowered.com/app/{app_id}",
                    )
                )
        except Exception:
            logger.exception("Failed to fetch Steam most played games")

        return results
