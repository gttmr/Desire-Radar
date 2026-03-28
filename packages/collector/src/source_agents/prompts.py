"""Source-agent prompt path helpers."""

from __future__ import annotations

from pathlib import Path

SOURCE_AGENT_PROMPT_ROOT = Path(__file__).resolve().parent.parent / "agents" / "sources"


def get_source_agent_prompt_root() -> Path:
    return SOURCE_AGENT_PROMPT_ROOT


def get_source_agent_prompt_path(source_id: str) -> str:
    return str(SOURCE_AGENT_PROMPT_ROOT / f"{source_id}.md")
