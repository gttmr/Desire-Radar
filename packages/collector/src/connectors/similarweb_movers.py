"""Web traffic/domain ranking connector — uses public sources (Tranco, Umbrella)."""

import csv
import io
import logging
import zipfile

import httpx

from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)

# Tranco: research-grade domain ranking (updated daily, public, no auth)
TRANCO_TOP_URL = "https://tranco-list.eu/top-1m.csv.zip"
# Cisco Umbrella public top 1M (backup)
UMBRELLA_TOP_URL = "http://s3-us-west-1.amazonaws.com/umbrella-static/top-1m.csv.zip"

MAX_DOMAINS = 100


class SimilarwebMoversConnector(BaseConnector):
    name = "similarweb_movers"
    cadence_seconds = 3600
    source_tier = 2

    async def fetch(self) -> list[RawPayload]:
        payloads: list[RawPayload] = []

        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            # Primary: Tranco list
            tranco = await self._fetch_tranco(client)
            if tranco:
                payloads.extend(tranco)
            else:
                # Fallback: Cisco Umbrella
                umbrella = await self._fetch_umbrella(client)
                payloads.extend(umbrella)

        logger.info("similarweb_movers collected %d payloads", len(payloads))
        return payloads

    async def _fetch_tranco(self, client: httpx.AsyncClient) -> list[RawPayload]:
        """Download Tranco top-1M CSV zip and extract top N domains."""
        try:
            resp = await client.get(TRANCO_TOP_URL)
            resp.raise_for_status()

            return self._parse_csv_zip(resp.content, "tranco")

        except Exception:
            logger.warning("Failed to fetch Tranco list", exc_info=True)
            return []

    async def _fetch_umbrella(self, client: httpx.AsyncClient) -> list[RawPayload]:
        """Download Cisco Umbrella top-1M as fallback."""
        try:
            resp = await client.get(UMBRELLA_TOP_URL)
            resp.raise_for_status()

            return self._parse_csv_zip(resp.content, "umbrella")

        except Exception:
            logger.warning("Failed to fetch Umbrella list", exc_info=True)
            return []

    def _parse_csv_zip(self, content: bytes, source_name: str) -> list[RawPayload]:
        """Parse a zip file containing rank,domain CSV."""
        results: list[RawPayload] = []
        try:
            zf = zipfile.ZipFile(io.BytesIO(content))
            # Find the CSV file inside the zip
            csv_name = [n for n in zf.namelist() if n.endswith(".csv")][0]
            csv_data = zf.read(csv_name).decode("utf-8")

            reader = csv.reader(io.StringIO(csv_data))
            count = 0
            for row in reader:
                if count >= MAX_DOMAINS:
                    break
                if len(row) < 2:
                    continue
                rank = int(row[0])
                domain = row[1].strip()
                results.append(
                    RawPayload(
                        source=self.name,
                        data={
                            "domain": domain,
                            "rank": rank,
                            "list_type": source_name,
                            "category": _categorize_domain(domain),
                        },
                        request_params={"source": source_name, "limit": MAX_DOMAINS},
                        url_or_ref=f"https://{domain}",
                    )
                )
                count += 1

        except Exception:
            logger.warning("Failed to parse %s CSV zip", source_name, exc_info=True)

        return results


def _categorize_domain(domain: str) -> str:
    """Simple domain categorization based on known patterns."""
    categories = {
        "google": "search",
        "youtube": "video",
        "facebook": "social",
        "instagram": "social",
        "twitter": "social",
        "x.com": "social",
        "tiktok": "social",
        "reddit": "social",
        "amazon": "ecommerce",
        "coupang": "ecommerce",
        "naver": "search",
        "kakao": "messaging",
        "netflix": "entertainment",
        "disney": "entertainment",
        "spotify": "entertainment",
        "github": "developer",
        "openai": "ai",
        "anthropic": "ai",
        "chatgpt": "ai",
        "steam": "gaming",
        "twitch": "gaming",
        "apple": "tech",
        "microsoft": "tech",
    }
    domain_lower = domain.lower()
    for pattern, cat in categories.items():
        if pattern in domain_lower:
            return cat
    return "other"
