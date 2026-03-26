"""Load checked-in source manifests separately from runtime registry state."""

from __future__ import annotations

import json
from pathlib import Path

from .models import SourceManifest

CHECKED_IN_SOURCE_MANIFEST_DIR = Path(__file__).with_name("manifests")


def get_checked_in_source_manifest_dir() -> Path:
    return CHECKED_IN_SOURCE_MANIFEST_DIR


def load_checked_in_source_manifests(
    manifest_dir: str | Path | None = None,
) -> dict[str, SourceManifest]:
    root = Path(manifest_dir) if manifest_dir is not None else CHECKED_IN_SOURCE_MANIFEST_DIR
    if not root.exists():
        return {}

    manifests: dict[str, SourceManifest] = {}
    for path in sorted(root.glob("*.json")):
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        payload["manifest_path"] = str(path)
        manifest = SourceManifest.model_validate(payload)
        manifests[manifest.source_id] = manifest
    return manifests
