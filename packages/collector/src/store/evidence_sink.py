"""Thread-safe evidence storage with TTL enforcement and query support."""

import logging
import threading
from datetime import datetime, timedelta, timezone

from ..normalizer.evidence_schema import Evidence

logger = logging.getLogger(__name__)


class EvidenceSink:
    """Manages collected evidence with lifecycle management.

    Features:
        - append / extend for adding evidence
        - query_by_entity / query_recent for retrieval
        - enforce_ttl for periodic cleanup of stale evidence
        - count property
    """

    def __init__(self, freshness_ttl_days: int = 7) -> None:
        self._items: list[Evidence] = []
        self._fingerprints: set[str] = set()
        self._lock = threading.Lock()
        self.freshness_ttl = timedelta(days=freshness_ttl_days)

    @property
    def count(self) -> int:
        with self._lock:
            return len(self._items)

    def append(self, evidence: Evidence) -> None:
        with self._lock:
            fingerprint = self._fingerprint(evidence)
            if fingerprint in self._fingerprints:
                return
            self._items.append(evidence)
            self._fingerprints.add(fingerprint)

    def extend(self, evidences: list[Evidence]) -> None:
        with self._lock:
            for evidence in evidences:
                fingerprint = self._fingerprint(evidence)
                if fingerprint in self._fingerprints:
                    continue
                self._items.append(evidence)
                self._fingerprints.add(fingerprint)

    def get_all(self) -> list[Evidence]:
        """Return a copy of all evidence items."""
        with self._lock:
            return list(self._items)

    def query_by_entity(self, entity: str) -> list[Evidence]:
        """Return all evidence mentioning the given entity (case-insensitive)."""
        entity_lower = entity.strip().lower()
        with self._lock:
            return [
                ev
                for ev in self._items
                if any(c.lower() == entity_lower for c in ev.entity_candidates)
            ]

    def query_recent(self, hours: int = 24) -> list[Evidence]:
        """Return evidence collected within the last N hours."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        with self._lock:
            result: list[Evidence] = []
            for ev in self._items:
                try:
                    collected = datetime.fromisoformat(ev.collected_at)
                    if collected >= cutoff:
                        result.append(ev)
                except (ValueError, TypeError):
                    # Keep items with unparseable timestamps
                    result.append(ev)
            return result

    def query_by_source(self, source: str) -> list[Evidence]:
        with self._lock:
            return [ev for ev in self._items if ev.source == source]

    def query_by_ids(self, evidence_ids: list[str]) -> list[Evidence]:
        wanted = set(evidence_ids)
        with self._lock:
            return [ev for ev in self._items if ev.evidence_id in wanted]

    def enforce_ttl(self) -> int:
        """Remove evidence older than freshness_ttl. Return number of items removed."""
        cutoff = datetime.now(timezone.utc) - self.freshness_ttl
        with self._lock:
            before = len(self._items)
            kept: list[Evidence] = []
            for ev in self._items:
                try:
                    collected = datetime.fromisoformat(ev.collected_at)
                    if collected >= cutoff:
                        kept.append(ev)
                except (ValueError, TypeError):
                    kept.append(ev)
            self._items = kept
            self._fingerprints = {self._fingerprint(item) for item in self._items}
            removed = before - len(self._items)
            if removed > 0:
                logger.info("TTL cleanup: removed %d stale evidence items", removed)
            return removed

    def __len__(self) -> int:
        return self.count

    def _fingerprint(self, evidence: Evidence) -> str:
        entities = "|".join(sorted(evidence.entity_candidates))
        parents = "|".join(sorted(evidence.parent_evidence_ids))
        return "::".join(
            [
                evidence.source,
                evidence.raw_snapshot_ref,
                evidence.signal_type,
                evidence.title_or_label,
                entities,
                parents,
            ]
        )
