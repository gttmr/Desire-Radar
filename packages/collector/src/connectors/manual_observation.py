import json
import logging
import os

from .base import BaseConnector, RawPayload

logger = logging.getLogger(__name__)


class ManualObservationConnector(BaseConnector):
    name = "manual_observation"
    cadence_seconds = 0
    source_tier = 1

    def __init__(self, persist_path: str = "data/manual_observations.json") -> None:
        self.persist_path = persist_path
        self._pending: list[dict] = []
        self._load()

    def _load(self) -> None:
        """Load pending observations from disk on startup."""
        if os.path.exists(self.persist_path):
            try:
                with open(self.persist_path, "r") as f:
                    self._pending = json.load(f)
                logger.info(
                    "Loaded %d pending manual observations from %s",
                    len(self._pending),
                    self.persist_path,
                )
            except (json.JSONDecodeError, IOError) as exc:
                logger.warning(
                    "Failed to load manual observations from %s: %s",
                    self.persist_path,
                    exc,
                )
                self._pending = []

    def _save(self) -> None:
        """Persist pending observations to disk."""
        os.makedirs(os.path.dirname(self.persist_path) or ".", exist_ok=True)
        with open(self.persist_path, "w") as f:
            json.dump(self._pending, f, indent=2, default=str)

    def _clear_file(self) -> None:
        """Clear the persistence file after processing."""
        if os.path.exists(self.persist_path):
            with open(self.persist_path, "w") as f:
                json.dump([], f)

    def submit(self, observation: dict) -> None:
        self._pending.append(observation)
        self._save()

    async def fetch(self) -> list[RawPayload]:
        items = list(self._pending)
        self._pending.clear()
        self._clear_file()
        return [
            RawPayload(
                source=self.name,
                data=item,
                request_params={},
                url_or_ref="manual",
            )
            for item in items
        ]
