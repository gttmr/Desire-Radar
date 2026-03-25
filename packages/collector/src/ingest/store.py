"""Persistent submission store for ingestion requests."""

from __future__ import annotations

import json
import os

from .models import SubmissionRecord


class SubmissionStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._records: dict[str, SubmissionRecord] = {}
        self._load()

    def create(self, record: SubmissionRecord) -> SubmissionRecord:
        self._records[record.submission_id] = record
        self._save()
        return record

    def get(self, submission_id: str) -> SubmissionRecord | None:
        record = self._records.get(submission_id)
        return record.model_copy(deep=True) if record is not None else None

    def update(self, submission_id: str, **updates) -> SubmissionRecord:
        record = self._records[submission_id]
        updated = record.model_copy(update=updates, deep=True)
        self._records[submission_id] = updated
        self._save()
        return updated

    def list(self) -> list[SubmissionRecord]:
        return [record.model_copy(deep=True) for record in self._records.values()]

    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        self._records = {
            item["submission_id"]: SubmissionRecord.model_validate(item)
            for item in payload.get("submissions", [])
        }

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "submissions": [
                        record.model_dump(mode="json")
                        for record in self._records.values()
                    ]
                },
                handle,
                indent=2,
            )
