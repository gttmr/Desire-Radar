"""Main FastAPI server for the collector service."""

import logging
import os
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from .analysis import (
    AnalysisPolicy,
    AnalysisStore,
    ContextPacker,
    SessionPool,
)
from .analysis.engine import AnalysisEngine
from .api import public_routes, internal_routes
from .builder.signal_candidate_builder import SignalCandidateBuilder
from .config import (
    COLLECTOR_HOST, COLLECTOR_PORT, DATA_DIR,
    LLM_ANALYSIS_BATCH_SIZE,
    LLM_ANALYSIS_ENABLED,
    LLM_ANALYSIS_EXECUTION_MODE,
    LLM_BATCH_CHAR_BUDGET,
    LLM_BATCH_INCLUDE_PREVIOUS_ANALYSIS,
    LLM_CLI_INITIAL_ARGS,
    LLM_CLI_ARGS,
    LLM_CLI_CONTINUE_FLAG,
    LLM_CLI_EXEC_PATH,
    LLM_CLI_MODEL_FLAG,
    LLM_CLI_PROVIDER,
    LLM_CLI_PROMPT_FLAG,
    LLM_CLI_PROMPT_MODE,
    LLM_CLI_RESUME_ARGS,
    LLM_CLI_USE_STDIN,
    LLM_CONTEXT_CHAR_BUDGET,
    LLM_DEFAULT_MODEL,
    LLM_ENTITY_COOLDOWN_SECONDS,
    LLM_MAX_CANDIDATES_PER_RUN,
    LLM_MAX_EVIDENCE_PER_TASK,
    LLM_MIN_EMERGENCE_DELTA,
    LLM_MIN_SOURCE_COUNT,
    LLM_PARSE_ERROR_SNIPPET_CHARS,
    LLM_PROMPT_FORMAT,
    LLM_PROMPT_INCLUDE_EVIDENCE_IDS,
    LLM_PROMPT_INCLUDE_GEO,
    LLM_PROMPT_INCLUDE_METRICS,
    LLM_PROMPT_INCLUDE_PREVIOUS_ANALYSIS,
    LLM_PROMPT_INCLUDE_URLS,
    LLM_PROMPT_TITLE_MAX_CHARS,
    LLM_HUMAN_ROUTING_AUTO_THRESHOLD,
    LLM_HUMAN_ROUTING_ENABLED,
    LLM_HUMAN_ROUTING_EXECUTION_MODE,
    LLM_HUMAN_ROUTING_MAX_INPUT_CHARS,
    LLM_HUMAN_ROUTING_MODEL,
    LLM_HUMAN_ROUTING_REVIEW_THRESHOLD,
    LLM_HUMAN_ROUTING_SESSION_DOMAIN,
    LLM_REVIEW_CONFIDENCE_THRESHOLD,
    LLM_SOURCE_AGENT_ENABLED,
    LLM_SOURCE_AGENT_EXECUTION_MODE,
    LLM_SOURCE_AGENT_MAX_INPUT_CHARS,
    LLM_SESSION_DOMAIN,
    LLM_SESSION_MAX_IDLE_MINUTES,
    LLM_SESSION_MAX_TURNS,
    LLM_SESSION_WORKDIR_ROOT,
    LLM_SESSION_MEMORY_CHAR_BUDGET,
    LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET,
    LLM_SESSION_MEMORY_ENTRY_COUNT,
    LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS,
    LLM_TIMEOUT_SECONDS,
    SOURCE_BOOTSTRAP_ON_START,
    SOURCE_RUN_WORKER_CONCURRENCY,
)
from .connectors import build_connector_registry
from .ingest.engine import IngestionEngine
from .ingest.store import SubmissionStore
from .ingest.human_input_router import HumanInputRouter
from .normalizer import normalize
from .resolver.entity_resolver import EntityResolver
from .scheduler.cadence_runner import CadenceRunner
from .sources.defaults import build_default_sources
from .sources.registry import SourceRegistry
from .sources.validity import SourceValidityEngine
from .source_agents import (
    SourceAgentArtifactStore,
    SourceAgentContextBuilder,
    SourceAgentRegistry,
)
from .source_agents.runner import SourceAgentRunner
from .store.entity_store import EntityStore
from .store.evidence_sink import EvidenceSink
from .store.raw_snapshot_store import RawSnapshotStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Global state
evidence_sink: EvidenceSink = EvidenceSink(freshness_ttl_days=7)
cadence_runner: CadenceRunner | None = None
_ttl_scheduler: AsyncIOScheduler | None = None
analysis_engine: AnalysisEngine | None = None
ingestion_engine_instance: IngestionEngine | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    global cadence_runner, _ttl_scheduler, analysis_engine, ingestion_engine_instance

    # Initialize stores
    snapshot_store = RawSnapshotStore(
        base_dir=os.path.join(DATA_DIR, "snapshots")
    )
    entity_store = EntityStore(
        path=os.path.join(DATA_DIR, "entities.json")
    )
    analysis_store = AnalysisStore(
        path=os.path.join(DATA_DIR, "analysis.json")
    )
    source_agent_artifact_store = SourceAgentArtifactStore(
        path=os.path.join(DATA_DIR, "source_agent_artifacts.json")
    )
    submission_store = SubmissionStore(
        path=os.path.join(DATA_DIR, "submissions.json")
    )

    # Initialize connectors (with data_dir for persistence)
    connectors = build_connector_registry(data_dir=DATA_DIR)
    source_registry = SourceRegistry(
        path=os.path.join(DATA_DIR, "sources.json"),
        defaults=build_default_sources(connectors),
        validity_engine=SourceValidityEngine(),
    )

    # Initialize resolver and builder
    entity_resolver = EntityResolver(entity_store)
    signal_builder = SignalCandidateBuilder(
        entity_store=entity_store,
        analysis_store=analysis_store,
        source_registry=source_registry,
    )

    analysis_policy = AnalysisPolicy(
        min_source_count=LLM_MIN_SOURCE_COUNT,
        max_candidates_per_run=LLM_MAX_CANDIDATES_PER_RUN,
        cooldown_seconds=LLM_ENTITY_COOLDOWN_SECONDS,
        min_emergence_delta=LLM_MIN_EMERGENCE_DELTA,
        source_registry=source_registry,
    )
    context_packer = ContextPacker(
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
    session_pool = SessionPool(
        exec_path=LLM_CLI_EXEC_PATH,
        provider=LLM_CLI_PROVIDER,
        initial_args=LLM_CLI_INITIAL_ARGS,
        resume_args=LLM_CLI_RESUME_ARGS,
        model=LLM_DEFAULT_MODEL,
        model_flag=LLM_CLI_MODEL_FLAG,
        timeout_seconds=LLM_TIMEOUT_SECONDS,
        memory_char_budget=LLM_SESSION_MEMORY_CHAR_BUDGET,
        memory_entry_count=LLM_SESSION_MEMORY_ENTRY_COUNT,
        memory_entry_char_budget=LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET,
        max_idle_minutes=LLM_SESSION_MAX_IDLE_MINUTES,
        max_turns=LLM_SESSION_MAX_TURNS,
        session_workdir_root=LLM_SESSION_WORKDIR_ROOT,
        max_uncached_input_tokens=LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS,
        parse_error_snippet_chars=LLM_PARSE_ERROR_SNIPPET_CHARS,
        use_stdin=LLM_CLI_USE_STDIN,
        base_args=LLM_CLI_ARGS,
        prompt_mode=LLM_CLI_PROMPT_MODE,
        prompt_flag=LLM_CLI_PROMPT_FLAG,
        continue_flag=LLM_CLI_CONTINUE_FLAG,
    )
    human_input_session_pool = SessionPool(
        exec_path=LLM_CLI_EXEC_PATH,
        provider=LLM_CLI_PROVIDER,
        initial_args=LLM_CLI_INITIAL_ARGS,
        resume_args=LLM_CLI_RESUME_ARGS,
        model=LLM_HUMAN_ROUTING_MODEL,
        model_flag=LLM_CLI_MODEL_FLAG,
        timeout_seconds=LLM_TIMEOUT_SECONDS,
        memory_char_budget=LLM_SESSION_MEMORY_CHAR_BUDGET,
        memory_entry_count=LLM_SESSION_MEMORY_ENTRY_COUNT,
        memory_entry_char_budget=LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET,
        max_idle_minutes=LLM_SESSION_MAX_IDLE_MINUTES,
        max_turns=LLM_SESSION_MAX_TURNS,
        session_workdir_root=LLM_SESSION_WORKDIR_ROOT,
        max_uncached_input_tokens=LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS,
        parse_error_snippet_chars=LLM_PARSE_ERROR_SNIPPET_CHARS,
        use_stdin=LLM_CLI_USE_STDIN,
        base_args=LLM_CLI_ARGS,
        prompt_mode=LLM_CLI_PROMPT_MODE,
        prompt_flag=LLM_CLI_PROMPT_FLAG,
        continue_flag=LLM_CLI_CONTINUE_FLAG,
    )
    human_input_router = HumanInputRouter(
        session_pool=human_input_session_pool,
        enabled=LLM_HUMAN_ROUTING_ENABLED,
        execution_mode=LLM_HUMAN_ROUTING_EXECUTION_MODE,
        session_domain=LLM_HUMAN_ROUTING_SESSION_DOMAIN,
        auto_threshold=LLM_HUMAN_ROUTING_AUTO_THRESHOLD,
        review_threshold=LLM_HUMAN_ROUTING_REVIEW_THRESHOLD,
        max_input_chars=LLM_HUMAN_ROUTING_MAX_INPUT_CHARS,
    )
    source_agent_registry = SourceAgentRegistry(source_registry)
    source_agent_context_builder = SourceAgentContextBuilder(
        source_agent_registry,
        max_input_chars=LLM_SOURCE_AGENT_MAX_INPUT_CHARS,
    )
    source_agent_runner = SourceAgentRunner(
        source_registry=source_registry,
        agent_registry=source_agent_registry,
        context_builder=source_agent_context_builder,
        artifact_store=source_agent_artifact_store,
        session_pool=session_pool,
        submission_store=submission_store,
        evidence_sink=evidence_sink,
        enabled=LLM_SOURCE_AGENT_ENABLED,
        execution_mode=LLM_SOURCE_AGENT_EXECUTION_MODE,
    )
    analysis_engine = AnalysisEngine(
        evidence_sink=evidence_sink,
        signal_builder=signal_builder,
        analysis_store=analysis_store,
        policy=analysis_policy,
        context_packer=context_packer,
        session_pool=session_pool,
        enabled=LLM_ANALYSIS_ENABLED,
        session_domain=LLM_SESSION_DOMAIN,
        review_threshold=LLM_REVIEW_CONFIDENCE_THRESHOLD,
        execution_mode=LLM_ANALYSIS_EXECUTION_MODE,
        analysis_batch_size=LLM_ANALYSIS_BATCH_SIZE,
        source_registry=source_registry,
    )
    ingestion_engine = IngestionEngine(
        source_registry=source_registry,
        submission_store=submission_store,
        snapshot_store=snapshot_store,
        evidence_sink=evidence_sink,
        entity_resolver=entity_resolver,
        normalizer_fn=normalize,
        connectors=connectors,
        analysis_engine=analysis_engine,
        human_input_router=human_input_router,
        source_agent_runner=source_agent_runner,
        source_run_worker_concurrency=SOURCE_RUN_WORKER_CONCURRENCY,
    )
    ingestion_engine_instance = ingestion_engine

    if LLM_ANALYSIS_ENABLED:
        logger.info(
            "Collector analysis enabled (exec=%s, provider=%s, model=%s, mode=%s, domain=%s)",
            LLM_CLI_EXEC_PATH,
            LLM_CLI_PROVIDER,
            LLM_DEFAULT_MODEL,
            LLM_ANALYSIS_EXECUTION_MODE,
            LLM_SESSION_DOMAIN,
        )
    else:
        logger.info("Collector analysis disabled — candidates will remain unanalyzed")
    logger.info(
        "Collector human routing %s (model=%s, mode=%s, domain=%s)",
        "enabled" if LLM_HUMAN_ROUTING_ENABLED else "disabled",
        LLM_HUMAN_ROUTING_MODEL or "(default)",
        LLM_HUMAN_ROUTING_EXECUTION_MODE,
        LLM_HUMAN_ROUTING_SESSION_DOMAIN,
    )
    logger.info(
        "Collector source agents %s (mode=%s)",
        "enabled" if LLM_SOURCE_AGENT_ENABLED else "disabled",
        LLM_SOURCE_AGENT_EXECUTION_MODE,
    )

    # Initialize scheduler with entity resolver and analysis engine
    cadence_runner = CadenceRunner(
        connectors=connectors,
        ingestion_engine=ingestion_engine,
        source_registry=source_registry,
        bootstrap_on_start=SOURCE_BOOTSTRAP_ON_START,
    )

    # Shared dependencies for route handlers
    deps = {
        "connectors": connectors,
        "source_registry": source_registry,
        "snapshot_store": snapshot_store,
        "entity_store": entity_store,
        "entity_resolver": entity_resolver,
        "signal_builder": signal_builder,
        "cadence_runner": cadence_runner,
        "evidence_sink": evidence_sink,
        "analysis_store": analysis_store,
        "source_agent_runner": source_agent_runner,
        "source_agent_artifact_store": source_agent_artifact_store,
        "analysis_engine": analysis_engine,
        "submission_store": submission_store,
        "ingestion_engine": ingestion_engine,
    }
    public_routes.init_dependencies(deps)
    internal_routes.init_dependencies(deps)

    # Start cadence runner
    await analysis_engine.start()
    await ingestion_engine.start()
    cadence_runner.start()

    # Schedule periodic TTL cleanup (every hour)
    _ttl_scheduler = AsyncIOScheduler()
    _ttl_scheduler.add_job(
        _enforce_ttl,
        "interval",
        hours=1,
        id="evidence_ttl_cleanup",
        name="Evidence TTL Cleanup",
    )
    _ttl_scheduler.start()

    logger.info("Collector service started on %s:%d", COLLECTOR_HOST, COLLECTOR_PORT)

    yield

    # Shutdown
    cadence_runner.stop()
    await ingestion_engine.stop()
    await analysis_engine.stop()
    if _ttl_scheduler is not None:
        _ttl_scheduler.shutdown(wait=False)
    ingestion_engine_instance = None
    logger.info("Collector service stopped")


async def _enforce_ttl() -> None:
    """Periodic TTL enforcement callback."""
    evidence_sink.enforce_ttl()


app = FastAPI(
    title="Agentic Collector",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(public_routes.router)
app.include_router(internal_routes.router)


@app.get("/health")
async def health() -> dict:
    runtime = (
        ingestion_engine_instance.get_runtime_status()
        if ingestion_engine_instance is not None
        else {
            "source_run_queue_size": 0,
            "active_source_count": 0,
            "source_run_worker_concurrency": 0,
        }
    )
    return {
        "status": "ok",
        "service": "collector",
        "evidence_count": evidence_sink.count,
        "analysis_enabled": analysis_engine.enabled if analysis_engine is not None else False,
        "analysis_queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
        "analysis_execution_mode": analysis_engine.execution_mode if analysis_engine is not None else "disabled",
        "source_run_queue_size": runtime["source_run_queue_size"],
        "active_source_count": runtime["active_source_count"],
        "source_run_worker_concurrency": runtime["source_run_worker_concurrency"],
    }
