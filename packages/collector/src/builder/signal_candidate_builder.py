"""Signal candidate builder: groups evidence into entity-centric clusters."""

from collections import defaultdict
from datetime import datetime, timezone
import re
from typing import Literal

from pydantic import BaseModel, Field

from ..analysis.store import AnalysisStore
from ..normalizer.evidence_schema import Evidence
from ..resolver.alias_dict import ALIAS_DICT
from ..sources.registry import SourceRegistry
from ..store.entity_store import EntityStore

_GENERIC_CANDIDATE_TERMS = {
    "says", "said", "report", "reports", "reported", "free", "crash", "crashes",
    "bots", "bot", "music", "royalty", "dies", "keep", "phone", "airport",
    "year", "years", "shocking", "speed", "scientific", "practical", "building",
    "energy", "independence", "feels", "mini", "home", "solar", "farms",
    "today", "week", "month", "people", "thing", "things", "post", "posts",
    "video", "videos", "thread", "threads", "update", "updates", "launch",
    "launches", "feature", "features", "use", "uses", "using", "new", "great",
    "good", "bad", "best", "worst", "story", "stories", "news", "leak",
    "leaks", "rumor", "rumors", "issue", "issues", "problem", "problems",
}
_ACRONYM_OR_DIGIT_PATTERN = re.compile(r"^(?:[A-Z]{2,}[A-Z0-9]*|[A-Za-z]+[0-9]+[A-Za-z0-9]*)$")
_NON_WORD_PATTERN = re.compile(r"[^a-z0-9]+")


class SignalCandidate(BaseModel):
    entity: str
    cluster_id: str | None = None
    candidate_kind: Literal["entity_cluster"] = "entity_cluster"
    display_label: str | None = None
    primary_entity: str | None = None
    aliases: list[str] = Field(default_factory=list)
    supporting_terms: list[str] = Field(default_factory=list)
    theme_tags: list[str] = Field(default_factory=list)
    event_summary: str | None = None
    graph_summary: str | None = None
    status: Literal["emerging", "preheat", "spreading"]
    emergence_score: float
    velocity_score: float
    source_count: int
    evidence_ids: list[str]
    sources: list[str]
    first_seen: str
    last_seen: str
    source_quality_score: float | None = None

    # LLM-enriched aggregated fields
    desire_types: list[str] = Field(default_factory=list)  # Aggregated desire types from evidence
    behavioral_signals: list[str] = Field(default_factory=list)  # Aggregated behavioral descriptions
    avg_intensity: float | None = None  # Average desire intensity
    demographic_hints: list[str] = Field(default_factory=list)  # Aggregated demographics
    desire_summary: str | None = None  # Best LLM summary for this entity
    analysis_status: str | None = None
    analysis_summary: str | None = None
    analysis_confidence: float | None = None
    analysis_reason: str | None = None
    last_analyzed_at: str | None = None
    analysis_session_domain: str | None = None


