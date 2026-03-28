"""Tests for the signal candidate builder."""

from datetime import datetime, timezone

from src.builder.signal_candidate_builder import SignalCandidateBuilder
from src.connectors.base import BaseConnector
from src.normalizer.evidence_schema import Evidence, EvidenceEventFrame, EvidenceRelationshipHint
from src.sources.defaults import build_default_sources
from src.sources.registry import SourceRegistry


class _DummyConnector(BaseConnector):
    name = "google_trends"
    cadence_seconds = 60
    source_tier = 2

    async def fetch(self):
        return []


def _make_evidence(
    entity_candidates: list[str],
    source: str = "reddit_mentions",
    source_tier: int = 2,
    **kwargs,
) -> Evidence:
    defaults = {
        "evidence_id": f"ev_{id(entity_candidates)}",
        "source": source,
        "source_tier": source_tier,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "entity_candidates": entity_candidates,
        "signal_type": "social_mention",
        "title_or_label": "Test evidence",
    }
    defaults.update(kwargs)
    return Evidence(**defaults)


class TestSignalCandidateBuilder:
    def test_empty_evidence_list(self):
        builder = SignalCandidateBuilder()
        candidates = builder.build_candidates([])
        assert candidates == []

    def test_single_entity_single_source(self):
        builder = SignalCandidateBuilder()
        evidence = [_make_evidence(["ChatGPT"], evidence_id="ev1")]
        candidates = builder.build_candidates(evidence)
        assert len(candidates) == 1
        c = candidates[0]
        assert c.entity == "ChatGPT"
        assert c.status == "emerging"
        assert c.source_count == 1
        assert c.emergence_score > 0

    def test_entity_with_multiple_sources_becomes_preheat(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(["ChatGPT"], source="reddit_mentions", evidence_id="ev1"),
            _make_evidence(["ChatGPT"], source="google_trends", evidence_id="ev2"),
            _make_evidence(["ChatGPT"], source="manual_observation", evidence_id="ev3"),
        ]
        candidates = builder.build_candidates(evidence)
        assert len(candidates) == 1
        c = candidates[0]
        assert c.status == "preheat"
        assert c.source_count == 3

    def test_entity_with_five_plus_sources_becomes_spreading(self):
        builder = SignalCandidateBuilder()
        sources = [
            "reddit_mentions",
            "google_trends",
            "manual_observation",
            "naver_datalab",
            "app_store_top_charts",
        ]
        evidence = [
            _make_evidence(["ChatGPT"], source=s, evidence_id=f"ev_{i}")
            for i, s in enumerate(sources)
        ]
        candidates = builder.build_candidates(evidence)
        assert len(candidates) == 1
        assert candidates[0].status == "spreading"
        assert candidates[0].source_count == 5

    def test_multiple_entities_sorted_by_emergence_score(self):
        builder = SignalCandidateBuilder()
        evidence = [
            # ChatGPT has 3 sources
            _make_evidence(["ChatGPT"], source="reddit_mentions", evidence_id="ev1"),
            _make_evidence(["ChatGPT"], source="google_trends", evidence_id="ev2"),
            _make_evidence(["ChatGPT"], source="manual_observation", evidence_id="ev3"),
            # Steam Deck has 1 source
            _make_evidence(["Steam Deck"], source="reddit_mentions", evidence_id="ev4"),
        ]
        candidates = builder.build_candidates(evidence)
        assert len(candidates) == 2
        # ChatGPT should be first (higher emergence score)
        assert candidates[0].entity == "ChatGPT"
        assert candidates[1].entity == "Steam Deck"
        assert candidates[0].emergence_score > candidates[1].emergence_score

    def test_evidence_with_multiple_entity_candidates(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(["ChatGPT", "OpenAI"], evidence_id="ev1"),
        ]
        candidates = builder.build_candidates(evidence)
        # Both entities should appear as candidates
        entities = {c.entity for c in candidates}
        assert "ChatGPT" in entities
        assert "OpenAI" in entities

    def test_velocity_score_is_computed(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(["ChatGPT"], evidence_id=f"ev_{i}")
            for i in range(10)
        ]
        candidates = builder.build_candidates(evidence)
        assert len(candidates) == 1
        assert candidates[0].velocity_score > 0

    def test_aliases_group_into_one_canonical_candidate(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(["ChatGPT"], source="reddit_mentions", evidence_id="ev1"),
            _make_evidence(["GPT"], source="google_trends", evidence_id="ev2"),
        ]

        candidates = builder.build_candidates(evidence)

        assert len(candidates) == 1
        assert candidates[0].entity == "ChatGPT"
        assert "GPT" in candidates[0].aliases

    def test_generic_reddit_tokens_do_not_form_standalone_candidates(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(
                ["says", "report", "free", "Microsoft", "AV1"],
                evidence_id="ev1",
                title_or_label="Microsoft AV1 crash report says royalty free codec issue",
            )
        ]

        candidates = builder.build_candidates(evidence)

        assert [candidate.entity for candidate in candidates] == ["Microsoft"]
        assert "AV1" in candidates[0].supporting_terms

    def test_fallback_prefers_entity_like_terms_over_noisy_phrase(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(
                ["Micron SanDisk Stocks Tumble"],
                evidence_id="ev_phrase",
                title_or_label="Micron SanDisk Stocks Tumble After Weak Guidance",
            )
        ]

        candidates = builder.build_candidates(evidence)

        assert len(candidates) == 1
        assert candidates[0].entity in {"Micron", "SanDisk"}
        assert "Micron SanDisk Stocks Tumble" not in candidates[0].supporting_terms

    def test_fallback_drops_phrase_when_only_noise_suffix_exists(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(
                ["Microsoft Set"],
                evidence_id="ev_noise_phrase",
                title_or_label="Microsoft Set to Announce Additional Changes",
            )
        ]

        candidates = builder.build_candidates(evidence)

        assert len(candidates) == 1
        assert candidates[0].entity == "Microsoft"

    def test_candidate_includes_event_and_graph_facets(self):
        builder = SignalCandidateBuilder()
        evidence = [
            _make_evidence(
                ["Microsoft"],
                evidence_id="ev1",
                event_frame=EvidenceEventFrame(
                    event_type="codec_rollout",
                    summary="AV1 playback changes are triggering crash chatter",
                    subjects=["Microsoft"],
                    objects=["AV1"],
                ),
                relationship_hints=[
                    EvidenceRelationshipHint(
                        **{
                            "from": "Microsoft",
                            "to": "AV1",
                            "kind": "codec_dependency",
                            "confidence": 0.72,
                        }
                    )
                ],
            )
        ]

        candidates = builder.build_candidates(evidence)

        assert len(candidates) == 1
        candidate = candidates[0]
        assert candidate.event_summary == "AV1 playback changes are triggering crash chatter"
        assert "codec_rollout" in candidate.theme_tags
        assert "codec_dependency" in candidate.theme_tags
        assert candidate.graph_summary is not None
        assert candidate.cluster_id == "entity:microsoft"

    def test_source_validity_lowers_emergence_score(self, tmp_path):
        registry = SourceRegistry(
            str(tmp_path / "sources.json"),
            build_default_sources({"dummy": _DummyConnector()}),
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

        builder = SignalCandidateBuilder(source_registry=registry)
        evidence = [
            _make_evidence(["ChatGPT"], source="google_trends", evidence_id="ev1"),
            _make_evidence(["ChatGPT"], source="manual_observation", source_tier=1, evidence_id="ev2"),
        ]
        candidates = builder.build_candidates(evidence)
        assert len(candidates) == 1
        assert candidates[0].source_quality_score is not None
        assert candidates[0].source_quality_score < 1.0
