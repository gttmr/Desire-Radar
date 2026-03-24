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

    def save(self, source: str, payload: Any, request_params: dict) -> str:
        """Save raw payload, return snapshot_id. Skip if checksum duplicate."""
        payload_json = json.dumps(payload, sort_keys=True, default=str)
        checksum = hashlib.sha256(payload_json.encode()).hexdigest()

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        directory = os.path.join(self.base_dir, source, date_str)
        os.makedirs(directory, exist_ok=True)

        # Check for duplicate checksum in today's directory
        for fname in os.listdir(directory):
            if not fname.endswith(".json"):
                continue
            filepath = os.path.join(directory, fname)
            try:
                with open(filepath, "r") as f:
                    existing = json.load(f)
                if existing.get("checksum_sha256") == checksum:
                    return existing.get("snapshot_id", fname.replace(".json", ""))
            except (json.JSONDecodeError, OSError):
                continue

        snapshot_id = uuid.uuid4().hex[:16]
        record = {
            "snapshot_id": snapshot_id,
            "source": source,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "checksum_sha256": checksum,
            "request_params": request_params,
            "payload": payload,
        }

        filepath = os.path.join(directory, f"{snapshot_id}.json")
        with open(filepath, "w") as f:
            json.dump(record, f, indent=2, default=str)

        return snapshot_id

    def get(self, snapshot_id: str, source: str, date: str) -> dict | None:
        """Retrieve a snapshot by id, source, and date."""
        filepath = os.path.join(self.base_dir, source, date, f"{snapshot_id}.json")
        if not os.path.exists(filepath):
            return None
        with open(filepath, "r") as f:
            return json.load(f)
