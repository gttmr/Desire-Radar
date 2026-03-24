"""Compress candidate evidence into bounded prompts for CLI analysis."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .models import AnalysisProjection, PackedContext

_ANALYSIS_INSTRUCTIONS = """\
당신은 트렌드 수집 파이프라인의 후보 심사기입니다.
입력은 하나의 entity 후보와 대표 evidence 묶음입니다.
항상 유효한 JSON만 출력하세요. 스키마는 아래와 같습니다.
{
  "summary": string,
  "confidence": number,
  "desire_types": string[],
  "behavioral_signals": string[],
  "demographic_hints": string[],
  "avg_intensity": number | null,
  "open_questions": string[]
}
"""


def _parse_collected_at(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def _sort_ts(value: str) -> float:
    parsed = _parse_collected_at(value)
    try:
        return parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return 0.0


class ContextPacker:
    def __init__(
        self,
        char_budget: int = 6000,
        max_evidence: int = 8,
    ) -> None:
        self.char_budget = char_budget
        self.max_evidence = max_evidence

    def pack(
        self,
        candidate: Any,
        evidences: list[Any],
        projection: AnalysisProjection | None = None,
    ) -> PackedContext:
        selected = self._select_evidence(evidences)
        prompt = self._render_prompt(candidate, selected, projection)

        while len(prompt) > self.char_budget and len(selected) > 1:
            selected.pop()
            prompt = self._render_prompt(candidate, selected, projection)

        if len(prompt) > self.char_budget:
            prompt = prompt[: self.char_budget - 1]

        return PackedContext(
            entity=getattr(candidate, "entity"),
            prompt=prompt,
            evidence_ids=[ev.evidence_id for ev in selected],
            sources=list(dict.fromkeys(ev.source for ev in selected)),
            char_count=len(prompt),
        )

    def _select_evidence(self, evidences: list[Any]) -> list[Any]:
        ranked = sorted(
            evidences,
            key=lambda ev: (
                getattr(ev, "source_tier", 3),
                -float(getattr(ev, "trust_score", 0.0)),
                -_sort_ts(getattr(ev, "collected_at", "")),
            ),
            reverse=False,
        )

        selected: list[Any] = []
        used_sources: set[str] = set()

        for ev in ranked:
            if ev.source in used_sources:
                continue
            selected.append(ev)
            used_sources.add(ev.source)
            if len(selected) >= self.max_evidence:
                return selected

        for ev in ranked:
            if ev in selected:
                continue
            selected.append(ev)
            if len(selected) >= self.max_evidence:
                break

        return selected

    def _render_prompt(
        self,
        candidate: Any,
        evidences: list[Any],
        projection: AnalysisProjection | None,
    ) -> str:
        previous_summary = projection.summary if projection else None
        payload = {
            "instructions": _ANALYSIS_INSTRUCTIONS,
            "candidate": {
                "entity": getattr(candidate, "entity"),
                "status": getattr(candidate, "status"),
                "emergence_score": getattr(candidate, "emergence_score"),
                "velocity_score": getattr(candidate, "velocity_score"),
                "source_count": getattr(candidate, "source_count"),
                "sources": getattr(candidate, "sources"),
                "first_seen": getattr(candidate, "first_seen"),
                "last_seen": getattr(candidate, "last_seen"),
            },
            "previous_analysis": {
                "summary": previous_summary,
                "confidence": projection.confidence if projection else None,
                "open_questions": projection.open_questions if projection else [],
            },
            "evidence": [self._render_evidence(ev) for ev in evidences],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def _render_evidence(self, ev: Any) -> dict[str, Any]:
        title = getattr(ev, "title_or_label", "")
        if len(title) > 180:
            title = f"{title[:177]}..."
        return {
            "evidence_id": ev.evidence_id,
            "source": ev.source,
            "source_tier": ev.source_tier,
            "collected_at": ev.collected_at,
            "signal_type": ev.signal_type,
            "title_or_label": title,
            "metric_value": ev.metric_value,
            "metric_delta": ev.metric_delta,
            "rank": ev.rank,
            "geo": ev.geo,
            "trust_score": ev.trust_score,
            "url_or_ref": ev.url_or_ref,
        }
