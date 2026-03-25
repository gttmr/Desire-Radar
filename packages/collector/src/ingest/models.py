"""Models for hybrid ingestion submissions."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SubmissionStatus = Literal[
    "pending",
    "running",
    "completed",
    "failed",
    "rejected",
    "pending_human",
]

SubmissionInputKind = Literal["raw", "evidence"]


class SubmissionRecord(BaseModel):
    submission_id: str
    source_id: str
    source_kind: str
    ingestion_mode: SubmissionInputKind
    status: SubmissionStatus
    snapshot_ids: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)
    error_message: str | None = None
    producer_ref: str | None = None
    received_at: str
    processed_at: str | None = None
    payloads: list[dict[str, Any]] = Field(default_factory=list)
    evidence_payloads: list[dict[str, Any]] = Field(default_factory=list)
    request_params: dict[str, Any] = Field(default_factory=dict)
    parent_evidence_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
