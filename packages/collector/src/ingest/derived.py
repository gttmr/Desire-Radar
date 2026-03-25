"""Derived source builders that emit evidence from existing evidence."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from ..normalizer.evidence_schema import Evidence

_TIGHTNESS_KEYWORDS = ("sold out", "waitlist", "resale", "out of stock", "backorder")


def build_derived_evidence(
    source_id: str,
    evidence_list: list[Evidence],
    source_tier: int,
) -> list[Evidence]:
    match source_id:
        case "co_mention_surge":
            return _build_co_mention_surge(evidence_list, source_tier)
        case "search_rank_divergence":
            return _build_search_rank_divergence(evidence_list, source_tier)
        case "persistence_acceleration":
            return _build_persistence_acceleration(evidence_list, source_tier)
        case "supply_tightness_proxy":
            return _build_supply_tightness_proxy(evidence_list, source_tier)
        case _:
            return []


def _build_co_mention_surge(evidence_list: list[Evidence], source_tier: int) -> list[Evidence]:
    pairs: dict[tuple[str, str], set[str]] = {}
    parent_ids: dict[tuple[str, str], list[str]] = {}
    for evidence in evidence_list:
        entities = sorted({entity for entity in evidence.entity_candidates if entity})
        if len(entities) < 2:
            continue
        pair = (entities[0], entities[1])
        pairs.setdefault(pair, set()).add(evidence.source)
        parent_ids.setdefault(pair, []).append(evidence.evidence_id)

    results: list[Evidence] = []
    for pair, sources in pairs.items():
        if len(sources) < 2:
            continue
        results.append(
            _make_derived_evidence(
                source="co_mention_surge",
                source_tier=source_tier,
                entities=list(pair),
                title=f"{pair[0]} + {pair[1]} co-mentioned across {len(sources)} sources",
                signal_type="derived_co_mention",
                metric_value=float(len(sources)),
                parent_evidence_ids=parent_ids.get(pair, []),
            )
        )
    return results


def _build_search_rank_divergence(evidence_list: list[Evidence], source_tier: int) -> list[Evidence]:
    by_entity: dict[str, list[Evidence]] = {}
    for evidence in evidence_list:
        for entity in evidence.entity_candidates:
            by_entity.setdefault(entity, []).append(evidence)

    results: list[Evidence] = []
    for entity, evidences in by_entity.items():
        has_search = any(item.signal_type == "search_trend" for item in evidences)
        has_rank = any(item.rank is not None for item in evidences)
        if not has_search or not has_rank:
            continue
        results.append(
            _make_derived_evidence(
                source="search_rank_divergence",
                source_tier=source_tier,
                entities=[entity],
                title=f"{entity} shows both search acceleration and rank visibility",
                signal_type="derived_search_rank_divergence",
                parent_evidence_ids=[item.evidence_id for item in evidences[:6]],
            )
        )
    return results


def _build_persistence_acceleration(evidence_list: list[Evidence], source_tier: int) -> list[Evidence]:
    by_entity: dict[str, list[Evidence]] = {}
    for evidence in evidence_list:
        for entity in evidence.entity_candidates:
            by_entity.setdefault(entity, []).append(evidence)

    results: list[Evidence] = []
    for entity, evidences in by_entity.items():
        sources = {item.source for item in evidences}
        if len(evidences) < 3 or len(sources) < 2:
            continue
        results.append(
            _make_derived_evidence(
                source="persistence_acceleration",
                source_tier=source_tier,
                entities=[entity],
                title=f"{entity} persisted across {len(evidences)} evidence items and {len(sources)} sources",
                signal_type="derived_persistence",
                metric_value=float(len(evidences)),
                parent_evidence_ids=[item.evidence_id for item in evidences[:8]],
            )
        )
    return results


def _build_supply_tightness_proxy(evidence_list: list[Evidence], source_tier: int) -> list[Evidence]:
    results: list[Evidence] = []
    for evidence in evidence_list:
        title = evidence.title_or_label.lower()
        if not any(keyword in title for keyword in _TIGHTNESS_KEYWORDS):
            continue
        if not evidence.entity_candidates:
            continue
        results.append(
            _make_derived_evidence(
                source="supply_tightness_proxy",
                source_tier=source_tier,
                entities=evidence.entity_candidates,
                title=f"Supply tightness signal inferred from: {evidence.title_or_label}",
                signal_type="derived_supply_tightness",
                parent_evidence_ids=[evidence.evidence_id],
            )
        )
    return results


def _make_derived_evidence(
    *,
    source: str,
    source_tier: int,
    entities: list[str],
    title: str,
    signal_type: str,
    metric_value: float | None = None,
    parent_evidence_ids: list[str] | None = None,
) -> Evidence:
    return Evidence(
        evidence_id=uuid.uuid4().hex[:16],
        source=source,
        source_tier=source_tier,
        source_kind="derived",
        producer_ref="collector",
        parent_evidence_ids=parent_evidence_ids or [],
        collected_at=datetime.now(timezone.utc).isoformat(),
        entity_candidates=entities,
        signal_type=signal_type,
        title_or_label=title,
        metric_value=metric_value,
        metric_delta=None,
        rank=None,
        geo="global",
        url_or_ref="",
        raw_snapshot_ref="",
        trust_score=0.75,
        tos_risk="none",
        freshness_ttl=21600,
    )
