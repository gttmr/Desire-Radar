"""Prompt construction for collector source-agents."""

from __future__ import annotations

import math
from collections import Counter
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
_SOURCE_AGENT_EXECUTION_GUARDRAILS = """The prompt already contains the source context you are allowed to use.
Do not inspect workspace files, run shell commands, browse, or look for extra context outside this prompt.
Work only from the provided metadata, evidence summary, and submission evidence lines."""


def _estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


class SourceAgentContextBuilder:
    def __init__(
        self,
        registry: SourceAgentRegistry,
        *,
        max_input_chars: int = 8000,
        evidence_limit: int = 8,
        compact_input_chars: int | None = None,
        compact_evidence_limit: int = 4,
        title_max_chars: int = 120,
        compact_title_max_chars: int = 84,
    ) -> None:
        self.registry = registry
        self.max_input_chars = max_input_chars
        self.evidence_limit = evidence_limit
        self.compact_input_chars = compact_input_chars or max(2200, min(4000, max_input_chars // 2))
        self.compact_evidence_limit = compact_evidence_limit
        self.title_max_chars = title_max_chars
        self.compact_title_max_chars = compact_title_max_chars

    def build(
        self,
        source_id: str,
        submission: SubmissionRecord | None,
        evidences: list[Evidence],
        *,
        compact: bool = False,
    ) -> SourceAgentPromptPreview:
        source = self.registry.get_source(source_id)
        prompt_body = self.registry.load_prompt(source_id)
        rendered = self._render_prompt(
            prompt_body,
            source,
            submission,
            evidences,
            compact=compact,
        )
        max_chars = self.compact_input_chars if compact else self.max_input_chars
        if len(rendered) > max_chars:
            rendered = rendered[: max_chars - 3].rstrip() + "..."
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
        *,
        compact: bool,
    ) -> str:
        evidence_limit = self.compact_evidence_limit if compact else self.evidence_limit
        evidence_lines = [
            self._render_evidence_line(item, compact=compact)
            for item in self._select_evidences(evidences, limit=evidence_limit)
        ]
        metadata_lines = [
            f"- context_mode: {'compact' if compact else 'standard'}",
            f"- source_id: {source.source_id}",
            f"- source_kind: {source.kind}",
            f"- ingestion_mode: {source.ingestion_mode}",
            f"- configured_tier: {source.configured_tier}",
            f"- effective_tier: {source.effective_tier}",
            f"- capabilities: {', '.join(source.capabilities) if source.capabilities else '(none)'}",
        ]
        if submission is not None:
            metadata_lines.extend(self._render_submission_metadata(submission))
        evidence_summary_lines = self._render_evidence_summary(evidences)
        lines = [
            _SOURCE_AGENT_INSTRUCTIONS,
            _SOURCE_AGENT_EXECUTION_GUARDRAILS,
            "## Source Agent Prompt",
            prompt_body,
            "## Source Metadata",
            *metadata_lines,
            "## Evidence Summary",
            *evidence_summary_lines,
            "## Submission Evidence",
            *(f"- {line}" for line in evidence_lines),
        ]
        if len(evidences) > evidence_limit:
            lines.append(f"- additional_evidence_count: {len(evidences) - evidence_limit}")
        rendered = "\n".join(lines)
        rendered += (
            "\n## Estimated Tokens\n"
            f"- estimated_input_tokens: {_estimate_tokens(rendered)}"
        )
        return rendered

    def _select_evidences(self, evidences: list[Evidence], *, limit: int) -> list[Evidence]:
        ranked = sorted(
            evidences,
            key=lambda evidence: (
                1 if evidence.event_frame is not None else 0,
                len(evidence.relationship_hints),
                len(evidence.entity_candidates),
                evidence.trust_score,
                float(evidence.metric_value or 0.0),
            ),
            reverse=True,
        )
        return ranked[:limit]

    def _render_submission_metadata(self, submission: SubmissionRecord) -> list[str]:
        lines = [
            f"- submission_id: {submission.submission_id}",
            f"- submission_status: {submission.status}",
            f"- producer_ref: {submission.producer_ref or '(none)'}",
            f"- payload_count: {len(submission.payloads)}",
            f"- snapshot_count: {len(submission.snapshot_ids)}",
            f"- evidence_count: {len(submission.evidence_ids)}",
            f"- parent_evidence_count: {len(submission.parent_evidence_ids)}",
        ]
        progress = submission.metadata.get("progress")
        if isinstance(progress, dict):
            if progress.get("current_stage"):
                lines.append(f"- progress_stage: {progress['current_stage']}")
            if progress.get("current_stage_message"):
                lines.append(
                    f"- progress_message: {self._truncate(str(progress['current_stage_message']), 120)}"
                )
            warning_targets = progress.get("last_warning_targets")
            if isinstance(warning_targets, list) and warning_targets:
                preview = ", ".join(str(value) for value in warning_targets[:4])
                if len(warning_targets) > 4:
                    preview += ", ..."
                lines.append(f"- warning_targets: {preview}")
        metadata_keys = sorted(str(key) for key in submission.metadata.keys() if key != "progress")
        if metadata_keys:
            lines.append(f"- metadata_keys: {', '.join(metadata_keys[:8])}")
        return lines

    def _render_evidence_summary(self, evidences: list[Evidence]) -> list[str]:
        if not evidences:
            return ["- total_evidence: 0"]
        signal_counts = Counter(evidence.signal_type for evidence in evidences if evidence.signal_type)
        entity_counts = Counter()
        event_count = 0
        relationship_count = 0
        for evidence in evidences:
            entity_counts.update(evidence.entity_candidates[:3])
            if evidence.event_frame is not None:
                event_count += 1
            relationship_count += len(evidence.relationship_hints)
        summary = [
            f"- total_evidence: {len(evidences)}",
            "- signal_types: "
            + ", ".join(f"{signal}={count}" for signal, count in signal_counts.most_common(4)),
            "- top_entities: "
            + (
                ", ".join(f"{entity}({count})" for entity, count in entity_counts.most_common(6))
                if entity_counts
                else "(none)"
            ),
            f"- event_frames: {event_count}",
            f"- relationship_hints: {relationship_count}",
        ]
        return summary

    def _render_evidence_line(self, evidence: Evidence, *, compact: bool) -> str:
        title_max_chars = self.compact_title_max_chars if compact else self.title_max_chars
        parts = [
            evidence.evidence_id,
            evidence.signal_type,
            self._truncate(evidence.title_or_label, title_max_chars),
        ]
        if evidence.entity_candidates:
            parts.append(f"entities={','.join(evidence.entity_candidates[:4])}")
        if evidence.event_frame and evidence.event_frame.summary:
            parts.append(f"event={self._truncate(evidence.event_frame.summary, 80)}")
        if evidence.relationship_hints:
            parts.append(f"relationships={len(evidence.relationship_hints)}")
        if evidence.rank is not None:
            parts.append(f"rank={evidence.rank}")
        if evidence.metric_value is not None:
            parts.append(f"metric={evidence.metric_value}")
        parts.append(f"trust={round(evidence.trust_score, 2)}")
        return " | ".join(parts)

    def _truncate(self, value: str, limit: int) -> str:
        cleaned = " ".join(str(value).split())
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[: limit - 3].rstrip() + "..."
