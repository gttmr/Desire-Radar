"""Persistent per-source runtime state and recent run ledger."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from statistics import median
from typing import Any

from pydantic import BaseModel, Field

from ..sources.models import FetchStrategy, SourceReadinessStatus


class SourceRunState(BaseModel):
    source_id: str
    fetch_strategy: FetchStrategy = "full_snapshot"
    readiness_status: SourceReadinessStatus = "ready"
    readiness_reason: str | None = None
    last_attempt_at: str | None = None
    last_success_at: str | None = None
    cooldown_until: str | None = None
    last_cursor: str | None = None
    last_seen_ids: list[str] = Field(default_factory=list)
    last_rate_limit_reset_at: str | None = None


class SourceRunLedgerEntry(BaseModel):
    run_id: str
    source_id: str
    submission_id: str
    started_at: str
    finished_at: str
    duration_ms: int
    status: str
    payload_total: int = 0
    snapshot_total: int = 0
    evidence_total: int = 0
    partial_failure_count: int = 0
    failure_kind: str | None = None
    warning_kinds: list[str] = Field(default_factory=list)
    source_agent_status: str | None = None
    quality_status: str | None = None


class SourceRunStateStore:
    def __init__(self, path: str | None = None, *, ledger_limit: int = 20) -> None:
        self.path = path
        self.ledger_limit = max(1, ledger_limit)
        self._states: dict[str, SourceRunState] = {}
        self._ledger: dict[str, list[SourceRunLedgerEntry]] = {}
        self._load()

    def get_state(self, source_id: str) -> SourceRunState | None:
        state = self._states.get(source_id)
        return state.model_copy(deep=True) if state is not None else None

    def ensure_state(
        self,
        source_id: str,
        *,
        fetch_strategy: FetchStrategy = "full_snapshot",
    ) -> SourceRunState:
        state = self._states.get(source_id)
        if state is None:
            state = SourceRunState(source_id=source_id, fetch_strategy=fetch_strategy)
            self._states[source_id] = state
            self._save()
        elif state.fetch_strategy != fetch_strategy:
            state = state.model_copy(update={"fetch_strategy": fetch_strategy}, deep=True)
            self._states[source_id] = state
            self._save()
        return state.model_copy(deep=True)

    def update_state(self, source_id: str, **updates: Any) -> SourceRunState:
        state = self._states.get(source_id)
        if state is None:
            state = SourceRunState(source_id=source_id)
        updated = state.model_copy(update=updates, deep=True)
        if updated != state:
            self._states[source_id] = updated
            self._save()
        else:
            self._states[source_id] = state
        return self._states[source_id].model_copy(deep=True)

    def append_ledger_entry(self, entry: SourceRunLedgerEntry) -> SourceRunLedgerEntry:
        entries = list(self._ledger.get(entry.source_id, []))
        entries.insert(0, entry)
        self._ledger[entry.source_id] = entries[: self.ledger_limit]
        self._save()
        return entry.model_copy(deep=True)

    def recent_runs(
        self,
        source_id: str,
        *,
        limit: int = 5,
    ) -> list[SourceRunLedgerEntry]:
        return [
            entry.model_copy(deep=True)
            for entry in self._ledger.get(source_id, [])[:limit]
        ]

    def summarize_recent_runs(self, source_id: str, *, limit: int = 5) -> dict[str, Any]:
        runs = self.recent_runs(source_id, limit=limit)
        durations = [entry.duration_ms for entry in runs if entry.duration_ms > 0]
        warning_kinds: list[str] = []
        for entry in runs:
            for warning_kind in entry.warning_kinds:
                if warning_kind not in warning_kinds:
                    warning_kinds.append(warning_kind)
        return {
            "recent_runs": [entry.model_dump(mode="json") for entry in runs],
            "median_duration_ms": int(median(durations)) if durations else None,
            "recent_warning_kinds": warning_kinds[:5],
            "recent_failure_count": sum(1 for entry in runs if entry.status == "failed"),
        }

    def freshness_lag_seconds(self, source_id: str) -> int | None:
        state = self._states.get(source_id)
        if state is None or not state.last_success_at:
            return None
        parsed = _parse_timestamp(state.last_success_at)
        return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))

    def _load(self) -> None:
        if not self.path or not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        self._states = {
            item["source_id"]: SourceRunState.model_validate(item)
            for item in payload.get("states", [])
        }
        self._ledger = {}
        for source_id, items in (payload.get("ledger") or {}).items():
            self._ledger[str(source_id)] = [
                SourceRunLedgerEntry.model_validate(item)
                for item in items
            ]

    def _save(self) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "states": [
                        state.model_dump(mode="json")
                        for state in self._states.values()
                    ],
                    "ledger": {
                        source_id: [
                            entry.model_dump(mode="json")
                            for entry in entries
                        ]
                        for source_id, entries in self._ledger.items()
                    },
                },
                handle,
                indent=2,
            )


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
