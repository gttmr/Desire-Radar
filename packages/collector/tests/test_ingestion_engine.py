from datetime import datetime, timezone
import asyncio

import pytest

from src.connectors.base import BaseConnector, RawPayload
from src.ingest.engine import IngestionEngine
from src.ingest.human_input_models import HumanInputRoutingDecision
from src.ingest.store import SubmissionStore
from src.normalizer.evidence_schema import Evidence
from src.resolver.entity_resolver import EntityResolver
from src.sources.models import SourceDefinition
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


class BlockingConnector(BaseConnector):
    name = "blocking_pull"
    cadence_seconds = 60
    source_tier = 2

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def fetch(self) -> list[RawPayload]:
        self.started.set()
        await self.release.wait()
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


class StubHumanInputRouter:
    def __init__(self, decision: HumanInputRoutingDecision) -> None:
        self.decision = decision
        self.calls: list[tuple[object, str | None]] = []

    async def classify(self, envelope, *, preferred_route=None):
        self.calls.append((envelope, preferred_route))
        return self.decision


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


def _build_engine(tmp_path, human_input_router=None):
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
        human_input_router=human_input_router,
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
async def test_run_source_persists_research_metadata_and_records_fulfillment(tmp_path):
    engine, registry, _ = _build_engine(tmp_path)

    record = await engine.run_source(
        "dummy_pull",
        producer_ref="research-loop",
        metadata={
            "question": "Refresh search demand before verdict.",
            "intent": "demand",
            "requested_by_agent": "research-loop",
            "requested_input_kind": "study_result",
        },
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    assert stored.producer_ref == "research-loop"
    assert stored.metadata["question"] == "Refresh search demand before verdict."
    validity = registry.validity("dummy_pull")
    assert validity["metrics"]["research_fulfillment_total"] == 1
    assert validity["metrics"]["research_useful_total"] == 1


@pytest.mark.asyncio
async def test_run_source_uses_normalizer_key_instead_of_adapter_name(tmp_path):
    connectors = {DummyConnector.name: DummyConnector()}
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        [
            SourceDefinition(
                source_id="custom_pull",
                kind="pull",
                ingestion_mode="raw",
                configured_tier=2,
                effective_tier=2,
                enabled=True,
                adapter_name=DummyConnector.name,
                default_producer_ref="custom",
                cadence_seconds=60,
                runnable=True,
                scheduled=True,
                normalizer_key="manual_observation",
            )
        ],
    )
    analysis_engine = StubAnalysisEngine()
    calls: list[str] = []

    def normalizer(source: str, raw_payload: dict, snapshot_ref: str) -> list[Evidence]:
        calls.append(source)
        return _normalizer(source, raw_payload, snapshot_ref)

    engine = IngestionEngine(
        source_registry=registry,
        submission_store=SubmissionStore(str(tmp_path / "submissions.json")),
        snapshot_store=RawSnapshotStore(str(tmp_path / "snapshots")),
        evidence_sink=EvidenceSink(),
        entity_resolver=EntityResolver(EntityStore(str(tmp_path / "entities.json"))),
        normalizer_fn=normalizer,
        connectors=connectors,
        analysis_engine=analysis_engine,
    )

    record = await engine.run_source("custom_pull")

    assert record.status == "completed"
    assert calls == ["manual_observation"]


