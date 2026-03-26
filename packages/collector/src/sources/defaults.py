"""Default source definitions seeded from connectors and platform channels."""

from __future__ import annotations

from ..connectors.base import BaseConnector
from .manifests import load_checked_in_source_manifests
from .models import SourceDefinition, SourceManifest


def _definition_from_manifest(
    manifest: SourceManifest,
    *,
    fallback_tier: int | None = None,
    fallback_cadence_seconds: int | None = None,
    fallback_runnable: bool | None = None,
    fallback_scheduled: bool | None = None,
) -> SourceDefinition:
    configured_tier = manifest.configured_tier if manifest.configured_tier is not None else (fallback_tier or 3)
    cadence_seconds = (
        manifest.cadence_seconds
        if manifest.cadence_seconds is not None
        else fallback_cadence_seconds
    )
    runnable = (
        manifest.runnable
        if manifest.runnable is not None
        else bool(fallback_runnable)
    )
    scheduled = (
        manifest.scheduled
        if manifest.scheduled is not None
        else bool(fallback_scheduled)
    )
    return SourceDefinition(
        source_id=manifest.source_id,
        kind=manifest.kind,
        ingestion_mode=manifest.ingestion_mode,
        configured_tier=configured_tier,
        effective_tier=configured_tier,
        enabled=manifest.enabled,
        adapter_name=manifest.adapter_name,
        default_producer_ref=manifest.default_producer_ref,
        cadence_seconds=cadence_seconds,
        runnable=runnable,
        scheduled=scheduled,
        description=manifest.description,
        capabilities=list(manifest.capabilities),
        request_kinds_supported=list(manifest.request_kinds_supported),
        normalizer_key=manifest.normalizer_key,
        manifest_path=manifest.manifest_path,
    )


def _connector_default_source(name: str, connector: BaseConnector) -> SourceDefinition:
    return SourceDefinition(
        source_id=name,
        kind="pull",
        ingestion_mode="raw",
        configured_tier=connector.source_tier,
        effective_tier=connector.source_tier,
        enabled=True,
        adapter_name=name,
        default_producer_ref=name,
        cadence_seconds=connector.cadence_seconds,
        runnable=True,
        scheduled=connector.cadence_seconds > 0,
        description=f"Pull connector for {name}",
        capabilities=["validation"],
        request_kinds_supported=["run_source"],
        normalizer_key=name,
    )


