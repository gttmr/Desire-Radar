from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from src.analysis.models import AnalysisProjection
from src.analysis.policy import AnalysisPolicy
from src.connectors.base import BaseConnector
from src.normalizer.evidence_schema import Evidence
from src.sources.defaults import build_default_sources
from src.sources.registry import SourceRegistry


def _candidate(**overrides):
    defaults = {
        "entity": "ChatGPT",
        "status": "preheat",
        "emergence_score": 5.0,
        "velocity_score": 3.0,
        "source_count": 2,
        "source_quality_score": 1.0,
        "evidence_ids": ["ev1", "ev2"],
        "sources": ["reddit_mentions", "google_trends"],
        "first_seen": datetime.now(timezone.utc).isoformat(),
        "last_seen": datetime.now(timezone.utc).isoformat(),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _evidence(evidence_id: str, source: str, source_tier: int = 2) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source=source,
        source_tier=source_tier,
        collected_at=datetime.now(timezone.utc).isoformat(),
        entity_candidates=["ChatGPT"],
        signal_type="search_trend",
        title_or_label="ChatGPT trend",
    )


class _GoogleConnector(BaseConnector):
    name = "google_trends"
    cadence_seconds = 60
    source_tier = 2

    async def fetch(self):
        return []


def test_policy_accepts_new_candidate_with_tier1_signal():
    policy = AnalysisPolicy(min_source_count=2)
    candidate = _candidate(source_count=1, sources=["manual_observation"], evidence_ids=["ev1"])
    evidences = [_evidence("ev1", "manual_observation", source_tier=1)]

    decision = policy.decide(candidate, evidences, projection=None)

    assert decision.should_enqueue is True
    assert decision.reason == "new_candidate"


def test_policy_skips_when_cooldown_is_active_even_if_changed():
    policy = AnalysisPolicy(cooldown_seconds=3600)
    candidate = _candidate(
        emergence_score=8.0,
        evidence_ids=["ev1", "ev2", "ev3"],
        sources=["reddit_mentions", "google_trends", "manual_observation"],
    )
    projection = AnalysisProjection(
        entity="ChatGPT",
        status="completed",
        summary="old summary",
        confidence=0.8,
        evidence_ids=["ev1"],
        sources=["reddit_mentions"],
        source_count=1,
        last_emergence_score=4.0,
        last_velocity_score=2.0,
        analyzed_at=(datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(),
        updated_at=datetime.now(timezone.utc).isoformat(),
    )

    decision = policy.decide(
        candidate,
        [_evidence("ev1", "reddit_mentions"), _evidence("ev2", "google_trends")],
        projection,
    )

    assert decision.should_enqueue is False
    assert decision.reason == "cooldown_active"


def test_policy_requeues_after_cooldown_when_material_change_exists():
    policy = AnalysisPolicy(cooldown_seconds=3600, min_emergence_delta=2.0)
    candidate = _candidate(
        emergence_score=8.5,
        evidence_ids=["ev1", "ev2", "ev3"],
        sources=["reddit_mentions", "google_trends", "manual_observation"],
    )
    projection = AnalysisProjection(
        entity="ChatGPT",
        status="completed",
        summary="old summary",
        confidence=0.8,
        evidence_ids=["ev1"],
        sources=["reddit_mentions"],
        source_count=1,
        last_emergence_score=4.0,
        last_velocity_score=2.0,
        analyzed_at=(datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
        updated_at=datetime.now(timezone.utc).isoformat(),
    )

    decision = policy.decide(
        candidate,
        [
            _evidence("ev1", "reddit_mentions"),
            _evidence("ev2", "google_trends"),
            _evidence("ev3", "manual_observation", source_tier=1),
        ],
        projection,
    )

    assert decision.should_enqueue is True
    assert decision.reason == "material_change"


def test_policy_skips_low_quality_sources_without_tier1(tmp_path):
    registry = SourceRegistry(
        str(tmp_path / "sources.json"),
        build_default_sources({"google_trends": _GoogleConnector()}),
    )
    registry.record_processing(
        "google_trends",
        success=False,
        snapshot_total=5,
        is_submission=True,
    )
    registry.record_processing(
        "google_trends",
        success=False,
        snapshot_total=5,
        is_submission=True,
    )
    registry.record_processing(
        "google_trends",
        success=False,
        snapshot_total=5,
        is_submission=True,
    )
    policy = AnalysisPolicy(source_registry=registry, min_source_quality_score=0.3)

    decision = policy.decide(
        _candidate(
            source_count=1,
            source_quality_score=0.1,
            sources=["google_trends"],
            evidence_ids=["ev1"],
        ),
        [_evidence("ev1", "google_trends")],
        projection=None,
    )

    assert decision.should_enqueue is False
    assert decision.reason == "low_source_quality"
