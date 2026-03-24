"""Canonical entity registry with alias dictionary."""

import json
import os
from datetime import datetime, timezone
from typing import Any


class EntityStore:
    def __init__(self, path: str = "data/entities.json") -> None:
        self.path = path
        self._data: dict[str, Any] = {
            "entities": {},
            "review_queue": [],
            "approved_t3": [],
        }
        self._load()

    def _load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path, "r") as f:
                self._data = json.load(f)
            # Ensure approved_t3 key exists for backward compat
            if "approved_t3" not in self._data:
                self._data["approved_t3"] = []
        else:
            self._data = {"entities": {}, "review_queue": [], "approved_t3": []}

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w") as f:
            json.dump(self._data, f, indent=2, default=str)

    def resolve(self, raw_text: str) -> str | None:
        """Resolve raw text to canonical entity name using alias dict."""
        normalized = raw_text.strip().lower()
        for name, entity in self._data["entities"].items():
            if normalized == name.lower():
                return name
            aliases = [a.lower() for a in entity.get("aliases", [])]
            if normalized in aliases:
                return name
        return None

    def add_entity(
        self, name: str, entity_type: str, aliases: list[str]
    ) -> dict:
        """Add a new canonical entity."""
        entity = {
            "entity_type": entity_type,
            "aliases": aliases,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._data["entities"][name] = entity
        self._save()
        return entity

    def get_all_entities(self) -> dict:
        """Return all entities."""
        return dict(self._data["entities"])

    def add_to_review_queue(self, raw_text: str, source: str) -> None:
        """Add an unresolved entity mention to the review queue."""
        # Avoid duplicates
        for item in self._data["review_queue"]:
            if item["raw_text"].lower() == raw_text.lower():
                item["count"] = item.get("count", 1) + 1
                item["sources"] = list(set(item.get("sources", []) + [source]))
                self._save()
                return

        self._data["review_queue"].append(
            {
                "raw_text": raw_text,
                "sources": [source],
                "count": 1,
                "added_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        self._save()

    def get_review_queue(self) -> list[dict]:
        """Return the current review queue."""
        return list(self._data["review_queue"])

    def approve_review(self, raw_text: str, canonical_name: str) -> None:
        """Approve a review queue item: add as alias to canonical entity."""
        # Add alias if entity exists
        if canonical_name in self._data["entities"]:
            aliases = self._data["entities"][canonical_name].get("aliases", [])
            if raw_text not in aliases:
                aliases.append(raw_text)
                self._data["entities"][canonical_name]["aliases"] = aliases
        else:
            # Create new entity
            self.add_entity(canonical_name, "unknown", [raw_text])

        # Remove from review queue
        self._data["review_queue"] = [
            item
            for item in self._data["review_queue"]
            if item["raw_text"].lower() != raw_text.lower()
        ]
        self._save()

    def reject_review(self, raw_text: str) -> None:
        """Remove an item from the review queue without adding it."""
        self._data["review_queue"] = [
            item
            for item in self._data["review_queue"]
            if item["raw_text"].lower() != raw_text.lower()
        ]
        self._save()

    def is_approved(self, entity_text: str) -> bool:
        """Check if a T3 entity has been explicitly approved."""
        normalized = entity_text.strip().lower()
        return normalized in [
            e.lower() for e in self._data.get("approved_t3", [])
        ]

    def approve_t3(self, entity_text: str) -> None:
        """Approve a T3 entity for inclusion in signal candidates."""
        approved_list: list[str] = self._data.setdefault("approved_t3", [])
        normalized = entity_text.strip()
        if normalized.lower() not in [e.lower() for e in approved_list]:
            approved_list.append(normalized)
            self._save()
