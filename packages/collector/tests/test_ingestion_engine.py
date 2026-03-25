from datetime import datetime, timezone

import pytest

from src.connectors.base import BaseConnector, RawPayload
from src.ingest.engine import IngestionEngine
from src.ingest.store import SubmissionStore
from src.normalizer.evidence_schema import Evidence
from src.resolver.entity_resolver import EntityResolver
from src.sources.defaults import build_default_sources
from src.sources.registry import SourceRegistry
from src.store.entity_store import EntityStore
from src.store.evidence_sink import EvidenceSink
from src.store.raw_snapshot_store import RawSnapshotStore


class DummyConnector(BaseConnector):
    name = "dummy_pull"
    cadence_seconds = 60
    source_tier = 2

    async def fetch(self) -> list[RawPayload]:
        return [
            RawPayload(
                source=self.name,
                data={"title": "Cursor demand rising", "entities": ["Cursor"]},
                request_params={},
                url_or_ref="",
            )
        ]


class StubAnalysisEngine:
    def __init__(self) -> None:
        self.calls = 0

    async def on_evidence_updated(self):
        self.calls += 1
        return []


def _normalizer(source: str, raw_payload: dict, snapshot_ref: str) -> list[Evidence]:
    entity = raw_payload.get("entities", ["Cursor"])[0]
    return [
        Evidence(
            evidence_id=f"{source}-{snapshot_ref}",
            source=source,
            source_tier=2,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=[entity],
            signal_type="search_trend",
            title_or_label=raw_payload.get("title", "signal"),
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.8,
            freshness_ttl=3600,
        )
    ]


def _build_engine(tmp_path):
    connectors = {DummyConnector.name: DummyConnector()}
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        build_default_sources(connectors),
    )
    analysis_engine = StubAnalysisEngine()
    engine = IngestionEngine(
        source_registry=registry,
        submission_store=SubmissionStore(str(tmp_path / "submissions.json")),
        snapshot_store=RawSnapshotStore(str(tmp_path / "snapshots")),
        evidence_sink=EvidenceSink(),
        entity_resolver=EntityResolver(EntityStore(str(tmp_path / "entities.json"))),
        normalizer_fn=_normalizer,
        connectors=connectors,
        analysis_engine=analysis_engine,
    )
    return engine, registry, analysis_engine


@pytest.mark.asyncio
async def test_sync_human_observation_creates_submission_and_evidence(tmp_path):
    engine, registry, analysis_engine = _build_engine(tmp_path)

    record = await engine.submit_human_observation(
        {
            "title": "Cursor usage is spiking",
            "entities": ["Cursor"],
            "reporter": "operator",
        },
        async_mode=False,
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    assert stored.evidence_ids
    assert analysis_engine.calls == 1
    status = registry.status()["manual_observation"]
    assert status["pending_submissions"] == 0
    assert status["last_submission"] is not None


@pytest.mark.asyncio
async def test_async_evidence_submission_uses_current_effective_tier_snapshot(tmp_path):
    engine, registry, _ = _build_engine(tmp_path)
    await engine.start()
    try:
        registry.update_tier("agent_evidence", 3, override_reason="manual downgrade")
        record = await engine.enqueue_evidence(
            "agent_evidence",
            [
                {
                    "evidence_id": "agent-ev-1",
                    "source": "agent_evidence",
                    "entity_candidates": ["Cursor"],
                    "signal_type": "agent_research",
                    "title_or_label": "Agent found stronger demand",
                    "metric_value": None,
                    "metric_delta": None,
                    "rank": None,
                    "geo": "global",
                    "url_or_ref": "",
                    "trust_score": 0.85,
                    "freshness_ttl": 3600,
                }
            ],
            producer_ref="orchestrator-agent",
            parent_evidence_ids=["seed-1"],
        )
        await engine._queue.join()  # type: ignore[attr-defined]
    finally:
        await engine.stop()

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    evidence = engine.evidence_sink.get_all()[0]
    assert evidence.source == "agent_evidence"
    assert evidence.source_tier == 3
    assert evidence.source_kind == "agent"
    assert evidence.producer_ref == "orchestrator-agent"
    assert evidence.parent_evidence_ids == ["seed-1"]


@pytest.mark.asyncio
async def test_run_derived_source_keeps_parent_lineage(tmp_path):
    engine, _, _ = _build_engine(tmp_path)
    seed = Evidence(
        evidence_id="seed-a",
        source="google_trends",
        source_tier=2,
        collected_at=datetime.now(timezone.utc).isoformat(),
        entity_candidates=["Cursor", "OpenAI"],
        signal_type="search_trend",
        title_or_label="Cursor and OpenAI mentioned together",
        raw_snapshot_ref="snap-1",
        trust_score=0.8,
        freshness_ttl=3600,
    )
    second = seed.model_copy(
        update={
            "evidence_id": "seed-b",
            "source": "reddit_mentions",
            "raw_snapshot_ref": "snap-2",
        }
    )
    engine.evidence_sink.extend([seed, second])

    record = await engine.run_source("co_mention_surge")

    assert record.status == "completed"
    derived = [item for item in engine.evidence_sink.get_all() if item.source == "co_mention_surge"]
    assert len(derived) == 1
    assert set(derived[0].parent_evidence_ids) == {"seed-a", "seed-b"}


@pytest.mark.asyncio
async def test_request_human_analyst_note_creates_pending_human_submission(tmp_path):
    engine, registry, _ = _build_engine(tmp_path)

    record = await engine.request_human_analyst_note(
        {
            "entity_candidates": ["Cursor"],
            "question": "Why is demand spiking among developers?",
            "why_now": "Debate produced a missing channel explanation.",
            "priority": "high",
            "requested_by_agent": "human_intel",
            "run_id": "run-123",
        }
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "pending_human"
    assert stored.metadata["requested_by_agent"] == "human_intel"
    assert stored.metadata["run_id"] == "run-123"
    assert registry.status()["human_analyst_note"]["pending_submissions"] == 1
