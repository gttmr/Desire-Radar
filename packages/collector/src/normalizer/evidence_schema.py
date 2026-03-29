from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class EvidenceEventFrame(BaseModel):
    event_type: str
    summary: str | None = None
    subjects: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=list)
    happened_at: str | None = None


class EvidenceRelationshipHint(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    kind: str
    confidence: float | None = None
    rationale: str | None = None
    evidence_id: str | None = None


class Evidence(BaseModel):
    evidence_id: str
    source: str
    source_tier: Literal[1, 2, 3]
    source_kind: str | None = None
    producer_ref: str | None = None
    parent_evidence_ids: list[str] = Field(default_factory=list)
    submission_ref: str | None = None
    collected_at: str
    entity_candidates: list[str]
    signal_type: str
    title_or_label: str
    metric_value: float | None = None
    metric_delta: float | None = None
    rank: int | None = None
    geo: str = "global"
    url_or_ref: str = ""
    raw_snapshot_ref: str = ""
    trust_score: float = 1.0
    tos_risk: str = "none"
    freshness_ttl: int = 3600
    event_frame: EvidenceEventFrame | None = None
    relationship_hints: list[EvidenceRelationshipHint] = Field(default_factory=list)
