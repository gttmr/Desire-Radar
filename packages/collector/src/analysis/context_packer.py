"""Compress candidate evidence into bounded prompts for CLI analysis."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .models import (
    AnalysisBundle,
    AnalysisGraphEdge,
    AnalysisGraphNode,
    AnalysisProjection,
    PackedContext,
)

_SINGLE_RESPONSE_INSTRUCTIONS = (
    "Return JSON only with keys: summary, confidence, desire_types, "
    "behavioral_signals, demographic_hints, avg_intensity, open_questions."
)
_BATCH_RESPONSE_INSTRUCTIONS = (
    "Analyze each candidate block and return a JSON array. "
    "Each item must have keys: entity, summary, confidence, desire_types, "
    "behavioral_signals, demographic_hints, avg_intensity, open_questions."
)


def _parse_collected_at(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def _sort_ts(value: str) -> float:
    parsed = _parse_collected_at(value)
    try:
        return parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return 0.0


def _estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


class ContextPacker:
    def __init__(
        self,
        char_budget: int = 6000,
        max_evidence: int = 8,
        *,
        batch_char_budget: int = 7000,
        prompt_format: str = "markdown",
        title_max_chars: int = 120,
        include_previous_analysis: bool = True,
        batch_include_previous_analysis: bool = True,
        include_metrics: str = "auto",
        include_urls: bool = False,
        include_geo: bool = False,
        include_evidence_ids: bool = False,
    ) -> None:
        self.char_budget = char_budget
        self.max_evidence = max_evidence
        self.batch_char_budget = batch_char_budget
        self.prompt_format = prompt_format
        self.title_max_chars = title_max_chars
        self.include_previous_analysis = include_previous_analysis
        self.batch_include_previous_analysis = batch_include_previous_analysis
        self.include_metrics = include_metrics
        self.include_urls = include_urls
        self.include_geo = include_geo
        self.include_evidence_ids = include_evidence_ids

    def pack(
        self,
        candidate: Any,
        evidences: list[Any],
        projection: AnalysisProjection | None = None,
    ) -> PackedContext:
        selected = self._select_evidence(evidences)
        bundle = self._build_bundle(candidate, selected)
        prompt = self._render_single_prompt(candidate, selected, projection, bundle)
        prompt = self._trim_to_budget(prompt, self.char_budget)
        omitted_fields = self._omitted_fields()
        entity = getattr(candidate, "entity")
        return PackedContext(
            entity=entity,
            entities=[entity],
            prompt=prompt,
            bundle=bundle,
            evidence_ids=[ev.evidence_id for ev in selected],
            sources=list(dict.fromkeys(ev.source for ev in selected)),
            char_count=len(prompt),
            estimated_input_tokens=_estimate_tokens(prompt),
            omitted_fields=omitted_fields,
            prompt_format="markdown",
            batch_size=1,
            response_mode="single",
        )

    def pack_batch(
        self,
        items: list[tuple[Any, list[Any], AnalysisProjection | None]],
    ) -> PackedContext:
        blocks = []
        evidence_ids: list[str] = []
        sources: list[str] = []
        entities: list[str] = []

        for index, (candidate, evidences, projection) in enumerate(items, start=1):
            selected = self._select_evidence(evidences)
            bundle = self._build_bundle(candidate, selected)
            entity = getattr(candidate, "entity")
            entities.append(entity)
            evidence_ids.extend(ev.evidence_id for ev in selected)
            sources.extend(ev.source for ev in selected)
            blocks.append(
                self._render_candidate_block(
                    candidate,
                    selected,
                    projection,
                    bundle,
                    include_previous=self.batch_include_previous_analysis,
                    index=index,
                )
            )

        prompt = "\n".join([_BATCH_RESPONSE_INSTRUCTIONS, *blocks])
        prompt = self._trim_to_budget(prompt, self.batch_char_budget)
        return PackedContext(
            entity=entities[0] if entities else None,
            entities=entities,
            prompt=prompt,
            bundle=AnalysisBundle(
                entity=entities[0] if entities else None,
                entities=entities,
                summary=f"Batch bundle for {len(entities)} candidates",
                evidence_ids=evidence_ids,
                sources=list(dict.fromkeys(sources)),
            ),
            evidence_ids=evidence_ids,
            sources=list(dict.fromkeys(sources)),
            char_count=len(prompt),
            estimated_input_tokens=_estimate_tokens(prompt),
            omitted_fields=self._omitted_fields(),
            prompt_format="markdown",
            batch_size=len(entities),
            response_mode="batch",
        )

    def _select_evidence(self, evidences: list[Any]) -> list[Any]:
        ranked = sorted(
            evidences,
            key=lambda ev: (
                getattr(ev, "source_tier", 3),
                -float(getattr(ev, "trust_score", 0.0)),
                -_sort_ts(getattr(ev, "collected_at", "")),
            ),
            reverse=False,
        )

        selected: list[Any] = []
        used_sources: set[str] = set()

        for ev in ranked:
            if ev.source in used_sources:
                continue
            selected.append(ev)
            used_sources.add(ev.source)
            if len(selected) >= self.max_evidence:
                return selected

        for ev in ranked:
            if ev in selected:
                continue
            selected.append(ev)
            if len(selected) >= self.max_evidence:
                break

        return selected

    def _render_single_prompt(
        self,
        candidate: Any,
        evidences: list[Any],
        projection: AnalysisProjection | None,
        bundle: AnalysisBundle,
    ) -> str:
        block = self._render_candidate_block(
            candidate,
            evidences,
            projection,
            bundle,
            include_previous=self.include_previous_analysis,
            index=None,
        )
        return "\n".join([_SINGLE_RESPONSE_INSTRUCTIONS, block])

    def _render_candidate_block(
        self,
        candidate: Any,
        evidences: list[Any],
        projection: AnalysisProjection | None,
        bundle: AnalysisBundle,
        *,
        include_previous: bool,
        index: int | None,
    ) -> str:
        lines: list[str] = []
        if index is not None:
            lines.append(f"## Candidate {index}")

        entity = getattr(candidate, "entity")
        lines.append(f"Entity: {entity}")
        lines.append(f"Status: {getattr(candidate, 'status')}")
        lines.append(
            "Scores: "
            f"emergence={getattr(candidate, 'emergence_score')}, "
            f"velocity={getattr(candidate, 'velocity_score')}, "
            f"sources={getattr(candidate, 'source_count')}"
        )
        lines.append("Sources: " + ", ".join(getattr(candidate, "sources", [])))
        if include_previous and projection and projection.summary:
            lines.append("Previous: " + projection.summary.strip())
        if bundle.summary:
            lines.append("Graph: " + bundle.summary)
        lines.append("Evidence:")
        for ev in evidences:
            lines.append("- " + self._render_evidence_line(ev))
        return "\n".join(lines)

    def _build_bundle(self, candidate: Any, evidences: list[Any]) -> AnalysisBundle:
        entity = getattr(candidate, "entity")
        nodes: dict[str, AnalysisGraphNode] = {}
        edges: dict[str, AnalysisGraphEdge] = {}
        summary_parts: list[str] = []

        def ensure_node(node_id: str, label: str, kind: str, weight: float | None = None) -> None:
            if node_id not in nodes:
                nodes[node_id] = AnalysisGraphNode(
                    node_id=node_id,
                    label=label,
                    kind=kind,
                    weight=weight,
                )

        def ensure_edge(
            from_node: str,
            to_node: str,
            kind: str,
            evidence_id: str,
            weight: float | None = 1.0,
        ) -> None:
            key = f"{from_node}|{kind}|{to_node}"
            if key not in edges:
                edges[key] = AnalysisGraphEdge(
                    from_node=from_node,
                    to_node=to_node,
                    kind=kind,
                    weight=weight,
                    evidence_ids=[evidence_id],
                )
                return
            if evidence_id not in edges[key].evidence_ids:
                edges[key].evidence_ids.append(evidence_id)
            if weight is not None:
                edges[key].weight = (edges[key].weight or 0.0) + weight

        entity_node_id = f"entity:{entity}"
        ensure_node(entity_node_id, entity, "entity", float(len(evidences)))

        for ev in evidences:
            source_node_id = f"source:{ev.source}"
            signal_node_id = f"signal:{getattr(ev, 'signal_type', 'signal')}"
            ensure_node(source_node_id, ev.source, "source")
            ensure_node(signal_node_id, getattr(ev, "signal_type", "signal"), "signal")
            ensure_edge(source_node_id, entity_node_id, "observed_entity", ev.evidence_id)
            ensure_edge(entity_node_id, signal_node_id, "expresses_signal", ev.evidence_id)
            summary_parts.append(f"{ev.source}->{getattr(ev, 'signal_type', 'signal')}")

        summary = " | ".join(list(dict.fromkeys(summary_parts))[:5])
        return AnalysisBundle(
            entity=entity,
            entities=[entity],
            summary=summary,
            evidence_ids=[ev.evidence_id for ev in evidences],
            sources=list(dict.fromkeys(ev.source for ev in evidences)),
            graph_nodes=list(nodes.values()),
            graph_edges=list(edges.values()),
        )

    def _render_evidence_line(self, ev: Any) -> str:
        title = getattr(ev, "title_or_label", "").strip()
        if len(title) > self.title_max_chars:
            title = f"{title[: self.title_max_chars - 3]}..."

        parts = [f"{ev.source}/T{ev.source_tier}: {title}"]
        extras = self._metric_parts(ev)
        if self.include_geo and getattr(ev, "geo", ""):
            extras.append(f"geo={ev.geo}")
        if self.include_evidence_ids:
            extras.append(f"id={ev.evidence_id}")
        if self.include_urls and getattr(ev, "url_or_ref", ""):
            extras.append(f"url={ev.url_or_ref}")
        if extras:
            parts.append(" [" + ", ".join(extras) + "]")
        return "".join(parts)

    def _metric_parts(self, ev: Any) -> list[str]:
        if self.include_metrics == "false":
            return []

        extras: list[str] = []
        if getattr(ev, "metric_value", None) is not None:
            extras.append(f"value={ev.metric_value}")
        if getattr(ev, "metric_delta", None) is not None:
            extras.append(f"delta={ev.metric_delta}")
        if getattr(ev, "rank", None) is not None:
            extras.append(f"rank={ev.rank}")
        return extras

    def _trim_to_budget(self, prompt: str, budget: int) -> str:
        if len(prompt) <= budget:
            return prompt
        return prompt[: budget - 3].rstrip() + "..."

    def _omitted_fields(self) -> list[str]:
        omitted: list[str] = []
        if not self.include_urls:
            omitted.append("url_or_ref")
        if not self.include_geo:
            omitted.append("geo")
        if not self.include_evidence_ids:
            omitted.append("evidence_id")
        if self.include_metrics == "false":
            omitted.append("metric_fields")
        return omitted
