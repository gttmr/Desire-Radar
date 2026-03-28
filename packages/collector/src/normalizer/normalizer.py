"""Per-source normalizer functions."""

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from .evidence_schema import Evidence
from .registry import DEFAULT_NORMALIZER_REGISTRY, register_normalizer

# Words to ignore when extracting entity candidates from titles
_STOP_WORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "because", "but", "and", "or", "if", "while", "about", "up",
    "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
    "she", "her", "it", "its", "they", "them", "their", "what", "which",
    "who", "whom", "this", "that", "these", "those", "am",
}

_GENERIC_TITLE_WORDS = {
    "agent", "agents", "airport", "accounts", "announces", "app", "apps",
    "building", "business", "charged", "coding", "confirms", "continued",
    "crash", "crashes", "dies", "digital", "director", "energy", "era",
    "explained", "feature", "feels", "fishy", "free", "getting", "great",
    "hacked", "heel", "holder", "home", "human", "independence",
    "invincibility", "keep", "laws", "market", "mini", "music", "old",
    "outrage", "personal", "phone", "plan", "practical", "prediction",
    "product", "promoting", "prompts", "rate", "released", "report",
    "reports", "require", "review", "rise", "rises", "royalty", "run",
    "says", "school", "scientific", "seat", "season", "service",
    "shocking", "signals", "solar", "speed", "start", "story", "study",
    "subscription", "suddenly", "tell", "testing", "theme", "ticket",
    "tracking", "verify", "video", "violates", "watchlist", "week", "year",
}

_TITLE_TOKEN_RE = re.compile(r"[A-Za-z0-9가-힣]+(?:'[A-Za-z]+)?")


def _extract_title_keywords(title: str) -> list[str]:
    """Extract entity-shaped candidates from a noisy title string."""
    words = _TITLE_TOKEN_RE.findall(title)
    candidates: list[str] = []

    def add_candidate(value: str) -> None:
        cleaned = value.strip()
        if cleaned.lower().endswith("'s"):
            cleaned = cleaned[:-2]
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)

    def is_hangul_token(word: str) -> bool:
        return bool(re.search(r"[가-힣]", word))

    def is_strong_entity_token(word: str) -> bool:
        return (
            (is_hangul_token(word) and len(word) >= 2)
            or (any(char.isdigit() for char in word) and any(char.isalpha() for char in word))
            or (word.isupper() and len(word) >= 2)
            or any(char.isupper() for char in word[1:])
        )

    def is_simple_titlecase_token(word: str) -> bool:
        return len(word) > 2 and word[:1].isupper() and word[1:].islower()

    def is_entityish(word: str) -> bool:
        lowered = word.lower()
        return (
            lowered not in _STOP_WORDS
            and lowered not in _GENERIC_TITLE_WORDS
            and (is_strong_entity_token(word) or is_simple_titlecase_token(word))
        )

    index = 0
    while index < len(words):
        token = words[index]
        if not is_entityish(token):
            index += 1
            continue

        phrase = [token]
        lookahead = index + 1
        while lookahead < len(words):
            next_token = words[lookahead]
            if not is_entityish(next_token):
                break
            phrase.append(next_token)
            lookahead += 1

        if len(phrase) >= 2:
            add_candidate(" ".join(phrase[:4]))
            for part in phrase:
                if is_strong_entity_token(part):
                    add_candidate(part)
        else:
            add_candidate(token)

        index = lookahead

    return candidates


def _gen_id() -> str:
    return uuid.uuid4().hex[:16]


@register_normalizer("reddit_mentions")
def _normalize_reddit(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    title = raw_payload.get("title", "")
    subreddit = raw_payload.get("subreddit", "")
    score = raw_payload.get("score", 0)
    upvote_ratio = raw_payload.get("upvote_ratio", 0.0)
    permalink = raw_payload.get("permalink", "")

    entity_candidates = _extract_title_keywords(title)
    if not entity_candidates:
        return []

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="reddit_mentions",
            source_tier=2,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="social_mention",
            title_or_label=title,
            metric_value=float(score),
            metric_delta=upvote_ratio,
            geo="global",
            url_or_ref=f"https://www.reddit.com{permalink}" if permalink else "",
            raw_snapshot_ref=snapshot_ref,
            trust_score=min(1.0, upvote_ratio) if upvote_ratio else 0.5,
            tos_risk="low",
            freshness_ttl=3600,
        )
    ]


@register_normalizer("manual_observation")
def _normalize_manual(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    return [
        Evidence(
            evidence_id=_gen_id(),
            source="manual_observation",
            source_tier=1,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=raw_payload.get("entities", []),
            signal_type=raw_payload.get("signal_type", "manual"),
            title_or_label=raw_payload.get("title", "Manual observation"),
            metric_value=raw_payload.get("metric_value"),
            metric_delta=raw_payload.get("metric_delta"),
            rank=raw_payload.get("rank"),
            geo=raw_payload.get("geo", "global"),
            url_or_ref=raw_payload.get("url", ""),
            raw_snapshot_ref=snapshot_ref,
            trust_score=raw_payload.get("trust_score", 1.0),
            tos_risk="none",
            freshness_ttl=raw_payload.get("freshness_ttl", 86400),
        )
    ]


@register_normalizer("google_trends")
def _normalize_google_trends(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    topic = raw_payload.get("title") or raw_payload.get("topic") or raw_payload.get("query", "")
    traffic = raw_payload.get("traffic_volume") or raw_payload.get("value")
    geo = raw_payload.get("geo", "global")
    url = raw_payload.get("url", "")

    entity_candidates = [topic] if topic else []
    if not entity_candidates:
        return []

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="google_trends",
            source_tier=2,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="search_trend",
            title_or_label=topic or raw_payload.get("title", ""),
            metric_value=float(traffic) if traffic is not None else None,
            geo=geo,
            url_or_ref=url,
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.7,
            tos_risk="medium",
            freshness_ttl=21600,
        )
    ]


