"""
Knowledge store — persists user-provided investment insights.

Each entry has:
  id        — UUID
  content   — free-form text (e.g. "반도체 재고 사이클은 재고/출하 비율로 선행")
  tags      — optional labels for filtering (e.g. ["semiconductor", "cycle"])
  created_at

The store exposes get_context() which returns all entries formatted as a
single string suitable for injection into an LLM system prompt.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class KnowledgeEntry:
    id: str
    content: str
    tags: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "tags": self.tags,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "KnowledgeEntry":
        return cls(
            id=data["id"],
            content=data["content"],
            tags=data.get("tags", []),
            created_at=data.get("created_at", ""),
        )


class KnowledgeStore:
    def __init__(self, path: str = "data/knowledge.json"):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def add(self, content: str, tags: list[str] | None = None) -> KnowledgeEntry:
        entry = KnowledgeEntry(
            id=str(uuid.uuid4()),
            content=content.strip(),
            tags=tags or [],
        )
        entries = self._read()
        entries.append(entry.to_dict())
        self._write(entries)
        logger.info("[knowledge_store] added entry %s", entry.id)
        return entry

    def remove(self, entry_id: str) -> bool:
        entries = self._read()
        before = len(entries)
        entries = [e for e in entries if e.get("id") != entry_id]
        if len(entries) == before:
            return False
        self._write(entries)
        return True

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def list_all(self) -> list[KnowledgeEntry]:
        return [KnowledgeEntry.from_dict(e) for e in self._read()]

    def get_context(self, tags: list[str] | None = None) -> str:
        """
        Return all entries (optionally filtered by tags) as a single
        newline-separated string for LLM prompt injection.
        """
        entries = self.list_all()
        if tags:
            tag_set = set(tags)
            entries = [e for e in entries if tag_set & set(e.tags)] or entries
        if not entries:
            return ""
        lines = ["## 사용자 투자 관점 메모"]
        for entry in entries:
            tag_str = f" [{', '.join(entry.tags)}]" if entry.tags else ""
            lines.append(f"- {entry.content}{tag_str}")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _read(self) -> list[dict[str, Any]]:
        try:
            return json.loads(self._path.read_text("utf-8"))
        except FileNotFoundError:
            return []
        except Exception as exc:
            logger.warning("[knowledge_store] read error: %s", exc)
            return []

    def _write(self, entries: list[dict[str, Any]]) -> None:
        self._path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), "utf-8")
