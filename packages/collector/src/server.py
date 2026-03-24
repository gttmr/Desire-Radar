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
    LLM_ANALYSIS_ENABLED,
    LLM_CLI_ARGS,
    LLM_CLI_CONTINUE_FLAG,
    LLM_CLI_EXEC_PATH,
    LLM_CLI_MODEL_FLAG,
    LLM_CLI_PROMPT_FLAG,
    LLM_CLI_PROMPT_MODE,
    LLM_CONTEXT_CHAR_BUDGET,
    LLM_DEFAULT_MODEL,
    LLM_ENTITY_COOLDOWN_SECONDS,
    LLM_MAX_CANDIDATES_PER_RUN,
    LLM_MAX_EVIDENCE_PER_TASK,
    LLM_MIN_EMERGENCE_DELTA,
    LLM_MIN_SOURCE_COUNT,
    LLM_REVIEW_CONFIDENCE_THRESHOLD,
    LLM_SESSION_DOMAIN,
    LLM_SESSION_MEMORY_CHAR_BUDGET,
    LLM_TIMEOUT_SECONDS,
)
from .connectors import build_connector_registry
from .normalizer import normalize
from .resolver.entity_resolver import EntityResolver
from .scheduler.cadence_runner import CadenceRunner
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    global cadence_runner, _ttl_scheduler, analysis_engine

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

    # Initialize connectors (with data_dir for persistence)
    connectors = build_connector_registry(data_dir=DATA_DIR)

    # Initialize resolver and builder
    entity_resolver = EntityResolver(entity_store)
    signal_builder = SignalCandidateBuilder(
        entity_store=entity_store,
        analysis_store=analysis_store,
    )

    analysis_policy = AnalysisPolicy(
        min_source_count=LLM_MIN_SOURCE_COUNT,
        max_candidates_per_run=LLM_MAX_CANDIDATES_PER_RUN,
        cooldown_seconds=LLM_ENTITY_COOLDOWN_SECONDS,
        min_emergence_delta=LLM_MIN_EMERGENCE_DELTA,
    )
    context_packer = ContextPacker(
        char_budget=LLM_CONTEXT_CHAR_BUDGET,
        max_evidence=LLM_MAX_EVIDENCE_PER_TASK,
    )
    session_pool = SessionPool(
        exec_path=LLM_CLI_EXEC_PATH,
        base_args=LLM_CLI_ARGS,
        model=LLM_DEFAULT_MODEL,
        prompt_mode=LLM_CLI_PROMPT_MODE,
        prompt_flag=LLM_CLI_PROMPT_FLAG,
        model_flag=LLM_CLI_MODEL_FLAG,
        continue_flag=LLM_CLI_CONTINUE_FLAG,
        timeout_seconds=LLM_TIMEOUT_SECONDS,
        memory_char_budget=LLM_SESSION_MEMORY_CHAR_BUDGET,
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
    )

    if LLM_ANALYSIS_ENABLED:
        logger.info(
            "Collector analysis enabled (exec=%s, model=%s, domain=%s)",
            LLM_CLI_EXEC_PATH,
            LLM_DEFAULT_MODEL,
            LLM_SESSION_DOMAIN,
        )
    else:
        logger.info("Collector analysis disabled — candidates will remain unanalyzed")

    # Initialize scheduler with entity resolver and analysis engine
    cadence_runner = CadenceRunner(
        connectors=connectors,
        snapshot_store=snapshot_store,
        normalizer_fn=normalize,
        evidence_sink=evidence_sink,
        entity_resolver=entity_resolver,
        analysis_engine=analysis_engine,
    )

    # Shared dependencies for route handlers
    deps = {
        "connectors": connectors,
        "snapshot_store": snapshot_store,
        "entity_store": entity_store,
        "entity_resolver": entity_resolver,
        "signal_builder": signal_builder,
        "cadence_runner": cadence_runner,
        "evidence_sink": evidence_sink,
        "analysis_store": analysis_store,
        "analysis_engine": analysis_engine,
    }
    public_routes.init_dependencies(deps)
    internal_routes.init_dependencies(deps)

    # Start cadence runner
    await analysis_engine.start()
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
    await analysis_engine.stop()
    if _ttl_scheduler is not None:
        _ttl_scheduler.shutdown(wait=False)
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
    return {
        "status": "ok",
        "service": "collector",
        "evidence_count": evidence_sink.count,
        "analysis_enabled": analysis_engine.enabled if analysis_engine is not None else False,
        "analysis_queue_size": analysis_engine.get_status("_")["queue_size"] if analysis_engine is not None else 0,
    }
