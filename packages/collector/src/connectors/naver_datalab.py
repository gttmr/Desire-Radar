"""Naver DataLab connector — Shopping Insight + Search Trend APIs."""

import logging
from datetime import datetime, timedelta

import httpx

from ..config import NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)

# Predefined keyword groups for search trend tracking
KEYWORD_GROUPS = [
    {"groupName": "AI_ChatGPT", "keywords": ["AI", "ChatGPT"]},
    {"groupName": "게임_스팀", "keywords": ["게임", "스팀"]},
    {"groupName": "투자_주식", "keywords": ["투자", "주식"]},
    {"groupName": "건강_다이어트", "keywords": ["건강", "다이어트"]},
    {"groupName": "패션_명품", "keywords": ["패션", "명품"]},
]

# Top-level Naver Shopping categories to track
SHOPPING_CATEGORY_IDS = [
    "50000000",  # 패션의류
    "50000001",  # 패션잡화
    "50000002",  # 화장품/미용
    "50000003",  # 디지털/가전
    "50000004",  # 가구/인테리어
    "50000005",  # 출산/육아
    "50000006",  # 식품
    "50000007",  # 스포츠/레저
    "50000008",  # 생활/건강
    "50000009",  # 여가/생활편의
]

NAVER_HEADERS_TEMPLATE = {
    "Content-Type": "application/json",
}


class NaverDatalabConnector(BaseConnector):
    name = "naver_datalab"
    cadence_seconds = 43200  # 12h
    source_tier = 1

    def readiness(self) -> tuple[str, str | None]:
        if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
            return "missing_credentials", "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not set."
        return "ready", None

    async def fetch(self) -> list[RawPayload]:
        if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
            logger.warning(
                "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not set — skipping naver_datalab"
            )
            return []

        payloads: list[RawPayload] = []
        headers = {
            **NAVER_HEADERS_TEMPLATE,
            "X-Naver-Client-Id": NAVER_CLIENT_ID,
            "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
        }

        async with httpx.AsyncClient(headers=headers, timeout=20.0) as client:
            # 1) Shopping Insight — category trends
            shopping_payloads = await self._fetch_shopping_categories(client)
            payloads.extend(shopping_payloads)

            # 2) Search Trend — keyword groups
            search_payloads = await self._fetch_search_trends(client)
            payloads.extend(search_payloads)

        logger.info("naver_datalab collected %d payloads", len(payloads))
        return payloads

    # ------------------------------------------------------------------
    # Shopping Insight API
    # ------------------------------------------------------------------

    async def _fetch_shopping_categories(
        self, client: httpx.AsyncClient
    ) -> list[RawPayload]:
        url = "https://openapi.naver.com/v1/datalab/shopping/categories"
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=30)

        body = {
            "startDate": start_date.strftime("%Y-%m-%d"),
            "endDate": end_date.strftime("%Y-%m-%d"),
            "timeUnit": "week",
            "category": [
                {"name": cat_id, "param": [cat_id]}
                for cat_id in SHOPPING_CATEGORY_IDS
            ],
        }

        results: list[RawPayload] = []
        try:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()

            for cat_result in data.get("results", []):
                cat_name = cat_result.get("title", "unknown")
                data_points = cat_result.get("data", [])
                # Get most recent data point's ratio as the trend value
                latest = data_points[-1] if data_points else {}
                results.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "category": cat_name,
                            "latest_ratio": latest.get("ratio"),
                            "latest_period": latest.get("period"),
                            "trend_data": data_points,
                            "type": "shopping_category_trend",
                            "fetched_at": datetime.utcnow().isoformat(),
                        },
                        request_params={
                            "startDate": body["startDate"],
                            "endDate": body["endDate"],
                            "category": cat_name,
                        },
                        url_or_ref=url,
                    )
                )
        except Exception:
            logger.exception("Failed to fetch Naver shopping category trends")

        return results

    # ------------------------------------------------------------------
    # Search Trend API
    # ------------------------------------------------------------------

    async def _fetch_search_trends(
        self, client: httpx.AsyncClient
    ) -> list[RawPayload]:
        url = "https://openapi.naver.com/v1/datalab/search"
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=30)

        keyword_groups_body = [
            {"groupName": grp["groupName"], "keywords": grp["keywords"]}
            for grp in KEYWORD_GROUPS
        ]

        body = {
            "startDate": start_date.strftime("%Y-%m-%d"),
            "endDate": end_date.strftime("%Y-%m-%d"),
            "timeUnit": "week",
            "keywordGroups": keyword_groups_body,
        }

        results: list[RawPayload] = []
        try:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()

            for grp_result in data.get("results", []):
                grp_title = grp_result.get("title", "unknown")
                keywords = grp_result.get("keywords", [])
                data_points = grp_result.get("data", [])
                latest = data_points[-1] if data_points else {}

                results.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "group_name": grp_title,
                            "keywords": keywords,
                            "latest_ratio": latest.get("ratio"),
                            "latest_period": latest.get("period"),
                            "trend_data": data_points,
                            "type": "search_trend",
                            "fetched_at": datetime.utcnow().isoformat(),
                        },
                        request_params={
                            "startDate": body["startDate"],
                            "endDate": body["endDate"],
                            "groupName": grp_title,
                        },
                        url_or_ref=url,
                    )
                )
        except Exception:
            logger.exception("Failed to fetch Naver search trends")

        return results
