"""Data models for collector-side candidate analysis."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AnalysisStatus = Literal[
    "pending",
    "running",
    "completed",
    "failed",
    "needs_review",
    "skipped",
]


class PolicyDecision(BaseModel):
    should_enqueue: bool
    reason: str
    priority: float = 0.0


class AnalysisTask(BaseModel):
    task_id: str
    entity: str
    session_domain: str
    reason: str
    emergence_score: float
    velocity_score: float
    source_count: int
    evidence_ids: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    first_seen: str
    last_seen: str
    enqueued_at: str


class PackedContext(BaseModel):
    entity: str
    prompt: str
    evidence_ids: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    char_count: int


class SessionState(BaseModel):
    session_id: str
    domain: str
    model: str | None = None
    turn_count: int = 0
    last_active_at: str
    rolling_memory: str = ""


class AnalysisResponse(BaseModel):
    summary: str
    confidence: float
    desire_types: list[str] = Field(default_factory=list)
    behavioral_signals: list[str] = Field(default_factory=list)
    demographic_hints: list[str] = Field(default_factory=list)
    avg_intensity: float | None = None
    open_questions: list[str] = Field(default_factory=list)


class AnalysisProjection(BaseModel):
    entity: str
    status: AnalysisStatus = "pending"
    session_domain: str = "trend-analysis"
    session_id: str | None = None
    model: str | None = None
    summary: str | None = None
    confidence: float | None = None
    desire_types: list[str] = Field(default_factory=list)
    behavioral_signals: list[str] = Field(default_factory=list)
    demographic_hints: list[str] = Field(default_factory=list)
    avg_intensity: float | None = None
    open_questions: list[str] = Field(default_factory=list)
    reason: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    source_count: int = 0
    last_emergence_score: float | None = None
    last_velocity_score: float | None = None
    first_enqueued_at: str | None = None
    analyzed_at: str | None = None
    updated_at: str

