"""Models for routing free-form human input into collector ingest types."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

HumanInputRoute = Literal[
    "manual_observation",
    "human_analyst_note",
    "human_curated_dataset",
    "needs_review",
]


class HumanInputEnvelope(BaseModel):
    content: str = ""
    message_url: str = ""
    attachment_urls: list[str] = Field(default_factory=list)
    producer_ref: str | None = None
    author_id: str | None = None
    author_name: str | None = None
    guild_id: str | None = None
    channel_id: str | None = None
    channel_name: str | None = None
    message_id: str | None = None
    thread_id: str | None = None
    thread_name: str | None = None
    request_submission_id: str | None = None
    posted_at: str | None = None


class HumanInputRoutingDecision(BaseModel):
    route: HumanInputRoute
    confidence: float = 0.0
    rationale: str = ""
    title: str = ""
    entities: list[str] = Field(default_factory=list)
    signal_type: str = "manual"
    metric_value: float | None = None
    metric_delta: float | None = None
    rank: int | None = None
    geo: str = "global"
    url: str = ""
    trust_score: float = 0.9
    freshness_ttl: int = 86400
    observation: str = ""
    why_now: str = ""
    beneficiary_hints: list[str] = Field(default_factory=list)
    research_questions: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    supporting_points: list[str] = Field(default_factory=list)
    study_type: str = "analysis_note"
    dataset_name: str = "discord_human_input"
    notes: str = ""
    evidence_items: list[dict[str, Any]] = Field(default_factory=list)
    request_submission_id: str | None = None
    user_message: str | None = None
