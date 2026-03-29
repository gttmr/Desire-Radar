from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import internal_routes, public_routes
from src.connectors.base import BaseConnector, RawPayload
from src.ingest.engine import IngestionEngine
from src.ingest.store import SubmissionStore
from src.normalizer.evidence_schema import Evidence
from src.resolver.entity_resolver import EntityResolver
from src.scheduler.cadence_runner import CadenceRunner
from src.source_agents.models import SourceAgentArtifact, SourceAgentPromptPreview, SourceAgentRunResult
from src.sources.defaults import build_default_sources
from src.sources.registry import SourceRegistry
from src.store.entity_store import EntityStore
from src.store.evidence_sink import EvidenceSink
from src.store.raw_snapshot_store import RawSnapshotStore


class EnabledConnector(BaseConnector):
    name = "enabled_pull"
    cadence_seconds = 60
    source_tier = 2

    async def fetch(self):
        return [
            RawPayload(
                source=self.name,
                data={"title": "Cursor demand rising", "entities": ["Cursor"]},
                request_params={},
                url_or_ref="",
            )
        ]


class DisabledConnector(BaseConnector):
    name = "disabled_pull"
    cadence_seconds = 60
    source_tier = 2

    async def fetch(self):
        return []

    def readiness(self):
        return "missing_credentials", "disabled pull credentials missing"


class StubAnalysisEngine:
    enabled = False

    def get_status(self, _entity: str):
        return {"queue_size": 0}


class StubSourceAgentRunner:
    def status(self, source_id: str):
        return {
            "source_id": source_id,
            "global_enabled": True,
            "agent_enabled": True,
            "agent_prompt_path": f"/tmp/{source_id}.md",
            "agent_session_domain": f"source-agent:{source_id}",
            "agent_output_mode": "artifact_and_derived",
            "latest_artifact": None,
            "session": None,
        }

    def preview(self, source_id: str, submission_id: str | None = None):
        return SourceAgentPromptPreview(
            source_id=source_id,
            submission_id=submission_id,
            session_domain=f"source-agent:{source_id}",
            output_mode="artifact_and_derived",
            prompt="preview",
            char_count=7,
            evidence_count=1,
            evidence_ids=["ev-1"],
            prompt_path=f"/tmp/{source_id}.md",
        ).model_dump() | {"agent_enabled": True, "global_enabled": True}

    async def run_latest(self, source_id: str, *, submission_id: str | None = None):
        artifact = SourceAgentArtifact(
            artifact_id=f"artifact-{source_id}",
            source_id=source_id,
            submission_id=submission_id,
            status="completed",
            output_mode="artifact_and_derived",
            session_domain=f"source-agent:{source_id}",
            derived_evidence_ids=["derived-1"],
            created_at="2026-03-28T00:00:00Z",
            updated_at="2026-03-28T00:00:00Z",
        )
        return SourceAgentRunResult(artifact=artifact, derived_evidence=[])


def _normalizer(source: str, raw_payload: dict, snapshot_ref: str) -> list[Evidence]:
    return [
        Evidence(
            evidence_id=f"{source}-{snapshot_ref}",
            source=source,
            source_tier=2,
            collected_at="2026-03-28T00:00:00Z",
            entity_candidates=raw_payload.get("entities", ["Cursor"]),
            signal_type="search_trend",
            title_or_label=raw_payload.get("title", "signal"),
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.8,
            freshness_ttl=3600,
        )
    ]


