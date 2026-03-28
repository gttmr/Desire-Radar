from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import dashboard_routes, internal_routes, public_routes
from src.builder.signal_candidate_builder import SignalCandidateBuilder
from src.connectors.base import BaseConnector, RawPayload
from src.ingest.engine import IngestionEngine
from src.ingest.models import SubmissionRecord
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


class StubAnalysisEngine:
    enabled = False
    execution_mode = "batch"

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


def _build_client(tmp_path, monkeypatch) -> tuple[TestClient, SubmissionStore, EvidenceSink]:
    connectors = {
        EnabledConnector.name: EnabledConnector(),
    }
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "GOOGLE_TRENDS_GEO=KR,US",
                "LLM_ANALYSIS_BATCH_SIZE=3",
                "LLM_ANALYSIS_ENABLED=true",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("COLLECTOR_ADMIN_ENV_FILE", str(env_file))

    submission_store = SubmissionStore(str(tmp_path / "submissions.json"))
    evidence_sink = EvidenceSink()
    entity_store = EntityStore(str(tmp_path / "entities.json"))
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        build_default_sources(connectors),
    )
    prompt_path = tmp_path / "enabled_pull.md"
    prompt_path.write_text("# enabled_pull\n\nPrompt body\n", encoding="utf-8")
    registry._sources["enabled_pull"].agent_prompt_path = str(prompt_path)
    registry._sources["enabled_pull"].agent_enabled = True
    engine = IngestionEngine(
        source_registry=registry,
        submission_store=submission_store,
        snapshot_store=RawSnapshotStore(str(tmp_path / "snapshots")),
        evidence_sink=evidence_sink,
        entity_resolver=EntityResolver(entity_store),
        normalizer_fn=_normalizer,
        connectors=connectors,
        analysis_engine=StubAnalysisEngine(),
    )
    builder = SignalCandidateBuilder(
        entity_store=entity_store,
        source_registry=registry,
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
        "submission_store": submission_store,
        "evidence_sink": evidence_sink,
        "signal_builder": builder,
    }
    public_routes.init_dependencies(deps)
    internal_routes.init_dependencies(deps)
    dashboard_routes.init_dependencies(deps)

    evidence_sink.append(
        Evidence(
            evidence_id="ev-1",
            source="enabled_pull",
            source_tier=2,
            collected_at="2026-03-28T09:00:00Z",
            entity_candidates=["Cursor"],
            signal_type="search_trend",
            title_or_label="Cursor demand rising",
            raw_snapshot_ref="snap-1",
            trust_score=0.8,
            freshness_ttl=3600,
        )
    )
    submission_store.create(
        SubmissionRecord(
            submission_id="sub-1",
            source_id="enabled_pull",
            source_kind="pull",
            ingestion_mode="raw",
            status="completed",
            snapshot_ids=["snap-1"],
            evidence_ids=["ev-1"],
            producer_ref="test",
            received_at="2026-03-28T09:00:00Z",
            processed_at="2026-03-28T09:01:00Z",
        )
    )

    app = FastAPI()
    app.include_router(public_routes.router)
    app.include_router(internal_routes.router)
    app.include_router(dashboard_routes.router)
    return TestClient(app), submission_store, evidence_sink


def test_dashboard_page_serves_html(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    response = client.get("/dashboard")

    assert response.status_code == 200
    assert "Collector operator dashboard" in response.text
    assert "Prompt editor" in response.text
    assert "/dashboard/assets/dashboard.css" in response.text


def test_dashboard_overview_returns_runtime_data(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    response = client.get("/dashboard/api/overview")

    assert response.status_code == 200
    payload = response.json()
    assert payload["health"]["service"] == "collector"
    assert any(source["source_id"] == "enabled_pull" for source in payload["sources"])
    assert payload["candidates"][0]["entity"] == "Cursor"
    assert payload["recent_evidence"][0]["title_or_label"] == "Cursor demand rising"
    assert payload["submissions"][0]["submission_id"] == "sub-1"
    assert payload["top_entities"][0] == {"entity": "Cursor", "count": 1}
    assert payload["source_agents"]["enabled_source_count"] >= 1


def test_dashboard_env_settings_reads_allowlisted_values(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    response = client.get("/dashboard/api/env-settings")

    assert response.status_code == 200
    payload = response.json()
    assert payload["available"] is True
    values = {item["key"]: item["value"] for item in payload["settings"]}
    assert values["GOOGLE_TRENDS_GEO"] == "KR,US"
    assert values["LLM_ANALYSIS_BATCH_SIZE"] == "3"


def test_dashboard_env_settings_updates_allowlisted_values(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    response = client.patch(
        "/dashboard/api/env-settings",
        json={
            "settings": {
                "GOOGLE_TRENDS_GEO": "US,JP",
                "LLM_ANALYSIS_BATCH_SIZE": 5,
                "LLM_ANALYSIS_ENABLED": False,
            }
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["updated_keys"] == [
        "GOOGLE_TRENDS_GEO",
        "LLM_ANALYSIS_BATCH_SIZE",
        "LLM_ANALYSIS_ENABLED",
    ]
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "GOOGLE_TRENDS_GEO=US,JP" in env_text
    assert "LLM_ANALYSIS_BATCH_SIZE=5" in env_text
    assert "LLM_ANALYSIS_ENABLED=false" in env_text


def test_dashboard_env_settings_rejects_unknown_keys(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    response = client.patch(
        "/dashboard/api/env-settings",
        json={"settings": {"OPENAI_API_KEY": "should-not-work"}},
    )

    assert response.status_code == 400
    assert "Unsupported setting key" in response.json()["detail"]


def test_dashboard_source_prompts_list_and_read(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    index_response = client.get("/dashboard/api/source-prompts")
    detail_response = client.get("/dashboard/api/source-prompts/enabled_pull")

    assert index_response.status_code == 200
    index_payload = index_response.json()
    assert any(item["source_id"] == "enabled_pull" for item in index_payload["prompts"])
    assert detail_response.status_code == 200
    detail_payload = detail_response.json()
    assert detail_payload["source_id"] == "enabled_pull"
    assert "Prompt body" in detail_payload["content"]


def test_dashboard_source_prompt_update_writes_markdown(tmp_path, monkeypatch):
    client, _, _ = _build_client(tmp_path, monkeypatch)

    response = client.patch(
        "/dashboard/api/source-prompts/enabled_pull",
        json={"content": "# enabled_pull\n\nUpdated prompt\n"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["updated"] is True
    assert payload["char_count"] == len("# enabled_pull\n\nUpdated prompt\n")
    assert (tmp_path / "enabled_pull.md").read_text(encoding="utf-8") == "# enabled_pull\n\nUpdated prompt\n"
