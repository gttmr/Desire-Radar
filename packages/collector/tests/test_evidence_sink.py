from datetime import datetime, timedelta, timezone

from src.normalizer.evidence_schema import Evidence
from src.store.evidence_sink import EvidenceSink


def _evidence(*, evidence_id: str, collected_at: str) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source="test_source",
        source_tier=2,
        collected_at=collected_at,
        entity_candidates=["Cursor"],
        signal_type="search_trend",
        title_or_label="Cursor demand rising",
        raw_snapshot_ref=f"snap-{evidence_id}",
        trust_score=0.8,
        freshness_ttl=3600,
    )


def test_evidence_sink_persists_and_reloads_items(tmp_path):
    path = tmp_path / "evidence.json"
    now = datetime.now(timezone.utc).isoformat()
    sink = EvidenceSink(path=str(path))
    sink.append(_evidence(evidence_id="ev-1", collected_at=now))

    reloaded = EvidenceSink(path=str(path))

    assert reloaded.count == 1
    assert reloaded.get_all()[0].evidence_id == "ev-1"


def test_evidence_sink_enforces_ttl_on_reload(tmp_path):
    path = tmp_path / "evidence.json"
    stale = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    sink = EvidenceSink(path=str(path), freshness_ttl_days=7)
    sink.append(_evidence(evidence_id="ev-stale", collected_at=stale))

    reloaded = EvidenceSink(path=str(path), freshness_ttl_days=7)

    assert reloaded.count == 0
    assert reloaded.get_all() == []
