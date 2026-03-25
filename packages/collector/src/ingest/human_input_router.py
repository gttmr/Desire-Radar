"""Route free-form human messages into structured collector ingest payloads."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..analysis.session import SessionPool
from .human_input_models import HumanInputEnvelope, HumanInputRoutingDecision

logger = logging.getLogger(__name__)

_REQUIRED_DATASET_FIELDS = {
    "evidence_id",
    "entity_candidates",
    "signal_type",
    "title_or_label",
}
_KNOWN_METADATA_KEYS = {
    "title",
    "entity",
    "entities",
    "entity_candidates",
    "signal_type",
    "geo",
    "url",
    "trust_score",
    "freshness_ttl",
    "metric_value",
    "metric_delta",
    "rank",
    "why_now",
    "confidence",
    "beneficiary_hints",
    "research_questions",
    "source_refs",
    "supporting_points",
    "study_type",
    "dataset_name",
    "notes",
    "request_submission_id",
}
_SYSTEM_INSTRUCTIONS = """Return JSON only.
Choose route from manual_observation, human_analyst_note, human_curated_dataset, needs_review.
Use human_curated_dataset only if the message contains structured data that can be normalized immediately.
If the input is analytical, comparative, or explains why demand is changing, prefer human_analyst_note.
Use needs_review when the message is too incomplete to classify safely.
Keep confidence between 0 and 1.
For human_curated_dataset, evidence_items must be a JSON array of evidence objects with keys:
evidence_id, entity_candidates, signal_type, title_or_label, metric_value, metric_delta, rank, geo, url_or_ref, trust_score, freshness_ttl.
For other routes, evidence_items should be an empty array.
Return keys:
route, confidence, rationale, title, entities, signal_type, metric_value, metric_delta, rank, geo, trust_score, freshness_ttl, observation, why_now, beneficiary_hints, research_questions, source_refs, supporting_points, study_type, dataset_name, notes, evidence_items, request_submission_id, user_message."""


class _ParsedMetadata:
    def __init__(self, values: dict[str, str], body: str) -> None:
        self.values = values
        self.body = body


class HumanInputRouter:
    def __init__(
        self,
        *,
        session_pool: SessionPool | None,
        enabled: bool,
        execution_mode: str = "fresh",
        session_domain: str = "human-input-routing",
        auto_threshold: float = 0.75,
        review_threshold: float = 0.45,
        max_input_chars: int = 4000,
    ) -> None:
        self.session_pool = session_pool
        self.enabled = enabled
        self.execution_mode = execution_mode
        self.session_domain = session_domain
        self.auto_threshold = auto_threshold
        self.review_threshold = review_threshold
        self.max_input_chars = max_input_chars

    async def classify(
        self,
        envelope: HumanInputEnvelope,
        *,
        preferred_route: str | None = None,
    ) -> HumanInputRoutingDecision:
        heuristic = self._heuristic_classify(envelope, preferred_route=preferred_route)
        if heuristic.route == "human_curated_dataset":
            return heuristic
        if not self.enabled or self.session_pool is None:
            return heuristic

        prompt = self._build_prompt(envelope, heuristic, preferred_route=preferred_route)
        try:
            result = await self.session_pool.execute_json(
                prompt,
                domain=self.session_domain,
                execution_mode=self.execution_mode,
            )
            decision = HumanInputRoutingDecision.model_validate(result.payload or {})
        except Exception:
            logger.exception("Human input classification failed; using heuristic fallback")
            return heuristic

        normalized = self._normalize_decision(
            decision,
            envelope=envelope,
            fallback=heuristic,
            preferred_route=preferred_route,
        )
        if normalized.route == "needs_review":
            return normalized
        if normalized.confidence >= self.auto_threshold:
            return normalized
        if heuristic.route != "needs_review" and heuristic.confidence >= self.auto_threshold:
            return heuristic
        if normalized.confidence < self.review_threshold:
            return self._review_result(
                envelope,
                preferred_route=preferred_route,
                reason=normalized.rationale or "classification_low_confidence",
            )
        return normalized

    def _heuristic_classify(
        self,
        envelope: HumanInputEnvelope,
        *,
        preferred_route: str | None,
    ) -> HumanInputRoutingDecision:
        parsed = _parse_metadata(envelope.content)
        request_submission_id = (
            envelope.request_submission_id
            or parsed.values.get("request_submission_id")
        )
        json_payload = _parse_json_code_block(envelope.content)
        if isinstance(json_payload, dict) and isinstance(json_payload.get("evidence_items"), list):
            evidence_items = self._normalize_evidence_items(
                json_payload.get("evidence_items", []),
                envelope=envelope,
            )
            if evidence_items:
                return HumanInputRoutingDecision(
                    route="human_curated_dataset",
                    confidence=0.99,
                    rationale="structured_json_dataset",
                    dataset_name=parsed.values.get("dataset_name") or json_payload.get("dataset_name") or "discord_human_input",
                    notes=parsed.values.get("notes", ""),
                    evidence_items=evidence_items,
                    request_submission_id=request_submission_id,
                )

        body = parsed.body or envelope.content.strip()
        entities = _parse_list(
            parsed.values.get("entity_candidates")
            or parsed.values.get("entities")
            or parsed.values.get("entity")
        )
        source_refs = _dedupe_strings(
            [
                envelope.message_url,
                *envelope.attachment_urls,
                *_parse_list(parsed.values.get("source_refs")),
            ]
        )
        title = parsed.values.get("title") or _summarize(body, 140) or "Human input"

        if preferred_route == "human_curated_dataset" and envelope.attachment_urls:
            return self._review_result(
                envelope,
                preferred_route=preferred_route,
                reason="dataset_requested_but_attachment_only",
            )

        note_signals = any(
            parsed.values.get(key)
            for key in (
                "why_now",
                "beneficiary_hints",
                "research_questions",
                "supporting_points",
                "study_type",
            )
        )
        long_body = len(body) >= 280
        if preferred_route == "human_analyst_note" or note_signals or long_body:
            return HumanInputRoutingDecision(
                route="human_analyst_note",
                confidence=0.84 if preferred_route == "human_analyst_note" else 0.8,
                rationale="structured_note_heuristic",
                title=title,
                observation=body,
                entities=entities,
                why_now=parsed.values.get("why_now", ""),
                geo=parsed.values.get("geo", "global"),
                beneficiary_hints=_parse_list(parsed.values.get("beneficiary_hints")),
                research_questions=_parse_list(parsed.values.get("research_questions")),
                source_refs=source_refs,
                supporting_points=_parse_list(parsed.values.get("supporting_points")),
                study_type=parsed.values.get("study_type", "analysis_note"),
                request_submission_id=request_submission_id,
            )

        if body or entities or envelope.attachment_urls:
            return HumanInputRoutingDecision(
                route="manual_observation",
                confidence=0.78,
                rationale="default_observation_heuristic",
                title=title,
                entities=entities,
                signal_type=parsed.values.get("signal_type", "manual"),
                metric_value=_parse_optional_number(parsed.values.get("metric_value")),
                metric_delta=_parse_optional_number(parsed.values.get("metric_delta")),
                rank=_parse_optional_integer(parsed.values.get("rank")),
                geo=parsed.values.get("geo", "global"),
                url=parsed.values.get("url") or envelope.attachment_urls[:1] and envelope.attachment_urls[0] or envelope.message_url,
                trust_score=_parse_optional_number(parsed.values.get("trust_score")) or 0.9,
                freshness_ttl=_parse_optional_integer(parsed.values.get("freshness_ttl")) or 86400,
                observation=body,
                request_submission_id=request_submission_id,
            )

        return self._review_result(envelope, preferred_route=preferred_route, reason="empty_message")

    def _normalize_decision(
        self,
        decision: HumanInputRoutingDecision,
        *,
        envelope: HumanInputEnvelope,
        fallback: HumanInputRoutingDecision,
        preferred_route: str | None,
    ) -> HumanInputRoutingDecision:
        route = decision.route
        confidence = max(0.0, min(1.0, float(decision.confidence or 0.0)))
        request_submission_id = decision.request_submission_id or envelope.request_submission_id
        if route == "human_curated_dataset":
            evidence_items = self._normalize_evidence_items(decision.evidence_items, envelope=envelope)
            if not evidence_items:
                return fallback
            return decision.model_copy(
                update={
                    "confidence": confidence,
                    "request_submission_id": request_submission_id,
                    "evidence_items": evidence_items,
                    "dataset_name": decision.dataset_name or "discord_human_input",
                },
                deep=True,
            )

        if route == "needs_review" or confidence < self.review_threshold:
            return self._review_result(
                envelope,
                preferred_route=preferred_route,
                reason=decision.rationale or "classification_low_confidence",
            )

        title = decision.title or fallback.title or _summarize(decision.observation or envelope.content, 140) or "Human input"
        url = decision.url or envelope.attachment_urls[:1] and envelope.attachment_urls[0] or envelope.message_url
        source_refs = _dedupe_strings(
            [
                *decision.source_refs,
                envelope.message_url,
                *envelope.attachment_urls,
            ]
        )
        return decision.model_copy(
            update={
                "confidence": confidence,
                "title": title,
                "entities": _dedupe_strings(decision.entities or fallback.entities),
                "url": url,
                "source_refs": source_refs,
                "request_submission_id": request_submission_id,
                "freshness_ttl": decision.freshness_ttl or 86400,
                "trust_score": decision.trust_score or 0.9,
            },
            deep=True,
        )

    def _normalize_evidence_items(
        self,
        items: list[dict[str, Any]] | list[Any],
        *,
        envelope: HumanInputEnvelope,
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for index, raw_item in enumerate(items, start=1):
            if not isinstance(raw_item, dict):
                continue
            if not _REQUIRED_DATASET_FIELDS.issubset(raw_item.keys()):
                continue
            normalized.append(
                {
                    "evidence_id": str(raw_item.get("evidence_id") or f"{envelope.message_id or 'human'}-{index}"),
                    "entity_candidates": [str(item).strip() for item in raw_item.get("entity_candidates", []) if str(item).strip()],
                    "signal_type": str(raw_item.get("signal_type", "human_data_source")).strip(),
                    "title_or_label": str(raw_item.get("title_or_label", "Human data source")).strip(),
                    "metric_value": _coerce_optional_number(raw_item.get("metric_value")),
                    "metric_delta": _coerce_optional_number(raw_item.get("metric_delta")),
                    "rank": _coerce_optional_integer(raw_item.get("rank")),
                    "geo": str(raw_item.get("geo", "global")).strip() or "global",
                    "url_or_ref": str(raw_item.get("url_or_ref") or envelope.attachment_urls[:1] and envelope.attachment_urls[0] or envelope.message_url),
                    "trust_score": _coerce_optional_number(raw_item.get("trust_score")) or 0.9,
                    "freshness_ttl": _coerce_optional_integer(raw_item.get("freshness_ttl")) or 86400,
                }
            )
        return normalized

    def _build_prompt(
        self,
        envelope: HumanInputEnvelope,
        heuristic: HumanInputRoutingDecision,
        *,
        preferred_route: str | None,
    ) -> str:
        content = envelope.content.strip()
        if len(content) > self.max_input_chars:
            content = content[: self.max_input_chars - 3].rstrip() + "..."
        return "\n".join(
            [
                _SYSTEM_INSTRUCTIONS,
                f"Preferred route: {preferred_route or 'none'}",
                f"Heuristic suggestion: {heuristic.route} ({heuristic.confidence})",
                f"Producer: {envelope.producer_ref or 'unknown'}",
                f"Message URL: {envelope.message_url or '(none)'}",
                "Attachment URLs: " + ", ".join(envelope.attachment_urls or ["(none)"]),
                f"Request submission id: {envelope.request_submission_id or '(none)'}",
                "Message content:",
                content or "(empty)",
            ]
        )

    def _review_result(
        self,
        envelope: HumanInputEnvelope,
        *,
        preferred_route: str | None,
        reason: str,
    ) -> HumanInputRoutingDecision:
        route_hint = preferred_route or "manual_observation / human_analyst_note / human_curated_dataset"
        return HumanInputRoutingDecision(
            route="needs_review",
            confidence=0.0,
            rationale=reason,
            request_submission_id=envelope.request_submission_id,
            user_message=(
                "입력 형식이 모호합니다. "
                f"원하는 형태를 더 명확히 적어 주세요. route hint: {route_hint}. "
                "예: observation은 짧은 관측, analyst note는 why_now/supporting_points 포함, "
                "dataset은 JSON code block with evidence_items."
            ),
        )


def _parse_metadata(content: str) -> _ParsedMetadata:
    lines = content.splitlines()
    values: dict[str, str] = {}
    body_lines: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        match = re.match(r"^([a-z_]+)\s*:\s*(.+)$", line, flags=re.IGNORECASE)
        if match:
            key = match.group(1).lower()
            value = match.group(2).strip()
            if key in _KNOWN_METADATA_KEYS:
                values[key] = value
                continue
        body_lines.append(raw_line)

    body = "\n".join(body_lines).strip()
    body = re.sub(r"```json[\s\S]*?```", "", body, flags=re.IGNORECASE).strip()
    return _ParsedMetadata(values=values, body=body)


def _parse_json_code_block(content: str) -> Any | None:
    match = re.search(r"```json\s*([\s\S]*?)```", content, flags=re.IGNORECASE)
    if not match:
        return None
    try:
        return json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        return None


def _parse_list(value: str | None) -> list[str]:
    if not value:
        return []
    return _dedupe_strings(
        [
            item.strip()
            for item in re.split(r"[,;|]", value)
            if item.strip()
        ]
    )


def _dedupe_strings(values: list[str]) -> list[str]:
    deduped: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in deduped:
            deduped.append(normalized)
    return deduped


def _summarize(value: str, max_length: int) -> str | None:
    normalized = re.sub(r"\s+", " ", value or "").strip()
    if not normalized:
        return None
    if len(normalized) <= max_length:
        return normalized
    return normalized[: max_length - 3].rstrip() + "..."


def _parse_optional_number(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed == parsed else None


def _parse_optional_integer(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _coerce_optional_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _coerce_optional_integer(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
