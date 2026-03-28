from datetime import datetime, timezone

import pytest

from src.analysis.models import ExecutionUsage, RawExecutionResult, SessionState
from src.connectors.base import BaseConnector
from src.ingest.models import SubmissionRecord
from src.ingest.store import SubmissionStore
from src.normalizer.evidence_schema import Evidence
from src.source_agents import (
    SourceAgentArtifactStore,
    SourceAgentContextBuilder,
    SourceAgentRegistry,
)
from src.source_agents.runner import SourceAgentRunner
from src.sources.defaults import build_default_sources
from src.sources.registry import SourceRegistry
from src.store.evidence_sink import EvidenceSink


class _SessionPool:
    def __init__(self, payload: dict):
        self.payload = payload
        self.calls = []

    async def execute_json(self, prompt: str, *, domain: str, execution_mode: str):
        self.calls.append((prompt, domain, execution_mode))
        return RawExecutionResult(
            session_id="provider-session",
            model="gpt-5.4-mini",
            payload=self.payload,
            usage=ExecutionUsage(input_tokens=100, output_tokens=20, uncached_input_tokens=100),
            raw_text='{"summary":"ok"}',
            session_dir="/tmp/source-agent/session",
            turn_index=1,
            request_artifact_path="/tmp/source-agent/session/artifacts/turn-0001-request.json",
            response_artifact_path="/tmp/source-agent/session/artifacts/turn-0001-response.json",
        )

    def list_states(self):
        return [
            SessionState(
                session_id="provider-session",
                domain="source-agent:reddit_mentions",
                model="gpt-5.4-mini",
                session_dir="/tmp/source-agent/session",
                last_active_at=datetime.now(timezone.utc).isoformat(),
            )
        ]


class _FlakySessionPool(_SessionPool):
    def __init__(self, payload: dict, *, error_message: str = "analysis CLI timed out after 120s"):
        super().__init__(payload)
        self.fail_first = True
        self.error_message = error_message

    async def execute_json(self, prompt: str, *, domain: str, execution_mode: str):
        self.calls.append((prompt, domain, execution_mode))
        if self.fail_first:
            self.fail_first = False
            raise RuntimeError(self.error_message)
        return await super().execute_json(prompt, domain=domain, execution_mode=execution_mode)

    def reset(self, domain: str):
        self.calls.append(("__reset__", domain, ""))


class _AlwaysFailSessionPool(_SessionPool):
    def __init__(self, *, error_message: str):
        super().__init__({})
        self.error_message = error_message

    async def execute_json(self, prompt: str, *, domain: str, execution_mode: str):
        self.calls.append((prompt, domain, execution_mode))
        raise RuntimeError(self.error_message)

    def reset(self, domain: str):
        self.calls.append(("__reset__", domain, ""))


class _RedditConnector(BaseConnector):
    name = "reddit_mentions"
    cadence_seconds = 300
    source_tier = 2

    async def fetch(self):
        return []


def _build_runner(tmp_path, payload: dict) -> tuple[SourceAgentRunner, EvidenceSink, SubmissionStore]:
    connectors = {"reddit_mentions": _RedditConnector()}
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        build_default_sources(connectors),
    )
    artifact_store = SourceAgentArtifactStore(str(tmp_path / "source-agent-artifacts.json"))
    submission_store = SubmissionStore(str(tmp_path / "submissions.json"))
    sink = EvidenceSink()
    runner = SourceAgentRunner(
        source_registry=registry,
        agent_registry=SourceAgentRegistry(registry),
        context_builder=SourceAgentContextBuilder(SourceAgentRegistry(registry)),
        artifact_store=artifact_store,
        session_pool=_SessionPool(payload),
        submission_store=submission_store,
        evidence_sink=sink,
        enabled=True,
        execution_mode="resume",
    )
    return runner, sink, submission_store


def _build_runner_with_session_pool(tmp_path, session_pool) -> tuple[SourceAgentRunner, EvidenceSink, SubmissionStore]:
    connectors = {"reddit_mentions": _RedditConnector()}
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        build_default_sources(connectors),
    )
    artifact_store = SourceAgentArtifactStore(str(tmp_path / "source-agent-artifacts.json"))
    submission_store = SubmissionStore(str(tmp_path / "submissions.json"))
    sink = EvidenceSink()
    runner = SourceAgentRunner(
        source_registry=registry,
        agent_registry=SourceAgentRegistry(registry),
        context_builder=SourceAgentContextBuilder(SourceAgentRegistry(registry)),
        artifact_store=artifact_store,
        session_pool=session_pool,
        submission_store=submission_store,
        evidence_sink=sink,
        enabled=True,
        execution_mode="resume",
    )
    return runner, sink, submission_store


def _submission(source_id: str) -> SubmissionRecord:
    return SubmissionRecord(
        submission_id="submission-1",
        source_id=source_id,
        source_kind="pull",
        ingestion_mode="raw",
        status="completed",
        received_at=datetime.now(timezone.utc).isoformat(),
        evidence_ids=["ev-1"],
    )


def _evidence(source_id: str = "reddit_mentions") -> Evidence:
    return Evidence(
        evidence_id="ev-1",
        source=source_id,
        source_tier=2,
        source_kind="pull",
        producer_ref=source_id,
        submission_ref="submission-1",
        collected_at=datetime.now(timezone.utc).isoformat(),
        entity_candidates=["Cursor"],
        signal_type="social_mention",
        title_or_label="Cursor rollout chatter increases",
        raw_snapshot_ref="snap-1",
        trust_score=0.8,
        freshness_ttl=3600,
    )


