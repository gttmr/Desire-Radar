"""Google Trends connector — fetches daily trending searches via pytrends."""

import asyncio
import logging
from datetime import datetime

from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)

GEOS = ["KR", "US"]


class GoogleTrendsConnector(BaseConnector):
    name = "google_trends"
    cadence_seconds = 21600  # 6h
    source_tier = 1

    def readiness(self) -> tuple[str, str | None]:
        try:
            from pytrends.request import TrendReq  # noqa: F401
        except ImportError:
            return "dependency_missing", "pytrends is not installed."
        return "ready", None

    async def fetch(self) -> list[RawPayload]:
        payloads: list[RawPayload] = []

        try:
            from pytrends.request import TrendReq  # noqa: F401
        except ImportError:
            logger.error("pytrends is not installed — skipping google_trends")
            return []

        loop = asyncio.get_running_loop()

        for geo in GEOS:
            try:
                daily = await loop.run_in_executor(
                    None, self._fetch_daily_trends, geo
                )
                payloads.extend(daily)
            except Exception:
                logger.exception(
                    "Failed to fetch daily trending searches for geo=%s", geo
                )

            # Interest over time for key topics
            try:
                interest = await loop.run_in_executor(
                    None, self._fetch_interest_over_time, geo
                )
                payloads.extend(interest)
            except Exception:
                logger.exception(
                    "Failed to fetch interest over time for geo=%s", geo
                )

        logger.info("google_trends collected %d payloads", len(payloads))
        return payloads

    # ------------------------------------------------------------------
    # Synchronous helpers (run inside executor)
    # ------------------------------------------------------------------

    @staticmethod
    def _fetch_daily_trends(geo: str) -> list[RawPayload]:
        from pytrends.request import TrendReq

        pytrends = TrendReq(
            hl="ko" if geo == "KR" else "en-US",
            tz=540 if geo == "KR" else 360,
        )
        df = pytrends.trending_searches(pn=_pn_for_geo(geo))

        results: list[RawPayload] = []
        for idx, row in df.iterrows():
            title = str(row.iloc[0]) if hasattr(row, "iloc") else str(row[0])
            results.append(
                RawPayload(
                    source="google_trends",
                    data={
                        "title": title,
                        "traffic_volume": None,
                        "related_queries": [],
                        "type": "daily_trending",
                        "geo": geo,
                        "rank": int(idx) + 1,
                        "fetched_at": datetime.utcnow().isoformat(),
                    },
                    request_params={"geo": geo, "type": "daily_trending"},
                    url_or_ref=f"https://trends.google.com/trending?geo={geo}",
                )
            )
        return results

    @staticmethod
    def _fetch_interest_over_time(geo: str) -> list[RawPayload]:
        """Fetch interest over time for key topics to detect rising trends."""
        from pytrends.request import TrendReq

        pytrends = TrendReq(
            hl="ko" if geo == "KR" else "en-US",
            tz=540 if geo == "KR" else 360,
        )

        # Track popular categories by geo
        keyword_groups = {
            "KR": [
                ["ChatGPT", "AI", "클로드"],
                ["비트코인", "이더리움", "솔라나"],
                ["넷플릭스", "디즈니플러스", "유튜브"],
                ["쿠팡", "네이버쇼핑", "무신사"],
                ["스팀", "닌텐도", "PS5"],
            ],
            "US": [
                ["ChatGPT", "AI", "Claude"],
                ["Bitcoin", "Ethereum", "Solana"],
                ["Netflix", "Disney+", "YouTube"],
                ["Amazon", "TikTok Shop", "Shein"],
                ["Steam", "Nintendo", "PS5"],
            ],
        }

        results: list[RawPayload] = []
        groups = keyword_groups.get(geo, keyword_groups["US"])

        for group in groups:
            try:
                pytrends.build_payload(group, cat=0, timeframe="now 7-d", geo=geo)
                df = pytrends.interest_over_time()
                if df.empty:
                    continue

                for keyword in group:
                    if keyword not in df.columns:
                        continue
                    series = df[keyword]
                    current = float(series.iloc[-1]) if len(series) > 0 else 0
                    avg = float(series.mean()) if len(series) > 0 else 0
                    delta = current - avg if avg > 0 else 0

                    results.append(
                        RawPayload(
                            source="google_trends",
                            data={
                                "title": keyword,
                                "traffic_volume": current,
                                "metric_delta": round(delta, 2),
                                "average_7d": round(avg, 2),
                                "related_queries": [],
                                "type": "interest_over_time",
                                "geo": geo,
                                "rank": None,
                                "fetched_at": datetime.utcnow().isoformat(),
                            },
                            request_params={
                                "geo": geo,
                                "type": "interest_over_time",
                                "keywords": group,
                            },
                            url_or_ref=f"https://trends.google.com/trends/explore?geo={geo}&q={keyword}",
                        )
                    )
            except Exception:
                logger.warning(
                    "interest_over_time failed for group=%s geo=%s", group, geo
                )

        return results


def _pn_for_geo(geo: str) -> str:
    """Map ISO geo code to pytrends pn parameter."""
    mapping = {
        "KR": "south_korea",
        "US": "united_states",
        "JP": "japan",
    }
    return mapping.get(geo, "united_states")
