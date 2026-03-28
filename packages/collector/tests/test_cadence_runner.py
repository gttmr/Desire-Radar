import pytest

from src.scheduler.cadence_runner import CadenceRunner
from src.connectors.base import BaseConnector


class DummyConnector(BaseConnector):
    name = "dummy_pull"
    cadence_seconds = 60
    source_tier = 2

    async def fetch(self):
        return []


class StubSourceRegistry:
    def __init__(self, *, enabled: bool = True, runnable: bool = True) -> None:
        self.enabled = enabled
        self.runnable = runnable

    def get(self, source_id: str):
        return type(
            "Source",
            (),
            {
                "enabled": self.enabled,
                "runnable": self.runnable,
            },
        )()

    def status(self):
        return {}


class StubIngestionEngine:
    def __init__(self) -> None:
        self.calls = []

    async def enqueue_source_run(self, source_id: str, *, metadata=None):
        self.calls.append((source_id, metadata))

        class Record:
            submission_id = "sub-1"

        return Record()


@pytest.mark.asyncio
async def test_cadence_runner_queues_source_runs() -> None:
    engine = StubIngestionEngine()
    runner = CadenceRunner(
        connectors={DummyConnector.name: DummyConnector()},
        ingestion_engine=engine,
        source_registry=StubSourceRegistry(),
        bootstrap_on_start=False,
    )

    await runner._run_wrapper("dummy_pull")

    assert engine.calls == [("dummy_pull", {"trigger": "scheduled"})]
    assert runner.runtime_status()["bootstrap_on_start"] is False


@pytest.mark.asyncio
async def test_cadence_runner_skips_disabled_sources_at_runtime() -> None:
    engine = StubIngestionEngine()
    runner = CadenceRunner(
        connectors={DummyConnector.name: DummyConnector()},
        ingestion_engine=engine,
        source_registry=StubSourceRegistry(enabled=False),
        bootstrap_on_start=False,
    )

    await runner._run_wrapper("dummy_pull")

    assert engine.calls == []
