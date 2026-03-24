"""Signal candidate builder: groups evidence by entity and computes scores."""

from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel

from ..normalizer.evidence_schema import Evidence
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


class SignalCandidateBuilder:
    def __init__(
        self,
        time_window_seconds: int = 86400,
        entity_store: EntityStore | None = None,
    ) -> None:
        self.time_window_seconds = time_window_seconds
        self.entity_store = entity_store

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
                10.0, source_count * 2.0 + len(evidences) * 0.5
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
            if source_count >= 5:
                status: Literal["emerging", "preheat", "spreading"] = "spreading"
            elif source_count >= 3:
                status = "preheat"
            else:
                status = "emerging"

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
                )
            )

        # Sort by emergence score descending
        candidates.sort(key=lambda c: c.emergence_score, reverse=True)
        return candidates