def test_source_agent_runner_preview_exposes_prompt_and_metadata(tmp_path):
    runner, sink, submission_store = _build_runner(
        tmp_path,
        {"summary": "ok", "confidence": 0.6, "warnings": [], "theme_tags": [], "entity_hints": []},
    )
    submission = _submission("reddit_mentions")
    submission_store.create(submission)
    sink.append(_evidence())

    preview = runner.preview("reddit_mentions")

    assert preview["source_id"] == "reddit_mentions"
    assert preview["agent_enabled"] is True
    assert preview["session_domain"] == "source-agent:reddit_mentions"
    assert preview["prompt_path"].endswith("reddit_mentions.md")
    assert "Cursor rollout chatter increases" in preview["prompt"]
    assert "metadata:" not in preview["prompt"]
    assert "signal_types:" in preview["prompt"]
    assert "Do not inspect workspace files" in preview["prompt"]


@pytest.mark.asyncio
async def test_source_agent_runner_creates_artifact_and_derived_evidence(tmp_path):
    runner, sink, submission_store = _build_runner(
        tmp_path,
        {
            "summary": "Repeated rollout chatter suggests a workflow adoption event.",
            "confidence": 0.72,
            "warnings": [],
            "theme_tags": ["developer-workflow"],
            "event_summary": "Cursor adoption event",
            "entity_hints": ["Cursor"],
            "relationship_hints": [],
            "derived_evidence": [],
        },
    )
    submission = _submission("reddit_mentions")
    submission_store.create(submission)
    sink.append(_evidence())

    result = await runner.run_latest("reddit_mentions")

    assert result.artifact.status == "completed"
    assert result.artifact.source_id == "reddit_mentions"
    assert result.artifact.request_artifact_path is not None
    assert result.artifact.response_artifact_path is not None
    assert len(result.derived_evidence) == 1
    derived = result.derived_evidence[0]
    assert derived.source == "reddit_mentions"
    assert derived.source_kind == "derived"
    assert derived.producer_ref == "source_agent:reddit_mentions"


@pytest.mark.asyncio
async def test_source_agent_runner_retries_with_compact_context_after_parse_failure(tmp_path):
    session_pool = _FlakySessionPool(
        {
            "summary": "Compact retry succeeded.",
            "confidence": 0.67,
            "warnings": [],
            "theme_tags": ["workflow"],
            "entity_hints": ["Cursor"],
            "derived_evidence": [],
        },
        error_message="analysis CLI returned invalid JSON: {",
    )
    runner, sink, submission_store = _build_runner_with_session_pool(tmp_path, session_pool)
    submission = _submission("reddit_mentions")
    submission_store.create(submission)
    sink.append(_evidence())

    result = await runner.run_latest("reddit_mentions")

    assert result.artifact.status == "completed"
    assert result.artifact.execution_notes
    assert session_pool.calls[0][2] == "resume"
    assert ("__reset__", "source-agent:reddit_mentions", "") in session_pool.calls
    assert session_pool.calls[-1][2] == "fresh"
    assert session_pool.calls[0][0] != session_pool.calls[-1][0]


@pytest.mark.asyncio
async def test_source_agent_runner_retries_timeout_failures_with_minimal_context(tmp_path):
    session_pool = _FlakySessionPool(
        {
            "summary": "Minimal retry succeeded.",
            "confidence": 0.58,
            "warnings": [],
            "theme_tags": ["workflow"],
            "entity_hints": ["Cursor"],
        },
        error_message="analysis CLI timed out after 120s",
    )
    runner, sink, submission_store = _build_runner_with_session_pool(tmp_path, session_pool)
    submission = _submission("reddit_mentions")
    submission_store.create(submission)
    sink.append(_evidence())

    result = await runner.run_latest("reddit_mentions")

    assert result.artifact.status == "completed"
    assert ("__reset__", "source-agent:reddit_mentions", "") in session_pool.calls
    assert session_pool.calls[0][2] == "resume"
    assert session_pool.calls[-1][2] == "fresh"
    assert "context_mode: minimal" in session_pool.calls[-1][0]
    assert any("minimal" in note for note in result.artifact.execution_notes)


@pytest.mark.asyncio
async def test_source_agent_runner_fails_after_all_fallbacks_exhausted(tmp_path):
    session_pool = _AlwaysFailSessionPool(error_message="analysis CLI timed out after 120s")
    runner, sink, submission_store = _build_runner_with_session_pool(tmp_path, session_pool)
    submission = _submission("reddit_mentions")
    submission_store.create(submission)
    sink.append(_evidence())

    result = await runner.run_latest("reddit_mentions")

    assert result.artifact.status == "failed"
    assert "standard=analysis CLI timed out after 120s" in (result.artifact.error_message or "")
    assert "minimal=analysis CLI timed out after 120s" in (result.artifact.error_message or "")


def test_source_agent_runner_status_surfaces_latest_artifact(tmp_path):
    runner, sink, submission_store = _build_runner(
        tmp_path,
        {"summary": "ok", "confidence": 0.6, "warnings": [], "theme_tags": [], "entity_hints": []},
    )
    submission = _submission("reddit_mentions")
    submission_store.create(submission)
    sink.append(_evidence())

    # Persist one artifact through the normal runner path.
    import asyncio

    asyncio.run(runner.run_latest("reddit_mentions"))
    status = runner.status("reddit_mentions")

    assert status["agent_enabled"] is True
    assert status["latest_artifact"]["status"] == "completed"
    assert status["session"]["domain"] == "source-agent:reddit_mentions"
