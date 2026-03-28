"""Common ingestion engine for pull and push sources."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from ..analysis.engine import AnalysisEngine
from ..connectors.base import BaseConnector, ConnectorWarning, FetchResult, RawPayload
from ..ingest.derived import build_derived_evidence
from ..ingest.human_input_models import HumanInputEnvelope, HumanInputRoutingDecision
from ..ingest.human_input_router import HumanInputRouter
from ..ingest.models import SubmissionRecord
from ..ingest.store import SubmissionStore
from ..normalizer.evidence_schema import Evidence
from ..resolver.entity_resolver import EntityResolver
from ..source_agents.runner import SourceAgentRunner
from ..sources.registry import SourceRegistry

logger = logging.getLogger(__name__)


class IngestionEngine:
    def __init__(
        self,
        *,
        source_registry: SourceRegistry,
        submission_store: SubmissionStore,
        snapshot_store: Any,
        evidence_sink: Any,
        entity_resolver: EntityResolver,
        normalizer_fn: Any,
        connectors: dict[str, BaseConnector],
        analysis_engine: AnalysisEngine | None = None,
        human_input_router: HumanInputRouter | None = None,
        source_agent_runner: SourceAgentRunner | None = None,
        source_run_worker_concurrency: int = 2,
        processing_yield_every: int = 1,
    ) -> None:
        self.source_registry = source_registry
        self.submission_store = submission_store
        self.snapshot_store = snapshot_store
        self.evidence_sink = evidence_sink
        self.entity_resolver = entity_resolver
        self.normalizer_fn = normalizer_fn
        self.connectors = connectors
        self.analysis_engine = analysis_engine
        self.human_input_router = human_input_router
        self.source_agent_runner = source_agent_runner
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._source_run_queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._source_workers: list[asyncio.Task] = []
        self._running = False
        self._source_run_worker_concurrency = max(1, source_run_worker_concurrency)
        self._processing_yield_every = max(1, processing_yield_every)
        self._source_runtime: dict[str, dict[str, Any]] = {}
        for source in self.source_registry.list():
            self._source_runtime[source.source_id] = self._new_source_runtime()

    async def start(self) -> None:
        self._running = True
        self._worker = asyncio.create_task(self._worker_loop())
        self._source_workers = [
            asyncio.create_task(self._source_worker_loop(index))
            for index in range(self._source_run_worker_concurrency)
        ]

    async def stop(self) -> None:
        self._running = False
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
        for worker in self._source_workers:
            worker.cancel()
        for worker in self._source_workers:
            try:
                await worker
            except asyncio.CancelledError:
                pass
        self._source_workers = []

    async def enqueue_source_run(
        self,
        source_id: str,
        *,
        producer_ref: str | None = None,
        request_params: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SubmissionRecord:
        source = self.source_registry.require(source_id)
        if not source.enabled:
            raise ValueError(f"Source disabled: {source_id}")
        if not source.runnable:
            raise ValueError(f"Source is not runnable: {source_id}")

        trigger = str((metadata or {}).get("trigger", "manual"))
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id=source_id,
            source_kind=source.kind,
            ingestion_mode=source.ingestion_mode,
            status="pending",
            producer_ref=producer_ref or source.default_producer_ref,
            received_at=self._now(),
            request_params=request_params or {},
            metadata={**(metadata or {}), "trigger": trigger},
        )
        self.submission_store.create(record)
        self._mark_source_queued(source_id, record.submission_id, trigger=trigger)
        await self._source_run_queue.put(record.submission_id)
        return record

    async def enqueue_raw(
        self,
        source_id: str,
        payloads: list[dict[str, Any]],
        *,
        producer_ref: str | None = None,
        request_params: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SubmissionRecord:
        source = self.source_registry.require(source_id)
        if not source.enabled:
            raise ValueError(f"Source disabled: {source_id}")
        if source.ingestion_mode != "raw":
            raise ValueError(f"Source does not accept raw payloads: {source_id}")

        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id=source_id,
            source_kind=source.kind,
            ingestion_mode="raw",
            status="pending",
            producer_ref=producer_ref or source.default_producer_ref,
            received_at=self._now(),
            payloads=payloads,
            request_params=request_params or {},
            metadata=metadata or {},
        )
        self.submission_store.create(record)
        self.source_registry.record_submission(source_id)
        await self._queue.put(record.submission_id)
        return record

    async def enqueue_evidence(
        self,
        source_id: str,
        evidence_payloads: list[dict[str, Any]],
        *,
        producer_ref: str | None = None,
        parent_evidence_ids: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SubmissionRecord:
        source = self.source_registry.require(source_id)
        if not source.enabled:
            raise ValueError(f"Source disabled: {source_id}")
        if source.ingestion_mode != "evidence":
            raise ValueError(f"Source does not accept evidence payloads: {source_id}")

        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id=source_id,
            source_kind=source.kind,
            ingestion_mode="evidence",
            status="pending",
            producer_ref=producer_ref or source.default_producer_ref,
            received_at=self._now(),
            evidence_payloads=evidence_payloads,
            parent_evidence_ids=parent_evidence_ids or [],
            metadata=metadata or {},
        )
        self.submission_store.create(record)
        self.source_registry.record_submission(source_id)
        await self._queue.put(record.submission_id)
        return record

    async def submit_human_observation(
        self,
        payload: dict[str, Any],
        *,
        async_mode: bool,
    ) -> SubmissionRecord:
        if async_mode:
            return await self.enqueue_raw(
                "manual_observation",
                [payload],
                producer_ref=payload.get("reporter") or "human",
            )
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id="manual_observation",
            source_kind="human",
            ingestion_mode="raw",
            status="pending",
            producer_ref=payload.get("reporter") or "human",
            received_at=self._now(),
            payloads=[payload],
        )
        self.submission_store.create(record)
        self.source_registry.record_submission("manual_observation")
        return await self._process_raw_submission(record, is_submission=True)

    async def submit_human_analyst_note(
        self,
        payload: dict[str, Any],
        *,
        async_mode: bool,
    ) -> SubmissionRecord:
        title = payload.get("title") or payload.get("observation") or "Analyst note"
        evidence_payload = {
            "evidence_id": uuid.uuid4().hex[:16],
            "source": "human_analyst_note",
            "entity_candidates": payload.get("entity_candidates", []),
            "signal_type": "human_analyst_note",
            "title_or_label": title,
            "metric_value": None,
            "metric_delta": None,
            "rank": None,
            "geo": payload.get("geo", "global"),
            "url_or_ref": "",
            "trust_score": payload.get("confidence", 0.8),
            "freshness_ttl": 172800,
        }
        if async_mode:
            return await self.enqueue_evidence(
                "human_analyst_note",
                [evidence_payload],
                producer_ref=payload.get("producer_ref") or "human-analyst",
                metadata={
                    "observation": payload.get("observation", ""),
                    "why_now": payload.get("why_now", ""),
                    "beneficiary_hints": payload.get("beneficiary_hints", []),
                    "research_questions": payload.get("research_questions", []),
                    "source_refs": payload.get("source_refs", []),
                    "supporting_points": payload.get("supporting_points", []),
                    "channel": payload.get("channel", "analyst"),
                    "geo": payload.get("geo", "global"),
                    "study_type": payload.get("study_type", "analysis_note"),
                    "request_submission_id": payload.get("request_submission_id"),
                },
            )
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id="human_analyst_note",
            source_kind="human",
            ingestion_mode="evidence",
            status="pending",
            producer_ref=payload.get("producer_ref") or "human-analyst",
            received_at=self._now(),
            evidence_payloads=[evidence_payload],
            metadata={
                "observation": payload.get("observation", ""),
                "why_now": payload.get("why_now", ""),
                "beneficiary_hints": payload.get("beneficiary_hints", []),
                "research_questions": payload.get("research_questions", []),
                "source_refs": payload.get("source_refs", []),
                "supporting_points": payload.get("supporting_points", []),
                "channel": payload.get("channel", "analyst"),
                "geo": payload.get("geo", "global"),
                "study_type": payload.get("study_type", "analysis_note"),
                "request_submission_id": payload.get("request_submission_id"),
            },
        )
        self.submission_store.create(record)
        self.source_registry.record_submission("human_analyst_note")
        return await self._process_evidence_submission(record, is_submission=True)

    async def submit_human_evidence_batch(
        self,
        payload: dict[str, Any],
        *,
        async_mode: bool = True,
    ) -> SubmissionRecord:
        if async_mode:
            return await self.enqueue_evidence(
                "human_curated_dataset",
                payload.get("evidence_items", []),
                producer_ref=payload.get("producer_ref") or "human-data",
                parent_evidence_ids=payload.get("parent_evidence_ids", []),
                metadata={
                    "dataset_name": payload.get("dataset_name"),
                    "channel": payload.get("channel", "human-data"),
                    "notes": payload.get("notes", ""),
                    "request_submission_id": payload.get("request_submission_id"),
                },
            )
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id="human_curated_dataset",
            source_kind="human",
            ingestion_mode="evidence",
            status="pending",
            producer_ref=payload.get("producer_ref") or "human-data",
            received_at=self._now(),
            evidence_payloads=payload.get("evidence_items", []),
            parent_evidence_ids=payload.get("parent_evidence_ids", []),
            metadata={
                "dataset_name": payload.get("dataset_name"),
                "channel": payload.get("channel", "human-data"),
                "notes": payload.get("notes", ""),
                "request_submission_id": payload.get("request_submission_id"),
            },
        )
        self.submission_store.create(record)
        self.source_registry.record_submission("human_curated_dataset")
        return await self._process_evidence_submission(record, is_submission=True)

    async def submit_human_input(
        self,
        payload: dict[str, Any],
    ) -> SubmissionRecord:
        envelope = HumanInputEnvelope.model_validate(payload)
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id="human_input_inbox",
            source_kind="human",
            ingestion_mode="raw",
            status="running",
            producer_ref=envelope.producer_ref or "human-input",
            received_at=self._now(),
            payloads=[envelope.model_dump()],
            metadata={
                "message_url": envelope.message_url,
                "attachment_urls": envelope.attachment_urls,
                "author_id": envelope.author_id,
                "author_name": envelope.author_name,
                "guild_id": envelope.guild_id,
                "channel_id": envelope.channel_id,
                "channel_name": envelope.channel_name,
                "message_id": envelope.message_id,
                "thread_id": envelope.thread_id,
                "thread_name": envelope.thread_name,
                "request_submission_id": envelope.request_submission_id,
            },
        )
        self.submission_store.create(record)
        self.source_registry.record_submission("human_input_inbox")
        return await self._process_human_input_submission(record, envelope)

    async def request_human_analyst_note(self, payload: dict[str, Any]) -> SubmissionRecord:
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id="human_analyst_note",
            source_kind="human",
            ingestion_mode="evidence",
            status="pending_human",
            producer_ref=payload.get("producer_ref") or "human-analyst",
            received_at=self._now(),
            metadata={
                "entity_candidates": payload.get("entity_candidates", []),
                "question": payload.get("question", ""),
                "why_now": payload.get("why_now", ""),
                "priority": payload.get("priority", "normal"),
                "requested_by_agent": payload.get("requested_by_agent"),
                "run_id": payload.get("run_id"),
                "intent": payload.get("intent", "demand"),
                "requested_input_kind": payload.get("requested_input_kind", "study_result"),
                "required_fields": payload.get("required_fields", []),
                "preferred_capabilities": payload.get("preferred_capabilities", []),
                "source_hints": payload.get("source_hints", []),
            },
        )
        self.submission_store.create(record)
        self.source_registry.record_submission("human_analyst_note")
        return record

    async def run_source(
        self,
        source_id: str,
        *,
        producer_ref: str | None = None,
        request_params: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SubmissionRecord:
        source = self.source_registry.require(source_id)
        if not source.enabled:
            raise ValueError(f"Source disabled: {source_id}")
        if not source.runnable:
            raise ValueError(f"Source is not runnable: {source_id}")

        trigger = str((metadata or {}).get("trigger", "manual"))

        if source.kind == "derived":
            record = SubmissionRecord(
                submission_id=self._gen_id(),
                source_id=source_id,
                source_kind=source.kind,
                ingestion_mode="evidence",
                status="running",
                producer_ref=producer_ref or source.default_producer_ref,
                received_at=self._now(),
                request_params=request_params or {},
                metadata={**(metadata or {}), "trigger": trigger},
            )
            self.submission_store.create(record)
        else:
            record = SubmissionRecord(
                submission_id=self._gen_id(),
                source_id=source_id,
                source_kind=source.kind,
                ingestion_mode="raw",
                status="running",
                producer_ref=producer_ref or source.default_producer_ref,
                received_at=self._now(),
                request_params=request_params or {},
                metadata={**(metadata or {}), "trigger": trigger},
            )
            self.submission_store.create(record)
        return await self._execute_source_run(record)

    async def get_submission(self, submission_id: str) -> SubmissionRecord | None:
        return self.submission_store.get(submission_id)

    def get_runtime_status(self) -> dict[str, Any]:
        sources = {}
        active_sources = 0
        for source_id in sorted(self._source_runtime):
            runtime = self._source_runtime[source_id]
            snapshot = {
                "run_state": runtime["run_state"],
                "queued_runs": runtime["queued_runs"],
                "active_runs": runtime["active_runs"],
                "active_submission_ids": list(runtime["active_submission_ids"]),
                "current_stage": runtime["current_stage"],
                "current_stage_message": runtime["current_stage_message"],
                "last_progress_at": runtime["last_progress_at"],
                "last_trigger": runtime["last_trigger"],
                "last_submission_id": runtime["last_submission_id"],
                "last_started_at": runtime["last_started_at"],
                "last_finished_at": runtime["last_finished_at"],
                "last_error": runtime["last_error"],
                "last_failure_kind": runtime["last_failure_kind"],
                "last_outcome": runtime["last_outcome"],
                "payload_total": runtime["payload_total"],
                "payloads_processed": runtime["payloads_processed"],
                "snapshot_total": runtime["snapshot_total"],
                "evidence_total": runtime["evidence_total"],
                "source_agent_status": runtime["source_agent_status"],
                "source_agent_artifact_id": runtime["source_agent_artifact_id"],
                "source_agent_error": runtime["source_agent_error"],
                "derived_evidence_total": runtime["derived_evidence_total"],
                "resolve_success_total": runtime["resolve_success_total"],
                "resolve_miss_total": runtime["resolve_miss_total"],
                "partial_failure_count": runtime["partial_failure_count"],
                "last_warning_kind": runtime["last_warning_kind"],
                "last_warning_count": runtime["last_warning_count"],
                "last_warning_message": runtime["last_warning_message"],
                "last_warning_targets": list(runtime["last_warning_targets"]),
            }
            active_sources += 1 if runtime["active_runs"] > 0 else 0
            sources[source_id] = snapshot
        return {
            "source_run_queue_size": self._source_run_queue.qsize(),
            "source_run_worker_concurrency": self._source_run_worker_concurrency,
            "active_source_count": active_sources,
            "sources": sources,
        }

    async def _worker_loop(self) -> None:
        while self._running:
            submission_id = await self._queue.get()
            try:
                record = self.submission_store.get(submission_id)
                if record is None:
                    continue
                if record.ingestion_mode == "raw":
                    await self._process_raw_submission(record, is_submission=True)
                else:
                    await self._process_evidence_submission(record, is_submission=True)
            except Exception:
                logger.exception("Failed to process submission %s", submission_id)
            finally:
                self._queue.task_done()

    async def _source_worker_loop(self, _worker_index: int) -> None:
        while self._running:
            submission_id = await self._source_run_queue.get()
            try:
                record = self.submission_store.get(submission_id)
                if record is None:
                    continue
                await self._execute_source_run(record)
            except Exception:
                logger.exception("Failed to execute source run %s", submission_id)
            finally:
                self._source_run_queue.task_done()

    async def _execute_source_run(self, record: SubmissionRecord) -> SubmissionRecord:
        trigger = str(record.metadata.get("trigger", "manual"))
        self._mark_source_running(record.source_id, record.submission_id, trigger=trigger)
        running_record = self.submission_store.update(
            record.submission_id,
            status="running",
        )
        try:
            source = self.source_registry.require(running_record.source_id)
            if source.kind == "derived":
                self._update_source_progress(
                    running_record.source_id,
                    running_record.submission_id,
                    stage="building_derived_evidence",
                    message="building evidence from existing graph state",
                )
                updated = await self._process_derived_submission(
                    running_record,
                    is_submission=False,
                )
            else:
                self._update_source_progress(
                    running_record.source_id,
                    running_record.submission_id,
                    stage="fetching",
                    message="waiting for connector fetch to complete",
                )
                connector = self.connectors.get(source.adapter_name)
                if connector is None:
                    raise ValueError(
                        f"Runnable source has no connector adapter: {running_record.source_id}"
                    )
                fetch_result = await connector.fetch()
                payloads, warnings = self._normalize_fetch_result(fetch_result)
                warning_dicts = [self._warning_to_dict(item) for item in warnings]
                running = self.submission_store.update(
                    running_record.submission_id,
                    status="running",
                    payloads=[payload.data for payload in payloads],
                    metadata={
                        **running_record.metadata,
                        "warnings": warning_dicts,
                    },
                )
                self._update_source_progress(
                    running_record.source_id,
                    running_record.submission_id,
                    stage="processing_payloads",
                    message=f"fetched {len(payloads)} payloads from connector",
                    payload_total=len(payloads),
                    payloads_processed=0,
                    snapshot_total=0,
                    evidence_total=0,
                    resolve_success_total=0,
                    resolve_miss_total=0,
                    partial_failure_count=len(warnings),
                    last_warning_count=len(warnings),
                    last_warning_kind=self._primary_warning_value(warning_dicts, "kind"),
                    last_warning_message=self._primary_warning_value(warning_dicts, "message"),
                    last_warning_targets=self._warning_targets(warning_dicts),
                )
                updated = await self._process_raw_payloads(
                    running,
                    source_id=running_record.source_id,
                    source_kind=running_record.source_kind,
                    payloads=payloads,
                    warnings=warnings,
                    is_run=True,
                    is_submission=False,
                )
        except Exception as exc:
            failure_kind = self._classify_runtime_failure(exc)
            updated = self.submission_store.update(
                running_record.submission_id,
                status="failed",
                error_message=str(exc),
                processed_at=self._now(),
            )
            updated = self._update_source_progress(
                running_record.source_id,
                running_record.submission_id,
                stage="failed",
                message=str(exc),
            )
            self.source_registry.record_processing(
                running_record.source_id,
                success=False,
                failure_kind=failure_kind,
                failure_message=str(exc),
                is_run=True,
                is_submission=False,
            )
            self._mark_source_finished(
                running_record.source_id,
                running_record.submission_id,
                outcome="failed",
                error_message=str(exc),
                failure_kind=failure_kind,
            )
            return updated

        self._mark_source_finished(
            running_record.source_id,
            running_record.submission_id,
            outcome=(
                "completed_with_warnings"
                if updated.metadata.get("warnings")
                else updated.status
            ),
            error_message=updated.error_message,
            failure_kind=(
                self._classify_runtime_failure(Exception(updated.error_message))
                if updated.status == "failed" and updated.error_message
                else None
            ),
            warning_kind=self._primary_warning_value(updated.metadata.get("warnings"), "kind"),
            warning_count=len(updated.metadata.get("warnings", [])),
            warning_message=self._primary_warning_value(updated.metadata.get("warnings"), "message"),
            warning_targets=self._warning_targets(updated.metadata.get("warnings")),
        )
        return updated

    def _new_source_runtime(self) -> dict[str, Any]:
        return {
            "run_state": "idle",
            "queued_runs": 0,
            "active_runs": 0,
            "active_submission_ids": [],
            "current_stage": None,
            "current_stage_message": None,
            "last_progress_at": None,
            "last_trigger": None,
            "last_submission_id": None,
            "last_started_at": None,
            "last_finished_at": None,
            "last_error": None,
            "last_failure_kind": None,
            "last_outcome": None,
            "payload_total": 0,
            "payloads_processed": 0,
            "snapshot_total": 0,
            "evidence_total": 0,
            "source_agent_status": None,
            "source_agent_artifact_id": None,
            "source_agent_error": None,
            "derived_evidence_total": 0,
            "resolve_success_total": 0,
            "resolve_miss_total": 0,
            "partial_failure_count": 0,
            "last_warning_kind": None,
            "last_warning_count": 0,
            "last_warning_message": None,
            "last_warning_targets": [],
        }

    def _runtime_for_source(self, source_id: str) -> dict[str, Any]:
        runtime = self._source_runtime.get(source_id)
        if runtime is None:
            runtime = self._new_source_runtime()
            self._source_runtime[source_id] = runtime
        return runtime

    def _mark_source_queued(self, source_id: str, submission_id: str, *, trigger: str) -> None:
        runtime = self._runtime_for_source(source_id)
        runtime["queued_runs"] += 1
        runtime["last_trigger"] = trigger
        runtime["last_submission_id"] = submission_id
        runtime["current_stage"] = "queued"
        runtime["current_stage_message"] = "waiting for a source worker"
        runtime["last_progress_at"] = self._now()
        if runtime["active_runs"] <= 0:
            runtime["run_state"] = "queued"

    def _mark_source_running(self, source_id: str, submission_id: str, *, trigger: str) -> None:
        runtime = self._runtime_for_source(source_id)
        runtime["queued_runs"] = max(0, int(runtime["queued_runs"]) - 1)
        runtime["active_runs"] += 1
        active_ids = list(runtime["active_submission_ids"])
        if submission_id not in active_ids:
            active_ids.append(submission_id)
        runtime["active_submission_ids"] = active_ids
        runtime["run_state"] = "running"
        runtime["last_trigger"] = trigger
        runtime["last_submission_id"] = submission_id
        runtime["last_started_at"] = self._now()
        runtime["last_progress_at"] = runtime["last_started_at"]
        runtime["current_stage"] = "starting"
        runtime["current_stage_message"] = "source worker claimed this run"
        runtime["last_error"] = None
        runtime["last_failure_kind"] = None
        runtime["payload_total"] = 0
        runtime["payloads_processed"] = 0
        runtime["snapshot_total"] = 0
        runtime["evidence_total"] = 0
        runtime["source_agent_status"] = None
        runtime["source_agent_artifact_id"] = None
        runtime["source_agent_error"] = None
        runtime["derived_evidence_total"] = 0
        runtime["resolve_success_total"] = 0
        runtime["resolve_miss_total"] = 0
        runtime["partial_failure_count"] = 0
        runtime["last_warning_kind"] = None
        runtime["last_warning_count"] = 0
        runtime["last_warning_message"] = None
        runtime["last_warning_targets"] = []

    def _mark_source_finished(
        self,
        source_id: str,
        submission_id: str,
        *,
        outcome: str,
        error_message: str | None,
        failure_kind: str | None = None,
        warning_kind: str | None = None,
        warning_count: int = 0,
        warning_message: str | None = None,
        warning_targets: list[str] | None = None,
    ) -> None:
        runtime = self._runtime_for_source(source_id)
        runtime["active_runs"] = max(0, int(runtime["active_runs"]) - 1)
        runtime["active_submission_ids"] = [
            item
            for item in runtime["active_submission_ids"]
            if item != submission_id
        ]
        runtime["last_finished_at"] = self._now()
        runtime["last_progress_at"] = runtime["last_finished_at"]
        runtime["last_outcome"] = outcome
        runtime["last_error"] = error_message
        runtime["last_failure_kind"] = failure_kind
        runtime["current_stage"] = outcome
        runtime["current_stage_message"] = error_message or warning_message
        runtime["partial_failure_count"] = warning_count
        runtime["last_warning_kind"] = warning_kind
        runtime["last_warning_count"] = warning_count
        runtime["last_warning_message"] = warning_message
        runtime["last_warning_targets"] = list(warning_targets or [])
        if runtime["active_runs"] > 0:
            runtime["run_state"] = "running"
        elif runtime["queued_runs"] > 0:
            runtime["run_state"] = "queued"
        elif outcome == "failed":
            runtime["run_state"] = "failed"
        else:
            runtime["run_state"] = "idle"

    def _normalize_fetch_result(
        self,
        result: list[RawPayload] | FetchResult,
    ) -> tuple[list[RawPayload], list[ConnectorWarning]]:
        if isinstance(result, FetchResult):
            return list(result.payloads), list(result.warnings)
        return list(result), []

    def _warning_to_dict(self, warning: ConnectorWarning) -> dict[str, Any]:
        return {
            "kind": warning.kind,
            "message": warning.message,
            "target": warning.target,
            "recoverable": warning.recoverable,
        }

    def _classify_runtime_failure(self, error: Exception) -> str:
        message = str(error).lower()
        if "403" in message or "forbidden" in message or "blocked" in message:
            return "http_403_blocked"
        if "timeout" in message:
            return "timeout"
        if "normalizer" in message:
            return "normalizer_failed"
        if "resolve" in message:
            return "entity_resolver_failed"
        return "run_failed"

    def _primary_warning_value(
        self,
        warnings: Any,
        field: str,
    ) -> str | None:
        if not isinstance(warnings, list) or not warnings:
            return None
        first = warnings[0]
        if not isinstance(first, dict):
            return None
        value = first.get(field)
        return str(value) if value is not None else None

    def _warning_targets(self, warnings: Any) -> list[str]:
        if not isinstance(warnings, list):
            return []
        targets: list[str] = []
        for item in warnings:
            if not isinstance(item, dict):
                continue
            target = item.get("target")
            if target is None:
                continue
            normalized = str(target).strip()
            if normalized and normalized not in targets:
                targets.append(normalized)
        return targets[:5]

    def _update_submission_progress(
        self,
        submission_id: str,
        *,
        stage: str,
        message: str | None = None,
        **counts: Any,
    ) -> SubmissionRecord:
        record = self.submission_store.get(submission_id)
        if record is None:
            raise KeyError(submission_id)
        metadata = dict(record.metadata)
        progress = dict(metadata.get("progress") or {})
        progress["stage"] = stage
        progress["updated_at"] = self._now()
        if message is not None:
            progress["message"] = message
        for key, value in counts.items():
            if value is not None:
                progress[key] = value
        metadata["progress"] = progress
        return self.submission_store.update(submission_id, metadata=metadata)

    def _update_source_progress(
        self,
        source_id: str,
        submission_id: str,
        *,
        stage: str,
        message: str | None = None,
        **counts: Any,
    ) -> SubmissionRecord:
        runtime = self._runtime_for_source(source_id)
        runtime["current_stage"] = stage
        runtime["current_stage_message"] = message
        runtime["last_progress_at"] = self._now()
        for key in (
            "payload_total",
            "payloads_processed",
            "snapshot_total",
            "evidence_total",
            "derived_evidence_total",
            "resolve_success_total",
            "resolve_miss_total",
            "partial_failure_count",
            "last_warning_count",
        ):
            if key in counts and counts[key] is not None:
                runtime[key] = counts[key]
        if counts.get("source_agent_status") is not None:
            runtime["source_agent_status"] = counts["source_agent_status"]
        if counts.get("source_agent_artifact_id") is not None:
            runtime["source_agent_artifact_id"] = counts["source_agent_artifact_id"]
        if "source_agent_error" in counts:
            runtime["source_agent_error"] = counts.get("source_agent_error")
        if counts.get("last_warning_kind") is not None:
            runtime["last_warning_kind"] = counts["last_warning_kind"]
        if counts.get("last_warning_message") is not None:
            runtime["last_warning_message"] = counts["last_warning_message"]
        if counts.get("last_warning_targets") is not None:
            runtime["last_warning_targets"] = list(counts["last_warning_targets"])
        return self._update_submission_progress(
            submission_id,
            stage=stage,
            message=message,
            **counts,
        )

    def _should_record_payload_progress(self, index: int, total: int) -> bool:
        return index == 1 or index == total or index % 5 == 0

    async def _process_raw_submission(
        self,
        record: SubmissionRecord,
        *,
        is_submission: bool,
    ) -> SubmissionRecord:
        payloads = [
            RawPayload(
                source=record.source_id,
                data=item,
                request_params=record.request_params,
                url_or_ref=item.get("url", "") if isinstance(item, dict) else "",
            )
            for item in record.payloads
        ]
        return await self._process_raw_payloads(
            record,
            source_id=record.source_id,
            source_kind=record.source_kind,
            payloads=payloads,
            is_run=False,
            is_submission=is_submission,
        )

    async def _process_raw_payloads(
        self,
        record: SubmissionRecord,
        *,
        source_id: str,
        source_kind: str,
        payloads: list[RawPayload],
        warnings: list[ConnectorWarning] | None = None,
        is_run: bool,
        is_submission: bool,
    ) -> SubmissionRecord:
        self.submission_store.update(record.submission_id, status="running")
        def progress_update(**kwargs: Any) -> SubmissionRecord:
            if is_run:
                return self._update_source_progress(
                    source_id,
                    record.submission_id,
                    **kwargs,
                )
            return self._update_submission_progress(record.submission_id, **kwargs)

        source = self.source_registry.require(source_id)
        snapshot_ids: list[str] = []
        resolved_evidence_ids: list[str] = []
        all_evidences: list[Evidence] = []
        deduped = 0
        resolve_success = 0
        resolve_miss = 0
        warning_items = warnings or []
        progress_update(
            stage="processing_payloads",
            message=f"processing {len(payloads)} raw payloads",
            payload_total=len(payloads),
            payloads_processed=0,
            snapshot_total=0,
            evidence_total=0,
            resolve_success_total=0,
            resolve_miss_total=0,
            partial_failure_count=len(warning_items),
            last_warning_count=len(warning_items),
            last_warning_targets=[item.target for item in warning_items if item.target][:5],
            last_warning_kind=warning_items[0].kind if warning_items else None,
            last_warning_message=warning_items[0].message if warning_items else None,
        )

        try:
            for index, payload in enumerate(payloads, start=1):
                saved = self.snapshot_store.save_record(
                    source=source_id,
                    payload=payload.data,
                    request_params=payload.request_params,
                    metadata={
                        "source_kind": source_kind,
                        "producer_ref": record.producer_ref,
                        "url_or_ref": payload.url_or_ref,
                        **record.metadata,
                    },
                )
                snapshot_ids.append(saved["snapshot_id"])
                if saved["deduped"]:
                    deduped += 1

                evidences = self.normalizer_fn(
                    source=source.normalizer_key or source.adapter_name,
                    raw_payload=payload.data,
                    snapshot_ref=saved["snapshot_id"],
                )
                resolved_evidences, hit_count, miss_count = self._resolve_evidence(
                    source_id,
                    source_kind,
                    record.producer_ref,
                    record.submission_id,
                    evidences,
                )
                resolve_success += hit_count
                resolve_miss += miss_count
                all_evidences.extend(resolved_evidences)
                resolved_evidence_ids.extend([item.evidence_id for item in resolved_evidences])
                if self._should_record_payload_progress(index, len(payloads)):
                    progress_update(
                        stage="processing_payloads",
                        message=f"processed payload {index}/{len(payloads)}",
                        payload_total=len(payloads),
                        payloads_processed=index,
                        snapshot_total=len(snapshot_ids),
                        evidence_total=len(resolved_evidence_ids),
                        resolve_success_total=resolve_success,
                        resolve_miss_total=resolve_miss,
                        partial_failure_count=len(warning_items),
                        last_warning_count=len(warning_items),
                        last_warning_targets=[
                            item.target for item in warning_items if item.target
                        ][:5],
                        last_warning_kind=warning_items[0].kind if warning_items else None,
                        last_warning_message=warning_items[0].message if warning_items else None,
                    )
                await self._maybe_yield_processing(index)

            progress_update(
                stage="source_agent_analysis",
                message="writing evidence and running source agent",
                payload_total=len(payloads),
                payloads_processed=len(payloads),
                snapshot_total=len(snapshot_ids),
                evidence_total=len(resolved_evidence_ids),
                resolve_success_total=resolve_success,
                resolve_miss_total=resolve_miss,
                partial_failure_count=len(warning_items),
                last_warning_count=len(warning_items),
                last_warning_targets=[item.target for item in warning_items if item.target][:5],
                last_warning_kind=warning_items[0].kind if warning_items else None,
                last_warning_message=warning_items[0].message if warning_items else None,
            )
            self.evidence_sink.extend(all_evidences)
            source_agent_metadata, source_agent_evidence = await self._run_source_agent(
                record=record,
                evidences=all_evidences,
                is_run=is_run,
            )
            if source_agent_evidence:
                self.evidence_sink.extend(source_agent_evidence)
            combined_evidences = [*all_evidences, *source_agent_evidence]
            progress_update(
                stage="triggering_analysis",
                message="triggering candidate analysis",
                payload_total=len(payloads),
                payloads_processed=len(payloads),
                snapshot_total=len(snapshot_ids),
                evidence_total=len(resolved_evidence_ids),
                derived_evidence_total=len(source_agent_evidence),
                source_agent_status=source_agent_metadata.get("source_agent_status"),
                source_agent_artifact_id=source_agent_metadata.get("source_agent_artifact_id"),
                resolve_success_total=resolve_success,
                resolve_miss_total=resolve_miss,
                partial_failure_count=len(warning_items),
                last_warning_count=len(warning_items),
                last_warning_targets=[item.target for item in warning_items if item.target][:5],
                last_warning_kind=warning_items[0].kind if warning_items else None,
                last_warning_message=warning_items[0].message if warning_items else None,
            )
            await self._trigger_analysis(combined_evidences)
            updated = self.submission_store.update(
                record.submission_id,
                status="completed",
                snapshot_ids=snapshot_ids,
                evidence_ids=resolved_evidence_ids + [item.evidence_id for item in source_agent_evidence],
                processed_at=self._now(),
                metadata={
                    **record.metadata,
                    "warnings": [self._warning_to_dict(item) for item in warning_items],
                    **source_agent_metadata,
                },
            )
            updated = progress_update(
                stage="completed",
                message="source processing completed",
                payload_total=len(payloads),
                payloads_processed=len(payloads),
                snapshot_total=len(snapshot_ids),
                evidence_total=len(resolved_evidence_ids),
                derived_evidence_total=len(source_agent_evidence),
                source_agent_status=source_agent_metadata.get("source_agent_status"),
                source_agent_artifact_id=source_agent_metadata.get("source_agent_artifact_id"),
                resolve_success_total=resolve_success,
                resolve_miss_total=resolve_miss,
                partial_failure_count=len(warning_items),
                last_warning_count=len(warning_items),
                last_warning_targets=[item.target for item in warning_items if item.target][:5],
                last_warning_kind=warning_items[0].kind if warning_items else None,
                last_warning_message=warning_items[0].message if warning_items else None,
            )
            self.source_registry.record_processing(
                source_id,
                success=True,
                snapshot_total=len(payloads),
                deduped_snapshot_total=deduped,
                evidence_total=len(all_evidences),
                entity_resolve_success_total=resolve_success,
                entity_resolve_miss_total=resolve_miss,
                warning_kind=warning_items[0].kind if warning_items else None,
                warning_message=warning_items[0].message if warning_items else None,
                warning_count=len(warning_items),
                is_run=is_run,
                is_submission=is_submission,
            )
            self._record_research_fulfillment_if_applicable(
                record,
                useful=len(resolved_evidence_ids) > 0,
            )
            return updated
        except Exception as exc:
            failure_kind = self._classify_runtime_failure(exc)
            updated = self.submission_store.update(
                record.submission_id,
                status="failed",
                error_message=str(exc),
                snapshot_ids=snapshot_ids,
                evidence_ids=[],
                processed_at=self._now(),
                metadata={
                    **record.metadata,
                    "warnings": [self._warning_to_dict(item) for item in warning_items],
                },
            )
            updated = progress_update(
                stage="failed",
                message=str(exc),
                payload_total=len(payloads),
                payloads_processed=min(len(snapshot_ids), len(payloads)),
                snapshot_total=len(snapshot_ids),
                evidence_total=len(resolved_evidence_ids),
                resolve_success_total=resolve_success,
                resolve_miss_total=resolve_miss,
                partial_failure_count=len(warning_items),
                last_warning_count=len(warning_items),
                last_warning_targets=[item.target for item in warning_items if item.target][:5],
                last_warning_kind=warning_items[0].kind if warning_items else None,
                last_warning_message=warning_items[0].message if warning_items else None,
            )
            self.source_registry.record_processing(
                source_id,
                success=False,
                snapshot_total=len(payloads),
                deduped_snapshot_total=deduped,
                evidence_total=0,
                entity_resolve_success_total=0,
                entity_resolve_miss_total=0,
                failure_kind=failure_kind,
                failure_message=str(exc),
                warning_kind=warning_items[0].kind if warning_items else None,
                warning_message=warning_items[0].message if warning_items else None,
                warning_count=len(warning_items),
                is_run=is_run,
                is_submission=is_submission,
            )
            return updated

    async def _process_evidence_submission(
        self,
        record: SubmissionRecord,
        *,
        is_submission: bool,
    ) -> SubmissionRecord:
        self.submission_store.update(record.submission_id, status="running")
        self._update_submission_progress(
            record.submission_id,
            stage="validating_evidence",
            message=f"processing {len(record.evidence_payloads)} evidence items",
            payload_total=len(record.evidence_payloads),
            payloads_processed=0,
            snapshot_total=0,
            evidence_total=0,
            resolve_success_total=0,
            resolve_miss_total=0,
        )
        source = self.source_registry.require(record.source_id)
        snapshot_ids: list[str] = []
        evidence_ids: list[str] = []

        try:
            evidences: list[Evidence] = []
            resolve_success = 0
            resolve_miss = 0
            for index, payload in enumerate(record.evidence_payloads, start=1):
                saved = self.snapshot_store.save_record(
                    source=record.source_id,
                    payload=payload,
                    request_params={},
                    virtual=True,
                    metadata={
                        "source_kind": record.source_kind,
                        "producer_ref": record.producer_ref,
                        **record.metadata,
                    },
                )
                snapshot_ids.append(saved["snapshot_id"])
                evidence = Evidence.model_validate(
                    {
                        **payload,
                        "source": record.source_id,
                        "source_tier": source.effective_tier,
                        "source_kind": record.source_kind,
                        "producer_ref": record.producer_ref,
                        "parent_evidence_ids": record.parent_evidence_ids,
                        "raw_snapshot_ref": saved["snapshot_id"],
                        "collected_at": payload.get("collected_at", self._now()),
                    }
                )
                resolved_evidences, hit_count, miss_count = self._resolve_evidence(
                    record.source_id,
                    record.source_kind,
                    record.producer_ref,
                    record.submission_id,
                    [evidence],
                )
                resolve_success += hit_count
                resolve_miss += miss_count
                evidences.extend(resolved_evidences)
                if self._should_record_payload_progress(index, len(record.evidence_payloads)):
                    self._update_submission_progress(
                        record.submission_id,
                        stage="validating_evidence",
                        message=f"processed evidence item {index}/{len(record.evidence_payloads)}",
                        payload_total=len(record.evidence_payloads),
                        payloads_processed=index,
                        snapshot_total=len(snapshot_ids),
                        evidence_total=len(evidences),
                        resolve_success_total=resolve_success,
                        resolve_miss_total=resolve_miss,
                    )
                await self._maybe_yield_processing(index)

            self.evidence_sink.extend(evidences)
            evidence_ids.extend([item.evidence_id for item in evidences])
            source_agent_metadata, source_agent_evidence = await self._run_source_agent(
                record=record,
                evidences=evidences,
                is_run=False,
            )
            if source_agent_evidence:
                self.evidence_sink.extend(source_agent_evidence)
                evidence_ids.extend([item.evidence_id for item in source_agent_evidence])
            self._update_submission_progress(
                record.submission_id,
                stage="triggering_analysis",
                message="writing evidence and triggering analysis",
                payload_total=len(record.evidence_payloads),
                payloads_processed=len(record.evidence_payloads),
                snapshot_total=len(snapshot_ids),
                evidence_total=len([item.evidence_id for item in evidences]),
                derived_evidence_total=len(source_agent_evidence),
                source_agent_status=source_agent_metadata.get("source_agent_status"),
                source_agent_artifact_id=source_agent_metadata.get("source_agent_artifact_id"),
                resolve_success_total=resolve_success,
                resolve_miss_total=resolve_miss,
            )
            await self._trigger_analysis([*evidences, *source_agent_evidence])
            updated = self.submission_store.update(
                record.submission_id,
                status="completed",
                snapshot_ids=snapshot_ids,
                evidence_ids=evidence_ids,
                processed_at=self._now(),
                metadata={
                    **record.metadata,
                    **source_agent_metadata,
                },
            )
            updated = self._update_submission_progress(
                record.submission_id,
                stage="completed",
                message="evidence submission completed",
                payload_total=len(record.evidence_payloads),
                payloads_processed=len(record.evidence_payloads),
                snapshot_total=len(snapshot_ids),
                evidence_total=len([item.evidence_id for item in evidences]),
                derived_evidence_total=len(source_agent_evidence),
                source_agent_status=source_agent_metadata.get("source_agent_status"),
                source_agent_artifact_id=source_agent_metadata.get("source_agent_artifact_id"),
                resolve_success_total=resolve_success,
                resolve_miss_total=resolve_miss,
            )
            self._finalize_human_request(
                request_submission_id=record.metadata.get("request_submission_id"),
                fulfillment_submission_id=record.submission_id,
                evidence_ids=evidence_ids,
            )
            self.source_registry.record_processing(
                record.source_id,
                success=True,
                snapshot_total=len(record.evidence_payloads),
                evidence_total=len(evidences),
                entity_resolve_success_total=resolve_success,
                entity_resolve_miss_total=resolve_miss,
                is_run=False,
                is_submission=is_submission,
            )
            self._record_research_fulfillment_if_applicable(
                record,
                useful=len(evidence_ids) > 0,
            )
            return updated
        except Exception as exc:
            updated = self.submission_store.update(
                record.submission_id,
                status="failed",
                error_message=str(exc),
                snapshot_ids=snapshot_ids,
                evidence_ids=evidence_ids,
                processed_at=self._now(),
            )
            updated = self._update_submission_progress(
                record.submission_id,
                stage="failed",
                message=str(exc),
                payload_total=len(record.evidence_payloads),
                payloads_processed=len(snapshot_ids),
                snapshot_total=len(snapshot_ids),
                evidence_total=len(evidence_ids),
                resolve_success_total=0,
                resolve_miss_total=0,
            )
            self.source_registry.record_processing(
                record.source_id,
                success=False,
                snapshot_total=len(record.evidence_payloads),
                is_run=False,
                is_submission=is_submission,
            )
            return updated

    async def _process_human_input_submission(
        self,
        record: SubmissionRecord,
        envelope: HumanInputEnvelope,
    ) -> SubmissionRecord:
        self.submission_store.update(record.submission_id, status="running")
        self._update_submission_progress(
            record.submission_id,
            stage="routing_human_input",
            message="classifying free-form human input",
            payload_total=1,
            payloads_processed=0,
            snapshot_total=0,
            evidence_total=0,
        )
        snapshot_ids: list[str] = []
        evidence_ids: list[str] = []
        try:
            saved = self.snapshot_store.save_record(
                source=record.source_id,
                payload=envelope.model_dump(),
                request_params={},
                metadata={
                    "source_kind": record.source_kind,
                    "producer_ref": record.producer_ref,
                    **record.metadata,
                },
            )
            snapshot_ids.append(saved["snapshot_id"])
            preferred_route = self._preferred_route_for_request(envelope.request_submission_id)
            if self.human_input_router is None:
                raise RuntimeError("human input router not configured")
            decision = await self.human_input_router.classify(
                envelope,
                preferred_route=preferred_route,
            )
            metadata = {
                **record.metadata,
                "classification": decision.model_dump(mode="json"),
            }
            if decision.route == "needs_review":
                updated = self.submission_store.update(
                    record.submission_id,
                    status="rejected",
                    snapshot_ids=snapshot_ids,
                    processed_at=self._now(),
                    metadata=metadata,
                )
                updated = self._update_submission_progress(
                    record.submission_id,
                    stage="rejected",
                    message="human input requires manual review",
                    payload_total=1,
                    payloads_processed=1,
                    snapshot_total=len(snapshot_ids),
                    evidence_total=0,
                )
                self.source_registry.record_processing(
                    record.source_id,
                    success=True,
                    snapshot_total=1,
                    is_submission=True,
                )
                return updated

            if decision.route == "none":
                updated = self.submission_store.update(
                    record.submission_id,
                    status="completed",
                    snapshot_ids=snapshot_ids,
                    processed_at=self._now(),
                    metadata=metadata,
                )
                updated = self._update_submission_progress(
                    record.submission_id,
                    stage="completed",
                    message="human input classified without collector-native routing",
                    payload_total=1,
                    payloads_processed=1,
                    snapshot_total=len(snapshot_ids),
                    evidence_total=0,
                )
                self.source_registry.record_processing(
                    record.source_id,
                    success=True,
                    snapshot_total=1,
                    is_submission=True,
                )
                return updated

            self._update_submission_progress(
                record.submission_id,
                stage="dispatching_human_input",
                message=f"dispatching routed input to {decision.route}",
                payload_total=1,
                payloads_processed=1,
                snapshot_total=len(snapshot_ids),
            )
            routed = await self._dispatch_human_input(decision, envelope)
            evidence_ids = list(routed.evidence_ids)
            metadata.update(
                {
                    "routed_submission_id": routed.submission_id,
                    "routed_source_id": routed.source_id,
                }
            )
            updated = self.submission_store.update(
                record.submission_id,
                status="completed" if routed.status == "completed" else routed.status,
                snapshot_ids=snapshot_ids,
                evidence_ids=evidence_ids,
                processed_at=self._now(),
                metadata=metadata,
            )
            updated = self._update_submission_progress(
                record.submission_id,
                stage="completed" if routed.status == "completed" else routed.status,
                message=f"routed to {decision.route}",
                payload_total=1,
                payloads_processed=1,
                snapshot_total=len(snapshot_ids),
                evidence_total=len(evidence_ids),
            )
            self.source_registry.record_processing(
                record.source_id,
                success=routed.status == "completed",
                snapshot_total=1,
                evidence_total=len(evidence_ids),
                is_submission=True,
            )
            self._record_research_fulfillment_if_applicable(
                record,
                useful=len(evidence_ids) > 0,
            )
            return updated
        except Exception as exc:
            updated = self.submission_store.update(
                record.submission_id,
                status="failed",
                error_message=str(exc),
                snapshot_ids=snapshot_ids,
                evidence_ids=evidence_ids,
                processed_at=self._now(),
            )
            updated = self._update_submission_progress(
                record.submission_id,
                stage="failed",
                message=str(exc),
                payload_total=1,
                payloads_processed=1 if snapshot_ids else 0,
                snapshot_total=len(snapshot_ids),
                evidence_total=len(evidence_ids),
            )
            self.source_registry.record_processing(
                record.source_id,
                success=False,
                snapshot_total=1,
                evidence_total=len(evidence_ids),
                is_submission=True,
            )
            return updated

    async def _process_derived_submission(
        self,
        record: SubmissionRecord,
        *,
        is_submission: bool,
    ) -> SubmissionRecord:
        source = self.source_registry.require(record.source_id)
        self.submission_store.update(record.submission_id, status="running")
        self._update_submission_progress(
            record.submission_id,
            stage="building_derived_evidence",
            message="deriving evidence from existing evidence graph",
        )
        try:
            evidences = build_derived_evidence(
                record.source_id,
                self.evidence_sink.get_all(),
                source.effective_tier,
            )
            resolved_evidences, hit_count, miss_count = self._resolve_evidence(
                record.source_id,
                source.kind,
                record.producer_ref,
                record.submission_id,
                evidences,
            )
            self.evidence_sink.extend(resolved_evidences)
            source_agent_metadata, source_agent_evidence = await self._run_source_agent(
                record=record,
                evidences=resolved_evidences,
                is_run=True,
            )
            if source_agent_evidence:
                self.evidence_sink.extend(source_agent_evidence)
            self._update_submission_progress(
                record.submission_id,
                stage="triggering_analysis",
                message="writing derived evidence and triggering analysis",
                evidence_total=len(resolved_evidences),
                derived_evidence_total=len(source_agent_evidence),
                source_agent_status=source_agent_metadata.get("source_agent_status"),
                source_agent_artifact_id=source_agent_metadata.get("source_agent_artifact_id"),
                resolve_success_total=hit_count,
                resolve_miss_total=miss_count,
            )
            await self._trigger_analysis([*resolved_evidences, *source_agent_evidence])
            updated = self.submission_store.update(
                record.submission_id,
                status="completed",
                evidence_ids=[item.evidence_id for item in resolved_evidences] + [item.evidence_id for item in source_agent_evidence],
                processed_at=self._now(),
                metadata={
                    **record.metadata,
                    **source_agent_metadata,
                },
            )
            updated = self._update_submission_progress(
                record.submission_id,
                stage="completed",
                message="derived source completed",
                evidence_total=len(resolved_evidences),
                derived_evidence_total=len(source_agent_evidence),
                source_agent_status=source_agent_metadata.get("source_agent_status"),
                source_agent_artifact_id=source_agent_metadata.get("source_agent_artifact_id"),
                resolve_success_total=hit_count,
                resolve_miss_total=miss_count,
            )
            self.source_registry.record_processing(
                record.source_id,
                success=True,
                evidence_total=len(resolved_evidences),
                entity_resolve_success_total=hit_count,
                entity_resolve_miss_total=miss_count,
                is_run=True,
                is_submission=is_submission,
            )
            self._record_research_fulfillment_if_applicable(
                record,
                useful=len(resolved_evidences) > 0,
            )
            return updated
        except Exception as exc:
            updated = self.submission_store.update(
                record.submission_id,
                status="failed",
                error_message=str(exc),
                processed_at=self._now(),
            )
            updated = self._update_submission_progress(
                record.submission_id,
                stage="failed",
                message=str(exc),
            )
            self.source_registry.record_processing(
                record.source_id,
                success=False,
                is_run=True,
                is_submission=is_submission,
            )
            return updated

    def _resolve_evidence(
        self,
        source_id: str,
        source_kind: str,
        producer_ref: str | None,
        submission_id: str,
        evidences: list[Evidence],
    ) -> tuple[list[Evidence], int, int]:
        source = self.source_registry.require(source_id)
        resolved_evidences: list[Evidence] = []
        success_count = 0
        miss_count = 0

        for evidence in evidences:
            resolved = self.entity_resolver.resolve_candidates(
                evidence.entity_candidates,
                source=source_id,
            )
            if resolved:
                success_count += len(resolved)
                miss_count += max(0, len(evidence.entity_candidates) - len(resolved))
                evidence.entity_candidates = resolved
            else:
                miss_count += len(evidence.entity_candidates)

            evidence.source = source_id
            evidence.source_tier = source.effective_tier
            evidence.source_kind = source_kind
            evidence.producer_ref = producer_ref
            evidence.submission_ref = submission_id
            resolved_evidences.append(evidence)

        return resolved_evidences, success_count, miss_count

    async def _run_source_agent(
        self,
        *,
        record: SubmissionRecord,
        evidences: list[Evidence],
        is_run: bool,
    ) -> tuple[dict[str, Any], list[Evidence]]:
        if self.source_agent_runner is None or not evidences:
            return {"source_agent_status": "skipped"}, []

        result = await self.source_agent_runner.run_for_submission(record, evidences)
        if result is None:
            return {"source_agent_status": "skipped"}, []

        artifact = result.artifact
        metadata = {
            "source_agent_status": artifact.status,
            "source_agent_artifact_id": artifact.artifact_id,
            "source_agent_summary": artifact.summary,
            "source_agent_confidence": artifact.confidence,
            "derived_evidence_ids": artifact.derived_evidence_ids,
        }
        if artifact.error_message:
            metadata["source_agent_error"] = artifact.error_message

        if is_run:
            self._update_source_progress(
                record.source_id,
                record.submission_id,
                stage="source_agent_analysis",
                message=artifact.summary or artifact.error_message or "source agent completed",
                derived_evidence_total=len(result.derived_evidence),
                source_agent_status=artifact.status,
                source_agent_artifact_id=artifact.artifact_id,
                source_agent_error=artifact.error_message,
            )
        else:
            self._update_submission_progress(
                record.submission_id,
                stage="source_agent_analysis",
                message=artifact.summary or artifact.error_message or "source agent completed",
                derived_evidence_total=len(result.derived_evidence),
                source_agent_status=artifact.status,
                source_agent_artifact_id=artifact.artifact_id,
                source_agent_error=artifact.error_message,
            )
        return metadata, [item for item in result.derived_evidence if isinstance(item, Evidence)]

    def _finalize_human_request(
        self,
        *,
        request_submission_id: Any,
        fulfillment_submission_id: str,
        evidence_ids: list[str],
    ) -> None:
        if not isinstance(request_submission_id, str) or not request_submission_id:
            return
        request = self.submission_store.get(request_submission_id)
        if request is None:
            return
        fulfilled = self.submission_store.get(fulfillment_submission_id)
        metadata = dict(request.metadata)
        metadata["fulfilled_by_submission_id"] = fulfillment_submission_id
        metadata["fulfilled_by_source_id"] = fulfilled.source_id if fulfilled is not None else None
        updated = self.submission_store.update(
            request_submission_id,
            status="completed",
            evidence_ids=evidence_ids,
            processed_at=self._now(),
            metadata=metadata,
        )
        if request.status == "pending_human":
            self.source_registry.record_processing(
                updated.source_id,
                success=True,
                evidence_total=len(evidence_ids),
                is_submission=True,
            )

    def _record_research_fulfillment_if_applicable(
        self,
        record: SubmissionRecord,
        *,
        useful: bool,
    ) -> None:
        metadata = record.metadata or {}
        if not any(
            metadata.get(key)
            for key in (
                "question",
                "intent",
                "requested_by_agent",
                "requested_input_kind",
                "request_submission_id",
                "run_id",
            )
        ):
            return
        self.source_registry.record_research_fulfillment(
            record.source_id,
            useful=useful,
        )

    async def _dispatch_human_input(
        self,
        decision: HumanInputRoutingDecision,
        envelope: HumanInputEnvelope,
    ) -> SubmissionRecord:
        producer_ref = envelope.producer_ref or "human-input"
        request_submission_id = decision.request_submission_id or envelope.request_submission_id
        if decision.route == "manual_observation":
            return await self.submit_human_observation(
                {
                    "title": decision.title,
                    "entities": decision.entities,
                    "signal_type": decision.signal_type,
                    "metric_value": decision.metric_value,
                    "metric_delta": decision.metric_delta,
                    "rank": decision.rank,
                    "geo": decision.geo,
                    "url": decision.url,
                    "trust_score": decision.trust_score,
                    "freshness_ttl": decision.freshness_ttl,
                    "reporter": producer_ref,
                },
                async_mode=False,
            )
        if decision.route == "human_analyst_note":
            return await self.submit_human_analyst_note(
                {
                    "title": decision.title,
                    "observation": decision.observation or envelope.content,
                    "entity_candidates": decision.entities,
                    "why_now": decision.why_now,
                    "confidence": decision.confidence or 0.8,
                    "geo": decision.geo,
                    "channel": envelope.channel_name or "human-input",
                    "study_type": decision.study_type,
                    "producer_ref": producer_ref,
                    "beneficiary_hints": decision.beneficiary_hints,
                    "research_questions": decision.research_questions,
                    "source_refs": decision.source_refs,
                    "supporting_points": decision.supporting_points,
                    "request_submission_id": request_submission_id,
                },
                async_mode=False,
            )
        if decision.route == "human_curated_dataset":
            return await self.submit_human_evidence_batch(
                {
                    "evidence_items": decision.evidence_items,
                    "producer_ref": producer_ref,
                    "dataset_name": decision.dataset_name,
                    "channel": envelope.channel_name or "human-input",
                    "notes": decision.notes,
                    "request_submission_id": request_submission_id,
                },
                async_mode=False,
            )
        raise ValueError(f"Unsupported routed human input: {decision.route}")

    def _preferred_route_for_request(self, request_submission_id: str | None) -> str | None:
        if not request_submission_id:
            return None
        request = self.submission_store.get(request_submission_id)
        if request is None:
            return None
        requested_kind = request.metadata.get("requested_input_kind")
        if requested_kind in {"data_source", "channel_check"}:
            return "human_curated_dataset"
        if requested_kind in {"study_result", "beneficiary_mapping", "validation_note"}:
            return "human_analyst_note"
        intent = request.metadata.get("intent")
        if intent in {"pricing", "supply"}:
            return "human_curated_dataset"
        if intent in {"monetization", "beneficiary", "validation", "demand", "ranking"}:
            return "human_analyst_note"
        return None

    async def _trigger_analysis(self, evidences: list[Evidence]) -> None:
        if self.analysis_engine is None or not evidences:
            return
        queued = await self.analysis_engine.on_evidence_updated()
        if queued:
            logger.info("Queued %d candidate analyses after ingestion update", len(queued))

    async def _maybe_yield_processing(self, index: int) -> None:
        if index % self._processing_yield_every == 0:
            await asyncio.sleep(0.001)

    def _gen_id(self) -> str:
        return uuid.uuid4().hex[:16]

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
