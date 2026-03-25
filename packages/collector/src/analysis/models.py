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
AnalysisExecutionMode = Literal["batch", "fresh", "resume"]
PromptFormat = Literal["json", "markdown"]
ResponseMode = Literal["single", "batch"]


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
    entity: str | None = None
    entities: list[str] = Field(default_factory=list)
    prompt: str
    evidence_ids: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    char_count: int
    estimated_input_tokens: int
    omitted_fields: list[str] = Field(default_factory=list)
    prompt_format: PromptFormat = "markdown"
    batch_size: int = 1
    response_mode: ResponseMode = "single"


class SessionState(BaseModel):
    session_id: str
    domain: str
    model: str | None = None
    turn_count: int = 0
    last_active_at: str
    rolling_memory: str = ""
    total_input_tokens: int = 0
    total_cached_input_tokens: int = 0
    total_uncached_input_tokens: int = 0


class AnalysisResponse(BaseModel):
    entity: str | None = None
    summary: str
    confidence: float
    desire_types: list[str] = Field(default_factory=list)
    behavioral_signals: list[str] = Field(default_factory=list)
    demographic_hints: list[str] = Field(default_factory=list)
    avg_intensity: float | None = None
    open_questions: list[str] = Field(default_factory=list)


class ExecutionUsage(BaseModel):
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    uncached_input_tokens: int = 0
    elapsed_ms: float | None = None


class ExecutionResult(BaseModel):
    session_id: str
    model: str | None = None
    responses: list[AnalysisResponse] = Field(default_factory=list)
    usage: ExecutionUsage = Field(default_factory=ExecutionUsage)
    raw_text: str = ""


class RawExecutionResult(BaseModel):
    session_id: str
    model: str | None = None
    payload: object | None = None
    usage: ExecutionUsage = Field(default_factory=ExecutionUsage)
    raw_text: str = ""


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
    last_execution_mode: AnalysisExecutionMode | None = None
    last_prompt_char_count: int | None = None
    last_estimated_input_tokens: int | None = None
    last_input_tokens: int | None = None
    last_cached_input_tokens: int | None = None
    last_uncached_input_tokens: int | None = None
    last_output_tokens: int | None = None
    last_batch_size: int | None = None
    updated_at: str
