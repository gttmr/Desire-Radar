"""Tests for the normalizer module."""

from src.normalizer.normalizer import normalize
from src.normalizer.registry import DEFAULT_NORMALIZER_REGISTRY


class TestRedditNormalizer:
    def test_normalize_reddit_post(self):
        raw = {
            "title": "ChatGPT just released a new feature for coding",
            "subreddit": "technology",
            "score": 1500,
            "upvote_ratio": 0.95,
            "permalink": "/r/technology/comments/abc123/chatgpt_feature/",
        }
        results = normalize("reddit_mentions", raw, "snap_001")

        assert len(results) == 1
        ev = results[0]
        assert ev.source == "reddit_mentions"
        assert ev.source_tier == 2
        assert ev.signal_type == "social_mention"
        assert ev.metric_value == 1500.0
        assert ev.metric_delta == 0.95
        assert ev.raw_snapshot_ref == "snap_001"
        assert "ChatGPT" in ev.entity_candidates
        assert ev.url_or_ref.startswith("https://www.reddit.com/")

    def test_normalize_reddit_empty_title(self):
        raw = {
            "title": "",
            "subreddit": "test",
            "score": 10,
            "upvote_ratio": 0.5,
            "permalink": "",
        }
        results = normalize("reddit_mentions", raw, "snap_002")
        # Empty title should produce no entity candidates, so no evidence
        assert len(results) == 0

    def test_normalize_reddit_filters_stop_words(self):
        raw = {
            "title": "The new Apple product is great",
            "subreddit": "gadgets",
            "score": 500,
            "upvote_ratio": 0.8,
            "permalink": "/r/gadgets/test/",
        }
        results = normalize("reddit_mentions", raw, "snap_003")
        assert len(results) == 1
        ev = results[0]
        # "The", "new", "is" should be filtered; "Apple", "product", "great" kept
        assert "The" not in ev.entity_candidates
        assert "is" not in ev.entity_candidates
        assert "Apple" in ev.entity_candidates


class TestManualObservationNormalizer:
    def test_normalize_manual_observation(self):
        raw = {
            "title": "TikTok ban discussion trending",
            "entities": ["TikTok", "US Government"],
            "signal_type": "policy_event",
            "geo": "US",
            "trust_score": 0.9,
        }
        results = normalize("manual_observation", raw, "snap_010")

        assert len(results) == 1
        ev = results[0]
        assert ev.source == "manual_observation"
        assert ev.source_tier == 1
        assert ev.signal_type == "policy_event"
        assert ev.entity_candidates == ["TikTok", "US Government"]
        assert ev.geo == "US"
        assert ev.trust_score == 0.9

    def test_normalize_manual_observation_defaults(self):
        raw = {"title": "Something happened"}
        results = normalize("manual_observation", raw, "snap_011")

        assert len(results) == 1
        ev = results[0]
        assert ev.entity_candidates == []
        assert ev.signal_type == "manual"
        assert ev.geo == "global"
        assert ev.trust_score == 1.0


class TestUnknownSource:
    def test_registry_exposes_known_normalizer_keys(self):
        assert "google_trends" in DEFAULT_NORMALIZER_REGISTRY.keys()
        assert "reddit_mentions" in DEFAULT_NORMALIZER_REGISTRY.keys()

    def test_unknown_source_returns_empty(self):
        results = normalize("unknown_source", {"data": "test"}, "snap_099")
        assert results == []

    def test_stub_connector_source_returns_empty(self):
        results = normalize("google_trends", {"data": "test"}, "snap_100")
        assert results == []
