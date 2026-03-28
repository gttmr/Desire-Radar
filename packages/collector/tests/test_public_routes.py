from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import internal_routes, public_routes
from src.connectors.base import BaseConnector, RawPayload
from src.ingest.engine import IngestionEngine
from src.ingest.store import SubmissionStore
from src.normalizer.evidence_schema import Evidence
from src.resolver.entity_resolver import EntityResolver
from src.scheduler.cadence_runner import CadenceRunner
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


class StubAnalysisEngine:
    enabled = False

    def get_status(self, _entity: str):
        return {"queue_size": 0}


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


def _build_client(tmp_path) -> tuple[TestClient, SourceRegistry]:
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
        "cadence_runner": cadence_runner,
        "submission_store": engine.submission_store,
    }
    public_routes.init_dependencies(deps)
    internal_routes.init_dependencies(deps)
    app = FastAPI()
    app.include_router(public_routes.router)
    app.include_router(internal_routes.router)
    return TestClient(app), registry


def test_collect_run_skips_disabled_pull_sources_by_default(tmp_path):
    client, registry = _build_client(tmp_path)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/collect/run", json={"async_mode": True})

    assert response.status_code == 200
    payload = response.json()
    assert payload["queued_sources"] == ["enabled_pull"]
    assert payload["skipped_sources"]["disabled_pull"] == "source_disabled"
    assert payload["skipped_disabled_count"] == 1
    assert "manual_observation" not in payload["queued_sources"]


def test_collect_run_returns_structured_conflict_for_disabled_connector(tmp_path):
    client, registry = _build_client(tmp_path)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/collect/run", json={"connector": "disabled_pull", "async_mode": True})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "reason": "source_disabled",
        "source_id": "disabled_pull",
        "connector": "disabled_pull",
    }


def test_collect_run_returns_no_enabled_pull_sources_when_all_pull_sources_are_disabled(tmp_path):
    client, registry = _build_client(tmp_path)
    registry.set_enabled("enabled_pull", False)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/collect/run", json={"async_mode": True})

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["reason"] == "no_enabled_pull_sources"
    assert detail["queued_sources"] == []
    assert detail["skipped_disabled_count"] == 2


def test_internal_run_source_returns_structured_conflict_for_disabled_source(tmp_path):
    client, registry = _build_client(tmp_path)
    registry.set_enabled("disabled_pull", False)

    response = client.post("/internal/sources/run/disabled_pull", json={})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "reason": "source_disabled",
        "source_id": "disabled_pull",
    }
