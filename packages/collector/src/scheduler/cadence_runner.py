"""Cadence-based scheduler for running connectors at declared intervals."""

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from ..analysis.engine import AnalysisEngine
from ..connectors.base import BaseConnector
from ..resolver.entity_resolver import EntityResolver

logger = logging.getLogger(__name__)


class CadenceRunner:
    def __init__(
        self,
        connectors: dict[str, BaseConnector],
        snapshot_store: Any,
        normalizer_fn: Callable,
        evidence_sink: Any = None,
        entity_resolver: EntityResolver | None = None,
        analysis_engine: AnalysisEngine | None = None,
    ) -> None:
        self.connectors = connectors
        self.snapshot_store = snapshot_store
        self.normalizer_fn = normalizer_fn
        self.evidence_sink: Any = evidence_sink if evidence_sink is not None else []
        self.entity_resolver = entity_resolver
        self.analysis_engine = analysis_engine
        self._scheduler = AsyncIOScheduler()
        self._last_run: dict[str, str] = {}

    def start(self) -> None:
        """Register each connector with its cadence. Use APScheduler."""
        for name, connector in self.connectors.items():
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
                next_run_time=datetime.now(timezone.utc),
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
        """Wrapper for APScheduler to call the async run_connector."""
        try:
            count = await self.run_connector(connector_name)
            logger.info("Connector %s produced %d evidence items", connector_name, count)
        except Exception:
            logger.exception("Error running connector %s", connector_name)

    async def run_connector(self, connector_name: str) -> int:
        """Run a single connector, save snapshots, normalize. Return evidence count."""
        connector = self.connectors.get(connector_name)
        if connector is None:
            logger.warning("Unknown connector: %s", connector_name)
            return 0

        payloads = await connector.fetch()
        evidence_count = 0
        all_evidences: list = []

        for payload in payloads:
            # Save raw snapshot
            snapshot_id = self.snapshot_store.save(
                source=payload.source,
                payload=payload.data,
                request_params=payload.request_params,
            )

            # Normalize
            evidences = self.normalizer_fn(
                source=payload.source,
                raw_payload=payload.data,
                snapshot_ref=snapshot_id,
            )

            # Resolve entity candidates through EntityResolver
            if self.entity_resolver is not None:
                for ev in evidences:
                    resolved = self.entity_resolver.resolve_candidates(
                        ev.entity_candidates, source=payload.source
                    )
                    if resolved:
                        ev.entity_candidates = resolved
                    # If no candidates resolved, keep originals (they are
                    # already queued for review by resolve_candidates)

            all_evidences.extend(evidences)
            evidence_count += len(evidences)

        self.evidence_sink.extend(all_evidences)
        if self.analysis_engine is not None and all_evidences:
            try:
                queued = await self.analysis_engine.on_evidence_updated()
                if queued:
                    logger.info(
                        "Queued %d candidate analyses after %s",
                        len(queued), connector_name,
                    )
            except Exception:
                logger.exception("Candidate analysis scheduling failed for connector %s", connector_name)
        self._last_run[connector_name] = datetime.now(timezone.utc).isoformat()
        return evidence_count

    def get_status(self) -> dict[str, dict]:
        """Return status of all connectors."""
        status: dict[str, dict] = {}
        for name, connector in self.connectors.items():
            status[name] = {
                "cadence_seconds": connector.cadence_seconds,
                "source_tier": connector.source_tier,
                "last_run": self._last_run.get(name),
                "scheduled": connector.cadence_seconds > 0,
            }
        return status
