from datetime import datetime, timedelta, timezone

from src.analysis.context_packer import ContextPacker
from src.analysis.models import AnalysisProjection
from src.normalizer.evidence_schema import Evidence


class Candidate:
    entity = "ChatGPT"
    status = "preheat"
    emergence_score = 7.0
    velocity_score = 3.5
    source_count = 3
    sources = ["manual_observation", "reddit_mentions", "google_trends"]
    first_seen = datetime.now(timezone.utc).isoformat()
    last_seen = datetime.now(timezone.utc).isoformat()


def _evidence(evidence_id: str, source: str, source_tier: int, trust_score: float, minutes_ago: int) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source=source,
        source_tier=source_tier,
        collected_at=(datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat(),
        entity_candidates=["ChatGPT"],
        signal_type="test",
        title_or_label=("ChatGPT trend " + evidence_id) * 12,
        trust_score=trust_score,
    )


def test_context_packer_keeps_budget_and_uses_previous_summary():
    packer = ContextPacker(char_budget=1300, max_evidence=4)
    projection = AnalysisProjection(
        entity="ChatGPT",
        status="completed",
        summary="Previous summary",
        confidence=0.7,
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    evidences = [
        _evidence("ev1", "reddit_mentions", 2, 0.9, 5),
        _evidence("ev2", "reddit_mentions", 2, 0.5, 50),
        _evidence("ev3", "google_trends", 2, 0.8, 10),
        _evidence("ev4", "manual_observation", 1, 1.0, 1),
    ]

    packed = packer.pack(Candidate(), evidences, projection)

    assert packed.char_count <= 1300
    assert "Previous summary" in packed.prompt
    assert "ev4" in packed.prompt
    assert len(packed.evidence_ids) <= 4


def test_context_packer_prioritizes_best_item_per_source_first():
    packer = ContextPacker(char_budget=5000, max_evidence=2)
    evidences = [
        _evidence("ev_old", "reddit_mentions", 2, 0.4, 30),
        _evidence("ev_new", "reddit_mentions", 2, 0.9, 1),
        _evidence("ev_other", "google_trends", 2, 0.8, 2),
    ]

    packed = packer.pack(Candidate(), evidences)

    assert "ev_new" in packed.evidence_ids
    assert "ev_other" in packed.evidence_ids
