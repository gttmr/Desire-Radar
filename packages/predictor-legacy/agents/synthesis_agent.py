"""
SynthesisAgent — aggregates domain agent signals into a holistic investment view.

Unlike domain agents, SynthesisAgent does not fetch external data. Its collect()
simply serialises the AgentSignal list provided at construction or via
run_with_signals(). The LLM is asked to produce a weighted synthesis; a
majority-vote heuristic is used when the LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

from agents.base import AgentSignal, BaseAgent

logger = logging.getLogger(__name__)


class SynthesisAgent(BaseAgent):
    name = "synthesis"
    ttl_seconds = 3600  # 1h

    def __init__(self, llm_client: Any) -> None:
        self._llm = llm_client
        self._signals: list[AgentSignal] = []

    # ------------------------------------------------------------------
    # collect — returns serialised signals, no external I/O
    # ------------------------------------------------------------------

    def collect(self) -> dict[str, Any]:
        return {"signals": [s.to_dict() for s in self._signals]}

    # ------------------------------------------------------------------
    # analyze
    # ------------------------------------------------------------------

    def analyze(self, data: dict[str, Any], knowledge: list[str]) -> AgentSignal:
        system_prompt = (
            "You are a senior investment strategist. "
            "You receive signals from multiple domain-observation agents and must produce "
            "a holistic investment perspective. "
            "Return JSON with keys: "
            "signal (overall: bullish/caution/bearish/neutral), "
            "horizon (e.g. '3-6m'), "
            "confidence (0-1), "
            "summary (Korean, 2-3 sentences), "
            "key_factors (array of Korean strings), "
            "watch_points (array of Korean strings, things the user should monitor), "
            "agent_weights (dict of agent_name -> 0-1 float showing how much each agent "
            "influenced the verdict)"
        )
        if knowledge:
            context_lines = ["## 사용자 투자 관점 메모"] + [f"- {k}" for k in knowledge]
            system_prompt += "\n\n" + "\n".join(context_lines)

        user_content = json.dumps(data, ensure_ascii=False)

        try:
            result = self._llm.chat_json(system=system_prompt, user=user_content)
            signal_val = str(result.get("signal", "neutral")).lower()
            if signal_val not in {"bullish", "caution", "bearish", "neutral"}:
                signal_val = "neutral"

            # Build a rich raw_data_snapshot that includes agent_weights/watch_points
            snapshot = dict(data)
            snapshot["agent_weights"] = result.get("agent_weights", {})
            snapshot["watch_points"] = result.get("watch_points", [])

            return AgentSignal(
                agent=self.name,
                signal=signal_val,
                horizon=str(result.get("horizon", "3-6m")),
                confidence=max(0.0, min(1.0, float(result.get("confidence", 0.5)))),
                summary=str(result.get("summary", "")),
                key_factors=[str(f) for f in result.get("key_factors", [])],
                raw_data_snapshot=snapshot,
            )
        except Exception as exc:
            logger.warning("[synthesis] LLM failed, using heuristic: %s", exc)
            return self._heuristic(data)

    # ------------------------------------------------------------------
    # heuristic fallback — majority vote
    # ------------------------------------------------------------------

    def _heuristic(self, data: dict[str, Any]) -> AgentSignal:
        signals = data.get("signals", [])
        if not signals:
            return AgentSignal.neutral(self.name, "입력 신호 없음")

        counts: Counter[str] = Counter()
        for s in signals:
            val = str(s.get("signal", "neutral")).lower()
            if val in {"bullish", "caution", "bearish", "neutral"}:
                counts[val] += 1

        majority_signal = counts.most_common(1)[0][0] if counts else "neutral"
        agent_names = [str(s.get("agent", "unknown")) for s in signals]
        summary = (
            f"다수결 집계: {majority_signal} "
            f"({', '.join(f'{k}={v}' for k, v in counts.items())})"
        )

        return AgentSignal(
            agent=self.name,
            signal=majority_signal,
            horizon="3-6m",
            confidence=0.4,
            summary=summary,
            key_factors=[f"다수결 기반 — 참여 에이전트: {', '.join(agent_names)}"],
            raw_data_snapshot=data,
        )

    # ------------------------------------------------------------------
    # Primary entry point for callers
    # ------------------------------------------------------------------

    def run_with_signals(
        self,
        signals: list[AgentSignal],
        knowledge: list[str],
    ) -> AgentSignal:
        """
        Synthesise a list of domain AgentSignal objects into one holistic signal.

        Args:
            signals:   outputs from domain agents (macro, semiconductor, geopolitical, …)
            knowledge: user-provided investment insight strings for context injection
        """
        self._signals = signals
        return self.run(knowledge=knowledge)
