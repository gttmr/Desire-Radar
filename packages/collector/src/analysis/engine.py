"""Async analysis queue and worker for candidate-level LLM review."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from uuid import uuid4

from ..builder.signal_candidate_builder import SignalCandidateBuilder
from ..store.evidence_sink import EvidenceSink
from .context_packer import ContextPacker
from .models import AnalysisProjection, AnalysisTask
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
            "projection": projection.model_dump() if projection else None,
            "sessions": [state.model_dump() for state in self.session_pool.list_states()],
        }

    async def _enqueue_candidates(
        self,
        force_entities: set[str] | None,
    ) -> list[AnalysisTask]:
        if not self.enabled:
            return []

        all_evidence = self.evidence_sink.get_all()
        candidates = self.signal_builder.build_candidates(all_evidence)
        evidence_by_entity = self._build_entity_evidence_map(all_evidence)

        ranked: list[tuple[float, AnalysisTask]] = []
        for candidate in candidates:
            entity_key = candidate.entity.strip().lower()
            if force_entities is not None and entity_key not in force_entities:
                continue

            projection = self.analysis_store.get_projection(candidate.entity)
            evidences = evidence_by_entity.get(entity_key, [])
            decision = self.policy.decide(
                candidate,
                evidences,
                projection,
                force=force_entities is not None,
            )
            if not decision.should_enqueue or entity_key in self._queued_entities:
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
                )
            )

        ranked.sort(key=lambda item: item[0], reverse=True)
        limit = len(ranked) if force_entities is not None else self.policy.max_candidates_per_run

        accepted: list[AnalysisTask] = []
        for _, task in ranked[:limit]:
            self._queued_entities.add(task.entity.strip().lower())
            self.analysis_store.mark_pending(task)
            self._queue.put_nowait(task)
            accepted.append(task)

        return accepted

    async def _worker_loop(self) -> None:
        while True:
            task = await self._queue.get()
            try:
                await self._process_task(task)
            except Exception:
                logger.exception("Candidate analysis failed for %s", task.entity)
            finally:
                self._queued_entities.discard(task.entity.strip().lower())
                self._queue.task_done()

    async def _process_task(self, task: AnalysisTask) -> None:
        all_evidence = self.evidence_sink.get_all()
        evidence_by_entity = self._build_entity_evidence_map(all_evidence)
        evidences = evidence_by_entity.get(task.entity.strip().lower(), [])
        candidates = self.signal_builder.build_candidates(all_evidence)
        candidate = next(
            (item for item in candidates if item.entity.strip().lower() == task.entity.strip().lower()),
            None,
        )
        if candidate is None or not evidences:
            self.analysis_store.mark_failed(task, "candidate_disappeared")
            return

        projection = self.analysis_store.get_projection(task.entity)
        packed = self.context_packer.pack(candidate, evidences, projection)
        session = self.session_pool.acquire(task.session_domain)
        self.analysis_store.mark_running(task, session.state.session_id, session.model)

        try:
            response = await session.analyze(packed)
        except Exception as exc:
            self.session_pool.reset(task.session_domain)
            self.analysis_store.mark_failed(task, str(exc))
            return

        self.analysis_store.mark_completed(
            task,
            response,
            session_id=session.state.session_id,
            model=session.model,
            review_threshold=self.review_threshold,
        )

    def _build_entity_evidence_map(self, all_evidence: list) -> dict[str, list]:
        grouped: dict[str, list] = {}
        for ev in all_evidence:
            for entity in ev.entity_candidates:
                key = entity.strip().lower()
                grouped.setdefault(key, []).append(ev)
        return grouped

