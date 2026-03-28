"""Registry helpers for source-agent prompt resolution."""

from __future__ import annotations

from pathlib import Path

from ..sources.models import SourceDefinition
from ..sources.registry import SourceRegistry


class SourceAgentRegistry:
    def __init__(self, source_registry: SourceRegistry) -> None:
        self.source_registry = source_registry

    def get_source(self, source_id: str) -> SourceDefinition:
        return self.source_registry.require(source_id)

    def load_prompt(self, source_id: str) -> str:
        source = self.get_source(source_id)
        if not source.agent_prompt_path:
            raise FileNotFoundError(f"source agent prompt path missing for {source_id}")
        path = Path(source.agent_prompt_path)
        if not path.exists():
            raise FileNotFoundError(f"source agent prompt not found: {path}")
        return path.read_text(encoding="utf-8").strip()
