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


class CandidateTwo:
    entity = "Cursor"
    status = "emerging"
    emergence_score = 6.1
    velocity_score = 4.0
    source_count = 2
    sources = ["manual_observation", "reddit_mentions"]
    first_seen = datetime.now(timezone.utc).isoformat()
    last_seen = datetime.now(timezone.utc).isoformat()


def _evidence(
    entity: str,
    evidence_id: str,
    source: str,
    source_tier: int,
    trust_score: float,
    minutes_ago: int,
) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source=source,
        source_tier=source_tier,
        collected_at=(datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat(),
        entity_candidates=[entity],
        signal_type="test",
        title_or_label=("Very long title for " + entity + " " + evidence_id + " ") * 10,
        trust_score=trust_score,
        metric_value=123 if source != "manual_observation" else None,
        url_or_ref=f"https://example.com/{evidence_id}",
    )


def test_context_packer_keeps_budget_and_uses_previous_summary():
    packer = ContextPacker(char_budget=900, max_evidence=4, title_max_chars=80)
    projection = AnalysisProjection(
        entity="ChatGPT",
        status="completed",
        summary="Previous summary",
        confidence=0.7,
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    evidences = [
        _evidence("ChatGPT", "ev1", "reddit_mentions", 2, 0.9, 5),
        _evidence("ChatGPT", "ev2", "reddit_mentions", 2, 0.5, 50),
        _evidence("ChatGPT", "ev3", "google_trends", 2, 0.8, 10),
        _evidence("ChatGPT", "ev4", "manual_observation", 1, 1.0, 1),
    ]

    packed = packer.pack(Candidate(), evidences, projection)

    assert packed.char_count <= 900
    assert packed.prompt_format == "markdown"
    assert "Previous: Previous summary" in packed.prompt
    assert "url=" not in packed.prompt
    assert "geo=" not in packed.prompt
    assert packed.estimated_input_tokens > 0
    assert len(packed.evidence_ids) <= 4


def test_context_packer_prioritizes_best_item_per_source_first():
    packer = ContextPacker(char_budget=5000, max_evidence=2)
    evidences = [
        _evidence("ChatGPT", "ev_old", "reddit_mentions", 2, 0.4, 30),
        _evidence("ChatGPT", "ev_new", "reddit_mentions", 2, 0.9, 1),
        _evidence("ChatGPT", "ev_other", "google_trends", 2, 0.8, 2),
    ]

    packed = packer.pack(Candidate(), evidences)

    assert "ev_new" in packed.evidence_ids
    assert "ev_other" in packed.evidence_ids


def test_context_packer_can_build_batch_prompt():
    packer = ContextPacker(batch_char_budget=2500, max_evidence=2)
    projection = AnalysisProjection(
        entity="ChatGPT",
        status="completed",
        summary="Previous summary",
        confidence=0.7,
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    packed = packer.pack_batch(
        [
            (
                Candidate(),
                [
                    _evidence("ChatGPT", "ev1", "manual_observation", 1, 1.0, 1),
                    _evidence("ChatGPT", "ev2", "google_trends", 2, 0.8, 3),
                ],
                projection,
            ),
            (
                CandidateTwo(),
                [
                    _evidence("Cursor", "ev3", "manual_observation", 1, 1.0, 1),
                    _evidence("Cursor", "ev4", "reddit_mentions", 2, 0.7, 2),
                ],
                None,
            ),
        ]
    )

    assert packed.response_mode == "batch"
    assert packed.batch_size == 2
    assert packed.entities == ["ChatGPT", "Cursor"]
    assert "## Candidate 1" in packed.prompt
    assert "## Candidate 2" in packed.prompt
    assert packed.char_count <= 2500
