"""Models for routing free-form human input into collector ingest types."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

HumanInputRoute = Literal[
    "manual_observation",
    "human_analyst_note",
    "human_curated_dataset",
    "needs_review",
    "none",
]
HumanInputKind = Literal["observation", "study_note", "dataset", "command", "mixed"]
AssetType = Literal["stock", "real_estate", "topic", "other"]
HandoffTarget = Literal["investment_module"]
ActionType = Literal["watchlist_add", "watchlist_remove"]


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


class AssetCandidate(BaseModel):
    asset_type: AssetType
    asset_key: str | None = None
    display_name: str
    ticker: str | None = None
    market: str | None = None
    confidence: float = 0.0
    rationale: str = ""


class ActionRequest(BaseModel):
    action: ActionType
    asset_type: Literal["stock"] = "stock"
    asset_key: str
    ticker: str
    display_name: str
    confidence: float = 0.0
    rationale: str = ""


class InvestmentNoteDraft(BaseModel):
    title: str = ""
    summary: str = ""
    structured_summary: list[str] = Field(default_factory=list)
    why_it_might_matter: str = ""
    beneficiary_hints: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    references: list[str] = Field(default_factory=list)
    asset_candidates: list[AssetCandidate] = Field(default_factory=list)
    status: Literal["resolved", "unresolved"] = "unresolved"


class HumanInputRoutingDecision(BaseModel):
    route: HumanInputRoute
    collector_route: HumanInputRoute | None = None
    input_kind: HumanInputKind = "observation"
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
    action_requests: list[ActionRequest] = Field(default_factory=list)
    handoff_targets: list[HandoffTarget] = Field(default_factory=list)
    asset_candidates: list[AssetCandidate] = Field(default_factory=list)
    investment_note: InvestmentNoteDraft | None = None

    @model_validator(mode="after")
    def _sync_collector_route(self) -> "HumanInputRoutingDecision":
        if self.collector_route is None:
            self.collector_route = self.route
        else:
            self.route = self.collector_route
        return self
