"""Thread-safe evidence storage with TTL enforcement and query support."""

import json
import logging
import os
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

    def __init__(
        self,
        freshness_ttl_days: int = 7,
        *,
        path: str | None = None,
    ) -> None:
        self._items: list[Evidence] = []
        self._fingerprints: set[str] = set()
        self._lock = threading.Lock()
        self.freshness_ttl = timedelta(days=freshness_ttl_days)
        self.path = path
        self._load()
        self.enforce_ttl()

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
            self._save_locked()

    def extend(self, evidences: list[Evidence]) -> None:
        with self._lock:
            changed = False
            for evidence in evidences:
                fingerprint = self._fingerprint(evidence)
                if fingerprint in self._fingerprints:
                    continue
                self._items.append(evidence)
                self._fingerprints.add(fingerprint)
                changed = True
            if changed:
                self._save_locked()

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
                self._save_locked()
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

    def _load(self) -> None:
        if not self.path or not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            logger.warning("Failed to load persisted evidence from %s", self.path)
            return

        items = payload.get("evidence", [])
        loaded: list[Evidence] = []
        fingerprints: set[str] = set()
        for item in items:
            try:
                evidence = Evidence.model_validate(item)
            except Exception:
                logger.warning("Skipping invalid persisted evidence item from %s", self.path)
                continue
            fingerprint = self._fingerprint(evidence)
            if fingerprint in fingerprints:
                continue
            loaded.append(evidence)
            fingerprints.add(fingerprint)

        self._items = loaded
        self._fingerprints = fingerprints

    def _save_locked(self) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp_path = f"{self.path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "evidence": [
                        item.model_dump(mode="json")
                        for item in self._items
                    ]
                },
                handle,
                indent=2,
                ensure_ascii=False,
            )
        os.replace(tmp_path, self.path)
