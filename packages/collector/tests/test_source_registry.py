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

