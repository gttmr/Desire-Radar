"""Connector registry for pull-based data sources."""

from .app_store_top_charts import AppStoreTopChartsConnector
from .base import BaseConnector
from .google_trends import GoogleTrendsConnector
from .hackernews import HackerNewsConnector
from .naver_datalab import NaverDatalabConnector
from .polymarket_markets import PolymarketMarketsConnector
from .reddit_mentions import RedditMentionsConnector
from .similarweb_movers import SimilarwebMoversConnector
from .steamdb_top_sellers import SteamdbTopSellersConnector
from .tiktok_creative_center import TiktokCreativeCenterConnector


def build_connector_registry(
    data_dir: str = "data",
) -> dict[str, BaseConnector]:
    """Return a dict mapping connector name to connector instance."""
    connectors: list[BaseConnector] = [
        RedditMentionsConnector(),
        GoogleTrendsConnector(),
        HackerNewsConnector(),
        NaverDatalabConnector(),
        AppStoreTopChartsConnector(),
        PolymarketMarketsConnector(),
        SteamdbTopSellersConnector(),
        TiktokCreativeCenterConnector(),
        SimilarwebMoversConnector(),
    ]
    return {c.name: c for c in connectors}
