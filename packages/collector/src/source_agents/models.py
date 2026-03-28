"""Data models for collector source-agent execution."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from ..analysis.models import ExecutionUsage
from ..normalizer.evidence_schema import EvidenceEventFrame, EvidenceRelationshipHint

SourceAgentStatus = Literal["completed", "failed", "skipped"]
SourceAgentOutputMode = Literal["artifact_only", "artifact_and_derived"]


class SourceAgentDerivedEvidenceInput(BaseModel):
    title_or_label: str
    signal_type: str
    entity_candidates: list[str] = Field(default_factory=list)
    metric_value: float | None = None
    metric_delta: float | None = None
    rank: int | None = None
    geo: str = "global"
    trust_score: float = 0.75
    freshness_ttl: int = 21600
    event_frame: EvidenceEventFrame | None = None
    relationship_hints: list[EvidenceRelationshipHint] = Field(default_factory=list)


class SourceAgentDecision(BaseModel):
    summary: str = ""
    confidence: float = 0.0
    warnings: list[str] = Field(default_factory=list)
    theme_tags: list[str] = Field(default_factory=list)
    event_summary: str | None = None
    entity_hints: list[str] = Field(default_factory=list)
    relationship_hints: list[EvidenceRelationshipHint] = Field(default_factory=list)
    derived_evidence: list[SourceAgentDerivedEvidenceInput] = Field(default_factory=list)


class SourceAgentArtifact(BaseModel):
    artifact_id: str
    source_id: str
    submission_id: str | None = None
    status: SourceAgentStatus
    output_mode: SourceAgentOutputMode
    session_domain: str
    session_id: str | None = None
    session_dir: str | None = None
    request_artifact_path: str | None = None
    response_artifact_path: str | None = None
    model: str | None = None
    summary: str | None = None
    confidence: float | None = None
    warnings: list[str] = Field(default_factory=list)
    theme_tags: list[str] = Field(default_factory=list)
    event_summary: str | None = None
    entity_hints: list[str] = Field(default_factory=list)
    relationship_hints: list[EvidenceRelationshipHint] = Field(default_factory=list)
    derived_evidence_ids: list[str] = Field(default_factory=list)
    execution_notes: list[str] = Field(default_factory=list)
    raw_text: str = ""
    error_message: str | None = None
    usage: ExecutionUsage = Field(default_factory=ExecutionUsage)
    created_at: str
    updated_at: str


class SourceAgentPromptPreview(BaseModel):
    source_id: str
    submission_id: str | None = None
    session_domain: str
    output_mode: SourceAgentOutputMode
    prompt: str
    char_count: int
    evidence_count: int
    evidence_ids: list[str] = Field(default_factory=list)
    prompt_path: str | None = None


class SourceAgentRunResult(BaseModel):
    artifact: SourceAgentArtifact
    derived_evidence: list[object] = Field(default_factory=list)