@pytest.mark.asyncio
async def test_enqueue_source_run_reports_runtime_state_while_running(tmp_path):
    connector = BlockingConnector()
    connectors = {connector.name: connector}
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        build_default_sources(connectors),
    )
    engine = IngestionEngine(
        source_registry=registry,
        submission_store=SubmissionStore(str(tmp_path / "submissions.json")),
        snapshot_store=RawSnapshotStore(str(tmp_path / "snapshots")),
        evidence_sink=EvidenceSink(),
        entity_resolver=EntityResolver(EntityStore(str(tmp_path / "entities.json"))),
        normalizer_fn=_normalizer,
        connectors=connectors,
        analysis_engine=StubAnalysisEngine(),
        source_run_worker_concurrency=1,
    )
    await engine.start()
    try:
        record = await engine.enqueue_source_run(
            "blocking_pull",
            metadata={"trigger": "scheduled"},
        )
        await connector.started.wait()

        runtime = engine.get_runtime_status()
        assert runtime["source_run_queue_size"] == 0
        assert runtime["active_source_count"] == 1
        source_runtime = runtime["sources"]["blocking_pull"]
        stored_while_running = await engine.get_submission(record.submission_id)
        assert stored_while_running is not None
        assert stored_while_running.status == "running"
        assert source_runtime["run_state"] == "running"
        assert source_runtime["active_runs"] == 1
        assert source_runtime["queued_runs"] == 0
        assert source_runtime["active_submission_ids"] == [record.submission_id]
        assert source_runtime["last_trigger"] == "scheduled"

        connector.release.set()
        await engine._source_run_queue.join()  # type: ignore[attr-defined]
    finally:
        await engine.stop()

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    runtime = engine.get_runtime_status()
    assert runtime["active_source_count"] == 0
    assert runtime["sources"]["blocking_pull"]["run_state"] == "idle"
    assert runtime["sources"]["blocking_pull"]["last_outcome"] == "completed"


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
    assert stored.metadata["intent"] == "demand"
    assert stored.metadata["requested_input_kind"] == "study_result"
    assert stored.metadata["required_fields"] == []
    assert stored.metadata["preferred_capabilities"] == []
    assert registry.status()["human_analyst_note"]["pending_submissions"] == 1


