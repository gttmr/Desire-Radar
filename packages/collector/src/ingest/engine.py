"""Common ingestion engine for pull and push sources."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from ..analysis.engine import AnalysisEngine
from ..connectors.base import BaseConnector, RawPayload
from ..ingest.derived import build_derived_evidence
from ..ingest.models import SubmissionRecord
from ..ingest.store import SubmissionStore
from ..normalizer.evidence_schema import Evidence
from ..resolver.entity_resolver import EntityResolver
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
    ) -> None:
        self.source_registry = source_registry
        self.submission_store = submission_store
        self.snapshot_store = snapshot_store
        self.evidence_sink = evidence_sink
        self.entity_resolver = entity_resolver
        self.normalizer_fn = normalizer_fn
        self.connectors = connectors
        self.analysis_engine = analysis_engine
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        self._running = True
        self._worker = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        self._running = False
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass

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
    ) -> SubmissionRecord:
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
            },
        )
        self.submission_store.create(record)
        self.source_registry.record_submission("human_analyst_note")
        return record

    async def run_source(self, source_id: str) -> SubmissionRecord:
        source = self.source_registry.require(source_id)
        if not source.enabled:
            raise ValueError(f"Source disabled: {source_id}")
        if not source.runnable:
            raise ValueError(f"Source is not runnable: {source_id}")

        if source.kind == "derived":
            record = SubmissionRecord(
                submission_id=self._gen_id(),
                source_id=source_id,
                source_kind=source.kind,
                ingestion_mode="evidence",
                status="running",
                received_at=self._now(),
            )
            self.submission_store.create(record)
            return await self._process_derived_submission(record, is_submission=False)

        connector = self.connectors.get(source.adapter_name)
        if connector is None:
            raise ValueError(f"Runnable source has no connector adapter: {source_id}")
        payloads = await connector.fetch()
        record = SubmissionRecord(
            submission_id=self._gen_id(),
            source_id=source_id,
            source_kind=source.kind,
            ingestion_mode="raw",
            status="running",
            received_at=self._now(),
            payloads=[payload.data for payload in payloads],
        )
        self.submission_store.create(record)
        return await self._process_raw_payloads(
            record,
            source_id=source_id,
            source_kind=source.kind,
            payloads=payloads,
            is_run=True,
            is_submission=False,
        )

    async def get_submission(self, submission_id: str) -> SubmissionRecord | None:
        return self.submission_store.get(submission_id)

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
        is_run: bool,
        is_submission: bool,
    ) -> SubmissionRecord:
        self.submission_store.update(record.submission_id, status="running")
        source = self.source_registry.require(source_id)
        snapshot_ids: list[str] = []
        evidence_ids: list[str] = []
        all_evidences: list[Evidence] = []
        deduped = 0
        resolve_success = 0
        resolve_miss = 0

        try:
            for payload in payloads:
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
                    source=source.adapter_name,
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
                evidence_ids.extend([item.evidence_id for item in resolved_evidences])

            self.evidence_sink.extend(all_evidences)
            await self._trigger_analysis(all_evidences)
            updated = self.submission_store.update(
                record.submission_id,
                status="completed",
                snapshot_ids=snapshot_ids,
                evidence_ids=evidence_ids,
                processed_at=self._now(),
            )
            self.source_registry.record_processing(
                source_id,
                success=True,
                snapshot_total=len(payloads),
                deduped_snapshot_total=deduped,
                evidence_total=len(all_evidences),
                entity_resolve_success_total=resolve_success,
                entity_resolve_miss_total=resolve_miss,
                is_run=is_run,
                is_submission=is_submission,
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
            self.source_registry.record_processing(
                source_id,
                success=False,
                snapshot_total=len(payloads),
                deduped_snapshot_total=deduped,
                evidence_total=len(all_evidences),
                entity_resolve_success_total=resolve_success,
                entity_resolve_miss_total=resolve_miss,
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
        source = self.source_registry.require(record.source_id)
        snapshot_ids: list[str] = []
        evidence_ids: list[str] = []

        try:
            evidences: list[Evidence] = []
            resolve_success = 0
            resolve_miss = 0
            for payload in record.evidence_payloads:
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

            self.evidence_sink.extend(evidences)
            evidence_ids.extend([item.evidence_id for item in evidences])
            await self._trigger_analysis(evidences)
            updated = self.submission_store.update(
                record.submission_id,
                status="completed",
                snapshot_ids=snapshot_ids,
                evidence_ids=evidence_ids,
                processed_at=self._now(),
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
            self.source_registry.record_processing(
                record.source_id,
                success=False,
                snapshot_total=len(record.evidence_payloads),
                is_run=False,
                is_submission=is_submission,
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
            await self._trigger_analysis(resolved_evidences)
            updated = self.submission_store.update(
                record.submission_id,
                status="completed",
                evidence_ids=[item.evidence_id for item in resolved_evidences],
                processed_at=self._now(),
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
            return updated
        except Exception as exc:
            updated = self.submission_store.update(
                record.submission_id,
                status="failed",
                error_message=str(exc),
                processed_at=self._now(),
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

    async def _trigger_analysis(self, evidences: list[Evidence]) -> None:
        if self.analysis_engine is None or not evidences:
            return
        queued = await self.analysis_engine.on_evidence_updated()
        if queued:
            logger.info("Queued %d candidate analyses after ingestion update", len(queued))

    def _gen_id(self) -> str:
        return uuid.uuid4().hex[:16]

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
