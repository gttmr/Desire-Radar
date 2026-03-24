"""Persistent storage for candidate analysis projections."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone

from .models import AnalysisProjection, AnalysisResponse, AnalysisTask


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_entity(entity: str) -> str:
    return entity.strip().lower()


class AnalysisStore:
    def __init__(self, path: str = "data/analysis.json") -> None:
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, dict] = {"projections": {}}
        self._load()

    def _load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
        else:
            self._data = {"projections": {}}

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, ensure_ascii=False)

    def get_projection(self, entity: str) -> AnalysisProjection | None:
        key = _norm_entity(entity)
        with self._lock:
            raw = self._data["projections"].get(key)
            return AnalysisProjection.model_validate(raw) if raw else None

    def list_projections(self) -> list[AnalysisProjection]:
        with self._lock:
            return [
                AnalysisProjection.model_validate(raw)
                for raw in self._data["projections"].values()
            ]

    def mark_pending(self, task: AnalysisTask) -> AnalysisProjection:
        now = _now_iso()
        with self._lock:
            existing = self._get_unlocked(task.entity)
            projection = AnalysisProjection(
                **(
                    existing.model_dump()
                    if existing is not None
                    else {
                        "entity": task.entity,
                        "updated_at": now,
                    }
                )
            )
            projection.status = "pending"
            projection.session_domain = task.session_domain
            projection.reason = task.reason
            projection.evidence_ids = task.evidence_ids
            projection.sources = task.sources
            projection.source_count = task.source_count
            projection.last_emergence_score = task.emergence_score
            projection.last_velocity_score = task.velocity_score
            projection.first_enqueued_at = projection.first_enqueued_at or task.enqueued_at
            projection.updated_at = now
            self._set_unlocked(projection)
            return projection

    def mark_running(
        self,
        task: AnalysisTask,
        session_id: str,
        model: str | None,
    ) -> AnalysisProjection:
        now = _now_iso()
        with self._lock:
            existing = self._get_unlocked(task.entity)
            projection = AnalysisProjection(
                **(
                    existing.model_dump()
                    if existing is not None
                    else {
                        "entity": task.entity,
                        "updated_at": now,
                    }
                )
            )
            projection.status = "running"
            projection.session_domain = task.session_domain
            projection.session_id = session_id
            projection.model = model
            projection.reason = task.reason
            projection.evidence_ids = task.evidence_ids
            projection.sources = task.sources
            projection.source_count = task.source_count
            projection.last_emergence_score = task.emergence_score
            projection.last_velocity_score = task.velocity_score
            projection.updated_at = now
            self._set_unlocked(projection)
            return projection

    def mark_completed(
        self,
        task: AnalysisTask,
        response: AnalysisResponse,
        session_id: str,
        model: str | None,
        review_threshold: float,
    ) -> AnalysisProjection:
        now = _now_iso()
        with self._lock:
            projection = AnalysisProjection(
                entity=task.entity,
                status="needs_review" if response.confidence < review_threshold else "completed",
                session_domain=task.session_domain,
                session_id=session_id,
                model=model,
                summary=response.summary,
                confidence=response.confidence,
                desire_types=response.desire_types,
                behavioral_signals=response.behavioral_signals,
                demographic_hints=response.demographic_hints,
                avg_intensity=response.avg_intensity,
                open_questions=response.open_questions,
                reason=task.reason,
                evidence_ids=task.evidence_ids,
                sources=task.sources,
                source_count=task.source_count,
                last_emergence_score=task.emergence_score,
                last_velocity_score=task.velocity_score,
                first_enqueued_at=self._first_enqueued_unlocked(task.entity, task.enqueued_at),
                analyzed_at=now,
                updated_at=now,
            )
            self._set_unlocked(projection)
            return projection

    def mark_failed(self, task: AnalysisTask, error_message: str) -> AnalysisProjection:
        now = _now_iso()
        with self._lock:
            existing = self._get_unlocked(task.entity)
            projection = AnalysisProjection(
                **(
                    existing.model_dump()
                    if existing is not None
                    else {
                        "entity": task.entity,
                        "updated_at": now,
                    }
                )
            )
            projection.status = "failed"
            projection.session_domain = task.session_domain
            projection.reason = error_message[:500]
            projection.evidence_ids = task.evidence_ids
            projection.sources = task.sources
            projection.source_count = task.source_count
            projection.last_emergence_score = task.emergence_score
            projection.last_velocity_score = task.velocity_score
            projection.updated_at = now
            self._set_unlocked(projection)
            return projection

    def _first_enqueued_unlocked(self, entity: str, fallback: str) -> str:
        existing = self._get_unlocked(entity)
        if existing and existing.first_enqueued_at:
            return existing.first_enqueued_at
        return fallback

    def _get_unlocked(self, entity: str) -> AnalysisProjection | None:
        raw = self._data["projections"].get(_norm_entity(entity))
        return AnalysisProjection.model_validate(raw) if raw else None

    def _set_unlocked(self, projection: AnalysisProjection) -> None:
        self._data["projections"][_norm_entity(projection.entity)] = projection.model_dump()
        self._save()

