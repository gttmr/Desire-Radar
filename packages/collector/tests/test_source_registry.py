from src.sources.models import SourceDefinition
from src.sources.registry import SourceRegistry


def _defaults() -> list[SourceDefinition]:
    return [
        SourceDefinition(
            source_id="alpha",
            kind="pull",
            ingestion_mode="raw",
            configured_tier=2,
            effective_tier=2,
            enabled=True,
            adapter_name="alpha",
            default_producer_ref="alpha",
            cadence_seconds=300,
            runnable=True,
            scheduled=True,
            description="alpha source",
            capabilities=["demand"],
            request_kinds_supported=["run_source"],
            normalizer_key="alpha",
        ),
        SourceDefinition(
            source_id="human_analyst_note",
            kind="human",
            ingestion_mode="evidence",
            configured_tier=1,
            effective_tier=1,
            enabled=True,
            adapter_name="human_analyst_note",
            default_producer_ref="human",
            cadence_seconds=0,
            runnable=False,
            scheduled=False,
            description="human note",
            capabilities=["validation"],
            request_kinds_supported=["request_human_note"],
        ),
    ]


def test_source_registry_tier_override_is_persistent_and_advisory(tmp_path):
    registry = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    updated = registry.update_tier("alpha", 3, override_reason="manual downgrade")
    registry.record_submission("alpha")
    registry.record_processing(
        "alpha",
        success=False,
        snapshot_total=4,
        deduped_snapshot_total=3,
        entity_resolve_miss_total=4,
        is_submission=True,
    )

    reloaded = SourceRegistry(str(tmp_path / "sources.json"), _defaults())
    alpha = reloaded.require("alpha")

    assert updated.configured_tier == 3
    assert alpha.configured_tier == 3
    assert alpha.effective_tier == 3
    assert alpha.tier_override_reason == "manual downgrade"
    assert alpha.validity_status in {"noisy", "degraded", "blocked"}
    assert alpha.recommended_tier is None or alpha.recommended_tier == 3


def test_source_registry_enable_toggle_is_persistent(tmp_path):
    registry = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    registry.set_enabled("alpha", False)
    reloaded = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    assert reloaded.require("alpha").enabled is False


def test_source_registry_surfaces_selection_metadata(tmp_path):
    registry = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    status = registry.status()["alpha"]
    catalog = {item["source_id"]: item for item in registry.catalog()}

    assert status["capabilities"] == ["demand"]
    assert status["request_kinds_supported"] == ["run_source"]
    assert status["normalizer_key"] == "alpha"
    assert status["manifest_path"] is None
    assert status["agent_enabled"] is False
    assert status["agent_prompt_path"] is None
    assert status["agent_session_domain"] is None
    assert status["runnable"] is True
    assert status["adapter_name"] == "alpha"
    assert catalog["alpha"]["capabilities"] == ["demand"]
    assert catalog["alpha"]["request_kinds_supported"] == ["run_source"]


def test_source_registry_tracks_source_agent_status(tmp_path):
    registry = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    registry.record_source_agent_outcome(
        "alpha",
        status="completed",
        artifact_id="artifact-123",
    )

    status = registry.status()["alpha"]
    assert status["last_agent_status"] == "completed"
    assert status["last_agent_run"] is not None


def test_source_registry_tracks_downstream_usefulness_metrics(tmp_path):
    registry = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    baseline = registry.validity("alpha")
    registry.record_analysis_candidate(["alpha"])
    registry.record_analysis_outcome(["alpha"], "completed")
    registry.record_analysis_outcome(["alpha"], "failed")
    registry.record_research_fulfillment("alpha", useful=True)

    current = registry.validity("alpha")

    assert current["metrics"]["analysis_candidates_total"] == 1
    assert current["metrics"]["analysis_completed_total"] == 1
    assert current["metrics"]["analysis_failed_total"] == 1
    assert current["metrics"]["research_fulfillment_total"] == 1
    assert current["metrics"]["research_useful_total"] == 1
    assert current["validity_score"] >= baseline["validity_score"]


def test_source_registry_tracks_partial_failure_metadata(tmp_path):
    registry = SourceRegistry(str(tmp_path / "sources.json"), _defaults())

    registry.record_processing(
        "alpha",
        success=True,
        warning_kind="http_403_blocked",
        warning_message="Failed to fetch r/gadgets: HTTP 403",
        warning_count=2,
        is_run=True,
    )

    status = registry.status()["alpha"]
    assert status["partial_failure_count"] == 2
    assert status["last_warning_kind"] == "http_403_blocked"
    assert status["last_warning_message"] == "Failed to fetch r/gadgets: HTTP 403"