def _non_connector_defaults() -> list[SourceDefinition]:
    return [
        SourceDefinition(
            source_id="human_input_inbox",
            kind="human",
            ingestion_mode="raw",
            configured_tier=1,
            effective_tier=1,
            enabled=True,
            adapter_name="human_input_inbox",
            default_producer_ref="human-input",
            cadence_seconds=0,
            runnable=False,
            scheduled=False,
            description="Free-form human input inbox routed into structured ingest",
            capabilities=["validation"],
            request_kinds_supported=["request_human_note"],
            normalizer_key=None,
        ),
        SourceDefinition(
            source_id="manual_observation",
            kind="human",
            ingestion_mode="raw",
            configured_tier=1,
            effective_tier=1,
            enabled=True,
            adapter_name="manual_observation",
            default_producer_ref="human",
            cadence_seconds=0,
            runnable=False,
            scheduled=False,
            description="Quick human observation submission",
            capabilities=["validation"],
            request_kinds_supported=["request_human_note"],
            normalizer_key="manual_observation",
        ),
        SourceDefinition(
            source_id="human_analyst_note",
            kind="human",
            ingestion_mode="evidence",
            configured_tier=1,
            effective_tier=1,
            enabled=True,
            adapter_name="human_analyst_note",
            default_producer_ref="human-analyst",
            cadence_seconds=0,
            runnable=False,
            scheduled=False,
            description="Structured analyst note submission",
            capabilities=["demand", "monetization", "beneficiary", "validation"],
            request_kinds_supported=["request_human_note"],
            normalizer_key=None,
        ),
        SourceDefinition(
            source_id="human_curated_dataset",
            kind="human",
            ingestion_mode="evidence",
            configured_tier=1,
            effective_tier=1,
            enabled=True,
            adapter_name="human_curated_dataset",
            default_producer_ref="human-data",
            cadence_seconds=0,
            runnable=False,
            scheduled=False,
            description="Human-curated evidence batch or manual data source",
            capabilities=["demand", "ranking", "pricing", "supply", "validation"],
            request_kinds_supported=["request_human_note"],
            normalizer_key=None,
        ),
        SourceDefinition(
            source_id="co_mention_surge",
            kind="derived",
            ingestion_mode="evidence",
            configured_tier=2,
            effective_tier=2,
            enabled=True,
            adapter_name="co_mention_surge",
            default_producer_ref="collector",
            cadence_seconds=0,
            runnable=True,
            scheduled=False,
            description="Derived co-mention surge signal",
            capabilities=["demand", "validation"],
            request_kinds_supported=["run_source"],
            normalizer_key=None,
        ),
        SourceDefinition(
            source_id="search_rank_divergence",
            kind="derived",
            ingestion_mode="evidence",
            configured_tier=2,
            effective_tier=2,
            enabled=True,
            adapter_name="search_rank_divergence",
            default_producer_ref="collector",
            cadence_seconds=0,
            runnable=True,
            scheduled=False,
            description="Derived search/rank divergence signal",
            capabilities=["ranking", "validation"],
            request_kinds_supported=["run_source"],
            normalizer_key=None,
        ),
        SourceDefinition(
            source_id="persistence_acceleration",
            kind="derived",
            ingestion_mode="evidence",
            configured_tier=2,
            effective_tier=2,
            enabled=True,
            adapter_name="persistence_acceleration",
            default_producer_ref="collector",
            cadence_seconds=0,
            runnable=True,
            scheduled=False,
            description="Derived persistence acceleration signal",
            capabilities=["demand", "validation"],
            request_kinds_supported=["run_source"],
            normalizer_key=None,
        ),
        SourceDefinition(
            source_id="supply_tightness_proxy",
            kind="derived",
            ingestion_mode="evidence",
            configured_tier=2,
            effective_tier=2,
            enabled=True,
            adapter_name="supply_tightness_proxy",
            default_producer_ref="collector",
            cadence_seconds=0,
            runnable=True,
            scheduled=False,
            description="Derived supply tightness proxy signal",
            capabilities=["pricing", "supply", "validation"],
            request_kinds_supported=["run_source"],
            normalizer_key=None,
        ),
    ]


def build_default_sources(
    connectors: dict[str, BaseConnector],
    *,
    manifest_dir: str | None = None,
) -> list[SourceDefinition]:
    manifests = load_checked_in_source_manifests(manifest_dir)
    defaults: list[SourceDefinition] = []

    for name, connector in connectors.items():
        manifest = manifests.pop(name, None)
        if manifest is not None:
            defaults.append(
                _definition_from_manifest(
                    manifest,
                    fallback_tier=connector.source_tier,
                    fallback_cadence_seconds=connector.cadence_seconds,
                    fallback_runnable=True,
                    fallback_scheduled=connector.cadence_seconds > 0,
                )
            )
            continue
        defaults.append(_connector_default_source(name, connector))

    inline_defaults = {source.source_id: source for source in _non_connector_defaults()}
    for source_id, source in list(inline_defaults.items()):
        manifest = manifests.pop(source_id, None)
        if manifest is not None:
            defaults.append(
                _definition_from_manifest(
                    manifest,
                    fallback_tier=source.configured_tier,
                    fallback_cadence_seconds=source.cadence_seconds,
                    fallback_runnable=source.runnable,
                    fallback_scheduled=source.scheduled,
                )
            )
            inline_defaults.pop(source_id, None)

    defaults.extend(inline_defaults.values())
    defaults.extend(_definition_from_manifest(manifest) for manifest in manifests.values())
    return defaults
