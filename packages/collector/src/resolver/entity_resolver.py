"""Entity resolver using alias dict and EntityStore."""

from ..store.entity_store import EntityStore
from .alias_dict import ALIAS_DICT


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
        for candidate in candidates:
            name = self.resolve(candidate, source)
            if name and name not in seen:
                resolved.append(name)
                seen.add(name)
        return resolved