class SignalCandidateBuilder:
    def __init__(
        self,
        time_window_seconds: int = 86400,
        entity_store: EntityStore | None = None,
        analysis_store: AnalysisStore | None = None,
        source_registry: SourceRegistry | None = None,
    ) -> None:
        self.time_window_seconds = time_window_seconds
        self.entity_store = entity_store
        self.analysis_store = analysis_store
        self.source_registry = source_registry

    def _is_t3_allowed(self, ev: Evidence, entity: str) -> bool:
        """Check if T3 evidence is allowed (approved in review queue)."""
        if ev.source_tier != 3:
            return True
        if self.entity_store is None:
            return True  # No store to check, allow by default
        return self.entity_store.is_approved(entity)

    def build_candidates(
        self, evidence_list: list[Evidence]
    ) -> list[SignalCandidate]:
        """Group evidence by canonical cluster and compute signal candidates."""
        entity_evidence: dict[str, list[Evidence]] = defaultdict(list)
        entity_aliases: dict[str, set[str]] = defaultdict(set)
        entity_supporting_terms: dict[str, set[str]] = defaultdict(set)
        for ev in evidence_list:
            for entity, aliases, supporting_terms in self._cluster_entries_for_evidence(ev):
                if self._is_t3_allowed(ev, entity):
                    entity_evidence[entity].append(ev)
                    entity_aliases[entity].update(aliases)
                    entity_supporting_terms[entity].update(supporting_terms)

        candidates: list[SignalCandidate] = []
        now = datetime.now(timezone.utc)

        for entity, evidences in entity_evidence.items():
            sources = list({ev.source for ev in evidences})
            source_count = len(sources)
            evidence_ids = [ev.evidence_id for ev in evidences]
            weighted_source_score = sum(
                self._source_weight(source, evidences)
                for source in sources
            )
            source_quality_score = round(
                weighted_source_score / max(1, source_count),
                3,
            )

            # Parse timestamps for recency
            timestamps: list[datetime] = []
            for ev in evidences:
                try:
                    ts = datetime.fromisoformat(ev.collected_at)
                    timestamps.append(ts)
                except (ValueError, TypeError):
                    timestamps.append(now)

            first_seen = min(timestamps).isoformat() if timestamps else now.isoformat()
            last_seen = max(timestamps).isoformat() if timestamps else now.isoformat()

            # Emergence score: based on source count and evidence count
            emergence_score = min(
                10.0, weighted_source_score * 2.0 + len(evidences) * 0.5
            )

            # Velocity score: evidence count within the time window
            recent_count = sum(
                1
                for ts in timestamps
                if (now - ts).total_seconds() < self.time_window_seconds
            )
            velocity_score = min(
                10.0,
                recent_count / max(1, self.time_window_seconds / 3600) * 2.0,
            )

            # Status thresholds
            if source_count >= 5 and source_quality_score >= 0.6:
                status: Literal["emerging", "preheat", "spreading"] = "spreading"
            elif source_count >= 3 and source_quality_score >= 0.45:
                status = "preheat"
            else:
                status = "emerging"

            # Aggregate LLM-enriched fields
            desire_types = list({
                desire_type for ev in evidences
                if (desire_type := getattr(ev, "desire_type", None))
            })
            behavioral_signals = list({
                behavioral_signal for ev in evidences
                if (behavioral_signal := getattr(ev, "behavioral_signal", None))
            })
            intensities = [
                intensity for ev in evidences
                if (intensity := getattr(ev, "intensity", None)) is not None
            ]
            avg_intensity = (
                round(sum(intensities) / len(intensities), 2)
                if intensities else None
            )
            demographic_hints = list({
                demographic_hint for ev in evidences
                if (demographic_hint := getattr(ev, "demographic_hint", None))
            })
            # Pick the longest LLM summary as the best one
            summaries = [
                llm_summary for ev in evidences
                if (llm_summary := getattr(ev, "llm_summary", None))
            ]
            desire_summary = max(summaries, key=len) if summaries else None
            projection = (
                self.analysis_store.get_projection(entity)
                if self.analysis_store is not None
                else None
            )
            theme_tags = self._aggregate_theme_tags(evidences)
            event_summary = self._pick_event_summary(evidences)
            graph_summary = self._build_graph_summary(evidences, source_count)

            if projection is not None:
                desire_types = projection.desire_types or desire_types
                behavioral_signals = projection.behavioral_signals or behavioral_signals
                avg_intensity = projection.avg_intensity if projection.avg_intensity is not None else avg_intensity
                demographic_hints = projection.demographic_hints or demographic_hints
                desire_summary = projection.summary or desire_summary

            candidates.append(
                SignalCandidate(
                    entity=entity,
                    cluster_id=self._cluster_id(entity),
                    display_label=entity,
                    primary_entity=entity,
                    aliases=sorted(entity_aliases.get(entity, set())),
                    supporting_terms=sorted(entity_supporting_terms.get(entity, set())),
                    theme_tags=theme_tags,
                    event_summary=event_summary,
                    graph_summary=graph_summary,
                    status=status,
                    emergence_score=round(emergence_score, 2),
                    velocity_score=round(velocity_score, 2),
                    source_count=source_count,
                    evidence_ids=evidence_ids,
                    sources=sources,
                    first_seen=first_seen,
                    last_seen=last_seen,
                    source_quality_score=source_quality_score,
                    desire_types=desire_types,
                    behavioral_signals=behavioral_signals,
                    avg_intensity=avg_intensity,
                    demographic_hints=demographic_hints,
                    desire_summary=desire_summary,
                    analysis_status=projection.status if projection is not None else None,
                    analysis_summary=projection.summary if projection is not None else None,
                    analysis_confidence=projection.confidence if projection is not None else None,
                    analysis_reason=projection.reason if projection is not None else None,
                    last_analyzed_at=projection.analyzed_at if projection is not None else None,
                    analysis_session_domain=projection.session_domain if projection is not None else None,
                )
            )

        # Sort by emergence score descending
        candidates.sort(key=lambda c: c.emergence_score, reverse=True)
        return candidates

    def _cluster_entries_for_evidence(
        self,
        evidence: Evidence,
    ) -> list[tuple[str, list[str], list[str]]]:
        raw_terms = self._raw_terms_for_evidence(evidence)
        resolved_entities: list[str] = []
        aliases_by_entity: dict[str, set[str]] = defaultdict(set)
        unresolved_terms: list[str] = []

        for raw_term in raw_terms:
            canonical = self._resolve_entity_candidate(raw_term)
            if canonical:
                if canonical not in resolved_entities:
                    resolved_entities.append(canonical)
                if raw_term.lower() != canonical.lower():
                    aliases_by_entity[canonical].add(raw_term)
                continue
            if self._is_meaningful_fallback_term(raw_term):
                unresolved_terms.append(raw_term)

        if resolved_entities:
            entries: list[tuple[str, list[str], list[str]]] = []
            unresolved_unique = self._dedupe_terms(unresolved_terms)
            for entity in resolved_entities:
                supporting = set(unresolved_unique)
                supporting.update(
                    other for other in resolved_entities
                    if other.lower() != entity.lower()
                )
                entries.append(
                    (
                        entity,
                        sorted(aliases_by_entity.get(entity, set())),
                        sorted(
                            term for term in supporting
                            if term and term.lower() != entity.lower()
                        ),
                    )
                )
            return entries

        fallback_terms = self._dedupe_terms(unresolved_terms)
        if not fallback_terms:
            return []
        primary = fallback_terms[0]
        return [(primary, [], fallback_terms[1:])]

    def _raw_terms_for_evidence(self, evidence: Evidence) -> list[str]:
        ordered: list[str] = []
        if evidence.event_frame is not None:
            ordered.extend(evidence.event_frame.subjects)
            ordered.extend(evidence.event_frame.objects)
        ordered.extend(evidence.entity_candidates)
        return self._dedupe_terms(ordered)

    def _resolve_entity_candidate(self, raw_text: str) -> str | None:
        normalized = raw_text.strip()
        if not normalized:
            return None
        alias = ALIAS_DICT.get(normalized.lower())
        if alias:
            return alias
        if self.entity_store is not None:
            return self.entity_store.resolve(normalized)
        return None

    def _is_meaningful_fallback_term(self, raw_text: str) -> bool:
        normalized = raw_text.strip()
        if not normalized:
            return False
        lowered = normalized.lower()
        if lowered in _GENERIC_CANDIDATE_TERMS or len(lowered) < 3:
            return False
        if " " in normalized:
            return True
        if any("\uac00" <= char <= "\ud7a3" for char in normalized):
            return True
        return bool(_ACRONYM_OR_DIGIT_PATTERN.match(normalized))

    def _dedupe_terms(self, values: list[str]) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for value in values:
            normalized = value.strip()
            if not normalized:
                continue
            key = normalized.lower()
            if key in seen:
                continue
            ordered.append(normalized)
            seen.add(key)
        return ordered

    def _aggregate_theme_tags(self, evidences: list[Evidence]) -> list[str]:
        tags: list[str] = []
        for evidence in evidences:
            if evidence.event_frame is not None and evidence.event_frame.event_type:
                tags.append(evidence.event_frame.event_type)
            for hint in evidence.relationship_hints:
                if hint.kind:
                    tags.append(hint.kind)
        return self._dedupe_terms(tags)[:6]

    def _pick_event_summary(self, evidences: list[Evidence]) -> str | None:
        summaries = [
            evidence.event_frame.summary.strip()
            for evidence in evidences
            if evidence.event_frame is not None and evidence.event_frame.summary
        ]
        if not summaries:
            return None
        summaries = self._dedupe_terms(summaries)
        summaries.sort(key=len, reverse=True)
        return summaries[0]

    def _build_graph_summary(self, evidences: list[Evidence], source_count: int) -> str | None:
        event_frame_count = sum(1 for evidence in evidences if evidence.event_frame is not None)
        relationship_count = sum(len(evidence.relationship_hints) for evidence in evidences)
        if event_frame_count <= 0 and relationship_count <= 0:
            return None
        parts: list[str] = []
        if event_frame_count > 0:
            parts.append(f"{event_frame_count} event frames")
        if relationship_count > 0:
            parts.append(f"{relationship_count} relationship hints")
        parts.append(f"{source_count} sources")
        return ", ".join(parts)

    def _cluster_id(self, entity: str) -> str:
        slug = _NON_WORD_PATTERN.sub("-", entity.strip().lower()).strip("-")
        return f"entity:{slug or 'cluster'}"

    def _source_weight(self, source: str, evidences: list[Evidence]) -> float:
        source_evidences = [ev for ev in evidences if ev.source == source]
        source_tier = min((ev.source_tier for ev in source_evidences), default=3)
        tier_weight = {1: 1.25, 2: 1.0, 3: 0.7}.get(source_tier, 0.7)

        if self.source_registry is None:
            return tier_weight

        status = self.source_registry.status().get(source, {})
        validity_score = float(status.get("validity_score") or 1.0)
        validity_status = str(status.get("validity_status") or "healthy")
        status_weight = {
            "healthy": 1.0,
            "noisy": 0.75,
            "degraded": 0.4,
            "blocked": 0.0,
        }.get(validity_status, 0.5)
        return round(tier_weight * validity_score * status_weight, 3)
