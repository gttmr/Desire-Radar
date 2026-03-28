"""Append-only JSON file store for raw snapshots."""

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any


class RawSnapshotStore:
    def __init__(self, base_dir: str = "data/snapshots") -> None:
        self.base_dir = base_dir
        self._checksum_index_cache: dict[str, dict[str, str]] = {}

    def save(self, source: str, payload: Any, request_params: dict) -> str:
        return self.save_record(
            source=source,
            payload=payload,
            request_params=request_params,
        )["snapshot_id"]

    def save_record(
        self,
        source: str,
        payload: Any,
        request_params: dict,
        *,
        virtual: bool = False,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Save raw payload, return snapshot_id. Skip if checksum duplicate."""
        payload_json = json.dumps(payload, sort_keys=True, default=str)
        checksum = hashlib.sha256(payload_json.encode()).hexdigest()

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        directory = os.path.join(self.base_dir, source, date_str)
        os.makedirs(directory, exist_ok=True)
        checksum_index = self._load_checksum_index(directory)

        existing_snapshot_id = checksum_index.get(checksum)
        if existing_snapshot_id:
            existing = self.get(existing_snapshot_id, source, date_str)
            if existing is not None:
                return {
                    "snapshot_id": existing.get("snapshot_id", existing_snapshot_id),
                    "deduped": True,
                    "record": existing,
                }
            checksum_index.pop(checksum, None)
            self._save_checksum_index(directory)

        snapshot_id = uuid.uuid4().hex[:16]
        record = {
            "snapshot_id": snapshot_id,
            "source": source,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "checksum_sha256": checksum,
            "request_params": request_params,
            "payload": payload,
            "virtual": virtual,
            "metadata": metadata or {},
        }

        filepath = os.path.join(directory, f"{snapshot_id}.json")
        with open(filepath, "w") as f:
            json.dump(record, f, indent=2, default=str)

        checksum_index[checksum] = snapshot_id
        self._save_checksum_index(directory)
        return {"snapshot_id": snapshot_id, "deduped": False, "record": record}

    def get(self, snapshot_id: str, source: str, date: str) -> dict | None:
        """Retrieve a snapshot by id, source, and date."""
        filepath = os.path.join(self.base_dir, source, date, f"{snapshot_id}.json")
        if not os.path.exists(filepath):
            return None
        with open(filepath, "r") as f:
            return json.load(f)

    def _load_checksum_index(self, directory: str) -> dict[str, str]:
        cached = self._checksum_index_cache.get(directory)
        if cached is not None:
            return cached

        index_path = self._checksum_index_path(directory)
        if os.path.exists(index_path):
            try:
                with open(index_path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                checksums = {
                    str(checksum): str(snapshot_id)
                    for checksum, snapshot_id in (payload.get("checksums") or {}).items()
                    if checksum and snapshot_id
                }
                self._checksum_index_cache[directory] = checksums
                return checksums
            except (json.JSONDecodeError, OSError):
                pass

        rebuilt: dict[str, str] = {}
        for fname in os.listdir(directory):
            if not fname.endswith(".json") or fname == self._checksum_index_name():
                continue
            filepath = os.path.join(directory, fname)
            try:
                with open(filepath, "r", encoding="utf-8") as handle:
                    existing = json.load(handle)
            except (json.JSONDecodeError, OSError):
                continue
            checksum = str(existing.get("checksum_sha256") or "").strip()
            snapshot_id = str(existing.get("snapshot_id") or fname.removesuffix(".json")).strip()
            if checksum and snapshot_id:
                rebuilt[checksum] = snapshot_id
        self._checksum_index_cache[directory] = rebuilt
        if rebuilt:
            self._save_checksum_index(directory)
        return rebuilt

    def _save_checksum_index(self, directory: str) -> None:
        index_path = self._checksum_index_path(directory)
        checksums = self._checksum_index_cache.get(directory, {})
        with open(index_path, "w", encoding="utf-8") as handle:
            json.dump({"checksums": checksums}, handle, indent=2, sort_keys=True)

    def _checksum_index_path(self, directory: str) -> str:
        return os.path.join(directory, self._checksum_index_name())

    def _checksum_index_name(self) -> str:
        return ".checksum-index.json"
