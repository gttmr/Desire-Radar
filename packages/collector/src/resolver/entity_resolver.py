"""Entity resolver using alias dict and EntityStore."""

from __future__ import annotations

import re

from ..store.entity_store import EntityStore
from .alias_dict import ALIAS_DICT

_GENERIC_REVIEW_TERMS = {
    "says", "said", "report", "reports", "reported", "free", "crash", "crashes",
    "bot", "bots", "music", "royalty", "dies", "keep", "phone", "airport",
    "year", "years", "shocking", "speed", "scientific", "practical", "building",
    "energy", "independence", "feels", "mini", "home", "solar", "farms",
    "judge", "allows", "videos", "back", "online", "high", "school", "student",
    "today", "week", "month", "people", "story", "stories", "news", "feature",
    "features", "issue", "issues", "problem", "problems", "launch", "launches",
}
_ACRONYM_OR_DIGIT_PATTERN = re.compile(r"^(?:[A-Z]{2,}[A-Z0-9]*|[A-Za-z]+[0-9]+[A-Za-z0-9]*)$")


class EntityResolver:
    def __init__(self, entity_store: EntityStore) -> None:
        self.entity_store = entity_store

    def resolve(self, raw_text: str, source: str = "") -> str | None:
        """Resolve raw text to canonical entity name.

        1. Check static alias dict
        2. Check EntityStore
        3. If ambiguous, add to review queue and return None
        """
        normalized = raw_text.strip().lower()

        # 1. Static alias dict
        if normalized in ALIAS_DICT:
            return ALIAS_DICT[normalized]

        # 2. EntityStore lookup
        canonical = self.entity_store.resolve(raw_text)
        if canonical is not None:
            return canonical

        # 3. Unresolved — add to review queue
        if source:
            self.entity_store.add_to_review_queue(raw_text, source)

        return None

    def resolve_candidates(
        self, candidates: list[str], source: str = ""
    ) -> list[str]:
        """Resolve a list of entity candidates. Return resolved names (deduped)."""
        resolved: list[str] = []
        seen: set[str] = set()
        unresolved_for_review: list[str] = []
        for candidate in candidates:
            name = self.resolve(candidate)
            if name and name not in seen:
                resolved.append(name)
                seen.add(name)
            elif source and self._should_queue_review(candidate):
                unresolved_for_review.append(candidate)
        if source and unresolved_for_review:
            self.entity_store.add_many_to_review_queue(unresolved_for_review, source)
        return resolved

    def _should_queue_review(self, raw_text: str) -> bool:
        normalized = raw_text.strip()
        if not normalized or len(normalized) < 3:
            return False
        lowered = normalized.lower()
        if lowered in _GENERIC_REVIEW_TERMS:
            return False
        if " " in normalized:
            return True
        if any("\uac00" <= char <= "\ud7a3" for char in normalized):
            return True
        return bool(_ACRONYM_OR_DIGIT_PATTERN.match(normalized))
