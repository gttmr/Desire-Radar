"""Prompt construction for collector source-agents."""

from __future__ import annotations

import math
from typing import Any

from ..ingest.models import SubmissionRecord
from ..normalizer.evidence_schema import Evidence
from .models import SourceAgentPromptPreview
from .registry import SourceAgentRegistry

_SOURCE_AGENT_INSTRUCTIONS = """Return JSON only.
Keys:
- summary
- confidence
- warnings
- theme_tags
- event_summary
- entity_hints
- relationship_hints
- derived_evidence

relationship_hints must be an array of objects with keys: from, to, kind, confidence, rationale.
derived_evidence must be an array of objects with keys: title_or_label, signal_type, entity_candidates, metric_value, metric_delta, rank, geo, trust_score, freshness_ttl, event_frame, relationship_hints.
Keep confidence between 0 and 1.
Do not restate raw evidence verbatim unless needed for a signal summary.
Only propose derived_evidence when it adds source-level event/theme/relationship structure beyond the raw evidence."""


def _estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


class SourceAgentContextBuilder:
    def __init__(
        self,
        registry: SourceAgentRegistry,
        *,
        max_input_chars: int = 8000,
        evidence_limit: int = 12,
    ) -> None:
        self.registry = registry
        self.max_input_chars = max_input_chars
        self.evidence_limit = evidence_limit

    def build(
        self,
        source_id: str,
        submission: SubmissionRecord | None,
        evidences: list[Evidence],
    ) -> SourceAgentPromptPreview:
        source = self.registry.get_source(source_id)
        prompt_body = self.registry.load_prompt(source_id)
        rendered = self._render_prompt(prompt_body, source, submission, evidences)
        if len(rendered) > self.max_input_chars:
            rendered = rendered[: self.max_input_chars - 3].rstrip() + "..."
        return SourceAgentPromptPreview(
            source_id=source_id,
            submission_id=submission.submission_id if submission is not None else None,
            session_domain=source.agent_session_domain or f"source-agent:{source_id}",
            output_mode=source.agent_output_mode,
            prompt=rendered,
            char_count=len(rendered),
            evidence_count=len(evidences),
            evidence_ids=[item.evidence_id for item in evidences],
            prompt_path=source.agent_prompt_path,
        )

    def _render_prompt(
        self,
        prompt_body: str,
        source: Any,
        submission: SubmissionRecord | None,
        evidences: list[Evidence],
    ) -> str:
        evidence_lines = [
            self._render_evidence_line(item)
            for item in evidences[: self.evidence_limit]
        ]
        metadata_lines = [
            f"- source_id: {source.source_id}",
            f"- source_kind: {source.kind}",
            f"- ingestion_mode: {source.ingestion_mode}",
            f"- configured_tier: {source.configured_tier}",
            f"- effective_tier: {source.effective_tier}",
            f"- capabilities: {', '.join(source.capabilities) if source.capabilities else '(none)'}",
        ]
        if submission is not None:
            metadata_lines.extend(
                [
                    f"- submission_id: {submission.submission_id}",
                    f"- submission_status: {submission.status}",
                    f"- producer_ref: {submission.producer_ref or '(none)'}",
                    f"- metadata: {submission.metadata}",
                ]
            )
        lines = [
            _SOURCE_AGENT_INSTRUCTIONS,
            "## Source Agent Prompt",
            prompt_body,
            "## Source Metadata",
            *metadata_lines,
            "## Submission Evidence",
            *(f"- {line}" for line in evidence_lines),
        ]
        if len(evidences) > self.evidence_limit:
            lines.append(f"- additional_evidence_count: {len(evidences) - self.evidence_limit}")
        lines.append(f"## Estimated Tokens\n- estimated_input_tokens: {_estimate_tokens(prompt_body)}")
        return "\n".join(lines)

    def _render_evidence_line(self, evidence: Evidence) -> str:
        parts = [
            evidence.evidence_id,
            evidence.source,
            evidence.signal_type,
            evidence.title_or_label,
        ]
        if evidence.entity_candidates:
            parts.append(f"entities={','.join(evidence.entity_candidates)}")
        if evidence.event_frame and evidence.event_frame.summary:
            parts.append(f"event={evidence.event_frame.summary}")
        if evidence.relationship_hints:
            parts.append(f"relationships={len(evidence.relationship_hints)}")
        return " | ".join(parts)
