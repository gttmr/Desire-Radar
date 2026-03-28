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
        "google_trends": _Connector("google_trends", 3600, 2),
        "reddit_mentions": _Connector("reddit_mentions", 900, 2),
    }

    defaults = {source.source_id: source for source in build_default_sources(connectors)}

    google_trends = defaults["google_trends"]
    agent_evidence = defaults["agent_evidence"]

    assert get_checked_in_source_manifest_dir().name == "manifests"
    assert google_trends.capabilities == ["demand", "validation"]
    assert google_trends.request_kinds_supported == ["run_source"]
    assert google_trends.normalizer_key == "google_trends"
    assert google_trends.manifest_path is not None
    assert google_trends.agent_enabled is True
    assert google_trends.agent_prompt_path is not None
    assert google_trends.agent_session_domain == "source-agent:google_trends"
    assert google_trends.cadence_seconds == 3600
    assert google_trends.runnable is True
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
