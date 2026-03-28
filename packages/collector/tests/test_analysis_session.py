import json
import os

from src.analysis.models import PackedContext
from src.analysis.session import CliSession, SessionPool


def _session() -> CliSession:
    return CliSession(
        domain="trend-analysis",
        provider="codex",
        exec_path="mock",
        initial_args="",
        resume_args="",
        model="cheap-model",
        model_flag="-m",
        timeout_seconds=5,
        memory_char_budget=1000,
        memory_entry_count=3,
        memory_entry_char_budget=160,
        max_idle_minutes=20,
        max_turns=5,
        max_uncached_input_tokens=20000,
        parse_error_snippet_chars=200,
        use_stdin=True,
    )


def test_session_parses_codex_jsonl_single_response():
    session = _session()
    payload = "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "type": "agent_message",
                        "text": json.dumps(
                            {
                                "summary": "ok",
                                "confidence": 0.8,
                                "desire_types": ["호기심"],
                                "behavioral_signals": [],
                                "demographic_hints": [],
                                "avg_intensity": 0.4,
                                "open_questions": [],
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 40,
                        "output_tokens": 12,
                    },
                }
            ),
        ]
    )

    responses, usage, thread_id = session._parse_codex_jsonl(payload, "single")

    assert thread_id == "thread-1"
    assert len(responses) == 1
    assert responses[0].summary == "ok"
    assert usage.input_tokens == 100
    assert usage.cached_input_tokens == 40
    assert usage.uncached_input_tokens == 60


def test_session_parses_batch_response_objects():
    session = _session()
    raw = json.dumps(
        [
            {"entity": "ChatGPT", "summary": "a", "confidence": 0.6},
            {"entity": "Cursor", "summary": "b", "confidence": 0.7},
        ]
    )

    responses = session._parse_response_payload(raw, "batch")

    assert [item.entity for item in responses] == ["ChatGPT", "Cursor"]
    assert [item.summary for item in responses] == ["a", "b"]


def test_session_extracts_generic_json_payload_from_codex_jsonl():
    session = _session()
    payload = "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": "thread-router"}),
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "type": "agent_message",
                        "text": json.dumps(
                            {
                                "route": "human_analyst_note",
                                "confidence": 0.88,
                                "title": "Field study",
                            }
                        ),
                    },
                }
            ),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 60,
                        "cached_input_tokens": 10,
                        "output_tokens": 15,
                    },
                }
            ),
        ]
    )

    message_text, usage, thread_id = session._extract_codex_message(payload)
    parsed = session._parse_json_payload(message_text)

    assert thread_id == "thread-router"
    assert isinstance(parsed, dict)
    assert parsed["route"] == "human_analyst_note"
    assert usage.uncached_input_tokens == 50


def test_session_pool_normalizes_relative_workdir_root_to_absolute(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    pool = SessionPool(
        exec_path="mock",
        provider="codex",
        initial_args="exec --json",
        resume_args="exec resume --json",
        model="gpt-5.4-mini",
        model_flag="-m",
        timeout_seconds=5,
        memory_char_budget=1000,
        memory_entry_count=3,
        memory_entry_char_budget=160,
        max_idle_minutes=20,
        max_turns=5,
        max_uncached_input_tokens=20000,
        parse_error_snippet_chars=200,
        use_stdin=True,
        session_workdir_root="data/llm-session-workdirs",
    )

    session = pool._new_session("source-agent:reddit_mentions")

    assert os.path.isabs(session.working_dir)
    assert session.working_dir.startswith(str(tmp_path))
