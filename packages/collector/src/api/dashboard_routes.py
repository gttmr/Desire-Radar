"""Operator dashboard routes for collector visibility and control."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..admin.env_settings import (
    EnvSettingsService,
    EnvSettingsUnavailableError,
    EnvSettingsValidationError,
)
from ..admin.source_prompts import SourcePromptService, SourcePromptValidationError

router = APIRouter()

_deps: dict[str, Any] = {}
STATIC_DIR = Path(__file__).resolve().parent / "static"
_DASHBOARD_HTML_PATH = STATIC_DIR / "dashboard.html"


def init_dependencies(deps: dict[str, Any]) -> None:
    """Inject service dependencies from server setup."""
    _deps.clear()
    _deps.update(deps)


class UpdateEnvSettingsRequest(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class UpdateSourcePromptRequest(BaseModel):
    content: str = ""


def _submission_summary(record: Any) -> dict[str, Any]:
    return record.model_dump(
        exclude={"payloads", "evidence_payloads", "request_params"},
    )


def _parse_timestamp(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    candidate = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _health_summary() -> dict[str, Any]:
    evidence_sink = _deps["evidence_sink"]
    ingestion_engine = _deps["ingestion_engine"]
    analysis_engine = _deps.get("analysis_engine")
    runtime = ingestion_engine.get_runtime_status()
    return {
        "status": "ok",
        "service": "collector",
        "evidence_count": evidence_sink.count,
        "analysis_enabled": analysis_engine.enabled if analysis_engine is not None else False,
        "analysis_queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
        "analysis_execution_mode": analysis_engine.execution_mode if analysis_engine is not None else "disabled",
        "source_run_queue_size": runtime["source_run_queue_size"],
        "active_source_count": runtime["active_source_count"],
        "source_run_worker_concurrency": runtime["source_run_worker_concurrency"],
    }


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page() -> HTMLResponse:
    return HTMLResponse(_DASHBOARD_HTML_PATH.read_text(encoding="utf-8"))


@router.get("/dashboard/api/overview")
async def dashboard_overview() -> dict[str, Any]:
    evidence_sink = _deps["evidence_sink"]
    builder = _deps["signal_builder"]
    registry = _deps["source_registry"]
    ingestion_engine = _deps["ingestion_engine"]
    submission_store = _deps["submission_store"]
    cadence_runner = _deps["cadence_runner"]
    analysis_engine = _deps.get("analysis_engine")

    evidence = evidence_sink.get_all()
    candidates = builder.build_candidates(evidence)
    runtime = ingestion_engine.get_runtime_status()
    sources = registry.status()
    for source_id, runtime_state in runtime["sources"].items():
        if source_id in sources:
            sources[source_id].update(runtime_state)

    recent_evidence = sorted(
        evidence,
        key=lambda item: _parse_timestamp(item.collected_at),
        reverse=True,
    )[:24]
    recent_submissions = submission_store.query(limit=20)
    ordered_sources = sorted(
        (
            {"source_id": source_id, **payload}
            for source_id, payload in sources.items()
        ),
        key=lambda item: (item["kind"], item["source_id"]),
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "health": _health_summary(),
        "analysis": {
            "enabled": analysis_engine.enabled if analysis_engine is not None else False,
            "queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
            "execution_mode": analysis_engine.execution_mode if analysis_engine is not None else "disabled",
        },
        "runtime": {
            "source_run_queue_size": runtime["source_run_queue_size"],
            "source_run_worker_concurrency": runtime["source_run_worker_concurrency"],
            "active_source_count": runtime["active_source_count"],
            **cadence_runner.runtime_status(),
        },
        "source_agents": {
            "enabled_source_count": sum(1 for source in ordered_sources if source.get("agent_enabled")),
            "latest_run_count": sum(1 for source in ordered_sources if source.get("last_agent_run")),
        },
        "sources": ordered_sources,
        "candidates": [candidate.model_dump() for candidate in candidates[:12]],
        "recent_evidence": [item.model_dump() for item in recent_evidence],
        "submissions": [_submission_summary(record) for record in recent_submissions],
        "top_entities": [
            {
                "entity": candidate.entity,
                "display_label": candidate.display_label or candidate.entity,
                "count": len(candidate.evidence_ids),
            }
            for candidate in candidates[:8]
        ],
    }


@router.get("/dashboard/api/env-settings")
async def get_env_settings() -> dict[str, Any]:
    service = EnvSettingsService()
    return service.read()


@router.patch("/dashboard/api/env-settings")
async def update_env_settings(body: UpdateEnvSettingsRequest) -> dict[str, Any]:
    service = EnvSettingsService()
    try:
        return service.update(body.settings)
    except EnvSettingsUnavailableError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except EnvSettingsValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/dashboard/api/source-prompts")
async def list_source_prompts() -> dict[str, Any]:
    service = SourcePromptService(_deps["source_registry"])
    return service.list()


@router.get("/dashboard/api/source-prompts/{source_id}")
async def get_source_prompt(source_id: str) -> dict[str, Any]:
    service = SourcePromptService(_deps["source_registry"])
    try:
        return service.read(source_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown source: {source_id}") from exc
    except SourcePromptValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/dashboard/api/source-prompts/{source_id}")
async def update_source_prompt(source_id: str, body: UpdateSourcePromptRequest) -> dict[str, Any]:
    service = SourcePromptService(_deps["source_registry"])
    try:
        return service.update(source_id, body.content)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown source: {source_id}") from exc
    except SourcePromptValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
