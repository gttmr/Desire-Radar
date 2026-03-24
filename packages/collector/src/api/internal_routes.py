"""Internal API routes for MCP orchestrator."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/internal")

_deps: dict[str, Any] = {}


def init_dependencies(deps: dict[str, Any]) -> None:
    """Inject service dependencies from server setup."""
    _deps.update(deps)


class BuildBundleRequest(BaseModel):
    entity: str
    max_evidence: int = 50


@router.get("/next-candidates")
async def next_candidates(only_needs_analysis: bool = False) -> dict:
    """Get next signal candidates for orchestrator consumption.

    Returns top candidates sorted by emergence score, excluding already
    processed ones.
    """
    builder = _deps["signal_builder"]
    evidence_sink = _deps["evidence_sink"]
    candidates = builder.build_candidates(evidence_sink.get_all())

    if only_needs_analysis:
        candidates = [
            candidate for candidate in candidates
            if candidate.analysis_status in (None, "failed", "needs_review")
        ]

    # Return top 20 candidates
    top = candidates[:20]
    return {
        "count": len(top),
        "candidates": [c.model_dump() for c in top],
    }


@router.post("/build-bundle")
async def build_bundle(body: BuildBundleRequest) -> dict:
    """Build an evidence bundle for a specific entity.

    Gathers all evidence for the entity, resolves through entity resolver,
    and returns a structured bundle.
    """
    evidence_sink = _deps["evidence_sink"]
    resolver = _deps["entity_resolver"]

    # Find all evidence mentioning this entity (or its aliases)
    canonical = resolver.resolve(body.entity) or body.entity
    matching = []
    for ev in evidence_sink.get_all():
        for candidate in ev.entity_candidates:
            resolved = resolver.resolve(candidate) or candidate
            if resolved.lower() == canonical.lower():
                matching.append(ev)
                break

    # Limit and sort by recency
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
    """Get the full history of evidence for an entity."""
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

    # Sort chronologically
    history.sort(key=lambda e: e["collected_at"])

    return {
        "entity": canonical,
        "total_evidence": len(history),
        "history": history,
    }


class AnalysisRunRequest(BaseModel):
    entity: str


@router.post("/analysis/run")
async def run_analysis(body: AnalysisRunRequest) -> dict:
    """Queue analysis for a specific entity."""
    engine = _deps["analysis_engine"]
    queued = await engine.enqueue_entity(body.entity)
    return {
        "entity": body.entity,
        "queued": len(queued) > 0,
        "tasks": [task.model_dump() for task in queued],
    }


@router.get("/analysis/status/{entity}")
async def analysis_status(entity: str) -> dict:
    """Return analysis status for a specific entity."""
    engine = _deps["analysis_engine"]
    return engine.get_status(entity)


@router.get("/analysis/preview/{entity}")
async def analysis_preview(entity: str) -> dict:
    """Return the packed prompt preview for one entity."""
    engine = _deps["analysis_engine"]
    return engine.preview_entity(entity)


@router.get("/analysis/preview-batch")
async def analysis_preview_batch() -> dict:
    """Return the packed prompt preview for the next analysis batch."""
    engine = _deps["analysis_engine"]
    return engine.preview_batch()
