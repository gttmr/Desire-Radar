from datetime import datetime, timezone

import pytest

from src.analysis.context_packer import ContextPacker
from src.analysis.engine import AnalysisEngine
from src.analysis.policy import AnalysisPolicy
from src.analysis.session import SessionPool
from src.analysis.store import AnalysisStore
from src.builder.signal_candidate_builder import SignalCandidateBuilder
from src.normalizer.evidence_schema import Evidence
from src.store.evidence_sink import EvidenceSink


def _evidence(entity: str, source: str, source_tier: int, evidence_id: str) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source=source,
        source_tier=source_tier,
        collected_at=datetime.now(timezone.utc).isoformat(),
        entity_candidates=[entity],
        signal_type="search_trend",
        title_or_label=f"{entity} trend",
    )


@pytest.mark.asyncio
async def test_analysis_engine_processes_force_enqueued_entity(tmp_path):
    sink = EvidenceSink()
    sink.extend(
        [
            _evidence("ChatGPT", "manual_observation", 1, "ev1"),
            _evidence("ChatGPT", "google_trends", 2, "ev2"),
        ]
    )
    store = AnalysisStore(path=str(tmp_path / "analysis.json"))
    builder = SignalCandidateBuilder(analysis_store=store)
    engine = AnalysisEngine(
        evidence_sink=sink,
        signal_builder=builder,
        analysis_store=store,
        policy=AnalysisPolicy(),
        context_packer=ContextPacker(),
        session_pool=SessionPool(
            exec_path="mock",
            base_args="",
            model="cheap-model",
            prompt_mode="stdin",
            prompt_flag="",
            model_flag="",
            continue_flag="",
            timeout_seconds=5,
            memory_char_budget=1000,
        ),
        enabled=True,
    )

    await engine.start()
    try:
        queued = await engine.enqueue_entity("ChatGPT")
        await engine._queue.join()  # type: ignore[attr-defined]
    finally:
        await engine.stop()

    assert len(queued) == 1
    projection = store.get_projection("ChatGPT")
    assert projection is not None
    assert projection.status in {"completed", "needs_review"}
    assert projection.summary is not None
    assert projection.model == "cheap-model"
