"""Rules for deciding which candidates are worth LLM analysis."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..sources.registry import SourceRegistry
from .models import AnalysisProjection, PolicyDecision


def _parse_iso(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


class AnalysisPolicy:
    def __init__(
        self,
        min_source_count: int = 2,
        max_candidates_per_run: int = 10,
        cooldown_seconds: int = 21600,
        min_emergence_delta: float = 2.0,
        source_registry: SourceRegistry | None = None,
        min_source_quality_score: float = 0.3,
    ) -> None:
        self.min_source_count = min_source_count
        self.max_candidates_per_run = max_candidates_per_run
        self.cooldown_seconds = cooldown_seconds
        self.min_emergence_delta = min_emergence_delta
        self.source_registry = source_registry
        self.min_source_quality_score = min_source_quality_score

    def decide(
        self,
        candidate: Any,
        evidences: list[Any],
        projection: AnalysisProjection | None,
        *,
        force: bool = False,
    ) -> PolicyDecision:
        if not evidences:
            return PolicyDecision(should_enqueue=False, reason="no_evidence")

        has_tier1 = any(getattr(ev, "source_tier", 3) == 1 for ev in evidences)
        eligible_source_count = len(
            {
                getattr(ev, "source", "").lower()
                for ev in evidences
                if self._source_is_eligible(getattr(ev, "source", ""))
            }
        )
        source_quality_score = float(getattr(candidate, "source_quality_score", 1.0) or 0.0)

        if (
            not force
            and source_quality_score < self.min_source_quality_score
            and not has_tier1
        ):
            return PolicyDecision(should_enqueue=False, reason="low_source_quality")

        if (
            not force
            and getattr(candidate, "source_count", 0) < self.min_source_count
            and eligible_source_count < self.min_source_count
            and not has_tier1
        ):
            return PolicyDecision(should_enqueue=False, reason="insufficient_source_diversity")

        if force:
            return PolicyDecision(
                should_enqueue=True,
                reason="manual_override",
                priority=self._priority(candidate, has_tier1),
            )

        if projection is None:
            return PolicyDecision(
                should_enqueue=True,
                reason="new_candidate",
                priority=self._priority(candidate, has_tier1),
            )

        if projection.status in {"pending", "running"}:
            return PolicyDecision(should_enqueue=False, reason=f"already_{projection.status}")

        if not self._material_change(candidate, projection):
            return PolicyDecision(should_enqueue=False, reason="no_material_change")

        analyzed_at = _parse_iso(projection.analyzed_at)
        if analyzed_at is not None:
            cooldown_cutoff = datetime.now(timezone.utc) - timedelta(seconds=self.cooldown_seconds)
            if analyzed_at >= cooldown_cutoff:
                return PolicyDecision(should_enqueue=False, reason="cooldown_active")

        return PolicyDecision(
            should_enqueue=True,
            reason="material_change",
            priority=self._priority(candidate, has_tier1),
        )

    def _material_change(self, candidate: Any, projection: AnalysisProjection) -> bool:
        emergence_score = float(getattr(candidate, "emergence_score", 0.0))
        last_score = projection.last_emergence_score or 0.0
        if emergence_score - last_score >= self.min_emergence_delta:
            return True

        current_sources = {source.lower() for source in getattr(candidate, "sources", [])}
        previous_sources = {source.lower() for source in projection.sources}
        if current_sources - previous_sources:
            return True

        current_evidence_ids = set(getattr(candidate, "evidence_ids", []))
        previous_evidence_ids = set(projection.evidence_ids)
        return len(current_evidence_ids - previous_evidence_ids) >= 2

    def _priority(self, candidate: Any, has_tier1: bool) -> float:
        emergence_score = float(getattr(candidate, "emergence_score", 0.0))
        velocity_score = float(getattr(candidate, "velocity_score", 0.0))
        quality_score = float(getattr(candidate, "source_quality_score", 1.0) or 0.0)
        tier_bonus = 2.0 if has_tier1 else 0.0
        return emergence_score + velocity_score + tier_bonus + quality_score

    def _source_is_eligible(self, source_id: str) -> bool:
        if self.source_registry is None:
            return True
        status = self.source_registry.status().get(source_id, {})
        return status.get("validity_status") not in {"blocked", "degraded"}
