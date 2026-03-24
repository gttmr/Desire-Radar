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


def _mock_session_pool() -> SessionPool:
    return SessionPool(
        exec_path="mock",
        provider="codex",
        initial_args="",
        resume_args="",
        model="cheap-model",
        model_flag="-m",
        timeout_seconds=5,
        memory_char_budget=1000,
        memory_entry_count=3,
        memory_entry_char_budget=160,
        max_idle_minutes=20,
        max_turns=5,
        max_uncached_input_tokens=20000,
        parse_error_snippet_chars=200,
        use_stdin=True,
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
        session_pool=_mock_session_pool(),
        enabled=True,
        execution_mode="fresh",
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
    assert projection.last_execution_mode == "fresh"


@pytest.mark.asyncio
async def test_analysis_engine_batches_multiple_candidates(tmp_path):
    sink = EvidenceSink()
    sink.extend(
        [
            _evidence("ChatGPT", "manual_observation", 1, "ev1"),
            _evidence("ChatGPT", "google_trends", 2, "ev2"),
            _evidence("Cursor", "manual_observation", 1, "ev3"),
            _evidence("Cursor", "reddit_mentions", 2, "ev4"),
            _evidence("Perplexity", "manual_observation", 1, "ev5"),
            _evidence("Perplexity", "google_trends", 2, "ev6"),
        ]
    )
    store = AnalysisStore(path=str(tmp_path / "analysis.json"))
    builder = SignalCandidateBuilder(analysis_store=store)
    engine = AnalysisEngine(
        evidence_sink=sink,
        signal_builder=builder,
        analysis_store=store,
        policy=AnalysisPolicy(),
        context_packer=ContextPacker(batch_char_budget=4000),
        session_pool=_mock_session_pool(),
        enabled=True,
        execution_mode="batch",
        analysis_batch_size=3,
    )

    await engine.start()
    try:
        queued = await engine.on_evidence_updated()
        await engine._queue.join()  # type: ignore[attr-defined]
    finally:
        await engine.stop()

    assert len(queued) == 3
    for entity in ("ChatGPT", "Cursor", "Perplexity"):
        projection = store.get_projection(entity)
        assert projection is not None
        assert projection.last_execution_mode == "batch"
        assert projection.last_batch_size == 3
        assert projection.last_uncached_input_tokens is not None


def test_analysis_engine_preview_batch_returns_prompt(tmp_path):
    sink = EvidenceSink()
    sink.extend(
        [
            _evidence("ChatGPT", "manual_observation", 1, "ev1"),
            _evidence("ChatGPT", "google_trends", 2, "ev2"),
            _evidence("Cursor", "manual_observation", 1, "ev3"),
            _evidence("Cursor", "reddit_mentions", 2, "ev4"),
        ]
    )
    store = AnalysisStore(path=str(tmp_path / "analysis.json"))
    builder = SignalCandidateBuilder(analysis_store=store)
    engine = AnalysisEngine(
        evidence_sink=sink,
        signal_builder=builder,
        analysis_store=store,
        policy=AnalysisPolicy(),
        context_packer=ContextPacker(batch_char_budget=4000),
        session_pool=_mock_session_pool(),
        enabled=True,
        execution_mode="batch",
        analysis_batch_size=2,
    )

    preview = engine.preview_batch()

    assert preview["count"] == 2
    assert preview["prompt_format"] == "markdown"
    assert preview["batch_size"] == 2