@pytest.mark.asyncio
async def test_request_human_analyst_note_stores_research_metadata(tmp_path):
    engine, _, _ = _build_engine(tmp_path)

    record = await engine.request_human_analyst_note(
        {
            "entity_candidates": ["Cursor"],
            "question": "Which public beneficiary should be monitored?",
            "why_now": "Need a public-market mapping before verdict.",
            "priority": "high",
            "requested_by_agent": "investment_verdict",
            "intent": "beneficiary",
            "requested_input_kind": "beneficiary_mapping",
            "required_fields": ["entity", "public_beneficiary", "value_capture_reason"],
            "preferred_capabilities": ["beneficiary", "monetization"],
            "source_hints": ["agent_evidence"],
        }
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.metadata["intent"] == "beneficiary"
    assert stored.metadata["requested_input_kind"] == "beneficiary_mapping"
    assert stored.metadata["required_fields"] == [
        "entity",
        "public_beneficiary",
        "value_capture_reason",
    ]
    assert stored.metadata["preferred_capabilities"] == ["beneficiary", "monetization"]
    assert stored.metadata["source_hints"] == ["agent_evidence"]


@pytest.mark.asyncio
async def test_human_analyst_note_fulfills_pending_request_and_sets_submission_ref(tmp_path):
    engine, registry, _ = _build_engine(tmp_path)

    request = await engine.request_human_analyst_note(
        {
            "entity_candidates": ["Cursor"],
            "question": "What specific workflow is driving adoption?",
            "requested_by_agent": "human_intel",
        }
    )

    note = await engine.submit_human_analyst_note(
        {
            "title": "Cursor field study",
            "observation": "Developers are adopting it for code review workflows.",
            "entity_candidates": ["Cursor"],
            "request_submission_id": request.submission_id,
            "beneficiary_hints": ["Microsoft"],
            "supporting_points": ["Repeated mentions in team adoption logs"],
        },
        async_mode=False,
    )

    fulfilled_request = await engine.get_submission(request.submission_id)
    assert fulfilled_request is not None
    assert fulfilled_request.status == "completed"
    assert fulfilled_request.metadata["fulfilled_by_submission_id"] == note.submission_id
    evidence = engine.evidence_sink.get_all()[0]
    assert evidence.submission_ref == note.submission_id
    assert registry.status()["human_analyst_note"]["pending_submissions"] == 0


@pytest.mark.asyncio
async def test_requested_channel_check_prefers_curated_dataset_route(tmp_path):
    router = StubHumanInputRouter(
        HumanInputRoutingDecision(
            route="manual_observation",
            confidence=0.99,
            rationale="forced",
            title="Ignored",
            entities=["Cursor"],
            observation="Ignored",
        )
    )
    engine, _, _ = _build_engine(tmp_path, human_input_router=router)
    request = await engine.request_human_analyst_note(
        {
            "entity_candidates": ["Cursor"],
            "question": "Provide channel check inventory datapoints.",
            "requested_input_kind": "channel_check",
        }
    )

    await engine.submit_human_input(
        {
            "content": '{"evidence_items":[{"evidence_id":"manual-1","entity_candidates":["Cursor"],"signal_type":"channel_check","title_or_label":"Store inventory tightened","trust_score":0.9}]}',
            "request_submission_id": request.submission_id,
            "channel_name": "human-input",
        }
    )

    assert router.calls[0][1] == "human_curated_dataset"


@pytest.mark.asyncio
async def test_human_curated_dataset_ingests_as_human_source_batch(tmp_path):
    engine, registry, _ = _build_engine(tmp_path)
    await engine.start()
    try:
        record = await engine.submit_human_evidence_batch(
            {
                "producer_ref": "research-desk",
                "dataset_name": "March channel checks",
                "notes": "Hand-curated observations from operator interviews.",
                "evidence_items": [
                    {
                        "evidence_id": "human-batch-1",
                        "entity_candidates": ["Cursor"],
                        "signal_type": "channel_check",
                        "title_or_label": "Procurement teams are expanding seat counts",
                        "trust_score": 0.9,
                    }
                ],
            }
        )
        await engine._queue.join()  # type: ignore[attr-defined]
    finally:
        await engine.stop()

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    evidence = engine.evidence_sink.get_all()[0]
    assert evidence.source == "human_curated_dataset"
    assert evidence.source_kind == "human"
    assert evidence.producer_ref == "research-desk"
    assert evidence.submission_ref == record.submission_id
    assert registry.status()["human_curated_dataset"]["pending_submissions"] == 0


@pytest.mark.asyncio
async def test_human_curated_dataset_can_fulfill_pending_request(tmp_path):
    engine, registry, _ = _build_engine(tmp_path)
    await engine.start()
    try:
        request = await engine.request_human_analyst_note(
            {
                "entity_candidates": ["Cursor"],
                "question": "Provide hard datapoints from channel checks.",
                "requested_by_agent": "research_loop",
            }
        )
        record = await engine.submit_human_evidence_batch(
            {
                "producer_ref": "research-desk",
                "dataset_name": "Channel checks",
                "request_submission_id": request.submission_id,
                "evidence_items": [
                    {
                        "evidence_id": "human-batch-2",
                        "entity_candidates": ["Cursor"],
                        "signal_type": "channel_check",
                        "title_or_label": "Three teams increased paid seat counts this week",
                        "trust_score": 0.9,
                    }
                ],
            }
        )
        await engine._queue.join()  # type: ignore[attr-defined]
    finally:
        await engine.stop()

    fulfilled_request = await engine.get_submission(request.submission_id)
    assert fulfilled_request is not None
    assert fulfilled_request.status == "completed"
    assert fulfilled_request.metadata["fulfilled_by_submission_id"] == record.submission_id
    assert fulfilled_request.metadata["fulfilled_by_source_id"] == "human_curated_dataset"
    assert registry.status()["human_analyst_note"]["pending_submissions"] == 0


@pytest.mark.asyncio
async def test_human_input_inbox_routes_manual_observation(tmp_path):
    router = StubHumanInputRouter(
        HumanInputRoutingDecision(
            route="manual_observation",
            confidence=0.9,
            title="Cursor adoption spike",
            entities=["Cursor"],
            signal_type="manual",
            geo="global",
            url="https://discord.example/message",
            trust_score=0.92,
            freshness_ttl=7200,
        )
    )
    engine, registry, _ = _build_engine(tmp_path, human_input_router=router)

    record = await engine.submit_human_input(
        {
            "content": "Cursor adoption spike",
            "message_url": "https://discord.example/message",
            "producer_ref": "discord:123",
            "author_id": "123",
            "author_name": "operator",
            "channel_name": "human-input",
            "message_id": "msg-1",
        }
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    assert stored.metadata["routed_source_id"] == "manual_observation"
    assert stored.evidence_ids
    evidence = engine.evidence_sink.get_all()[0]
    assert evidence.source == "manual_observation"
    assert evidence.producer_ref == "discord:123"
    assert registry.status()["human_input_inbox"]["pending_submissions"] == 0
    assert router.calls[0][1] is None


@pytest.mark.asyncio
async def test_human_input_inbox_routes_note_and_fulfills_request(tmp_path):
    router = StubHumanInputRouter(
        HumanInputRoutingDecision(
            route="human_analyst_note",
            confidence=0.88,
            title="Cursor field study",
            observation="Teams are expanding usage for code review workflows.",
            entities=["Cursor"],
            why_now="Adoption accelerated after broader IDE rollout.",
            supporting_points=["Three teams increased seats in one week"],
            request_submission_id="",
        )
    )
    engine, registry, _ = _build_engine(tmp_path, human_input_router=router)
    request = await engine.request_human_analyst_note(
        {
            "entity_candidates": ["Cursor"],
            "question": "What workflow is driving seat growth?",
            "requested_by_agent": "human_intel",
        }
    )

    record = await engine.submit_human_input(
        {
            "content": "why_now: rollout widened\nTeams are expanding usage for code review workflows.",
            "message_url": "https://discord.example/study",
            "producer_ref": "discord:321",
            "channel_name": "human-input",
            "message_id": "msg-2",
            "request_submission_id": request.submission_id,
        }
    )

    stored = await engine.get_submission(record.submission_id)
    fulfilled_request = await engine.get_submission(request.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    assert stored.metadata["routed_source_id"] == "human_analyst_note"
    assert fulfilled_request is not None
    assert fulfilled_request.status == "completed"
    assert fulfilled_request.metadata["fulfilled_by_source_id"] == "human_analyst_note"
    assert registry.status()["human_input_inbox"]["pending_submissions"] == 0
    assert router.calls[0][1] == "human_analyst_note"


@pytest.mark.asyncio
async def test_human_input_inbox_routes_dataset_batch(tmp_path):
    router = StubHumanInputRouter(
        HumanInputRoutingDecision(
            route="human_curated_dataset",
            confidence=0.97,
            dataset_name="Discord channel checks",
            evidence_items=[
                {
                    "evidence_id": "discord-1",
                    "entity_candidates": ["Cursor"],
                    "signal_type": "channel_check",
                    "title_or_label": "Three teams added paid seats",
                    "trust_score": 0.9,
                }
            ],
        )
    )
    engine, registry, _ = _build_engine(tmp_path, human_input_router=router)

    record = await engine.submit_human_input(
        {
            "content": "```json\n{\"evidence_items\":[{\"evidence_id\":\"discord-1\",\"entity_candidates\":[\"Cursor\"],\"signal_type\":\"channel_check\",\"title_or_label\":\"Three teams added paid seats\",\"trust_score\":0.9}]}\n```",
            "message_url": "https://discord.example/data",
            "producer_ref": "discord:999",
            "channel_name": "human-input",
            "message_id": "msg-3",
        }
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "completed"
    assert stored.metadata["routed_source_id"] == "human_curated_dataset"
    evidence = engine.evidence_sink.get_all()[0]
    assert evidence.source == "human_curated_dataset"
    assert evidence.producer_ref == "discord:999"
    assert registry.status()["human_input_inbox"]["pending_submissions"] == 0


@pytest.mark.asyncio
async def test_human_input_inbox_rejects_needs_review(tmp_path):
    router = StubHumanInputRouter(
        HumanInputRoutingDecision(
            route="needs_review",
            confidence=0.2,
            rationale="too_vague",
            user_message="형식을 더 구체화해 주세요.",
        )
    )
    engine, registry, _ = _build_engine(tmp_path, human_input_router=router)

    record = await engine.submit_human_input(
        {
            "content": "",
            "producer_ref": "discord:404",
            "message_id": "msg-4",
        }
    )

    stored = await engine.get_submission(record.submission_id)
    assert stored is not None
    assert stored.status == "rejected"
    assert stored.evidence_ids == []
    assert stored.metadata["classification"]["route"] == "needs_review"
    assert registry.status()["human_input_inbox"]["pending_submissions"] == 0