def _build_client(tmp_path) -> tuple[TestClient, SourceRegistry, IngestionEngine]:
    connectors = {
        EnabledConnector.name: EnabledConnector(),
        DisabledConnector.name: DisabledConnector(),
    }
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
    )
    cadence_runner = CadenceRunner(
        connectors=connectors,
        ingestion_engine=engine,
        source_registry=registry,
        bootstrap_on_start=False,
    )
    deps = {
        "ingestion_engine": engine,
        "connectors": connectors,
        "source_registry": registry,
        "analysis_engine": StubAnalysisEngine(),
        "source_agent_runner": StubSourceAgentRunner(),
        "cadence_runner": cadence_runner,
        "submission_store": engine.submission_store,
    }
    public_routes.init_dependencies(deps)
    internal_routes.init_dependencies(deps)
    app = FastAPI()
    app.include_router(public_routes.router)
    app.include_router(internal_routes.router)
    return TestClient(app), registry, engine


def test_collect_run_skips_disabled_pull_sources_by_default(tmp_path):
    client, registry, _ = _build_client(tmp_path)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/collect/run", json={"async_mode": True})

    assert response.status_code == 200
    payload = response.json()
    assert payload["queued_sources"] == ["enabled_pull"]
    assert payload["skipped_sources"]["disabled_pull"] == "source_disabled"
    assert payload["skipped_disabled_count"] >= 1
    assert "manual_observation" not in payload["queued_sources"]


def test_collect_run_returns_structured_conflict_for_disabled_connector(tmp_path):
    client, registry, _ = _build_client(tmp_path)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/collect/run", json={"connector": "disabled_pull", "async_mode": True})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "reason": "source_disabled",
        "source_id": "disabled_pull",
        "connector": "disabled_pull",
    }


def test_collect_run_returns_no_enabled_pull_sources_when_all_pull_sources_are_disabled(tmp_path):
    client, registry, _ = _build_client(tmp_path)
    registry.set_enabled("enabled_pull", False)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/collect/run", json={"async_mode": True})

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["reason"] == "no_enabled_pull_sources"
    assert detail["queued_sources"] == []
    assert detail["skipped_sources"]["enabled_pull"] == "source_disabled"
    assert detail["skipped_sources"]["disabled_pull"] == "source_disabled"
    assert detail["skipped_disabled_count"] >= 2


def test_collect_run_skips_not_ready_sources(tmp_path):
    client, _, _ = _build_client(tmp_path)

    response = client.post("/collect/run", json={"async_mode": True})

    assert response.status_code == 200
    payload = response.json()
    assert payload["queued_sources"] == ["enabled_pull"]
    assert payload["skipped_sources"]["disabled_pull"] == "missing_credentials"


def test_internal_run_source_returns_structured_conflict_for_disabled_source(tmp_path):
    client, registry, _ = _build_client(tmp_path)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/internal/sources/run/disabled_pull", json={})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "reason": "source_disabled",
        "source_id": "disabled_pull",
    }


def test_internal_source_agent_routes_return_runner_payloads(tmp_path):
    client, _, _ = _build_client(tmp_path)

    status_response = client.get("/internal/source-agents/enabled_pull/status")
    preview_response = client.get("/internal/source-agents/enabled_pull/preview")
    run_response = client.post("/internal/source-agents/run/enabled_pull", json={})

    assert status_response.status_code == 200
    assert status_response.json()["agent_session_domain"] == "source-agent:enabled_pull"
    assert preview_response.status_code == 200
    assert preview_response.json()["prompt"] == "preview"
    assert run_response.status_code == 200
    assert run_response.json()["artifact"]["artifact_id"] == "artifact-enabled_pull"


def test_sources_status_surfaces_source_agent_errors(tmp_path):
    client, registry, engine = _build_client(tmp_path)
    registry.record_source_agent_outcome(
        "enabled_pull",
        status="failed",
        artifact_id="artifact-enabled_pull",
        error_message="collector codex session failed",
    )
    engine._runtime_for_source("enabled_pull")["source_agent_error"] = "collector codex session failed"

    response = client.get("/sources/status")

    assert response.status_code == 200
    source = response.json()["sources"]["enabled_pull"]
    assert source["last_agent_error"] == "collector codex session failed"
    assert source["source_agent_error"] == "collector codex session failed"
    assert source["readiness_status"] == "ready"
