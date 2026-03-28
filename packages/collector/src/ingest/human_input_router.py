"""Route free-form human messages into structured collector ingest payloads."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..analysis.session import SessionPool
from .human_input_models import (
    ActionRequest,
    AssetCandidate,
    HumanInputEnvelope,
    HumanInputRoutingDecision,
    InvestmentNoteDraft,
)

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
    "ticker",
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
Choose route from manual_observation, human_analyst_note, human_curated_dataset, needs_review, none.
Use human_curated_dataset only if the message contains structured data that can be normalized immediately.
If the input is analytical, comparative, or explains why demand is changing, prefer human_analyst_note.
If the input is a watchlist command with no collector evidence to store, use route none.
Use needs_review when the message is too incomplete to classify safely.
Keep confidence between 0 and 1.
Set input_kind from observation, study_note, dataset, command, mixed.
Return action_requests only for low-risk stock watchlist add/remove actions when the stock is identified confidently.
Use handoff_targets ["investment_module"] when the input contains free-form study or research that should be archived for later investment use.
Asset candidates should include stock, real_estate, topic, or other.
If a free-form study is useful for later investment research, include an investment_note object.
For human_curated_dataset, evidence_items must be a JSON array of evidence objects with keys:
evidence_id, entity_candidates, signal_type, title_or_label, metric_value, metric_delta, rank, geo, url_or_ref, trust_score, freshness_ttl.
For other routes, evidence_items should be an empty array.
Return keys:
route, collector_route, input_kind, confidence, rationale, title, entities, signal_type, metric_value, metric_delta, rank, geo, trust_score, freshness_ttl, observation, why_now, beneficiary_hints, research_questions, source_refs, supporting_points, study_type, dataset_name, notes, evidence_items, request_submission_id, user_message, action_requests, handoff_targets, asset_candidates, investment_note."""
_WATCHLIST_TERMS = ("watchlist", "와치리스트", "관심종목", "관심 종목")
_ADD_TERMS = ("add", "추가", "등록", "넣어")
_REMOVE_TERMS = ("remove", "삭제", "제거", "빼")
_REAL_ESTATE_TERMS = ("부동산", "아파트", "오피스텔", "재건축")
_STUDY_NOTE_TERMS = (
    "study",
    "스터디",
    "invest",
    "투자",
    "관점",
    "가설",
    "thesis",
    "why now",
    "beneficiary",
    "고객사",
    "수급",
    "공급",
    "금리",
    "rollout",
    "seat",
    "hbm",
)
_KNOWN_STOCK_ALIASES: dict[str, tuple[str, str]] = {
    "005930": ("005930", "삼성전자"),
    "samsung electronics": ("005930", "삼성전자"),
    "삼성전자": ("005930", "삼성전자"),
    "삼성 전자": ("005930", "삼성전자"),
    "000660": ("000660", "SK하이닉스"),
    "sk hynix": ("000660", "SK하이닉스"),
    "sk하이닉스": ("000660", "SK하이닉스"),
}


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
            if heuristic.route != "needs_review" and heuristic.confidence >= self.auto_threshold:
                return heuristic
            return normalized
        if normalized.route == "none":
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
                    collector_route="human_curated_dataset",
                    input_kind="dataset",
                    confidence=0.99,
                    rationale="structured_json_dataset",
                    dataset_name=parsed.values.get("dataset_name") or json_payload.get("dataset_name") or "discord_human_input",
                    notes=parsed.values.get("notes", ""),
                    evidence_items=evidence_items,
                    request_submission_id=request_submission_id,
                    source_refs=_dedupe_strings([envelope.message_url, *envelope.attachment_urls]),
                    user_message="구조화된 데이터 입력으로 인식해 collector evidence로 적재합니다.",
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
        beneficiary_hints = _parse_list(parsed.values.get("beneficiary_hints"))
        research_questions = _parse_list(parsed.values.get("research_questions"))
        supporting_points = _parse_list(parsed.values.get("supporting_points"))
        stock_hint = parsed.values.get("ticker")
        asset_candidates = _extract_asset_candidates(
            envelope.content,
            title=title,
            raw_entities=entities,
            stock_hint=stock_hint,
        )
        action_requests = _detect_action_requests(envelope.content, asset_candidates)
        action_confidence = max((item.confidence for item in action_requests), default=0.0)

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
        normalized_body = _normalize_text(body).casefold()
        study_keyword_hits = sum(
            1 for term in _STUDY_NOTE_TERMS if term.casefold() in normalized_body
        )
        long_body = len(body) >= 140
        if any(term in body for term in _REAL_ESTATE_TERMS) and len(body) >= 60:
            note_signals = True
        if study_keyword_hits >= 2 and len(body) >= 70:
            note_signals = True
        if action_requests and study_keyword_hits >= 1 and len(body) >= 30:
            note_signals = True
        has_note_content = preferred_route == "human_analyst_note" or note_signals or long_body
        input_kind = (
            "mixed"
            if action_requests and has_note_content
            else "command"
            if action_requests
            else "study_note"
            if has_note_content
            else "observation"
        )
        investment_note = (
            _build_investment_note(
                title=title,
                body=body,
                source_refs=source_refs,
                asset_candidates=asset_candidates,
                why_now=parsed.values.get("why_now", ""),
                beneficiary_hints=beneficiary_hints,
                research_questions=research_questions,
                supporting_points=supporting_points,
            )
            if input_kind in {"study_note", "mixed"}
            else None
        )
        handoff_targets = ["investment_module"] if investment_note is not None else []
        user_message = _build_user_message(
            input_kind=input_kind,
            collector_route="human_analyst_note" if has_note_content else "none" if action_requests else "manual_observation",
            action_requests=action_requests,
            handoff_targets=handoff_targets,
        )

        if action_requests and not has_note_content:
            return HumanInputRoutingDecision(
                route="none",
                collector_route="none",
                input_kind="command",
                confidence=max(0.8, action_confidence),
                rationale="watchlist_command_heuristic",
                title=title,
                observation=body,
                entities=entities,
                source_refs=source_refs,
                request_submission_id=request_submission_id,
                action_requests=action_requests,
                asset_candidates=asset_candidates,
                user_message=user_message,
            )

        if has_note_content:
            return HumanInputRoutingDecision(
                route="human_analyst_note",
                collector_route="human_analyst_note",
                input_kind=input_kind,
                confidence=max(0.84 if preferred_route == "human_analyst_note" else 0.8, action_confidence),
                rationale="structured_note_heuristic",
                title=title,
                observation=body,
                entities=entities,
                why_now=parsed.values.get("why_now", ""),
                geo=parsed.values.get("geo", "global"),
                beneficiary_hints=beneficiary_hints,
                research_questions=research_questions,
                source_refs=source_refs,
                supporting_points=supporting_points,
                study_type=parsed.values.get("study_type", "analysis_note"),
                request_submission_id=request_submission_id,
                action_requests=action_requests,
                handoff_targets=handoff_targets,
                asset_candidates=asset_candidates,
                investment_note=investment_note,
                user_message=user_message,
            )

        if body or entities or envelope.attachment_urls:
            return HumanInputRoutingDecision(
                route="manual_observation",
                collector_route="manual_observation",
                input_kind="observation",
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
                asset_candidates=asset_candidates,
                user_message="관측 입력으로 인식해 collector evidence로 저장합니다.",
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

        if route == "none":
            return decision.model_copy(
                update={
                    "collector_route": "none",
                    "input_kind": decision.input_kind if decision.input_kind != "observation" else fallback.input_kind,
                    "confidence": confidence,
                    "title": decision.title or fallback.title or _summarize(envelope.content, 140) or "Human input",
                    "entities": _dedupe_strings(decision.entities or fallback.entities),
                    "source_refs": _dedupe_strings(
                        [
                            *decision.source_refs,
                            envelope.message_url,
                            *envelope.attachment_urls,
                        ]
                    ),
                    "request_submission_id": request_submission_id,
                    "action_requests": decision.action_requests or fallback.action_requests,
                    "asset_candidates": decision.asset_candidates or fallback.asset_candidates,
                    "handoff_targets": decision.handoff_targets or fallback.handoff_targets,
                    "investment_note": decision.investment_note or fallback.investment_note,
                    "user_message": decision.user_message or fallback.user_message,
                },
                deep=True,
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
                "collector_route": route,
                "input_kind": decision.input_kind if decision.input_kind != "observation" else fallback.input_kind,
                "title": title,
                "entities": _dedupe_strings(decision.entities or fallback.entities),
                "url": url,
                "source_refs": source_refs,
                "request_submission_id": request_submission_id,
                "freshness_ttl": decision.freshness_ttl or 86400,
                "trust_score": decision.trust_score or 0.9,
                "action_requests": decision.action_requests or fallback.action_requests,
                "handoff_targets": decision.handoff_targets or fallback.handoff_targets,
                "asset_candidates": decision.asset_candidates or fallback.asset_candidates,
                "investment_note": decision.investment_note or fallback.investment_note,
                "user_message": decision.user_message or fallback.user_message,
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
            collector_route="needs_review",
            input_kind="observation",
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


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _contains_any(value: str, candidates: tuple[str, ...]) -> bool:
    lowered = _normalize_text(value).casefold()
    return any(candidate.casefold() in lowered for candidate in candidates)


def _stock_candidate(ticker: str, display_name: str, rationale: str, confidence: float) -> AssetCandidate:
    return AssetCandidate(
        asset_type="stock",
        asset_key=f"stock:{ticker}",
        display_name=display_name,
        ticker=ticker,
        market="KRX",
        confidence=confidence,
        rationale=rationale,
    )


def _extract_asset_candidates(
    content: str,
    *,
    title: str,
    raw_entities: list[str],
    stock_hint: str | None,
) -> list[AssetCandidate]:
    candidates: list[AssetCandidate] = []
    search_space = [content, title, *raw_entities]
    normalized_blobs = [_normalize_text(item) for item in search_space if item.strip()]

    if stock_hint and re.fullmatch(r"\d{6}", stock_hint.strip()):
        ticker = stock_hint.strip()
        display_name = next(
            (name for known_ticker, name in _KNOWN_STOCK_ALIASES.values() if known_ticker == ticker),
            ticker,
        )
        candidates.append(_stock_candidate(ticker, display_name, "explicit_ticker_hint", 0.98))

    for blob in normalized_blobs:
        for alias, (ticker, display_name) in _KNOWN_STOCK_ALIASES.items():
            if blob.casefold() == alias.casefold() or alias.casefold() in blob.casefold():
                candidates.append(_stock_candidate(ticker, display_name, f"matched_alias:{alias}", 0.92))
        for match in re.findall(r"\b\d{6}\b", blob):
            display_name = next(
                (name for known_ticker, name in _KNOWN_STOCK_ALIASES.values() if known_ticker == match),
                match,
            )
            candidates.append(_stock_candidate(match, display_name, "matched_ticker_literal", 0.95))

    if not candidates and any(term in content for term in _REAL_ESTATE_TERMS):
        candidates.append(
            AssetCandidate(
                asset_type="real_estate",
                asset_key=None,
                display_name=title,
                confidence=0.6,
                rationale="real_estate_keyword_detected",
            )
        )

    if not candidates and raw_entities:
        candidates.extend(
            AssetCandidate(
                asset_type="topic",
                asset_key=None,
                display_name=entity,
                confidence=0.55,
                rationale="entity_candidate_hint",
            )
            for entity in raw_entities
        )

    deduped: list[AssetCandidate] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        dedupe_key = (candidate.asset_type, candidate.asset_key or candidate.display_name.casefold())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        deduped.append(candidate)
    return deduped


def _detect_action_requests(content: str, asset_candidates: list[AssetCandidate]) -> list[ActionRequest]:
    lowered = _normalize_text(content).casefold()
    if not _contains_any(lowered, _WATCHLIST_TERMS):
        return []

    wants_add = _contains_any(lowered, _ADD_TERMS)
    wants_remove = _contains_any(lowered, _REMOVE_TERMS)
    if wants_add == wants_remove:
        return []

    action = "watchlist_add" if wants_add else "watchlist_remove"
    requests: list[ActionRequest] = []
    for candidate in asset_candidates:
        if candidate.asset_type != "stock" or not candidate.asset_key or not candidate.ticker:
            continue
        requests.append(
            ActionRequest(
                action=action,
                asset_key=candidate.asset_key,
                ticker=candidate.ticker,
                display_name=candidate.display_name,
                confidence=max(candidate.confidence, 0.9),
                rationale="watchlist_command_detected",
            )
        )
    return requests


def _build_investment_note(
    *,
    title: str,
    body: str,
    source_refs: list[str],
    asset_candidates: list[AssetCandidate],
    why_now: str,
    beneficiary_hints: list[str],
    research_questions: list[str],
    supporting_points: list[str],
) -> InvestmentNoteDraft:
    summary = _summarize(body or title, 220) or title
    structured_summary = supporting_points or ([summary] if summary else [])
    open_questions = research_questions or (
        ["Which investable beneficiary captures this demand earliest?"]
        if asset_candidates
        else ["Which asset or beneficiary should this note attach to?"]
    )
    status = "resolved" if any(candidate.asset_key for candidate in asset_candidates) else "unresolved"
    return InvestmentNoteDraft(
        title=title,
        summary=summary,
        structured_summary=structured_summary,
        why_it_might_matter=why_now or summary,
        beneficiary_hints=beneficiary_hints,
        open_questions=open_questions,
        references=source_refs,
        asset_candidates=asset_candidates,
        status=status,
    )


def _build_user_message(
    *,
    input_kind: str,
    collector_route: str,
    action_requests: list[ActionRequest],
    handoff_targets: list[str],
) -> str:
    if input_kind == "command" and action_requests:
        labels = ", ".join(f"{item.display_name} ({item.ticker})" for item in action_requests)
        return f"watchlist 명령으로 해석했습니다: {labels}"
    if input_kind in {"study_note", "mixed"} and "investment_module" in handoff_targets:
        return "자유 형식 스터디 입력으로 해석해 collector note와 투자모듈 handoff를 함께 준비합니다."
    if collector_route == "manual_observation":
        return "자유 형식 관측 입력으로 해석해 collector evidence로 저장합니다."
    return "자유 형식 입력을 구조화해 처리합니다."
