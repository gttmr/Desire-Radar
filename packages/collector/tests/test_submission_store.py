from src.ingest.models import SubmissionRecord
from src.ingest.store import SubmissionStore


def _record(submission_id: str, *, status: str, source_id: str, received_at: str) -> SubmissionRecord:
    return SubmissionRecord(
        submission_id=submission_id,
        source_id=source_id,
        source_kind="human",
        ingestion_mode="evidence",
        status=status,
        received_at=received_at,
    )


def test_submission_store_query_filters_and_orders(tmp_path):
    store = SubmissionStore(str(tmp_path / "submissions.json"))
    store.create(
        _record(
            "sub-1",
            status="pending_human",
            source_id="human_analyst_note",
            received_at="2026-03-25T00:00:00Z",
        )
    )
    store.create(
        _record(
            "sub-2",
            status="completed",
            source_id="human_analyst_note",
            received_at="2026-03-25T00:01:00Z",
        )
    )
    store.create(
        _record(
            "sub-3",
            status="pending_human",
            source_id="human_curated_dataset",
            received_at="2026-03-25T00:02:00Z",
        )
    )

    pending = store.query(status="pending_human")
    assert [record.submission_id for record in pending] == ["sub-3", "sub-1"]

    human_notes = store.query(
        status="pending_human",
        source_id="human_analyst_note",
        limit=1,
    )
    assert [record.submission_id for record in human_notes] == ["sub-1"]
