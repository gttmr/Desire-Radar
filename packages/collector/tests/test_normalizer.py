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
        # Generic title words should be filtered even when the title is loosely capitalized.
        assert "The" not in ev.entity_candidates
        assert "is" not in ev.entity_candidates
        assert "Apple" in ev.entity_candidates
        assert "product" not in ev.entity_candidates
        assert "great" not in ev.entity_candidates

    def test_normalize_reddit_prefers_entity_shaped_terms(self):
        raw = {
            "title": "How to Keep ICE Agents Out of Your Phone at the Airport",
            "subreddit": "technology",
            "score": 320,
            "upvote_ratio": 0.87,
            "permalink": "/r/technology/test_ice/",
        }
        results = normalize("reddit_mentions", raw, "snap_004")
        assert len(results) == 1
        ev = results[0]
        assert ev.entity_candidates == ["ICE"]

    def test_normalize_reddit_keeps_entity_phrases(self):
        raw = {
            "title": "DOJ confirms FBI Director Kash Patel's personal email was hacked",
            "subreddit": "technology",
            "score": 420,
            "upvote_ratio": 0.91,
            "permalink": "/r/technology/test_doj/",
        }
        results = normalize("reddit_mentions", raw, "snap_005")
        assert len(results) == 1
        ev = results[0]
        assert "DOJ" in ev.entity_candidates
        assert "FBI" in ev.entity_candidates
        assert "Kash Patel" in ev.entity_candidates

    def test_normalize_reddit_avoids_headline_fragment_phrases(self):
        raw = {
            "title": "Microsoft Set for Worst Quarter Since 2008 as AI Takes Two Bites",
            "subreddit": "technology",
            "score": 270,
            "upvote_ratio": 0.82,
            "permalink": "/r/technology/test_microsoft/",
        }
        results = normalize("reddit_mentions", raw, "snap_006")

        assert len(results) == 1
        ev = results[0]
        assert "Microsoft" in ev.entity_candidates
        assert "AI" in ev.entity_candidates
        assert all("Microsoft Set" not in candidate for candidate in ev.entity_candidates)
        assert all("Quarter" not in candidate for candidate in ev.entity_candidates)

    def test_normalize_reddit_breaks_phrases_on_punctuation_and_generic_trailers(self):
        raw = {
            "title": "Micron, SanDisk Stocks Tumble After Google Unveils AI Memory Compression Breakthrough",
            "subreddit": "technology",
            "score": 310,
            "upvote_ratio": 0.89,
            "permalink": "/r/technology/test_micron/",
        }
        results = normalize("reddit_mentions", raw, "snap_007")

        assert len(results) == 1
        ev = results[0]
        assert "Micron" in ev.entity_candidates
        assert "SanDisk" in ev.entity_candidates
        assert "Google" in ev.entity_candidates
        assert "AI" in ev.entity_candidates
        assert all("Stocks" not in candidate for candidate in ev.entity_candidates)
        assert all("Tumble" not in candidate for candidate in ev.entity_candidates)


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


class TestHackerNewsNormalizer:
    def test_normalize_hackernews_thread(self):
        raw = {
            "title": "Show HN: Acme AI Copilot",
            "points": 42,
            "num_comments": 11,
            "discussion_url": "https://news.ycombinator.com/item?id=1001",
            "bucket_rank": 1,
        }
        results = normalize("hackernews", raw, "snap_hn_001")

        assert len(results) == 1
        ev = results[0]
        assert ev.source == "hackernews"
        assert ev.signal_type == "developer_discussion"
        assert ev.metric_value == 42.0
        assert ev.metric_delta == 11.0
        assert ev.rank == 1
        assert "Acme" in ev.entity_candidates
        assert "AI" in ev.entity_candidates
        assert ev.url_or_ref == "https://news.ycombinator.com/item?id=1001"


class TestPolymarketNormalizer:
    def test_normalize_polymarket_market(self):
        raw = {
            "question": "Will OpenAI have the best AI model by June 2026?",
            "probability_yes": 61.0,
            "price_change_1d": 7.0,
            "market_rank": 1,
            "liquidity": 150000.0,
            "event_url": "https://polymarket.com/event/best-ai-model",
            "tags": ["OpenAI", "Tech"],
        }
        results = normalize("polymarket_markets", raw, "snap_pm_001")

        assert len(results) == 1
        ev = results[0]
        assert ev.source == "polymarket_markets"
        assert ev.signal_type == "prediction_market"
        assert ev.metric_value == 61.0
        assert ev.metric_delta == 7.0
        assert ev.rank == 1
        assert "OpenAI" in ev.entity_candidates
        assert "AI" in ev.entity_candidates
        assert ev.trust_score == 0.8
        assert ev.url_or_ref == "https://polymarket.com/event/best-ai-model"


class TestUnknownSource:
    def test_registry_exposes_known_normalizer_keys(self):
        assert "google_trends" in DEFAULT_NORMALIZER_REGISTRY.keys()
        assert "hackernews" in DEFAULT_NORMALIZER_REGISTRY.keys()
        assert "polymarket_markets" in DEFAULT_NORMALIZER_REGISTRY.keys()
        assert "reddit_mentions" in DEFAULT_NORMALIZER_REGISTRY.keys()

    def test_unknown_source_returns_empty(self):
        results = normalize("unknown_source", {"data": "test"}, "snap_099")
        assert results == []

    def test_stub_connector_source_returns_empty(self):
        results = normalize("google_trends", {"data": "test"}, "snap_100")
        assert results == []
