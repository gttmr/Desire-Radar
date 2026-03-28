"""Cadence-based scheduler for running connectors at declared intervals."""

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from ..connectors.base import BaseConnector
from ..ingest.engine import IngestionEngine
from ..sources.registry import SourceRegistry

logger = logging.getLogger(__name__)


class CadenceRunner:
    def __init__(
        self,
        connectors: dict[str, BaseConnector],
        ingestion_engine: IngestionEngine,
        source_registry: SourceRegistry,
        *,
        bootstrap_on_start: bool = False,
    ) -> None:
        self.connectors = connectors
        self.ingestion_engine = ingestion_engine
        self.source_registry = source_registry
        self._scheduler = AsyncIOScheduler()
        self.bootstrap_on_start = bootstrap_on_start

    def start(self) -> None:
        """Register each connector with its cadence. Use APScheduler."""
        next_run_time = datetime.now(timezone.utc) if self.bootstrap_on_start else None
        for name, connector in self.connectors.items():
            source = self.source_registry.get(name)
            if source is None:
                logger.info("Skipping scheduler for %s (missing source)", name)
                continue
            if connector.cadence_seconds <= 0:
                logger.info(
                    "Skipping scheduler for %s (cadence=%d)",
                    name,
                    connector.cadence_seconds,
                )
                continue

            self._scheduler.add_job(
                self._run_wrapper,
                "interval",
                seconds=connector.cadence_seconds,
                args=[name],
                id=f"connector_{name}",
                name=f"Connector: {name}",
                max_instances=1,
                next_run_time=next_run_time,
                misfire_grace_time=connector.cadence_seconds,
            )
            logger.info(
                "Scheduled %s every %d seconds", name, connector.cadence_seconds
            )

        self._scheduler.start()
        logger.info("CadenceRunner started with %d jobs", len(self._scheduler.get_jobs()))

    def stop(self) -> None:
        """Shut down the scheduler."""
        self._scheduler.shutdown(wait=False)
        logger.info("CadenceRunner stopped")

    async def _run_wrapper(self, connector_name: str) -> None:
        """Wrapper for APScheduler to queue an async source run."""
        try:
            source = self.source_registry.get(connector_name)
            if source is None or not source.enabled or not source.runnable:
                logger.info(
                    "Skipping scheduled run for %s (enabled=%s runnable=%s)",
                    connector_name,
                    source.enabled if source is not None else None,
                    source.runnable if source is not None else None,
                )
                return
            record = await self.ingestion_engine.enqueue_source_run(
                connector_name,
                metadata={"trigger": "scheduled"},
            )
            logger.info(
                "Queued connector %s as submission %s",
                connector_name,
                record.submission_id,
            )
        except Exception:
            logger.exception("Error running connector %s", connector_name)

    async def run_connector(self, connector_name: str) -> int:
        """Run a single connector through the common ingestion engine."""
        connector = self.connectors.get(connector_name)
        if connector is None:
            logger.warning("Unknown connector: %s", connector_name)
            return 0

        record = await self.ingestion_engine.run_source(connector_name)
        return len(record.evidence_ids)

    def runtime_status(self) -> dict[str, int | bool]:
        return {
            "scheduled_job_count": len(self._scheduler.get_jobs()),
            "bootstrap_on_start": self.bootstrap_on_start,
        }

    def get_status(self) -> dict[str, dict]:
        """Return status of all sources from the registry."""
        return self.source_registry.status()
