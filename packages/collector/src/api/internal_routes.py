"""Internal API routes for MCP orchestrator and operator workflows."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/internal")

_deps: dict[str, Any] = {}


def init_dependencies(deps: dict[str, Any]) -> None:
    """Inject service dependencies from server setup."""
    _deps.update(deps)


class BuildBundleRequest(BaseModel):
    entity: str
    max_evidence: int = 50


class AnalysisRunRequest(BaseModel):
    entity: str


class RunSourceRequest(BaseModel):
    producer_ref: str | None = None
    request_params: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class UpdateSourceTierRequest(BaseModel):
    configured_tier: int
    tier_override_reason: str | None = None


class UpdateSourceEnableRequest(BaseModel):
    enabled: bool


@router.get("/next-candidates")
async def next_candidates(only_needs_analysis: bool = False) -> dict:
    builder = _deps["signal_builder"]
    evidence_sink = _deps["evidence_sink"]
    candidates = builder.build_candidates(evidence_sink.get_all())

    if only_needs_analysis:
        candidates = [
            candidate for candidate in candidates
            if candidate.analysis_status in (None, "failed", "needs_review")
        ]

    top = candidates[:20]
    return {
        "count": len(top),
        "candidates": [c.model_dump() for c in top],
    }


@router.post("/build-bundle")
async def build_bundle(body: BuildBundleRequest) -> dict:
    evidence_sink = _deps["evidence_sink"]
    resolver = _deps["entity_resolver"]

    canonical = resolver.resolve(body.entity) or body.entity
    matching = []
    for ev in evidence_sink.get_all():
        for candidate in ev.entity_candidates:
            resolved = resolver.resolve(candidate) or candidate
            if resolved.lower() == canonical.lower():
                matching.append(ev)
                break

    matching.sort(key=lambda e: e.collected_at, reverse=True)
    limited = matching[: body.max_evidence]

    return {
        "entity": canonical,
        "evidence_count": len(limited),
        "evidence": [ev.model_dump() for ev in limited],
        "sources": list({ev.source for ev in limited}),
    }


@router.get("/entity-history/{entity}")
async def entity_history(entity: str) -> dict:
    evidence_sink = _deps["evidence_sink"]
    resolver = _deps["entity_resolver"]

    canonical = resolver.resolve(entity) or entity

    history = []
    for ev in evidence_sink.get_all():
        for candidate in ev.entity_candidates:
            resolved = resolver.resolve(candidate) or candidate
            if resolved.lower() == canonical.lower():
                history.append(ev.model_dump())
                break

    history.sort(key=lambda e: e["collected_at"])

    return {
        "entity": canonical,
        "total_evidence": len(history),
        "history": history,
    }


@router.post("/analysis/run")
async def run_analysis(body: AnalysisRunRequest) -> dict:
    engine = _deps["analysis_engine"]
    queued = await engine.enqueue_entity(body.entity)
    return {
        "entity": body.entity,
        "queued": len(queued) > 0,
        "tasks": [task.model_dump() for task in queued],
    }


@router.get("/analysis/status/{entity}")
async def analysis_status(entity: str) -> dict:
    engine = _deps["analysis_engine"]
    return engine.get_status(entity)


@router.get("/analysis/preview/{entity}")
async def analysis_preview(entity: str) -> dict:
    engine = _deps["analysis_engine"]
    return engine.preview_entity(entity)


@router.get("/analysis/preview-batch")
async def analysis_preview_batch() -> dict:
    engine = _deps["analysis_engine"]
    return engine.preview_batch()


@router.post("/sources/run/{source_id}")
async def run_source(source_id: str, body: RunSourceRequest | None = None) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.run_source(
        source_id,
        producer_ref=body.producer_ref if body else None,
        request_params=body.request_params if body else None,
        metadata=body.metadata if body else None,
    )
    return record.model_dump(
        exclude={"payloads", "evidence_payloads", "request_params"},
    )


@router.patch("/sources/{source_id}/tier")
async def update_source_tier(source_id: str, body: UpdateSourceTierRequest) -> dict:
    registry = _deps["source_registry"]
    source = registry.update_tier(
        source_id,
        body.configured_tier,
        override_reason=body.tier_override_reason,
    )
    return source.model_dump()


@router.patch("/sources/{source_id}/enable")
async def update_source_enable(source_id: str, body: UpdateSourceEnableRequest) -> dict:
    registry = _deps["source_registry"]
    source = registry.set_enabled(source_id, body.enabled)
    return source.model_dump()


@router.get("/sources/{source_id}/validity")
async def get_source_validity(source_id: str) -> dict:
    registry = _deps["source_registry"]
    return registry.validity(source_id)
