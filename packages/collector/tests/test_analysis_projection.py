from datetime import datetime, timezone

from src.analysis.models import AnalysisProjection
from src.analysis.store import AnalysisStore
from src.builder.signal_candidate_builder import SignalCandidateBuilder
from src.normalizer.evidence_schema import Evidence


def _evidence(entity: str, source: str, evidence_id: str) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source=source,
        source_tier=2,
        collected_at=datetime.now(timezone.utc).isoformat(),
        entity_candidates=[entity],
        signal_type="search_trend",
        title_or_label=f"{entity} trend",
    )


def test_builder_merges_analysis_projection(tmp_path):
    store = AnalysisStore(path=str(tmp_path / "analysis.json"))
    projection = AnalysisProjection(
        entity="ChatGPT",
        status="completed",
        summary="Collector analysis summary",
        confidence=0.73,
        desire_types=["호기심"],
        behavioral_signals=["사람들이 반복 검색하고 있다"],
        demographic_hints=["직장인"],
        avg_intensity=0.61,
        session_domain="trend-analysis",
        analyzed_at=datetime.now(timezone.utc).isoformat(),
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    store._set_unlocked(projection)  # type: ignore[attr-defined]

    builder = SignalCandidateBuilder(analysis_store=store)
    candidates = builder.build_candidates(
        [
            _evidence("ChatGPT", "reddit_mentions", "ev1"),
            _evidence("ChatGPT", "google_trends", "ev2"),
        ]
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.analysis_status == "completed"
    assert candidate.analysis_summary == "Collector analysis summary"
    assert candidate.analysis_confidence == 0.73
    assert candidate.desire_types == ["호기심"]
    assert candidate.analysis_session_domain == "trend-analysis"
