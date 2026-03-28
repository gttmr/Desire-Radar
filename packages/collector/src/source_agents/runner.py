"""Execution and persistence for collector source-agents."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ..analysis.session import SessionPool
from ..ingest.models import SubmissionRecord
from ..ingest.store import SubmissionStore
from ..normalizer.evidence_schema import Evidence, EvidenceEventFrame
from ..sources.registry import SourceRegistry
from ..store.evidence_sink import EvidenceSink
from .context import SourceAgentContextBuilder
from .models import (
    SourceAgentArtifact,
    SourceAgentDecision,
    SourceAgentRunResult,
)
from .registry import SourceAgentRegistry
from .store import SourceAgentArtifactStore


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SourceAgentRunner:
    def __init__(
        self,
        *,
        source_registry: SourceRegistry,
        agent_registry: SourceAgentRegistry,
        context_builder: SourceAgentContextBuilder,
        artifact_store: SourceAgentArtifactStore,
        session_pool: SessionPool,
        submission_store: SubmissionStore,
        evidence_sink: EvidenceSink,
        enabled: bool = True,
        execution_mode: str = "resume",
    ) -> None:
        self.source_registry = source_registry
        self.agent_registry = agent_registry
        self.context_builder = context_builder
        self.artifact_store = artifact_store
        self.session_pool = session_pool
        self.submission_store = submission_store
        self.evidence_sink = evidence_sink
        self.enabled = enabled
        self.execution_mode = execution_mode

    def status(self, source_id: str) -> dict[str, Any]:
        source = self.source_registry.require(source_id)
        session_state = next(
            (
                state.model_dump()
                for state in self.session_pool.list_states()
                if state.domain == source.agent_session_domain
            ),
            None,
        )
        latest = self.artifact_store.latest_for_source(source_id)
        return {
            "source_id": source_id,
            "global_enabled": self.enabled,
            "agent_enabled": source.agent_enabled,
            "agent_prompt_path": source.agent_prompt_path,
            "agent_session_domain": source.agent_session_domain,
            "agent_output_mode": source.agent_output_mode,
            "latest_artifact": latest.model_dump() if latest is not None else None,
            "session": session_state,
        }

    def preview(self, source_id: str, submission_id: str | None = None) -> dict[str, Any]:
        source = self.source_registry.require(source_id)
        submission, evidences = self._resolve_source_input(source_id, submission_id)
        preview = self.context_builder.build(source_id, submission, evidences)
        return {
            **preview.model_dump(),
            "agent_enabled": source.agent_enabled,
            "global_enabled": self.enabled,
        }

    async def run_latest(
        self,
        source_id: str,
        *,
        submission_id: str | None = None,
    ) -> SourceAgentRunResult:
        source = self.source_registry.require(source_id)
        if not self.enabled:
            raise RuntimeError("source agent runner globally disabled")
        if not source.agent_enabled:
            raise RuntimeError(f"source agent disabled for {source_id}")
        submission, evidences = self._resolve_source_input(source_id, submission_id)
        result = await self.run_for_submission(submission, evidences)
        if result is None:
            raise RuntimeError(f"no source evidence available for {source_id}")
        return result

    async def run_for_submission(
        self,
        submission: SubmissionRecord | None,
        evidences: list[Evidence],
    ) -> SourceAgentRunResult | None:
        if submission is None:
            return None
        source = self.source_registry.require(submission.source_id)
        if not self.enabled or not source.agent_enabled or not evidences:
            return None

        try:
            preview = self.context_builder.build(
                submission.source_id,
                submission,
                evidences,
                mode="standard",
            )
            result, execution_notes = await self._execute_with_fallback(
                preview=preview,
                submission=submission,
                evidences=evidences,
            )
            decision = SourceAgentDecision.model_validate(result.payload or {})
            if execution_notes:
                decision.warnings = [*decision.warnings, *execution_notes]
            derived_evidence = self._build_derived_evidence(
                submission=submission,
                source_tier=source.effective_tier,
                decision=decision,
                parent_evidences=evidences,
            )
            artifact = SourceAgentArtifact(
                artifact_id=uuid.uuid4().hex[:16],
                source_id=submission.source_id,
                submission_id=submission.submission_id,
                status="completed",
                output_mode=source.agent_output_mode,
                session_domain=preview.session_domain,
                session_id=result.session_id,
                session_dir=result.session_dir,
                request_artifact_path=result.request_artifact_path,
                response_artifact_path=result.response_artifact_path,
                model=result.model,
                summary=decision.summary,
                confidence=decision.confidence,
                warnings=decision.warnings,
                theme_tags=decision.theme_tags,
                event_summary=decision.event_summary,
                entity_hints=decision.entity_hints,
                relationship_hints=decision.relationship_hints,
                derived_evidence_ids=[item.evidence_id for item in derived_evidence],
                execution_notes=execution_notes,
                raw_text=result.raw_text,
                usage=result.usage,
                created_at=_now_iso(),
                updated_at=_now_iso(),
            )
            self.artifact_store.put(artifact)
            self.source_registry.record_source_agent_outcome(
                submission.source_id,
                status="completed",
                artifact_id=artifact.artifact_id,
            )
            return SourceAgentRunResult(artifact=artifact, derived_evidence=derived_evidence)
        except Exception as exc:
            artifact = SourceAgentArtifact(
                artifact_id=uuid.uuid4().hex[:16],
                source_id=submission.source_id,
                submission_id=submission.submission_id,
                status="failed",
                output_mode=source.agent_output_mode,
                session_domain=source.agent_session_domain or f"source-agent:{submission.source_id}",
                summary=None,
                confidence=None,
                execution_notes=[],
                error_message=str(exc),
                created_at=_now_iso(),
                updated_at=_now_iso(),
            )
            self.artifact_store.put(artifact)
            self.source_registry.record_source_agent_outcome(
                submission.source_id,
                status="failed",
                artifact_id=artifact.artifact_id,
                error_message=str(exc),
            )
            return SourceAgentRunResult(artifact=artifact, derived_evidence=[])

    async def _execute_with_fallback(
        self,
        *,
        preview: Any,
        submission: SubmissionRecord,
        evidences: list[Evidence],
    ) -> tuple[Any, list[str]]:
        notes: list[str] = []
        failures: list[str] = []
        try:
            result = await self.session_pool.execute_json(
                preview.prompt,
                domain=preview.session_domain,
                execution_mode=self.execution_mode,
            )
            return result, notes
        except Exception as exc:
            failures.append(f"standard={self._short_error(exc)}")
            fallback_modes = self._fallback_modes_for_error(exc)
            if not fallback_modes:
                raise RuntimeError(
                    "source-agent execution failed; "
                    f"initial={self._short_error(exc)}"
                ) from exc
            notes.append(f"initial source-agent execution failed: {self._short_error(exc)}")
        for mode in fallback_modes:
            fallback_preview = self.context_builder.build(
                submission.source_id,
                submission,
                evidences,
                mode=mode,
            )
            notes.append(f"source-agent retried with {mode} context")
            self.session_pool.reset(preview.session_domain)
            try:
                result = await self.session_pool.execute_json(
                    fallback_preview.prompt,
                    domain=fallback_preview.session_domain,
                    execution_mode="fresh",
                )
                return result, notes
            except Exception as fallback_exc:
                failures.append(f"{mode}={self._short_error(fallback_exc)}")
                notes.append(
                    f"{mode} source-agent retry failed: {self._short_error(fallback_exc)}"
                )
        raise RuntimeError(
            "source-agent execution failed; "
            + "; ".join(failures)
        )

    def _resolve_source_input(
        self,
        source_id: str,
        submission_id: str | None,
    ) -> tuple[SubmissionRecord | None, list[Evidence]]:
        submission = self.submission_store.get(submission_id) if submission_id else None
        if submission is None:
            candidates = self.submission_store.query(source_id=source_id, limit=20)
            submission = next(
                (
                    record for record in candidates
                    if record.status == "completed" and record.evidence_ids
                ),
                None,
            )

        evidences: list[Evidence] = []
        if submission is not None and submission.evidence_ids:
            evidences = self.evidence_sink.query_by_ids(submission.evidence_ids)
        if not evidences:
            evidences = self.evidence_sink.query_by_source(source_id)
        if submission is None and evidences:
            submission = SubmissionRecord(
                submission_id=f"synthetic-{source_id}",
                source_id=source_id,
                source_kind=self.source_registry.require(source_id).kind,
                ingestion_mode=self.source_registry.require(source_id).ingestion_mode,
                status="completed",
                evidence_ids=[item.evidence_id for item in evidences],
                snapshot_ids=[],
                received_at=_now_iso(),
                metadata={"synthetic_preview": True},
            )
        return submission, evidences

    def _fallback_modes_for_error(self, exc: Exception) -> list[str]:
        message = self._short_error(exc).lower()
        parse_retry_markers = (
            "invalid json",
            "did not include agent_message",
            "returned unreadable response",
            "parse_failed",
        )
        timeout_retry_markers = (
            "timed out",
            "timeout",
        )
        if any(marker in message for marker in timeout_retry_markers):
            return ["minimal"]
        if any(marker in message for marker in parse_retry_markers):
            return ["compact", "minimal"]
        return []

    def _build_derived_evidence(
        self,
        *,
        submission: SubmissionRecord,
        source_tier: int,
        decision: SourceAgentDecision,
        parent_evidences: list[Evidence],
    ) -> list[Evidence]:
        derived_inputs = list(decision.derived_evidence)
        if (
            not derived_inputs
            and decision.event_summary
            and self.source_registry.require(submission.source_id).agent_output_mode == "artifact_and_derived"
        ):
            entity_candidates = decision.entity_hints or self._fallback_entities(parent_evidences)
            if entity_candidates:
                derived_inputs.append(
                    {
                        "title_or_label": decision.event_summary,
                        "signal_type": "source_agent_signal",
                        "entity_candidates": entity_candidates,
                        "trust_score": max(0.5, decision.confidence or 0.5),
                        "event_frame": EvidenceEventFrame(
                            event_type="source_agent_summary",
                            summary=decision.event_summary,
                            subjects=entity_candidates,
                        ),
                        "relationship_hints": decision.relationship_hints,
                    }
                )

        results: list[Evidence] = []
        for raw_item in derived_inputs:
            item = raw_item if isinstance(raw_item, dict) else raw_item.model_dump(mode="json")
            entities = [str(value).strip() for value in item.get("entity_candidates", []) if str(value).strip()]
            if not entities:
                continue
            event_frame = item.get("event_frame")
            if isinstance(event_frame, dict):
                event_frame = EvidenceEventFrame.model_validate(event_frame)
            results.append(
                Evidence(
                    evidence_id=uuid.uuid4().hex[:16],
                    source=submission.source_id,
                    source_tier=source_tier,
                    source_kind="derived",
                    producer_ref=f"source_agent:{submission.source_id}",
                    parent_evidence_ids=[item.evidence_id for item in parent_evidences],
                    submission_ref=submission.submission_id,
                    collected_at=_now_iso(),
                    entity_candidates=entities,
                    signal_type=str(item.get("signal_type", "source_agent_signal")).strip() or "source_agent_signal",
                    title_or_label=str(item.get("title_or_label", "Source agent derived signal")).strip(),
                    metric_value=item.get("metric_value"),
                    metric_delta=item.get("metric_delta"),
                    rank=item.get("rank"),
                    geo=str(item.get("geo", "global")).strip() or "global",
                    url_or_ref="",
                    raw_snapshot_ref="",
                    trust_score=float(item.get("trust_score", max(0.5, decision.confidence or 0.5))),
                    tos_risk="none",
                    freshness_ttl=int(item.get("freshness_ttl", 21600)),
                    event_frame=event_frame,
                    relationship_hints=item.get("relationship_hints", []),
                )
            )
        return results

    def _short_error(self, exc: Exception) -> str:
        message = str(exc).strip()
        if len(message) <= 240:
            return message
        return message[:237].rstrip() + "..."

    def _fallback_entities(self, evidences: list[Evidence]) -> list[str]:
        entities: list[str] = []
        for evidence in evidences:
            for entity in evidence.entity_candidates:
                if entity not in entities:
                    entities.append(entity)
        return entities[:4]