@register_normalizer("naver_datalab")
def _normalize_naver_datalab(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    keyword_group = raw_payload.get("title") or raw_payload.get("keyword_group", "")
    ratio = raw_payload.get("ratio") or raw_payload.get("latest_ratio") or raw_payload.get("value")
    period = raw_payload.get("period", "")
    keywords = raw_payload.get("keywords", [])

    entity_candidates = keywords if keywords else (
        [keyword_group] if keyword_group else []
    )
    if not entity_candidates:
        return []

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="naver_datalab",
            source_tier=2,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="search_trend",
            title_or_label=f"{keyword_group} ({period})" if period else keyword_group,
            metric_value=float(ratio) if ratio is not None else None,
            geo="KR",
            url_or_ref=raw_payload.get("url", ""),
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.8,
            tos_risk="medium",
            freshness_ttl=43200,
        )
    ]


@register_normalizer("app_store_top_charts")
def _normalize_app_store_top_charts(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    app_name = raw_payload.get("name") or raw_payload.get("app_name", "")
    position = raw_payload.get("position") or raw_payload.get("rank")
    chart_type = raw_payload.get("chart_type", "top_free")
    category = raw_payload.get("category", "")
    url = raw_payload.get("url", "")

    entity_candidates = [app_name] if app_name else []
    if not entity_candidates:
        return []

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="app_store_top_charts",
            source_tier=1,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="app_chart",
            title_or_label=f"{app_name} #{position} ({chart_type})" if position else app_name,
            metric_value=None,
            rank=int(position) if position is not None else None,
            geo=raw_payload.get("geo", "global"),
            url_or_ref=url,
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.9,
            tos_risk="low",
            freshness_ttl=3600,
        )
    ]


@register_normalizer("steamdb_top_sellers")
def _normalize_steamdb_top_sellers(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    game_name = raw_payload.get("title") or raw_payload.get("game_name") or raw_payload.get("name", "")
    # Skip placeholder names like "appid:12345"
    if game_name.startswith("appid:"):
        game_name = ""
    position = raw_payload.get("position") or raw_payload.get("rank")
    price = raw_payload.get("price_cents") or raw_payload.get("price")
    discount = raw_payload.get("discount_percent") or raw_payload.get("discount")
    url = raw_payload.get("url", "")

    entity_candidates = [game_name] if game_name else []
    if not entity_candidates:
        return []

    label = game_name
    if discount:
        label = f"{game_name} (-{discount}%)"

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="steamdb_top_sellers",
            source_tier=2,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="game_trend",
            title_or_label=label,
            metric_value=float(price) if price is not None else None,
            metric_delta=float(discount) if discount is not None else None,
            rank=int(position) if position is not None else None,
            geo="global",
            url_or_ref=url,
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.7,
            tos_risk="medium",
            freshness_ttl=3600,
        )
    ]


@register_normalizer("tiktok_creative_center")
def _normalize_tiktok_creative_center(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    hashtag = raw_payload.get("hashtag_name") or raw_payload.get("hashtag") or raw_payload.get("keyword") or raw_payload.get("nickname") or raw_payload.get("name", "")
    view_count = raw_payload.get("view_count") or raw_payload.get("views")
    video_count = raw_payload.get("video_count")
    url = raw_payload.get("url", "")

    entity_candidates = [hashtag.lstrip("#")] if hashtag else []
    if not entity_candidates:
        return []

    label = f"#{hashtag.lstrip('#')}"
    if video_count:
        label = f"{label} ({video_count} videos)"

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="tiktok_creative_center",
            source_tier=3,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="social_trend",
            title_or_label=label,
            metric_value=float(view_count) if view_count is not None else None,
            geo=raw_payload.get("geo", "global"),
            url_or_ref=url,
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.5,
            tos_risk="high",
            freshness_ttl=3600,
        )
    ]


@register_normalizer("similarweb_movers")
def _normalize_similarweb_movers(
    raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    domain = raw_payload.get("domain") or raw_payload.get("site", "")
    rank = raw_payload.get("rank") or raw_payload.get("position")
    category = raw_payload.get("category", "")
    change = raw_payload.get("change") or raw_payload.get("rank_change")
    url = raw_payload.get("url", "")

    # Extract meaningful entity name from domain (strip TLD)
    entity_name = domain.split(".")[0] if domain else ""
    entity_candidates = [entity_name] if entity_name else []
    if not entity_candidates:
        return []

    label = f"{domain} #{rank}" if rank else domain
    if category:
        label = f"{label} ({category})"

    return [
        Evidence(
            evidence_id=_gen_id(),
            source="similarweb_movers",
            source_tier=2,
            collected_at=datetime.now(timezone.utc).isoformat(),
            entity_candidates=entity_candidates,
            signal_type="web_traffic",
            title_or_label=label,
            metric_value=float(change) if change is not None else None,
            rank=int(rank) if rank is not None else None,
            geo="global",
            url_or_ref=url or f"https://{domain}" if domain else "",
            raw_snapshot_ref=snapshot_ref,
            trust_score=0.6,
            tos_risk="medium",
            freshness_ttl=3600,
        )
    ]


def normalize(
    source: str, raw_payload: dict[str, Any], snapshot_ref: str
) -> list[Evidence]:
    """Dispatch to per-source normalizer. Return empty list for unknown sources."""
    return DEFAULT_NORMALIZER_REGISTRY.normalize(source, raw_payload, snapshot_ref)
