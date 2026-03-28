"""Public API routes for the collector service."""

from typing import Any, Literal

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


class HumanInputMessageRequest(BaseModel):
    content: str = ""
    message_url: str = ""
    attachment_urls: list[str] = Field(default_factory=list)
    producer_ref: str | None = None
    author_id: str | None = None
    author_name: str | None = None
    guild_id: str | None = None
    channel_id: str | None = None
    channel_name: str | None = None
    message_id: str | None = None
    thread_id: str | None = None
    thread_name: str | None = None
    request_submission_id: str | None = None
    posted_at: str | None = None


class HumanAnalystRequestRequest(BaseModel):
    entity_candidates: list[str] = Field(default_factory=list)
    question: str
    why_now: str = ""
    priority: str = "normal"
    producer_ref: str | None = None
    requested_by_agent: str | None = None
    run_id: str | None = None
    intent: Literal[
        "demand",
        "ranking",
        "pricing",
        "supply",
        "monetization",
        "beneficiary",
        "validation",
    ] = "demand"
    requested_input_kind: Literal[
        "study_result",
        "data_source",
        "channel_check",
        "beneficiary_mapping",
        "validation_note",
    ] = "study_result"
    required_fields: list[str] = Field(default_factory=list)
    preferred_capabilities: list[str] = Field(default_factory=list)
    source_hints: list[str] = Field(default_factory=list)


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
    async_mode: bool = True


def _sanitize_submission(record: Any) -> dict:
    if record is None:
        raise HTTPException(404, "Submission not found")
    return record.model_dump(
        exclude={"payloads", "evidence_payloads", "request_params"},
    )


def _collect_run_conflict(reason: str, source_id: str | None = None) -> HTTPException:
    detail: dict[str, Any] = {"reason": reason}
    if source_id is not None:
        detail["source_id"] = source_id
        detail["connector"] = source_id
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


@router.post("/collect/run")
async def collect_run(body: CollectRunRequest | None = None) -> dict:
    """Trigger collection for one or all pull connectors."""
    ingestion_engine = _deps["ingestion_engine"]
    connectors = _deps["connectors"]
    registry = _deps["source_registry"]
    registry_map = registry.as_map()
    async_mode = body.async_mode if body is not None else True

    if body and body.connector:
        source = registry_map.get(body.connector)
        if source is None:
            raise HTTPException(404, f"Unknown connector: {body.connector}")
        if source.kind != "pull":
            raise _collect_run_conflict("source_not_pull", body.connector)
        if not source.enabled:
            raise _collect_run_conflict("source_disabled", body.connector)
        if not source.runnable:
            raise _collect_run_conflict("source_not_runnable", body.connector)
        if source.adapter_name not in connectors:
            raise _collect_run_conflict("missing_connector_adapter", body.connector)
        if async_mode:
            submission = await ingestion_engine.enqueue_source_run(
                body.connector,
                metadata={"trigger": "manual"},
            )
        else:
            submission = await ingestion_engine.run_source(
                body.connector,
                metadata={"trigger": "manual"},
            )
        return {
            "connector": body.connector,
            "evidence_count": len(submission.evidence_ids),
            "submission_id": submission.submission_id,
            "status": submission.status,
            "async_mode": async_mode,
            "queued_sources": [body.connector],
            "skipped_sources": {},
            "skipped_disabled_count": 0,
        }

    total = 0
    results: dict[str, int] = {}
    submission_ids: dict[str, str] = {}
    source_results: dict[str, dict[str, Any]] = {}
    queued_sources: list[str] = []
    skipped_sources: dict[str, str] = {}
    for source_id, source in registry_map.items():
        if source.kind != "pull":
            continue
        if not source.enabled:
            skipped_sources[source_id] = "source_disabled"
            continue
        if not source.runnable:
            skipped_sources[source_id] = "source_not_runnable"
            continue
        if source.adapter_name not in connectors:
            skipped_sources[source_id] = "missing_connector_adapter"
            continue
        if async_mode:
            submission = await ingestion_engine.enqueue_source_run(
                source_id,
                metadata={"trigger": "manual"},
            )
        else:
            submission = await ingestion_engine.run_source(
                source_id,
                metadata={"trigger": "manual"},
            )
        queued_sources.append(source_id)
        results[source_id] = len(submission.evidence_ids)
        submission_ids[source_id] = submission.submission_id
        source_results[source_id] = {
            "submission_id": submission.submission_id,
            "status": submission.status,
            "evidence_count": len(submission.evidence_ids),
            "error_message": submission.error_message,
        }
        total += len(submission.evidence_ids)

    if not queued_sources:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "reason": "no_enabled_pull_sources",
                "queued_sources": [],
                "skipped_sources": skipped_sources,
                "skipped_disabled_count": sum(
                    1 for value in skipped_sources.values() if value == "source_disabled"
                ),
            },
        )

    return {
        "total_evidence_count": total,
        "queued_count": len(submission_ids),
        "queued_sources": queued_sources,
        "skipped_sources": skipped_sources,
        "skipped_disabled_count": sum(
            1 for value in skipped_sources.values() if value == "source_disabled"
        ),
        "per_connector": results,
        "source_results": source_results,
        "submission_ids": submission_ids,
        "async_mode": async_mode,
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
    ingestion_engine = _deps["ingestion_engine"]
    cadence_runner = _deps["cadence_runner"]
    runtime = ingestion_engine.get_runtime_status()
    sources = registry.status()
    for source_id, runtime_state in runtime["sources"].items():
        if source_id in sources:
            sources[source_id].update(runtime_state)
    return {
        "sources": sources,
        "analysis": {
            "enabled": analysis_engine.enabled if analysis_engine is not None else False,
            "queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
        },
        "runtime": {
            "source_run_queue_size": runtime["source_run_queue_size"],
            "source_run_worker_concurrency": runtime["source_run_worker_concurrency"],
            "active_source_count": runtime["active_source_count"],
            **cadence_runner.runtime_status(),
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


@router.get("/runtime/status")
async def get_runtime_status() -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    cadence_runner = _deps["cadence_runner"]
    analysis_engine = _deps.get("analysis_engine")
    return {
        "sources": ingestion_engine.get_runtime_status(),
        "scheduler": cadence_runner.runtime_status(),
        "analysis": {
            "enabled": analysis_engine.enabled if analysis_engine is not None else False,
            "queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
        },
    }


@router.get("/ingest/submissions/{submission_id}")
async def get_submission(submission_id: str) -> dict:
    submission_store = _deps["submission_store"]
    return _sanitize_submission(submission_store.get(submission_id))


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
    "/ingest/human-input",
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_human_input(body: HumanInputMessageRequest) -> dict:
    ingestion_engine = _deps["ingestion_engine"]
    record = await ingestion_engine.submit_human_input(body.model_dump())
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
