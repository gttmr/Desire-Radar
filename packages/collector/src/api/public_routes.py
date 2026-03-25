"""Public API routes for the collector service."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

router = APIRouter()

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
    reporter: str | None = None


class HumanAnalystNoteRequest(BaseModel):
    title: str
    observation: str
    entity_candidates: list[str] = Field(default_factory=list)
    why_now: str = ""
    confidence: float = 0.8
    geo: str = "global"
    channel: str = "analyst"
    study_type: str = "analysis_note"
    producer_ref: str | None = None
    beneficiary_hints: list[str] = Field(default_factory=list)
    research_questions: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    supporting_points: list[str] = Field(default_factory=list)
    request_submission_id: str | None = None


class HumanEvidenceBatchRequest(BaseModel):
    evidence_items: list[dict]
    producer_ref: str | None = None
    dataset_name: str | None = None
    channel: str = "human-data"
    notes: str = ""
    parent_evidence_ids: list[str] = Field(default_factory=list)
    request_submission_id: str | None = None


class HumanAnalystRequestRequest(BaseModel):
    entity_candidates: list[str] = Field(default_factory=list)
    question: str
    why_now: str = ""
    priority: str = "normal"
    producer_ref: str | None = None
    requested_by_agent: str | None = None
    run_id: str | None = None
    requested_input_kind: str = "study_result"


class RawEnvelopeRequest(BaseModel):
    payloads: list[dict]
    producer_ref: str | None = None
    request_params: dict[str, Any] = Field(default_factory=dict)


class EvidenceEnvelopeRequest(BaseModel):
    evidence_items: list[dict]
    producer_ref: str | None = None
    parent_evidence_ids: list[str] = Field(default_factory=list)


class ReviewApproveRequest(BaseModel):
    raw_text: str
    canonical_name: str


class ReviewRejectRequest(BaseModel):
    raw_text: str


class CollectRunRequest(BaseModel):
    connector: str | None = None


def _sanitize_submission(record: Any) -> dict:
    if record is None:
        raise HTTPException(404, "Submission not found")
    return record.model_dump(
        exclude={"payloads", "evidence_payloads", "request_params"},
    )


@router.post("/collect/run")
async def collect_run(body: CollectRunRequest | None = None) -> dict:
    """Trigger collection for one or all pull connectors."""
    ingestion_engine = _deps["ingestion_engine"]
    connectors = _deps["connectors"]

    if body and body.connector:
        if body.connector not in connectors and body.connector not in _deps["source_registry"].as_map():
            raise HTTPException(404, f"Unknown connector: {body.connector}")
        submission = await ingestion_engine.run_source(body.connector)
        return {
            "connector": body.connector,
            "evidence_count": len(submission.evidence_ids),
            "submission_id": submission.submission_id,
        }

    total = 0
    results: dict[str, int] = {}
    submission_ids: dict[str, str] = {}
    for name in connectors:
        submission = await ingestion_engine.run_source(name)
        results[name] = len(submission.evidence_ids)
        submission_ids[name] = submission.submission_id
        total += len(submission.evidence_ids)

    return {
        "total_evidence_count": total,
        "per_connector": results,
        "submission_ids": submission_ids,
    }


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
    """Get status of all configured sources."""
    analysis_engine = _deps.get("analysis_engine")
    registry = _deps["source_registry"]
    return {
        "sources": registry.status(),
        "analysis": {
            "enabled": analysis_engine.enabled if analysis_engine is not None else False,
            "queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
        },
    }


@router.get("/sources/catalog")
async def get_sources_catalog() -> dict:
    """Return source catalog metadata."""
    registry = _deps["source_registry"]
    catalog = registry.catalog()
    return {
        "count": len(catalog),
        "sources": {item["source_id"]: item for item in catalog},
    }


@router.get("/ingest/submissions/{submission_id}")
async def get_submission(submission_id: str) -> dict:
    submission_store = _deps["submission_store"]
    return _sanitize_submission(submission_store.get(submission_id))


@router.get("/ingest/submissions")
async def list_submissions(
    status_filter: str | None = None,
    source_id: str | None = None,
    limit: int = 50,
) -> dict:
    submission_store = _deps["submission_store"]
    submissions = submission_store.query(
        status=status_filter,
        source_id=source_id,
        limit=limit,
    )
    return {
        "count": len(submissions),
        "submissions": [_sanitize_submission(record) for record in submissions],
    }


@router.get("/ingest/submissions")
async def list_submissions(
    submission_status: str | None = Query(default=None, alias="status"),
    source_id: str | None = None,
    limit: int = 50,
) -> dict:
    submission_store = _deps["submission_store"]
    records = submission_store.query(
        status=submission_status,
        source_id=source_id,
        limit=max(1, min(limit, 200)),
    )
    return {
        "count": len(records),
        "submissions": [_sanitize_submission(record) for record in records],
    }


@router.post(
    "/ingest/envelopes/{source_id}",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_envelope(source_id: str, body: RawEnvelopeRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.enqueue_raw(
        source_id,
        body.payloads,
        producer_ref=body.producer_ref,
        request_params=body.request_params,
    )
    return _sanitize_submission(record)


@router.post(
    "/ingest/evidence/{source_id}",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_evidence(source_id: str, body: EvidenceEnvelopeRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.enqueue_evidence(
        source_id,
        body.evidence_items,
        producer_ref=body.producer_ref,
        parent_evidence_ids=body.parent_evidence_ids,
    )
    return _sanitize_submission(record)


@router.post(
    "/ingest/human-observation",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_observation(body: ManualObservationRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_observation(
        body.model_dump(),
        async_mode=True,
    )
    return _sanitize_submission(record)


@router.post(
    "/ingest/human-analyst-note",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_analyst_note(body: HumanAnalystNoteRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_analyst_note(
        body.model_dump(),
        async_mode=True,
    )
    return _sanitize_submission(record)


@router.post(
    "/ingest/human-study-result",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_study_result(body: HumanAnalystNoteRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_analyst_note(
        body.model_dump(),
        async_mode=True,
    )
    return _sanitize_submission(record)


@router.post(
    "/ingest/human-evidence-batch",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_evidence_batch(body: HumanEvidenceBatchRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_evidence_batch(body.model_dump())
    return _sanitize_submission(record)


@router.post(
    "/ingest/human-data-source",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_data_source(body: HumanEvidenceBatchRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_evidence_batch(body.model_dump())
    return _sanitize_submission(record)


@router.post(
    "/ingest/human-analyst-request",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_analyst_request(body: HumanAnalystRequestRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.request_human_analyst_note(body.model_dump())
    return _sanitize_submission(record)


@router.post("/review/approve")
async def approve_review(body: ReviewApproveRequest) -> dict:
    entity_store = _deps["entity_store"]
    entity_store.approve_review(body.raw_text, body.canonical_name)
    return {"status": "approved", "raw_text": body.raw_text, "canonical_name": body.canonical_name}


@router.post("/review/reject")
async def reject_review(body: ReviewRejectRequest) -> dict:
    entity_store = _deps["entity_store"]
    entity_store.reject_review(body.raw_text)
    return {"status": "rejected", "raw_text": body.raw_text}


@router.post("/manual-observation")
async def submit_manual_observation(body: ManualObservationRequest) -> dict:
    """Compatibility wrapper around the common human observation ingest path."""
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_observation(
        body.model_dump(),
        async_mode=False,
    )
    return {
        "status": "submitted",
        "evidence_count": len(record.evidence_ids),
        "submission_id": record.submission_id,
    }
