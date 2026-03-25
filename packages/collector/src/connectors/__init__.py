"""Connector registry for pull-based data sources."""

from .reddit_mentions import RedditMentionsConnector
from .google_trends import GoogleTrendsConnector
from .naver_datalab import NaverDatalabConnector
from .app_store_top_charts import AppStoreTopChartsConnector
from .steamdb_top_sellers import SteamdbTopSellersConnector
from .tiktok_creative_center import TiktokCreativeCenterConnector
from .similarweb_movers import SimilarwebMoversConnector
from .base import BaseConnector


def build_connector_registry(
    data_dir: str = "data",
) -> dict[str, BaseConnector]:
    """Return a dict mapping connector name to connector instance."""
    connectors: list[BaseConnector] = [
        RedditMentionsConnector(),
        GoogleTrendsConnector(),
        NaverDatalabConnector(),
        AppStoreTopChartsConnector(),
        SteamdbTopSellersConnector(),
        TiktokCreativeCenterConnector(),
        SimilarwebMoversConnector(),
    ]
    return {c.name: c for c in connectors}
