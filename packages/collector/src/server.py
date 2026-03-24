"""Main FastAPI server for the collector service."""

import logging
import os
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from .api import public_routes, internal_routes
from .builder.signal_candidate_builder import SignalCandidateBuilder
from .config import COLLECTOR_HOST, COLLECTOR_PORT, DATA_DIR
from .connectors import build_connector_registry
from .normalizer import Evidence, normalize
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    global cadence_runner, _ttl_scheduler

    # Initialize stores
    snapshot_store = RawSnapshotStore(
        base_dir=os.path.join(DATA_DIR, "snapshots")
    )
    entity_store = EntityStore(
        path=os.path.join(DATA_DIR, "entities.json")
    )

    # Initialize connectors (with data_dir for persistence)
    connectors = build_connector_registry(data_dir=DATA_DIR)

    # Initialize resolver and builder
    entity_resolver = EntityResolver(entity_store)
    signal_builder = SignalCandidateBuilder(
        entity_store=entity_store,
    )

    # Initialize scheduler with entity resolver for inline resolution
    cadence_runner = CadenceRunner(
        connectors=connectors,
        snapshot_store=snapshot_store,
        normalizer_fn=normalize,
        evidence_sink=evidence_sink,
        entity_resolver=entity_resolver,
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
    }
    public_routes.init_dependencies(deps)
    internal_routes.init_dependencies(deps)

    # Start cadence runner
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
    }
