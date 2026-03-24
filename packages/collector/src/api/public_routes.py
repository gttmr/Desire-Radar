"""Public API routes for the collector service."""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# These will be injected by the server at startup
_deps: dict[str, Any] = {}


def init_dependencies(deps: dict[str, Any]) -> None:
    """Inject service dependencies from server setup."""
    _deps.update(deps)


class ManualObservationRequest(BaseModel):
    title: str
    entities: list[str] = []
    signal_type: str = "manual"
    metric_value: float | None = None
    metric_delta: float | None = None
    rank: int | None = None
    geo: str = "global"
    url: str = ""
    trust_score: float = 1.0
    freshness_ttl: int = 86400


class ReviewApproveRequest(BaseModel):
    raw_text: str
    canonical_name: str


class ReviewRejectRequest(BaseModel):
    raw_text: str


class CollectRunRequest(BaseModel):
    connector: str | None = None


@router.post("/collect/run")
async def collect_run(body: CollectRunRequest | None = None) -> dict:
    """Trigger collection for one or all connectors."""
    runner = _deps["cadence_runner"]
    connectors = _deps["connectors"]

    if body and body.connector:
        if body.connector not in connectors:
            raise HTTPException(404, f"Unknown connector: {body.connector}")
        count = await runner.run_connector(body.connector)
        return {"connector": body.connector, "evidence_count": count}

    total = 0
    results: dict[str, int] = {}
    for name in connectors:
        count = await runner.run_connector(name)
        results[name] = count
        total += count

    return {"total_evidence_count": total, "per_connector": results}


@router.get("/candidates/emerging")
async def get_emerging_candidates() -> dict:
    """Get emerging signal candidates."""
    builder = _deps["signal_builder"]
    evidence_sink = _deps["evidence_sink"]
    candidates = builder.build_candidates(evidence_sink.get_all())
    return {
        "count": len(candidates),
        "candidates": [c.model_dump() for c in candidates],
    }


@router.get("/evidence/bundles/{entity}")
async def get_evidence_bundle(entity: str) -> dict:
    """Get all evidence for a specific entity."""
    evidence_sink = _deps["evidence_sink"]
    matching = [
        ev.model_dump()
        for ev in evidence_sink.query_by_entity(entity)
    ]
    return {"entity": entity, "count": len(matching), "evidence": matching}


@router.get("/sources/status")
async def get_sources_status() -> dict:
    """Get status of all source connectors."""
    runner = _deps["cadence_runner"]
    return {"sources": runner.get_status()}


@router.post("/review/approve")
async def approve_review(body: ReviewApproveRequest) -> dict:
    """Approve a review queue item."""
    entity_store = _deps["entity_store"]
    entity_store.approve_review(body.raw_text, body.canonical_name)
    return {"status": "approved", "raw_text": body.raw_text, "canonical_name": body.canonical_name}


@router.post("/review/reject")
async def reject_review(body: ReviewRejectRequest) -> dict:
    """Reject a review queue item."""
    entity_store = _deps["entity_store"]
    entity_store.reject_review(body.raw_text)
    return {"status": "rejected", "raw_text": body.raw_text}


@router.post("/manual-observation")
async def submit_manual_observation(body: ManualObservationRequest) -> dict:
    """Submit a manual observation."""
    manual_connector = _deps["connectors"].get("manual_observation")
    if manual_connector is None:
        raise HTTPException(500, "Manual observation connector not found")

    manual_connector.submit(body.model_dump())
    runner = _deps["cadence_runner"]
    count = await runner.run_connector("manual_observation")
    return {"status": "submitted", "evidence_count": count}
