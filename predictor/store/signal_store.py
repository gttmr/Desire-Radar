"""
Signal store — persists and caches AgentSignal outputs.

Storage: one JSON file per agent under <base_dir>/signals/<agent_name>.json
Each file holds the latest signal plus a rolling history (capped at MAX_HISTORY).

Freshness check: a signal is "fresh" if (now - updated_at) < agent.ttl_seconds.
The runner skips re-execution when the stored signal is still fresh.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agents.base import AgentSignal

logger = logging.getLogger(__name__)

MAX_HISTORY = 48  # keep last 48 snapshots per agent


class SignalStore:
    def __init__(self, base_dir: str = "data/signals"):
        self._dir = Path(base_dir)
        self._dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, signal: AgentSignal) -> None:
        """Persist signal; prepend to history, cap at MAX_HISTORY."""
        path = self._path(signal.agent)
        existing = self._read(path)
        history: list[dict[str, Any]] = existing.get("history", [])
        history.insert(0, signal.to_dict())
        history = history[:MAX_HISTORY]
        self._write(path, {"latest": signal.to_dict(), "history": history})
        logger.debug("[signal_store] saved %s signal=%s", signal.agent, signal.signal)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def get_latest(self, agent_name: str) -> AgentSignal | None:
        data = self._read(self._path(agent_name))
        if not data or "latest" not in data:
            return None
        try:
            return AgentSignal.from_dict(data["latest"])
        except Exception as exc:
            logger.warning("[signal_store] corrupt entry for %s: %s", agent_name, exc)
            return None

    def get_history(self, agent_name: str) -> list[AgentSignal]:
        data = self._read(self._path(agent_name))
        signals = []
        for item in data.get("history", []):
            try:
                signals.append(AgentSignal.from_dict(item))
            except Exception:
                continue
        return signals

    def get_all_latest(self) -> list[AgentSignal]:
        """Return the most recent signal for every known agent."""
        signals = []
        for path in sorted(self._dir.glob("*.json")):
            agent_name = path.stem
            signal = self.get_latest(agent_name)
            if signal:
                signals.append(signal)
        return signals

    # ------------------------------------------------------------------
    # Freshness
    # ------------------------------------------------------------------

    def is_fresh(self, agent_name: str, ttl_seconds: int) -> bool:
        signal = self.get_latest(agent_name)
        if not signal or not signal.updated_at:
            return False
        try:
            updated = datetime.fromisoformat(signal.updated_at)
            age = (datetime.now(timezone.utc) - updated).total_seconds()
            return age < ttl_seconds
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _path(self, agent_name: str) -> Path:
        safe = agent_name.replace("/", "_").replace("..", "_")
        return self._dir / f"{safe}.json"

    def _read(self, path: Path) -> dict[str, Any]:
        try:
            return json.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            return {}
        except Exception as exc:
            logger.warning("[signal_store] read error %s: %s", path, exc)
            return {}

    def _write(self, path: Path, data: dict[str, Any]) -> None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
