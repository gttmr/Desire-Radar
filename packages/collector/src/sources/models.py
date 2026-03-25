"""Data models for source definitions and validity."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SourceKind = Literal["pull", "push", "agent", "human", "derived"]
IngestionMode = Literal["raw", "evidence"]
ValidityStatus = Literal["healthy", "noisy", "degraded", "blocked"]


class SourceMetrics(BaseModel):
    runs_total: int = 0
    submissions_total: int = 0
    failures_total: int = 0
    snapshot_total: int = 0
    deduped_snapshot_total: int = 0
    evidence_total: int = 0
    entity_resolve_success_total: int = 0
    entity_resolve_miss_total: int = 0
    pending_submissions: int = 0
    last_run: str | None = None
    last_submission: str | None = None
    last_success: str | None = None


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
    metrics: SourceMetrics = Field(default_factory=SourceMetrics)
