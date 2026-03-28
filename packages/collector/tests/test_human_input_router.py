import pytest

from src.ingest.human_input_models import HumanInputEnvelope
from src.ingest.human_input_router import HumanInputRouter


def _router() -> HumanInputRouter:
    return HumanInputRouter(
        session_pool=None,
        enabled=False,
    )


def test_watchlist_command_is_structured_without_collector_route():
    router = _router()

    decision = router._heuristic_classify(  # noqa: SLF001
        HumanInputEnvelope(content="삼성전자 와치리스트에 추가해"),
        preferred_route=None,
    )

    assert decision.route == "none"
    assert decision.collector_route == "none"
    assert decision.input_kind == "command"
    assert decision.action_requests
    assert decision.action_requests[0].action == "watchlist_add"
    assert decision.action_requests[0].ticker == "005930"
    assert decision.asset_candidates[0].asset_key == "stock:005930"


def test_free_form_study_note_generates_investment_handoff():
    router = _router()

    decision = router._heuristic_classify(  # noqa: SLF001
        HumanInputEnvelope(
            content=(
                "삼성전자 쪽을 이번 달 내내 다시 보고 있다. "
                "HBM과 패키징 투자, 그리고 고객사 확보 속도 때문에 메모리 사이클보다 "
                "상향 여지가 더 클 수 있다고 본다. why_now: 고객사 수요가 빨라졌다"
            )
        ),
        preferred_route=None,
    )

    assert decision.route == "human_analyst_note"
    assert decision.collector_route == "human_analyst_note"
    assert decision.input_kind == "study_note"
    assert decision.handoff_targets == ["investment_module"]
    assert decision.investment_note is not None
    assert decision.investment_note.title
    assert decision.asset_candidates
    assert decision.asset_candidates[0].asset_type == "stock"


def test_mixed_input_keeps_watchlist_action_and_investment_note():
    router = _router()

    decision = router._heuristic_classify(  # noqa: SLF001
        HumanInputEnvelope(
            content=(
                "삼성전자 와치리스트에 추가해. "
                "그리고 이번 주 스터디 내용을 남긴다. HBM 공급과 고객사 증설 속도가 예상보다 빠르다. "
                "supporting_points: HBM demand remains tight; AI server mix is rising"
            )
        ),
        preferred_route=None,
    )

    assert decision.route == "human_analyst_note"
    assert decision.input_kind == "mixed"
    assert decision.action_requests
    assert decision.handoff_targets == ["investment_module"]
    assert decision.investment_note is not None


def test_real_estate_note_does_not_auto_create_watchlist_action():
    router = _router()

    decision = router._heuristic_classify(  # noqa: SLF001
        HumanInputEnvelope(
            content=(
                "서울 재건축 쪽 수급을 길게 보고 있다. "
                "부동산 관점에서 강남권 아파트 공급 제약이 계속되고 있고, "
                "금리 하락 시 거래량 회복 가능성이 있다."
            )
        ),
        preferred_route=None,
    )

    assert decision.route == "human_analyst_note"
    assert decision.action_requests == []
    assert decision.handoff_targets == ["investment_module"]
    assert decision.investment_note is not None
    assert decision.investment_note.status == "unresolved"
    assert decision.asset_candidates[0].asset_type == "real_estate"
