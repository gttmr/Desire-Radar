"""Editing helpers for collector source-agent prompt markdown files."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..sources.registry import SourceRegistry


class SourcePromptError(Exception):
    """Base error for source prompt editing."""


class SourcePromptValidationError(SourcePromptError):
    """Raised when a source prompt update is invalid."""


class SourcePromptService:
    """List, read, and update registered source-agent prompt files."""

    def __init__(self, source_registry: SourceRegistry) -> None:
        self.source_registry = source_registry

    def list(self) -> dict[str, Any]:
        prompts = []
        for source in sorted(self.source_registry.list(), key=lambda item: item.source_id):
            if not source.agent_prompt_path:
                continue
            path = Path(source.agent_prompt_path)
            prompts.append(
                {
                    "source_id": source.source_id,
                    "kind": source.kind,
                    "description": source.description,
                    "agent_enabled": source.agent_enabled,
                    "agent_prompt_path": str(path),
                    "agent_session_domain": source.agent_session_domain,
                    "agent_output_mode": source.agent_output_mode,
                    "exists": path.exists(),
                    "last_agent_run": source.metrics.last_agent_run,
                    "last_agent_status": source.metrics.last_agent_status,
                }
            )
        return {
            "count": len(prompts),
            "prompts": prompts,
        }

    def read(self, source_id: str) -> dict[str, Any]:
        source = self.source_registry.require(source_id)
        if not source.agent_prompt_path:
            raise SourcePromptValidationError(
                f"Source prompt path missing for {source_id}"
            )
        path = Path(source.agent_prompt_path)
        exists = path.exists()
        content = path.read_text(encoding="utf-8") if exists else ""
        return {
            "source_id": source.source_id,
            "kind": source.kind,
            "description": source.description,
            "agent_enabled": source.agent_enabled,
            "agent_prompt_path": str(path),
            "agent_session_domain": source.agent_session_domain,
            "agent_output_mode": source.agent_output_mode,
            "exists": exists,
            "content": content,
            "char_count": len(content),
        }

    def update(self, source_id: str, content: str) -> dict[str, Any]:
        source = self.source_registry.require(source_id)
        if not source.agent_prompt_path:
            raise SourcePromptValidationError(
                f"Source prompt path missing for {source_id}"
            )
        path = Path(source.agent_prompt_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        payload = self.read(source_id)
        payload["updated"] = True
        return payload
