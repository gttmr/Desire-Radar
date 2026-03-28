"""Tests for the entity resolver module."""

import json
import os
import tempfile

import pytest

from src.resolver.entity_resolver import EntityResolver
from src.store.entity_store import EntityStore


@pytest.fixture
def tmp_entity_path():
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        json.dump({"entities": {}, "review_queue": []}, f)
        path = f.name
    yield path
    os.unlink(path)


@pytest.fixture
def entity_store(tmp_entity_path):
    return EntityStore(path=tmp_entity_path)


@pytest.fixture
def resolver(entity_store):
    return EntityResolver(entity_store)


class TestAliasResolution:
    def test_resolve_from_static_alias(self, resolver):
        assert resolver.resolve("chatgpt") == "ChatGPT"
        assert resolver.resolve("gpt") == "ChatGPT"
        assert resolver.resolve("chat gpt") == "ChatGPT"

    def test_resolve_case_insensitive(self, resolver):
        assert resolver.resolve("CHATGPT") == "ChatGPT"
        assert resolver.resolve("ChatGPT") == "ChatGPT"

    def test_resolve_from_entity_store(self, entity_store, resolver):
        entity_store.add_entity("MyProduct", "product", ["my-product", "myprod"])
        assert resolver.resolve("my-product") == "MyProduct"
        assert resolver.resolve("myprod") == "MyProduct"

    def test_resolve_unknown_returns_none(self, resolver):
        assert resolver.resolve("xyznonexistent") is None

    def test_resolve_candidates_dedup(self, resolver):
        candidates = ["chatgpt", "gpt", "openai", "ChatGPT"]
        resolved = resolver.resolve_candidates(candidates)
        assert "ChatGPT" in resolved
        assert "OpenAI" in resolved
        # Should be deduped — "chatgpt", "gpt", "ChatGPT" all resolve to "ChatGPT"
        assert resolved.count("ChatGPT") == 1


class TestReviewQueue:
    def test_unresolved_adds_to_review_queue(self, resolver, entity_store):
        resolver.resolve("BrandNewThing", source="reddit_mentions")
        queue = entity_store.get_review_queue()
        assert len(queue) == 1
        assert queue[0]["raw_text"] == "BrandNewThing"
        assert "reddit_mentions" in queue[0]["sources"]

    def test_duplicate_review_increments_count(self, resolver, entity_store):
        resolver.resolve("BrandNewThing", source="reddit_mentions")
        resolver.resolve("BrandNewThing", source="google_trends")
        queue = entity_store.get_review_queue()
        assert len(queue) == 1
        assert queue[0]["count"] == 2
        assert set(queue[0]["sources"]) == {"reddit_mentions", "google_trends"}

    def test_approve_review(self, entity_store):
        entity_store.add_to_review_queue("newthing", "test")
        entity_store.approve_review("newthing", "NewThing")
        queue = entity_store.get_review_queue()
        assert len(queue) == 0
        # Should now resolve
        assert entity_store.resolve("newthing") == "NewThing"

    def test_reject_review(self, entity_store):
        entity_store.add_to_review_queue("badthing", "test")
        entity_store.reject_review("badthing")
        queue = entity_store.get_review_queue()
        assert len(queue) == 0

    def test_resolve_candidates_batches_meaningful_review_terms(self, resolver, entity_store):
        resolved = resolver.resolve_candidates(
            ["says", "report", "AV1", "Brand New Thing"],
            source="reddit_mentions",
        )

        assert resolved == []
        queue = entity_store.get_review_queue()
        queued = {item["raw_text"] for item in queue}
        assert "AV1" in queued
        assert "Brand New Thing" in queued
        assert "says" not in queued
        assert "report" not in queued
