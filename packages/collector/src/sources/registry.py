"""Persistent registry for collector sources."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Literal

from .models import SourceDefinition
from .validity import SourceValidityEngine


class SourceRegistry:
    def __init__(
        self,
        path: str,
        defaults: list[SourceDefinition],
        validity_engine: SourceValidityEngine | None = None,
    ) -> None:
        self.path = path
        self.validity_engine = validity_engine or SourceValidityEngine()
        self._sources: dict[str, SourceDefinition] = {
            source.source_id: source for source in defaults
        }
        self._load()
        self._sync_defaults(defaults)

    def list(self) -> list[SourceDefinition]:
        return [source.model_copy(deep=True) for source in self._sources.values()]

    def as_map(self) -> dict[str, SourceDefinition]:
        return {
            source_id: source.model_copy(deep=True)
            for source_id, source in self._sources.items()
        }

    def get(self, source_id: str) -> SourceDefinition | None:
        source = self._sources.get(source_id)
        return source.model_copy(deep=True) if source is not None else None

    def require(self, source_id: str) -> SourceDefinition:
        source = self.get(source_id)
        if source is None:
            raise KeyError(source_id)
        return source

    def update_tier(
        self,
        source_id: str,
        configured_tier: int,
        override_reason: str | None = None,
    ) -> SourceDefinition:
        source = self._sources[source_id]
        source.configured_tier = configured_tier
        source.effective_tier = configured_tier
        source.tier_override_reason = override_reason
        self._refresh_validity(source)
        self._save()
        return source.model_copy(deep=True)

    def set_enabled(self, source_id: str, enabled: bool) -> SourceDefinition:
        source = self._sources[source_id]
        source.enabled = enabled
        self._save()
        return source.model_copy(deep=True)

    def record_submission(self, source_id: str) -> None:
        source = self._sources[source_id]
        source.metrics.submissions_total += 1
        source.metrics.pending_submissions += 1
        source.metrics.last_submission = self._now()
        self._refresh_validity(source)
        self._save()

    def record_processing(
        self,
        source_id: str,
        *,
        success: bool,
        snapshot_total: int = 0,
        deduped_snapshot_total: int = 0,
        evidence_total: int = 0,
        entity_resolve_success_total: int = 0,
        entity_resolve_miss_total: int = 0,
        failure_kind: str | None = None,
        failure_message: str | None = None,
        warning_kind: str | None = None,
        warning_message: str | None = None,
        warning_count: int = 0,
        is_run: bool = False,
        is_submission: bool = False,
    ) -> None:
        source = self._sources[source_id]
        if is_run:
            source.metrics.runs_total += 1
            source.metrics.last_run = self._now()
        if is_submission:
            source.metrics.pending_submissions = max(
                0, source.metrics.pending_submissions - 1
            )
        if not success:
            source.metrics.failures_total += 1
            source.metrics.last_failure_kind = failure_kind
            source.metrics.last_failure_message = failure_message
        if success:
            source.metrics.last_success = self._now()
            source.metrics.last_failure_kind = None
            source.metrics.last_failure_message = None
            if warning_count > 0:
                source.metrics.partial_failure_total += warning_count
                source.metrics.last_warning_kind = warning_kind
                source.metrics.last_warning_message = warning_message
                source.metrics.last_warning_count = warning_count
            else:
                source.metrics.last_warning_kind = None
                source.metrics.last_warning_message = None
                source.metrics.last_warning_count = 0

        source.metrics.snapshot_total += snapshot_total
        source.metrics.deduped_snapshot_total += deduped_snapshot_total
        source.metrics.evidence_total += evidence_total
        source.metrics.entity_resolve_success_total += entity_resolve_success_total
        source.metrics.entity_resolve_miss_total += entity_resolve_miss_total
        self._refresh_validity(source)
        self._save()

    def record_analysis_candidate(self, source_ids: list[str]) -> None:
        changed = False
        for source_id in {source_id for source_id in source_ids if source_id in self._sources}:
            source = self._sources[source_id]
            source.metrics.analysis_candidates_total += 1
            self._refresh_validity(source)
            changed = True
        if changed:
            self._save()

    def record_analysis_outcome(
        self,
        source_ids: list[str],
        outcome: Literal["completed", "needs_review", "failed"],
    ) -> None:
        changed = False
        for source_id in {source_id for source_id in source_ids if source_id in self._sources}:
            source = self._sources[source_id]
            if outcome == "completed":
                source.metrics.analysis_completed_total += 1
            elif outcome == "needs_review":
                source.metrics.analysis_needs_review_total += 1
            else:
                source.metrics.analysis_failed_total += 1
            self._refresh_validity(source)
            changed = True
        if changed:
            self._save()

    def record_research_fulfillment(self, source_id: str, *, useful: bool) -> None:
        if source_id not in self._sources:
            return
        source = self._sources[source_id]
        source.metrics.research_fulfillment_total += 1
        if useful:
            source.metrics.research_useful_total += 1
        self._refresh_validity(source)
        self._save()

    def catalog(self) -> list[dict]:
        return [
            {
                "source_id": source.source_id,
                "kind": source.kind,
                "ingestion_mode": source.ingestion_mode,
                "configured_tier": source.configured_tier,
                "effective_tier": source.effective_tier,
                "enabled": source.enabled,
                "adapter_name": source.adapter_name,
                "default_producer_ref": source.default_producer_ref,
                "cadence_seconds": source.cadence_seconds,
                "runnable": source.runnable,
                "scheduled": source.scheduled,
                "tier_override_reason": source.tier_override_reason,
                "validity_status": source.validity_status,
                "validity_score": source.validity_score,
                "recommended_tier": source.recommended_tier,
                "recommended_tier_reason": source.recommended_tier_reason,
                "description": source.description,
                "capabilities": source.capabilities,
                "request_kinds_supported": source.request_kinds_supported,
                "normalizer_key": source.normalizer_key,
                "manifest_path": source.manifest_path,
            }
            for source in self._sources.values()
        ]

    def status(self) -> dict[str, dict]:
        return {
            source.source_id: {
                "kind": source.kind,
                "ingestion_mode": source.ingestion_mode,
                "configured_tier": source.configured_tier,
                "effective_tier": source.effective_tier,
                "source_tier": source.effective_tier,
                "scheduled": source.scheduled,
                "enabled": source.enabled,
                "runnable": source.runnable,
                "adapter_name": source.adapter_name,
                "default_producer_ref": source.default_producer_ref,
                "tier_override_reason": source.tier_override_reason,
                "description": source.description,
                "last_run": source.metrics.last_run,
                "last_submission": source.metrics.last_submission,
                "last_success": source.metrics.last_success,
                "pending_submissions": source.metrics.pending_submissions,
                "failure_count": source.metrics.failures_total,
                "partial_failure_count": source.metrics.partial_failure_total,
                "last_failure_kind": source.metrics.last_failure_kind,
                "last_failure_message": source.metrics.last_failure_message,
                "last_warning_kind": source.metrics.last_warning_kind,
                "last_warning_message": source.metrics.last_warning_message,
                "last_warning_count": source.metrics.last_warning_count,
                "cadence_seconds": source.cadence_seconds or 0,
                "validity_status": source.validity_status,
                "validity_score": source.validity_score,
                "recommended_tier": source.recommended_tier,
                "recommended_tier_reason": source.recommended_tier_reason,
                "capabilities": source.capabilities,
                "request_kinds_supported": source.request_kinds_supported,
                "normalizer_key": source.normalizer_key,
                "manifest_path": source.manifest_path,
            }
            for source in self._sources.values()
        }

    def validity(self, source_id: str) -> dict:
        source = self._sources[source_id]
        return {
            "source_id": source.source_id,
            "validity_status": source.validity_status,
            "validity_score": source.validity_score,
            "recommended_tier": source.recommended_tier,
            "recommended_tier_reason": source.recommended_tier_reason,
            "configured_tier": source.configured_tier,
            "effective_tier": source.effective_tier,
            "metrics": source.metrics.model_dump(),
        }

    def _refresh_validity(self, source: SourceDefinition) -> None:
        status, score, recommended_tier, reason = self.validity_engine.evaluate(source)
        source.validity_status = status
        source.validity_score = score
        source.recommended_tier = recommended_tier
        source.recommended_tier_reason = reason

    def _sync_defaults(self, defaults: list[SourceDefinition]) -> None:
        for default in defaults:
            current = self._sources.get(default.source_id)
            if current is None:
                self._sources[default.source_id] = default
                continue
            current.kind = default.kind
            current.ingestion_mode = default.ingestion_mode
            current.adapter_name = default.adapter_name
            current.default_producer_ref = default.default_producer_ref
            current.cadence_seconds = default.cadence_seconds
            current.runnable = default.runnable
            current.scheduled = default.scheduled
            current.description = default.description
            current.capabilities = list(default.capabilities)
            current.request_kinds_supported = list(default.request_kinds_supported)
            current.normalizer_key = default.normalizer_key
            current.manifest_path = default.manifest_path
        for source in self._sources.values():
            self._refresh_validity(source)
        self._save()

    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        self._sources = {
            item["source_id"]: SourceDefinition.model_validate(item)
            for item in payload.get("sources", [])
        }

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "sources": [
                        source.model_dump(mode="json")
                        for source in self._sources.values()
                    ]
                },
                handle,
                indent=2,
            )

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
