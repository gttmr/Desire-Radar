"""Data models for source definitions, manifests, and validity."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SourceKind = Literal["pull", "push", "agent", "human", "derived"]
IngestionMode = Literal["raw", "evidence"]
ValidityStatus = Literal["healthy", "noisy", "degraded", "blocked"]
RequestKind = Literal["run_source", "submit_agent_evidence", "request_human_note"]


class SourceMetrics(BaseModel):
    runs_total: int = 0
    submissions_total: int = 0
    failures_total: int = 0
    partial_failure_total: int = 0
    snapshot_total: int = 0
    deduped_snapshot_total: int = 0
    evidence_total: int = 0
    entity_resolve_success_total: int = 0
    entity_resolve_miss_total: int = 0
    analysis_candidates_total: int = 0
    analysis_completed_total: int = 0
    analysis_needs_review_total: int = 0
    analysis_failed_total: int = 0
    research_fulfillment_total: int = 0
    research_useful_total: int = 0
    pending_submissions: int = 0
    last_run: str | None = None
    last_submission: str | None = None
    last_success: str | None = None
    last_failure_kind: str | None = None
    last_failure_message: str | None = None
    last_warning_kind: str | None = None
    last_warning_message: str | None = None
    last_warning_count: int = 0


class SourceDefinition(BaseModel):
    source_id: str
    kind: SourceKind
    ingestion_mode: IngestionMode
    configured_tier: int
    effective_tier: int
    enabled: bool = True
    adapter_name: str
    default_producer_ref: str | None = None
    cadence_seconds: int | None = None
    runnable: bool = False
    scheduled: bool = False
    tier_override_reason: str | None = None
    validity_status: ValidityStatus = "healthy"
    validity_score: float = 1.0
    recommended_tier: int | None = None
    recommended_tier_reason: str | None = None
    description: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    request_kinds_supported: list[RequestKind] = Field(default_factory=list)
    normalizer_key: str | None = None
    manifest_path: str | None = None
    metrics: SourceMetrics = Field(default_factory=SourceMetrics)


class SourceManifest(BaseModel):
    source_id: str
    kind: SourceKind
    ingestion_mode: IngestionMode
    configured_tier: int | None = None
    enabled: bool = True
    adapter_name: str
    default_producer_ref: str | None = None
    cadence_seconds: int | None = None
    runnable: bool | None = None
    scheduled: bool | None = None
    description: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    request_kinds_supported: list[RequestKind] = Field(default_factory=list)
    normalizer_key: str | None = None
    manifest_path: str | None = None
