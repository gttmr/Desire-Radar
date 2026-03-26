"""Async analysis queue and worker for candidate-level LLM review."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from uuid import uuid4

from ..builder.signal_candidate_builder import SignalCandidateBuilder
from ..sources.registry import SourceRegistry
from ..store.evidence_sink import EvidenceSink
from .context_packer import ContextPacker
from .models import AnalysisProjection, AnalysisTask, PackedContext
from .policy import AnalysisPolicy
from .session import SessionPool
from .store import AnalysisStore

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AnalysisEngine:
    def __init__(
        self,
        evidence_sink: EvidenceSink,
        signal_builder: SignalCandidateBuilder,
        analysis_store: AnalysisStore,
        policy: AnalysisPolicy,
        context_packer: ContextPacker,
        session_pool: SessionPool,
        *,
        enabled: bool = True,
        session_domain: str = "trend-analysis",
        review_threshold: float = 0.55,
        execution_mode: str = "batch",
        analysis_batch_size: int = 3,
        source_registry: SourceRegistry | None = None,
    ) -> None:
        self.evidence_sink = evidence_sink
        self.signal_builder = signal_builder
        self.analysis_store = analysis_store
        self.policy = policy
        self.context_packer = context_packer
        self.session_pool = session_pool
        self.enabled = enabled
        self.session_domain = session_domain
        self.review_threshold = review_threshold
        self.execution_mode = execution_mode
        self.analysis_batch_size = analysis_batch_size
        self.source_registry = source_registry
        self._queue: asyncio.Queue[AnalysisTask] = asyncio.Queue()
        self._queued_entities: set[str] = set()
        self._worker_task: asyncio.Task | None = None

    async def start(self) -> None:
        if not self.enabled or self._worker_task is not None:
            return
        self._worker_task = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        if self._worker_task is None:
            return
        self._worker_task.cancel()
        try:
            await self._worker_task
        except asyncio.CancelledError:
            pass
        self._worker_task = None

    async def on_evidence_updated(self) -> list[AnalysisTask]:
        return await self._enqueue_candidates(force_entities=None)

    async def enqueue_entity(self, entity: str) -> list[AnalysisTask]:
        return await self._enqueue_candidates(force_entities={entity.strip().lower()})

    def get_status(self, entity: str) -> dict:
        projection = self.analysis_store.get_projection(entity)
        normalized = entity.strip().lower()
        return {
            "entity": entity,
            "queued": normalized in self._queued_entities,
            "queue_size": self._queue.qsize(),
            "execution_mode": self.execution_mode,
            "projection": projection.model_dump() if projection else None,
            "sessions": [state.model_dump() for state in self.session_pool.list_states()],
        }

    def preview_entity(self, entity: str) -> dict:
        bundle = self._resolve_entity_bundle(entity)
        if bundle is None:
            return {
                "entity": entity,
                "execution_mode": self.execution_mode,
                "found": False,
            }

        candidate, evidences, projection = bundle
        packed = self.context_packer.pack(candidate, evidences, projection)
        return self._build_preview_payload(packed)

    def preview_batch(self) -> dict:
        planned = self._plan_candidates(force_entities=None, exclude_queued=False)
        batch = planned[: self.analysis_batch_size]
        if not batch:
            return {
                "count": 0,
                "execution_mode": self.execution_mode,
                "candidates": [],
            }

        packed = self.context_packer.pack_batch(
            [(candidate, evidences, projection) for _, _, candidate, evidences, projection in batch]
        )
        payload = self._build_preview_payload(packed)
        payload["count"] = len(batch)
        payload["candidates"] = [
            {
                "entity": task.entity,
                "reason": task.reason,
                "source_count": task.source_count,
                "emergence_score": task.emergence_score,
                "velocity_score": task.velocity_score,
            }
            for _, task, _, _, _ in batch
        ]
        return payload

    async def _enqueue_candidates(
        self,
        force_entities: set[str] | None,
    ) -> list[AnalysisTask]:
        if not self.enabled:
            return []

        ranked = self._plan_candidates(force_entities, exclude_queued=True)
        limit = len(ranked) if force_entities is not None else self.policy.max_candidates_per_run

        accepted: list[AnalysisTask] = []
        for _, task, _, _, _ in ranked[:limit]:
            entity_key = task.entity.strip().lower()
            self._queued_entities.add(entity_key)
            self.analysis_store.mark_pending(task)
            self._queue.put_nowait(task)
            if self.source_registry is not None:
                self.source_registry.record_analysis_candidate(task.sources)
            accepted.append(task)

        return accepted

    async def _worker_loop(self) -> None:
        while True:
            tasks = [await self._queue.get()]
            if self.execution_mode == "batch":
                while len(tasks) < self.analysis_batch_size:
                    try:
                        tasks.append(self._queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break

            try:
                if self.execution_mode == "batch":
                    await self._process_batch(tasks)
                else:
                    await self._process_single(tasks[0], execution_mode=self.execution_mode)
            except Exception:
                logger.exception("Candidate analysis failed for %s", ", ".join(task.entity for task in tasks))
            finally:
                for task in tasks:
                    self._queued_entities.discard(task.entity.strip().lower())
                    self._queue.task_done()

    async def _process_single(self, task: AnalysisTask, *, execution_mode: str) -> None:
        bundle = self._resolve_entity_bundle(task.entity)
        if bundle is None:
            self.analysis_store.mark_failed(task, "candidate_disappeared", execution_mode=execution_mode, batch_size=1)
            self._record_analysis_outcome(task, "failed")
            return

        candidate, evidences, projection = bundle
        packed = self.context_packer.pack(candidate, evidences, projection)
        self.analysis_store.mark_running(
            task,
            session_id="pending",
            model=self.session_pool.model,
            execution_mode=execution_mode,
            packed=packed,
            batch_size=1,
        )

        try:
            result = await self.session_pool.execute(
                packed,
                domain=task.session_domain,
                execution_mode=execution_mode,
            )
        except Exception as exc:
            self.session_pool.reset(task.session_domain)
            self.analysis_store.mark_failed(
                task,
                str(exc),
                packed=packed,
                execution_mode=execution_mode,
                batch_size=1,
            )
            self._record_analysis_outcome(task, "failed")
            return

        response = result.responses[0]
        self.analysis_store.mark_completed(
            task,
            response,
            session_id=result.session_id,
            model=result.model,
            review_threshold=self.review_threshold,
            packed=packed,
            usage=result.usage,
            execution_mode=execution_mode,
            batch_size=1,
        )
        self._record_analysis_outcome(
            task,
            "needs_review" if response.confidence < self.review_threshold else "completed",
        )

    async def _process_batch(self, tasks: list[AnalysisTask]) -> None:
        prepared: list[tuple[AnalysisTask, object, list, AnalysisProjection | None]] = []
        for task in tasks:
            bundle = self._resolve_entity_bundle(task.entity)
            if bundle is None:
                self.analysis_store.mark_failed(task, "candidate_disappeared", execution_mode="batch", batch_size=len(tasks))
                self._record_analysis_outcome(task, "failed")
                continue
            candidate, evidences, projection = bundle
            prepared.append((task, candidate, evidences, projection))

        if not prepared:
            return

        packed = self.context_packer.pack_batch(
            [(candidate, evidences, projection) for _, candidate, evidences, projection in prepared]
        )
        for task, _, _, _ in prepared:
            self.analysis_store.mark_running(
                task,
                session_id="pending",
                model=self.session_pool.model,
                execution_mode="batch",
                packed=packed,
                batch_size=len(prepared),
            )

        try:
            result = await self.session_pool.execute(
                packed,
                domain=self.session_domain,
                execution_mode="batch",
            )
        except Exception as exc:
            for task, _, _, _ in prepared:
                self.analysis_store.mark_failed(
                    task,
                    str(exc),
                    packed=packed,
                    execution_mode="batch",
                    batch_size=len(prepared),
                )
                self._record_analysis_outcome(task, "failed")
            return

        response_map = {
            response.entity.strip().lower(): response
            for response in result.responses
            if response.entity
        }
        sequential_responses = iter(result.responses)

        for task, _, _, _ in prepared:
            response = response_map.get(task.entity.strip().lower())
            if response is None:
                try:
                    response = next(sequential_responses)
                except StopIteration:
                    self.analysis_store.mark_failed(
                        task,
                        "missing_batch_response",
                        packed=packed,
                        execution_mode="batch",
                        batch_size=len(prepared),
                    )
                    self._record_analysis_outcome(task, "failed")
                    continue

            self.analysis_store.mark_completed(
                task,
                response,
                session_id=result.session_id,
                model=result.model,
                review_threshold=self.review_threshold,
                packed=packed,
                usage=result.usage,
                execution_mode="batch",
                batch_size=len(prepared),
            )
            self._record_analysis_outcome(
                task,
                "needs_review" if response.confidence < self.review_threshold else "completed",
            )

    def _build_preview_payload(self, packed: PackedContext) -> dict:
        return {
            "entity": packed.entity,
            "entities": packed.entities,
            "execution_mode": self.execution_mode,
            "prompt_format": packed.prompt_format,
            "prompt_char_count": packed.char_count,
            "estimated_input_tokens": packed.estimated_input_tokens,
            "selected_evidence_count": len(packed.evidence_ids),
            "selected_sources": packed.sources,
            "omitted_fields": packed.omitted_fields,
            "prompt_preview": packed.prompt,
            "model": self.session_pool.model,
            "batch_size": packed.batch_size,
            "response_mode": packed.response_mode,
        }

    def _plan_candidates(
        self,
        force_entities: set[str] | None,
        *,
        exclude_queued: bool,
    ) -> list[tuple[float, AnalysisTask, object, list, AnalysisProjection | None]]:
        candidates, evidence_by_entity = self._snapshot_candidates()
        ranked: list[tuple[float, AnalysisTask, object, list, AnalysisProjection | None]] = []

        for candidate in candidates:
            entity_key = candidate.entity.strip().lower()
            if force_entities is not None and entity_key not in force_entities:
                continue
            if exclude_queued and entity_key in self._queued_entities:
                continue

            projection = self.analysis_store.get_projection(candidate.entity)
            evidences = evidence_by_entity.get(entity_key, [])
            decision = self.policy.decide(
                candidate,
                evidences,
                projection,
                force=force_entities is not None,
            )
            if not decision.should_enqueue:
                continue

            ranked.append(
                (
                    decision.priority,
                    AnalysisTask(
                        task_id=uuid4().hex,
                        entity=candidate.entity,
                        session_domain=self.session_domain,
                        reason=decision.reason,
                        emergence_score=candidate.emergence_score,
                        velocity_score=candidate.velocity_score,
                        source_count=candidate.source_count,
                        evidence_ids=candidate.evidence_ids,
                        sources=candidate.sources,
                        first_seen=candidate.first_seen,
                        last_seen=candidate.last_seen,
                        enqueued_at=_now_iso(),
                    ),
                    candidate,
                    evidences,
                    projection,
                )
            )

        ranked.sort(key=lambda item: item[0], reverse=True)
        return ranked

    def _record_analysis_outcome(
        self,
        task: AnalysisTask,
        outcome: str,
    ) -> None:
        if self.source_registry is None:
            return
        normalized = "needs_review" if outcome == "needs_review" else (
            "completed" if outcome == "completed" else "failed"
        )
        self.source_registry.record_analysis_outcome(task.sources, normalized)

    def _resolve_entity_bundle(
        self,
        entity: str,
    ) -> tuple[object, list, AnalysisProjection | None] | None:
        candidates, evidence_by_entity = self._snapshot_candidates()
        entity_key = entity.strip().lower()
        candidate = next(
            (item for item in candidates if item.entity.strip().lower() == entity_key),
            None,
        )
        evidences = evidence_by_entity.get(entity_key, [])
        if candidate is None or not evidences:
            return None
        projection = self.analysis_store.get_projection(entity)
        return candidate, evidences, projection

    def _snapshot_candidates(self) -> tuple[list[object], dict[str, list]]:
        all_evidence = self.evidence_sink.get_all()
        candidates = self.signal_builder.build_candidates(all_evidence)
        return candidates, self._build_entity_evidence_map(all_evidence)

    def _build_entity_evidence_map(self, all_evidence: list) -> dict[str, list]:
        grouped: dict[str, list] = {}
        for ev in all_evidence:
            for entity in ev.entity_candidates:
                key = entity.strip().lower()
                grouped.setdefault(key, []).append(ev)
        return grouped
