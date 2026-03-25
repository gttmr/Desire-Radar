"""Benchmark helpers for collector analysis execution strategies."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Sequence

from ..config import (
    LLM_BATCH_CHAR_BUDGET,
    LLM_BATCH_INCLUDE_PREVIOUS_ANALYSIS,
    LLM_CLI_ARGS,
    LLM_CLI_CONTINUE_FLAG,
    LLM_CLI_EXEC_PATH,
    LLM_CLI_INITIAL_ARGS,
    LLM_CLI_MODEL_FLAG,
    LLM_CLI_PROMPT_FLAG,
    LLM_CLI_PROMPT_MODE,
    LLM_CLI_PROVIDER,
    LLM_CLI_RESUME_ARGS,
    LLM_CLI_USE_STDIN,
    LLM_CONTEXT_CHAR_BUDGET,
    LLM_DEFAULT_MODEL,
    LLM_MAX_EVIDENCE_PER_TASK,
    LLM_PARSE_ERROR_SNIPPET_CHARS,
    LLM_PROMPT_FORMAT,
    LLM_PROMPT_INCLUDE_EVIDENCE_IDS,
    LLM_PROMPT_INCLUDE_GEO,
    LLM_PROMPT_INCLUDE_METRICS,
    LLM_PROMPT_INCLUDE_PREVIOUS_ANALYSIS,
    LLM_PROMPT_INCLUDE_URLS,
    LLM_PROMPT_TITLE_MAX_CHARS,
    LLM_SESSION_MAX_IDLE_MINUTES,
    LLM_SESSION_MAX_TURNS,
    LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS,
    LLM_SESSION_MEMORY_CHAR_BUDGET,
    LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET,
    LLM_SESSION_MEMORY_ENTRY_COUNT,
    LLM_TIMEOUT_SECONDS,
)
from ..normalizer.evidence_schema import Evidence
from .context_packer import ContextPacker
from .models import AnalysisProjection, ExecutionUsage
from .session import SessionPool


@dataclass(slots=True)
class BenchmarkCase:
    entity: str
    candidate: object
    evidences: list[Evidence]
    projection: AnalysisProjection | None = None


def build_synthetic_cases() -> list[BenchmarkCase]:
    now = datetime.now(timezone.utc)
    return [
        _make_case(
            entity="ChatGPT",
            sources=["manual_observation", "google_trends", "reddit_mentions"],
            emergence_score=8.6,
            velocity_score=4.9,
            evidences=[
                _evidence(
                    entity="ChatGPT",
                    evidence_id="bench-chatgpt-manual",
                    source="manual_observation",
                    source_tier=1,
                    collected_at=now - timedelta(minutes=15),
                    title="대학생과 직장인이 ChatGPT로 보고서 자동화 팁을 공유하고 있다",
                ),
                _evidence(
                    entity="ChatGPT",
                    evidence_id="bench-chatgpt-trends",
                    source="google_trends",
                    source_tier=2,
                    collected_at=now - timedelta(minutes=40),
                    title="ChatGPT productivity prompts search interest climbs this week",
                    metric_value=78,
                    metric_delta=14.2,
                ),
                _evidence(
                    entity="ChatGPT",
                    evidence_id="bench-chatgpt-reddit",
                    source="reddit_mentions",
                    source_tier=2,
                    collected_at=now - timedelta(minutes=20),
                    title="Reddit threads compare ChatGPT workflows for coding and writing",
                    metric_value=61,
                ),
            ],
            projection_summary="Earlier analysis linked demand to research and office productivity.",
        ),
        _make_case(
            entity="Cursor",
            sources=["manual_observation", "reddit_mentions", "github_trending"],
            emergence_score=7.8,
            velocity_score=4.2,
            evidences=[
                _evidence(
                    entity="Cursor",
                    evidence_id="bench-cursor-manual",
                    source="manual_observation",
                    source_tier=1,
                    collected_at=now - timedelta(minutes=12),
                    title="개발자들이 Cursor와 Codex를 같이 쓰는 패턴을 공유하고 있다",
                ),
                _evidence(
                    entity="Cursor",
                    evidence_id="bench-cursor-reddit",
                    source="reddit_mentions",
                    source_tier=2,
                    collected_at=now - timedelta(minutes=35),
                    title="Cursor prompt engineering templates spread across programming communities",
                    metric_value=44,
                    metric_delta=9.5,
                ),
                _evidence(
                    entity="Cursor",
                    evidence_id="bench-cursor-github",
                    source="github_trending",
                    source_tier=2,
                    collected_at=now - timedelta(minutes=55),
                    title="Repositories describing Cursor setup and rules are appearing on GitHub",
                    metric_value=19,
                    rank=7,
                ),
            ],
            projection_summary="Previous run saw early adopter interest among software engineers.",
        ),
        _make_case(
            entity="Perplexity",
            sources=["manual_observation", "google_trends", "app_store_top_charts"],
            emergence_score=7.3,
            velocity_score=3.7,
            evidences=[
                _evidence(
                    entity="Perplexity",
                    evidence_id="bench-perplexity-manual",
                    source="manual_observation",
                    source_tier=1,
                    collected_at=now - timedelta(minutes=18),
                    title="학생들이 Perplexity를 시험기간 리서치 도구로 추천하고 있다",
                ),
                _evidence(
                    entity="Perplexity",
                    evidence_id="bench-perplexity-trends",
                    source="google_trends",
                    source_tier=2,
                    collected_at=now - timedelta(minutes=50),
                    title="Perplexity ai research tool queries are accelerating in KR and US",
                    metric_value=53,
                    metric_delta=8.0,
                ),
                _evidence(
                    entity="Perplexity",
                    evidence_id="bench-perplexity-appstore",
                    source="app_store_top_charts",
                    source_tier=2,
                    collected_at=now - timedelta(minutes=70),
                    title="Perplexity climbs in productivity charts after new feature rollout",
                    rank=11,
                ),
            ],
            projection_summary="Last analysis highlighted research-centric adoption signals.",
        ),
    ]


async def run_execution_benchmark(
    *,
    context_packer: ContextPacker,
    session_pool_factory: Callable[[str], SessionPool],
    cases: Sequence[BenchmarkCase] | None = None,
    modes: Sequence[str] = ("fresh", "resume", "batch"),
    domain_prefix: str = "collector-benchmark",
) -> dict:
    benchmark_cases = list(cases or build_synthetic_cases())
    if not benchmark_cases:
        raise ValueError("benchmark requires at least one case")

    results: dict[str, dict] = {}
    for mode in modes:
        session_pool = session_pool_factory(mode)
        if mode == "batch":
            report = await _run_batch_mode(
                benchmark_cases,
                context_packer=context_packer,
                session_pool=session_pool,
                domain=f"{domain_prefix}-batch",
            )
        else:
            report = await _run_sequential_mode(
                benchmark_cases,
                context_packer=context_packer,
                session_pool=session_pool,
                execution_mode=mode,
                domain=f"{domain_prefix}-{mode}",
            )
        results[mode] = report

    recommended_mode = min(
        results.values(),
        key=lambda item: (
            item["uncached_input_tokens_per_candidate"],
            item["wall_clock_ms_per_candidate"],
        ),
    )["execution_mode"]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "candidate_count": len(benchmark_cases),
        "provider": LLM_CLI_PROVIDER,
        "exec_path": LLM_CLI_EXEC_PATH,
        "model": LLM_DEFAULT_MODEL or None,
        "recommended_mode": recommended_mode,
        "results": results,
    }


def build_default_context_packer() -> ContextPacker:
    return ContextPacker(
        char_budget=LLM_CONTEXT_CHAR_BUDGET,
        max_evidence=LLM_MAX_EVIDENCE_PER_TASK,
        batch_char_budget=LLM_BATCH_CHAR_BUDGET,
        prompt_format=LLM_PROMPT_FORMAT,
        title_max_chars=LLM_PROMPT_TITLE_MAX_CHARS,
        include_previous_analysis=LLM_PROMPT_INCLUDE_PREVIOUS_ANALYSIS,
        batch_include_previous_analysis=LLM_BATCH_INCLUDE_PREVIOUS_ANALYSIS,
        include_metrics=LLM_PROMPT_INCLUDE_METRICS,
        include_urls=LLM_PROMPT_INCLUDE_URLS,
        include_geo=LLM_PROMPT_INCLUDE_GEO,
        include_evidence_ids=LLM_PROMPT_INCLUDE_EVIDENCE_IDS,
    )


def build_default_session_pool(mode: str) -> SessionPool:
    initial_args = LLM_CLI_INITIAL_ARGS
    if mode == "resume":
        initial_args = initial_args.replace("--ephemeral", "").replace("  ", " ").strip()

    return SessionPool(
        exec_path=LLM_CLI_EXEC_PATH,
        provider=LLM_CLI_PROVIDER,
        initial_args=initial_args,
        resume_args=LLM_CLI_RESUME_ARGS,
        model=LLM_DEFAULT_MODEL or None,
        model_flag=LLM_CLI_MODEL_FLAG,
        timeout_seconds=LLM_TIMEOUT_SECONDS,
        memory_char_budget=LLM_SESSION_MEMORY_CHAR_BUDGET,
        memory_entry_count=LLM_SESSION_MEMORY_ENTRY_COUNT,
        memory_entry_char_budget=LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET,
        max_idle_minutes=LLM_SESSION_MAX_IDLE_MINUTES,
        max_turns=LLM_SESSION_MAX_TURNS,
        max_uncached_input_tokens=LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS,
        parse_error_snippet_chars=LLM_PARSE_ERROR_SNIPPET_CHARS,
        use_stdin=LLM_CLI_USE_STDIN,
        base_args=LLM_CLI_ARGS,
        prompt_mode=LLM_CLI_PROMPT_MODE,
        prompt_flag=LLM_CLI_PROMPT_FLAG,
        continue_flag=LLM_CLI_CONTINUE_FLAG,
    )


async def _run_sequential_mode(
    cases: Sequence[BenchmarkCase],
    *,
    context_packer: ContextPacker,
    session_pool: SessionPool,
    execution_mode: str,
    domain: str,
) -> dict:
    usage = ExecutionUsage()
    prompt_char_count = 0
    estimated_input_tokens = 0
    total_elapsed_ms = 0.0

    for case in cases:
        packed = context_packer.pack(case.candidate, case.evidences, case.projection)
        prompt_char_count += packed.char_count
        estimated_input_tokens += packed.estimated_input_tokens
        result = await session_pool.execute(
            packed,
            domain=domain,
            execution_mode=execution_mode,
        )
        usage.input_tokens += result.usage.input_tokens
        usage.cached_input_tokens += result.usage.cached_input_tokens
        usage.output_tokens += result.usage.output_tokens
        usage.uncached_input_tokens += result.usage.uncached_input_tokens
        total_elapsed_ms += result.usage.elapsed_ms or 0.0

    return _report_for_mode(
        execution_mode=execution_mode,
        candidate_count=len(cases),
        prompt_char_count=prompt_char_count,
        estimated_input_tokens=estimated_input_tokens,
        usage=usage,
        total_elapsed_ms=total_elapsed_ms,
    )


async def _run_batch_mode(
    cases: Sequence[BenchmarkCase],
    *,
    context_packer: ContextPacker,
    session_pool: SessionPool,
    domain: str,
) -> dict:
    packed = context_packer.pack_batch(
        [(case.candidate, case.evidences, case.projection) for case in cases]
    )
    result = await session_pool.execute(
        packed,
        domain=domain,
        execution_mode="batch",
    )
    return _report_for_mode(
        execution_mode="batch",
        candidate_count=len(cases),
        prompt_char_count=packed.char_count,
        estimated_input_tokens=packed.estimated_input_tokens,
        usage=result.usage,
        total_elapsed_ms=result.usage.elapsed_ms or 0.0,
    )


def _report_for_mode(
    *,
    execution_mode: str,
    candidate_count: int,
    prompt_char_count: int,
    estimated_input_tokens: int,
    usage: ExecutionUsage,
    total_elapsed_ms: float,
) -> dict:
    return {
        "execution_mode": execution_mode,
        "candidate_count": candidate_count,
        "prompt_char_count": prompt_char_count,
        "estimated_input_tokens": estimated_input_tokens,
        "total_input_tokens": usage.input_tokens,
        "total_cached_input_tokens": usage.cached_input_tokens,
        "total_output_tokens": usage.output_tokens,
        "total_uncached_input_tokens": usage.uncached_input_tokens,
        "uncached_input_tokens_per_candidate": round(usage.uncached_input_tokens / candidate_count, 1),
        "wall_clock_ms": round(total_elapsed_ms, 1),
        "wall_clock_ms_per_candidate": round(total_elapsed_ms / candidate_count, 1),
    }


def _make_case(
    *,
    entity: str,
    sources: list[str],
    emergence_score: float,
    velocity_score: float,
    evidences: list[Evidence],
    projection_summary: str,
) -> BenchmarkCase:
    candidate = SimpleNamespace(
        entity=entity,
        status="emerging",
        emergence_score=emergence_score,
        velocity_score=velocity_score,
        source_count=len(sources),
        evidence_ids=[item.evidence_id for item in evidences],
        sources=sources,
        first_seen=(datetime.now(timezone.utc) - timedelta(hours=8)).isoformat(),
        last_seen=datetime.now(timezone.utc).isoformat(),
    )
    projection = AnalysisProjection(
        entity=entity,
        status="completed",
        summary=projection_summary,
        confidence=0.72,
        analyzed_at=(datetime.now(timezone.utc) - timedelta(hours=6)).isoformat(),
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    return BenchmarkCase(
        entity=entity,
        candidate=candidate,
        evidences=evidences,
        projection=projection,
    )


def _evidence(
    *,
    entity: str,
    evidence_id: str,
    source: str,
    source_tier: int,
    collected_at: datetime,
    title: str,
    metric_value: int | None = None,
    metric_delta: float | None = None,
    rank: int | None = None,
) -> Evidence:
    return Evidence(
        evidence_id=evidence_id,
        source=source,
        source_tier=source_tier,
        collected_at=collected_at.isoformat(),
        entity_candidates=[entity],
        signal_type="benchmark_signal",
        title_or_label=title,
        metric_value=metric_value,
        metric_delta=metric_delta,
        rank=rank,
        trust_score=0.82 if source_tier == 2 else 1.0,
        url_or_ref=f"https://example.com/{evidence_id}",
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run collector analysis execution benchmark.")
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional path for the JSON benchmark report.",
    )
    parser.add_argument(
        "--mode",
        action="append",
        choices=("fresh", "resume", "batch"),
        dest="modes",
        help="Restrict benchmark to one or more execution modes.",
    )
    return parser.parse_args()


async def _async_main() -> dict:
    if LLM_CLI_EXEC_PATH != "mock" and os.environ.get("RUN_REAL_CODEX_SMOKE") != "1":
        raise SystemExit("Set RUN_REAL_CODEX_SMOKE=1 to run the real Codex benchmark.")

    args = _parse_args()
    report = await run_execution_benchmark(
        context_packer=build_default_context_packer(),
        session_pool_factory=build_default_session_pool,
        modes=args.modes or ("fresh", "resume", "batch"),
    )
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    print(payload)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    return report


def main() -> None:
    asyncio.run(_async_main())


if __name__ == "__main__":
    main()
