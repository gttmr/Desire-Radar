from typing import Literal

from pydantic import BaseModel, Field


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
