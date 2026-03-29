from src.connectors.base import BaseConnector
from src.sources.defaults import build_default_sources
from src.sources.manifests import get_checked_in_source_manifest_dir


class _Connector(BaseConnector):
    def __init__(self, name: str, cadence_seconds: int, source_tier: int) -> None:
        self.name = name
        self.cadence_seconds = cadence_seconds
        self.source_tier = source_tier

    async def fetch(self):  # pragma: no cover - not used here
        return []


def test_build_default_sources_loads_checked_in_manifest_examples():
    connectors = {
        "app_store_top_charts": _Connector("app_store_top_charts", 3600, 1),
        "google_trends": _Connector("google_trends", 3600, 2),
        "hackernews": _Connector("hackernews", 3600, 2),
        "naver_datalab": _Connector("naver_datalab", 43200, 1),
        "polymarket_markets": _Connector("polymarket_markets", 3600, 2),
        "reddit_mentions": _Connector("reddit_mentions", 900, 2),
        "similarweb_movers": _Connector("similarweb_movers", 3600, 2),
        "steamdb_top_sellers": _Connector("steamdb_top_sellers", 3600, 2),
        "tiktok_creative_center": _Connector("tiktok_creative_center", 3600, 2),
    }

    defaults = {source.source_id: source for source in build_default_sources(connectors)}

    app_store = defaults["app_store_top_charts"]
    google_trends = defaults["google_trends"]
    hackernews = defaults["hackernews"]
    naver_datalab = defaults["naver_datalab"]
    polymarket_markets = defaults["polymarket_markets"]
    reddit_mentions = defaults["reddit_mentions"]
    similarweb_movers = defaults["similarweb_movers"]
    steamdb_top_sellers = defaults["steamdb_top_sellers"]
    tiktok_creative_center = defaults["tiktok_creative_center"]
    agent_evidence = defaults["agent_evidence"]

    assert get_checked_in_source_manifest_dir().name == "manifests"
    assert app_store.capabilities == ["demand", "ranking", "validation"]
    assert app_store.enabled is True
    assert app_store.manifest_path is not None
    assert google_trends.capabilities == ["demand", "ranking", "validation"]
    assert google_trends.request_kinds_supported == ["run_source"]
    assert google_trends.normalizer_key == "google_trends"
    assert google_trends.manifest_path is not None
    assert google_trends.enabled is True
    assert google_trends.agent_enabled is True
    assert google_trends.agent_prompt_path is not None
    assert google_trends.agent_session_domain == "source-agent:google_trends"
    assert google_trends.cadence_seconds == 3600
    assert google_trends.runnable is True
    assert hackernews.capabilities == ["demand", "validation"]
    assert hackernews.fetch_strategy == "incremental"
    assert hackernews.enabled is True
    assert hackernews.agent_prompt_path is not None
    assert hackernews.agent_session_domain == "source-agent:hackernews"
    assert naver_datalab.capabilities == ["demand", "ranking", "validation"]
    assert naver_datalab.enabled is False
    assert polymarket_markets.capabilities == ["pricing", "validation"]
    assert polymarket_markets.fetch_strategy == "full_snapshot"
    assert polymarket_markets.enabled is True
    assert polymarket_markets.agent_prompt_path is not None
    assert polymarket_markets.agent_session_domain == "source-agent:polymarket_markets"
    assert reddit_mentions.fetch_strategy == "incremental"
    assert reddit_mentions.enabled is True
    assert similarweb_movers.capabilities == ["demand", "ranking", "validation"]
    assert similarweb_movers.enabled is True
    assert steamdb_top_sellers.capabilities == ["demand", "ranking", "validation"]
    assert steamdb_top_sellers.enabled is True
    assert tiktok_creative_center.enabled is False
    assert "disabled" in (tiktok_creative_center.description or "").lower()
    assert agent_evidence.capabilities == [
        "demand",
        "pricing",
        "supply",
        "monetization",
        "beneficiary",
        "validation",
    ]
    assert agent_evidence.request_kinds_supported == ["submit_agent_evidence"]
    assert agent_evidence.normalizer_key is None
    assert agent_evidence.agent_enabled is True
    assert agent_evidence.agent_prompt_path is not None


def test_build_default_sources_supports_custom_manifest_dir(tmp_path):
    manifest_dir = tmp_path / "manifests"
    manifest_dir.mkdir()
    (manifest_dir / "alpha.json").write_text(
        """
        {
          "source_id": "alpha",
          "kind": "pull",
          "ingestion_mode": "raw",
          "adapter_name": "alpha",
          "configured_tier": 1,
          "description": "custom alpha",
          "capabilities": ["pricing"],
          "request_kinds_supported": ["run_source"],
          "normalizer_key": "alpha"
        }
        """.strip(),
        encoding="utf-8",
    )

    connectors = {"alpha": _Connector("alpha", 7200, 3)}
    defaults = {source.source_id: source for source in build_default_sources(connectors, manifest_dir=str(manifest_dir))}
    alpha = defaults["alpha"]

    assert alpha.configured_tier == 1
    assert alpha.effective_tier == 1
    assert alpha.cadence_seconds == 7200
    assert alpha.capabilities == ["pricing"]
    assert alpha.normalizer_key == "alpha"
    assert alpha.manifest_path is not None
    assert alpha.agent_enabled is True
    assert alpha.agent_prompt_path is not None
