"""Signal candidate builder: groups evidence by entity and computes scores."""

from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel

from ..analysis.store import AnalysisStore
from ..normalizer.evidence_schema import Evidence
from ..sources.registry import SourceRegistry
from ..store.entity_store import EntityStore


class SignalCandidate(BaseModel):
    entity: str
    status: Literal["emerging", "preheat", "spreading"]
    emergence_score: float
    velocity_score: float
    source_count: int
    evidence_ids: list[str]
    sources: list[str]
    first_seen: str
    last_seen: str
    source_quality_score: float | None = None

    # LLM-enriched aggregated fields
    desire_types: list[str] = []  # Aggregated desire types from evidence
    behavioral_signals: list[str] = []  # Aggregated behavioral descriptions
    avg_intensity: float | None = None  # Average desire intensity
    demographic_hints: list[str] = []  # Aggregated demographics
    desire_summary: str | None = None  # Best LLM summary for this entity
    analysis_status: str | None = None
    analysis_summary: str | None = None
    analysis_confidence: float | None = None
    analysis_reason: str | None = None
    last_analyzed_at: str | None = None
    analysis_session_domain: str | None = None


class SignalCandidateBuilder:
    def __init__(
        self,
        time_window_seconds: int = 86400,
        entity_store: EntityStore | None = None,
        analysis_store: AnalysisStore | None = None,
        source_registry: SourceRegistry | None = None,
    ) -> None:
        self.time_window_seconds = time_window_seconds
        self.entity_store = entity_store
        self.analysis_store = analysis_store
        self.source_registry = source_registry

    def _is_t3_allowed(self, ev: Evidence, entity: str) -> bool:
        """Check if T3 evidence is allowed (approved in review queue)."""
        if ev.source_tier != 3:
            return True
        if self.entity_store is None:
            return True  # No store to check, allow by default
        return self.entity_store.is_approved(entity)

    def build_candidates(
        self, evidence_list: list[Evidence]
    ) -> list[SignalCandidate]:
        """Group evidence by entity and compute signal candidates."""
        # Group evidence by each entity candidate, filtering T3
        entity_evidence: dict[str, list[Evidence]] = defaultdict(list)
        for ev in evidence_list:
            for entity in ev.entity_candidates:
                if self._is_t3_allowed(ev, entity):
                    entity_evidence[entity].append(ev)

        candidates: list[SignalCandidate] = []
        now = datetime.now(timezone.utc)

        for entity, evidences in entity_evidence.items():
            sources = list({ev.source for ev in evidences})
            source_count = len(sources)
            evidence_ids = [ev.evidence_id for ev in evidences]
            weighted_source_score = sum(
                self._source_weight(source, evidences)
                for source in sources
            )
            source_quality_score = round(
                weighted_source_score / max(1, source_count),
                3,
            )

            # Parse timestamps for recency
            timestamps: list[datetime] = []
            for ev in evidences:
                try:
                    ts = datetime.fromisoformat(ev.collected_at)
                    timestamps.append(ts)
                except (ValueError, TypeError):
                    timestamps.append(now)

            first_seen = min(timestamps).isoformat() if timestamps else now.isoformat()
            last_seen = max(timestamps).isoformat() if timestamps else now.isoformat()

            # Emergence score: based on source count and evidence count
            emergence_score = min(
                10.0, weighted_source_score * 2.0 + len(evidences) * 0.5
            )

            # Velocity score: evidence count within the time window
            recent_count = sum(
                1
                for ts in timestamps
                if (now - ts).total_seconds() < self.time_window_seconds
            )
            velocity_score = min(
                10.0,
                recent_count / max(1, self.time_window_seconds / 3600) * 2.0,
            )

            # Status thresholds
            if source_count >= 5 and source_quality_score >= 0.6:
                status: Literal["emerging", "preheat", "spreading"] = "spreading"
            elif source_count >= 3 and source_quality_score >= 0.45:
                status = "preheat"
            else:
                status = "emerging"

            # Aggregate LLM-enriched fields
            desire_types = list({
                desire_type for ev in evidences
                if (desire_type := getattr(ev, "desire_type", None))
            })
            behavioral_signals = list({
                behavioral_signal for ev in evidences
                if (behavioral_signal := getattr(ev, "behavioral_signal", None))
            })
            intensities = [
                intensity for ev in evidences
                if (intensity := getattr(ev, "intensity", None)) is not None
            ]
            avg_intensity = (
                round(sum(intensities) / len(intensities), 2)
                if intensities else None
            )
            demographic_hints = list({
                demographic_hint for ev in evidences
                if (demographic_hint := getattr(ev, "demographic_hint", None))
            })
            # Pick the longest LLM summary as the best one
            summaries = [
                llm_summary for ev in evidences
                if (llm_summary := getattr(ev, "llm_summary", None))
            ]
            desire_summary = max(summaries, key=len) if summaries else None
            projection = (
                self.analysis_store.get_projection(entity)
                if self.analysis_store is not None
                else None
            )

            if projection is not None:
                desire_types = projection.desire_types or desire_types
                behavioral_signals = projection.behavioral_signals or behavioral_signals
                avg_intensity = projection.avg_intensity if projection.avg_intensity is not None else avg_intensity
                demographic_hints = projection.demographic_hints or demographic_hints
                desire_summary = projection.summary or desire_summary

            candidates.append(
                SignalCandidate(
                    entity=entity,
                    status=status,
                    emergence_score=round(emergence_score, 2),
                    velocity_score=round(velocity_score, 2),
                    source_count=source_count,
                    evidence_ids=evidence_ids,
                    sources=sources,
                    first_seen=first_seen,
                    last_seen=last_seen,
                    source_quality_score=source_quality_score,
                    desire_types=desire_types,
                    behavioral_signals=behavioral_signals,
                    avg_intensity=avg_intensity,
                    demographic_hints=demographic_hints,
                    desire_summary=desire_summary,
                    analysis_status=projection.status if projection is not None else None,
                    analysis_summary=projection.summary if projection is not None else None,
                    analysis_confidence=projection.confidence if projection is not None else None,
                    analysis_reason=projection.reason if projection is not None else None,
                    last_analyzed_at=projection.analyzed_at if projection is not None else None,
                    analysis_session_domain=projection.session_domain if projection is not None else None,
                )
            )

        # Sort by emergence score descending
        candidates.sort(key=lambda c: c.emergence_score, reverse=True)
        return candidates

    def _source_weight(self, source: str, evidences: list[Evidence]) -> float:
        source_evidences = [ev for ev in evidences if ev.source == source]
        source_tier = min((ev.source_tier for ev in source_evidences), default=3)
        tier_weight = {1: 1.25, 2: 1.0, 3: 0.7}.get(source_tier, 0.7)

        if self.source_registry is None:
            return tier_weight

        status = self.source_registry.status().get(source, {})
        validity_score = float(status.get("validity_score") or 1.0)
        validity_status = str(status.get("validity_status") or "healthy")
        status_weight = {
            "healthy": 1.0,
            "noisy": 0.75,
            "degraded": 0.4,
            "blocked": 0.0,
        }.get(validity_status, 0.5)
        return round(tier_weight * validity_score * status_weight, 3)
