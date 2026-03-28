"""Persistent store for source-agent artifacts."""

from __future__ import annotations

import json
import os

from .models import SourceAgentArtifact


class SourceAgentArtifactStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._records: dict[str, SourceAgentArtifact] = {}
        self._load()

    def put(self, record: SourceAgentArtifact) -> SourceAgentArtifact:
        self._records[record.artifact_id] = record
        self._save()
        return record

    def get(self, artifact_id: str) -> SourceAgentArtifact | None:
        record = self._records.get(artifact_id)
        return record.model_copy(deep=True) if record is not None else None

    def latest_for_source(self, source_id: str) -> SourceAgentArtifact | None:
        matches = [record for record in self._records.values() if record.source_id == source_id]
        if not matches:
            return None
        matches.sort(key=lambda item: item.updated_at, reverse=True)
        return matches[0].model_copy(deep=True)

    def latest_for_submission(self, submission_id: str) -> SourceAgentArtifact | None:
        matches = [
            record for record in self._records.values()
            if record.submission_id == submission_id
        ]
        if not matches:
            return None
        matches.sort(key=lambda item: item.updated_at, reverse=True)
        return matches[0].model_copy(deep=True)

    def list(self) -> list[SourceAgentArtifact]:
        return [record.model_copy(deep=True) for record in self._records.values()]

    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        self._records = {
            item["artifact_id"]: SourceAgentArtifact.model_validate(item)
            for item in payload.get("artifacts", [])
        }

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "artifacts": [
                        record.model_dump(mode="json")
                        for record in self._records.values()
                    ]
                },
                handle,
                indent=2,
            )
