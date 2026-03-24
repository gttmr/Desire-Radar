import os

import pytest

from src.analysis.benchmark import (
    build_default_context_packer,
    build_default_session_pool,
    build_synthetic_cases,
    run_execution_benchmark,
)
from src.analysis.context_packer import ContextPacker
from src.analysis.session import CliSession, SessionPool


def _mock_session_pool(mode: str) -> SessionPool:
    initial_args = "exec --skip-git-repo-check --ephemeral -C /tmp -s read-only --json"
    if mode == "resume":
        initial_args = "exec --skip-git-repo-check -C /tmp -s read-only --json"
    return SessionPool(
        exec_path="mock",
        provider="codex",
        initial_args=initial_args,
        resume_args="exec resume --skip-git-repo-check --json",
        model="cheap-model",
        model_flag="-m",
        timeout_seconds=5,
        memory_char_budget=1500,
        memory_entry_count=3,
        memory_entry_char_budget=160,
        max_idle_minutes=20,
        max_turns=5,
        max_uncached_input_tokens=20000,
        parse_error_snippet_chars=200,
        use_stdin=True,
    )


@pytest.mark.asyncio
async def test_benchmark_prefers_batch_with_mock_provider():
    report = await run_execution_benchmark(
        context_packer=ContextPacker(
            char_budget=3000,
            batch_char_budget=5000,
            max_evidence=3,
        ),
        session_pool_factory=_mock_session_pool,
        cases=build_synthetic_cases(),
    )

    assert report["recommended_mode"] == "batch"
    assert set(report["results"]) == {"fresh", "resume", "batch"}
    assert (
        report["results"]["batch"]["uncached_input_tokens_per_candidate"]
        < report["results"]["fresh"]["uncached_input_tokens_per_candidate"]
    )


def test_codex_invocation_strips_ephemeral_for_resume():
    session = CliSession(
        domain="trend-analysis",
        provider="codex",
        exec_path="codex",
        initial_args="exec --skip-git-repo-check --ephemeral --json",
        resume_args="exec resume --skip-git-repo-check --json",
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

    initial_args, _ = session._build_codex_invocation("{}", execution_mode="resume")

    assert "--ephemeral" not in initial_args
    assert initial_args[-1] == "-"


@pytest.mark.asyncio
@pytest.mark.skipif(os.environ.get("RUN_REAL_CODEX_SMOKE") != "1", reason="opt-in real codex benchmark")
async def test_real_codex_benchmark_prefers_batch():
    report = await run_execution_benchmark(
        context_packer=build_default_context_packer(),
        session_pool_factory=build_default_session_pool,
        cases=build_synthetic_cases(),
    )

    assert set(report["results"]) == {"fresh", "resume", "batch"}
    assert (
        report["results"]["batch"]["uncached_input_tokens_per_candidate"]
        < report["results"]["fresh"]["uncached_input_tokens_per_candidate"]
    )
