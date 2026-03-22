"""
Base agent interface.

Every domain-observation agent inherits from BaseAgent and implements:
  - collect()  → gather raw data from external sources
  - analyze()  → call LLM (or heuristic) and return an AgentSignal

The runner calls run(), which wires collect → analyze and handles errors.
Agents declare their own ttl_seconds; the SignalStore uses this to decide
whether a cached signal is still fresh enough to skip re-execution.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

SignalValue = str  # 'bullish' | 'caution' | 'bearish' | 'neutral'
Horizon = str      # '1d' | '1w' | '1-3m' | '3-6m' | '6m+'


@dataclass
class AgentSignal:
    """Structured output from a single domain agent."""
    agent: str
    signal: SignalValue
    horizon: Horizon
    confidence: float          # 0.0 – 1.0
    summary: str
    key_factors: list[str] = field(default_factory=list)
    raw_data_snapshot: dict[str, Any] = field(default_factory=dict)
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent,
            "signal": self.signal,
            "horizon": self.horizon,
            "confidence": self.confidence,
            "summary": self.summary,
            "key_factors": self.key_factors,
            "raw_data_snapshot": self.raw_data_snapshot,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentSignal":
        return cls(
            agent=data["agent"],
            signal=data["signal"],
            horizon=data["horizon"],
            confidence=float(data["confidence"]),
            summary=data["summary"],
            key_factors=data.get("key_factors", []),
            raw_data_snapshot=data.get("raw_data_snapshot", {}),
            updated_at=data.get("updated_at", ""),
        )

    @classmethod
    def neutral(cls, agent_name: str, reason: str) -> "AgentSignal":
        """Return a neutral fallback signal when analysis cannot complete."""
        return cls(
            agent=agent_name,
            signal="neutral",
            horizon="unknown",
            confidence=0.0,
            summary=reason,
        )


class BaseAgent(ABC):
    """
    Abstract base for all domain-observation agents.

    Subclass contract:
      name        — unique identifier used as dict key in SignalStore
      ttl_seconds — how long a cached signal remains valid
      collect()   — fetch raw data; raise on unrecoverable errors
      analyze()   — turn raw data + knowledge into an AgentSignal
    """

    name: str = "base"
    ttl_seconds: int = 3600  # default: 1 hour

    @abstractmethod
    def collect(self) -> dict[str, Any]:
        """Fetch raw data from external sources. Must be side-effect-free."""
        ...

    @abstractmethod
    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        """
        Produce an AgentSignal from collected data.

        Args:
            data:      output of collect()
            knowledge: list of user-provided investment insight strings
                       that should influence this agent's perspective
        """
        ...

    def run(self, knowledge: list[str] | None = None) -> AgentSignal:
        """
        Execute collect → analyze with error isolation.
        Returns a neutral fallback signal if either step fails.
        """
        try:
            data = self.collect()
        except Exception as exc:
            logger.warning("[%s] collect() failed: %s", self.name, exc)
            return AgentSignal.neutral(self.name, f"데이터 수집 실패: {exc}")

        try:
            return self.analyze(data, knowledge or [])
        except Exception as exc:
            logger.warning("[%s] analyze() failed: %s", self.name, exc)
            return AgentSignal.neutral(self.name, f"분석 실패: {exc}")
