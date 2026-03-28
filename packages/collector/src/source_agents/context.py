"""Prompt construction for collector source-agents."""

from __future__ import annotations

import math
from collections import Counter
from typing import Any, Literal

from ..ingest.models import SubmissionRecord
from ..normalizer.evidence_schema import Evidence
from .models import SourceAgentPromptPreview
from .registry import SourceAgentRegistry

SourceAgentContextMode = Literal["standard", "compact", "minimal"]

_STANDARD_INSTRUCTIONS = """Return one JSON object only.
Required keys:
- summary
- confidence

Optional keys when clearly supported by the prompt:
- warnings
- theme_tags
- event_summary
- entity_hints
- relationship_hints
- derived_evidence

Rules:
- keep confidence between 0 and 1
- prefer omission over guessing
- keep summary to at most two sentences
- keep theme_tags to at most 3 short tags
- keep entity_hints to at most 4 items
- keep relationship_hints to at most 2 objects with keys: from, to, kind, confidence, rationale
- keep derived_evidence to at most 1 object with keys: title_or_label, signal_type, entity_candidates, metric_value, metric_delta, rank, geo, trust_score, freshness_ttl, event_frame, relationship_hints
- only emit derived_evidence when it adds source-level event/theme structure beyond raw evidence"""
_COMPACT_INSTRUCTIONS = """Return one compact JSON object only.
Required keys:
- summary
- confidence

Optional keys:
- warnings
- theme_tags
- event_summary
- entity_hints

Rules:
- keep summary to one short sentence
- keep theme_tags to at most 2 short tags
- keep entity_hints to at most 3 items
- omit relationship_hints and derived_evidence unless the signal is unmistakable
- prefer omission over speculation"""
_MINIMAL_INSTRUCTIONS = """Return one very small JSON object only.
Required keys:
- summary
- confidence

Optional keys:
- warnings
- theme_tags
- entity_hints

Rules:
- keep summary to one short sentence
- keep theme_tags to at most 2 short tags
- keep entity_hints to at most 2 items
- do not include relationship_hints
- do not include derived_evidence
- prefer omission over speculation"""
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
        compact_evidence_limit: int = 3,
        minimal_input_chars: int | None = None,
        minimal_evidence_limit: int = 2,
        title_max_chars: int = 120,
        compact_title_max_chars: int = 84,
        minimal_title_max_chars: int = 72,
    ) -> None:
        self.registry = registry
        self.max_input_chars = max_input_chars
        self.evidence_limit = evidence_limit
        self.compact_input_chars = compact_input_chars or max(1800, min(3200, max_input_chars // 3))
        self.compact_evidence_limit = compact_evidence_limit
        self.minimal_input_chars = minimal_input_chars or max(
            1200,
            min(1800, self.compact_input_chars - 400),
        )
        self.minimal_evidence_limit = minimal_evidence_limit
        self.title_max_chars = title_max_chars
        self.compact_title_max_chars = compact_title_max_chars
        self.minimal_title_max_chars = minimal_title_max_chars

    def build(
        self,
        source_id: str,
        submission: SubmissionRecord | None,
        evidences: list[Evidence],
        *,
        mode: SourceAgentContextMode = "standard",
    ) -> SourceAgentPromptPreview:
        source = self.registry.get_source(source_id)
        prompt_body = self.registry.load_prompt(source_id)
        rendered = self._render_prompt(
            prompt_body,
            source,
            submission,
            evidences,
            mode=mode,
        )
        max_chars = self._max_input_chars_for_mode(mode)
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
        mode: SourceAgentContextMode,
    ) -> str:
        evidence_limit = self._evidence_limit_for_mode(mode)
        evidence_lines = [
            self._render_evidence_line(item, mode=mode)
            for item in self._select_evidences(evidences, limit=evidence_limit)
        ]
        metadata_lines = self._render_source_metadata(source, mode=mode)
        if submission is not None:
            metadata_lines.extend(self._render_submission_metadata(submission, mode=mode))
        evidence_summary_lines = self._render_evidence_summary(evidences, mode=mode)
        lines = [
            self._instructions_for_mode(mode),
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
        if mode != "minimal":
            rendered += (
                "\n## Estimated Tokens\n"
                f"- estimated_input_tokens: {_estimate_tokens(rendered)}"
            )
        return rendered

    def _instructions_for_mode(self, mode: SourceAgentContextMode) -> str:
        if mode == "minimal":
            return _MINIMAL_INSTRUCTIONS
        if mode == "compact":
            return _COMPACT_INSTRUCTIONS
        return _STANDARD_INSTRUCTIONS

    def _max_input_chars_for_mode(self, mode: SourceAgentContextMode) -> int:
        if mode == "minimal":
            return self.minimal_input_chars
        if mode == "compact":
            return self.compact_input_chars
        return self.max_input_chars

    def _evidence_limit_for_mode(self, mode: SourceAgentContextMode) -> int:
        if mode == "minimal":
            return self.minimal_evidence_limit
        if mode == "compact":
            return self.compact_evidence_limit
        return self.evidence_limit

    def _render_source_metadata(self, source: Any, *, mode: SourceAgentContextMode) -> list[str]:
        lines = [
            f"- context_mode: {mode}",
            f"- source_id: {source.source_id}",
            f"- source_kind: {source.kind}",
            f"- effective_tier: {source.effective_tier}",
        ]
        if mode != "minimal":
            lines.append(f"- ingestion_mode: {source.ingestion_mode}")
            lines.append(
                f"- capabilities: {', '.join(source.capabilities) if source.capabilities else '(none)'}"
            )
        return lines

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

    def _render_submission_metadata(
        self,
        submission: SubmissionRecord,
        *,
        mode: SourceAgentContextMode,
    ) -> list[str]:
        lines = [
            f"- submission_id: {submission.submission_id}",
            f"- submission_status: {submission.status}",
            f"- payload_count: {len(submission.payloads)}",
            f"- evidence_count: {len(submission.evidence_ids)}",
        ]
        if mode != "minimal":
            lines.extend(
                [
                    f"- producer_ref: {submission.producer_ref or '(none)'}",
                    f"- snapshot_count: {len(submission.snapshot_ids)}",
                    f"- parent_evidence_count: {len(submission.parent_evidence_ids)}",
                ]
            )
        progress = submission.metadata.get("progress")
        if isinstance(progress, dict):
            if progress.get("current_stage"):
                lines.append(f"- progress_stage: {progress['current_stage']}")
            if progress.get("current_stage_message") and mode != "minimal":
                lines.append(
                    f"- progress_message: {self._truncate(str(progress['current_stage_message']), 120)}"
                )
            warning_targets = progress.get("last_warning_targets")
            if mode == "standard" and isinstance(warning_targets, list) and warning_targets:
                preview = ", ".join(str(value) for value in warning_targets[:4])
                if len(warning_targets) > 4:
                    preview += ", ..."
                lines.append(f"- warning_targets: {preview}")
        metadata_keys = sorted(str(key) for key in submission.metadata.keys() if key != "progress")
        if mode == "standard" and metadata_keys:
            lines.append(f"- metadata_keys: {', '.join(metadata_keys[:8])}")
        return lines

    def _render_evidence_summary(
        self,
        evidences: list[Evidence],
        *,
        mode: SourceAgentContextMode,
    ) -> list[str]:
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
        ]
        if mode != "minimal":
            summary.extend(
                [
                    f"- event_frames: {event_count}",
                    f"- relationship_hints: {relationship_count}",
                ]
            )
        return summary

    def _render_evidence_line(self, evidence: Evidence, *, mode: SourceAgentContextMode) -> str:
        if mode == "minimal":
            title_max_chars = self.minimal_title_max_chars
        elif mode == "compact":
            title_max_chars = self.compact_title_max_chars
        else:
            title_max_chars = self.title_max_chars
        parts = [
            evidence.evidence_id,
            evidence.signal_type,
            self._truncate(evidence.title_or_label, title_max_chars),
        ]
        if evidence.entity_candidates:
            entity_limit = 2 if mode == "minimal" else 4
            parts.append(f"entities={','.join(evidence.entity_candidates[:entity_limit])}")
        if evidence.event_frame and evidence.event_frame.summary and mode != "minimal":
            parts.append(f"event={self._truncate(evidence.event_frame.summary, 80)}")
        if evidence.relationship_hints and mode == "standard":
            parts.append(f"relationships={len(evidence.relationship_hints)}")
        if evidence.rank is not None and mode != "minimal":
            parts.append(f"rank={evidence.rank}")
        if evidence.metric_value is not None and mode == "standard":
            parts.append(f"metric={evidence.metric_value}")
        parts.append(f"trust={round(evidence.trust_score, 2)}")
        return " | ".join(parts)

    def _truncate(self, value: str, limit: int) -> str:
        cleaned = " ".join(str(value).split())
        if len(cleaned) <= limit:
            return cleaned
        return cleaned[: limit - 3].rstrip() + "..."
