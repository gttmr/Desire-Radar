from datetime import datetime, timezone
import json

from src.store.raw_snapshot_store import RawSnapshotStore


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def test_snapshot_store_dedupes_with_checksum_index(tmp_path):
    store = RawSnapshotStore(str(tmp_path / "snapshots"))

    first = store.save_record(
        source="reddit_mentions",
        payload={"title": "Cursor demand rising"},
        request_params={"limit": 25},
    )
    second = store.save_record(
        source="reddit_mentions",
        payload={"title": "Cursor demand rising"},
        request_params={"limit": 25},
    )

    assert first["deduped"] is False
    assert second["deduped"] is True
    assert second["snapshot_id"] == first["snapshot_id"]

    index_path = tmp_path / "snapshots" / "reddit_mentions" / _today() / ".checksum-index.json"
    assert index_path.exists()
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    assert payload["checksums"]


def test_snapshot_store_rebuilds_index_after_restart(tmp_path):
    base_dir = str(tmp_path / "snapshots")
    first_store = RawSnapshotStore(base_dir)
    first = first_store.save_record(
        source="reddit_mentions",
        payload={"title": "Cursor demand rising"},
        request_params={},
    )

    second_store = RawSnapshotStore(base_dir)
    second = second_store.save_record(
        source="reddit_mentions",
        payload={"title": "Cursor demand rising"},
        request_params={},
    )

    assert second["deduped"] is True
    assert second["snapshot_id"] == first["snapshot_id"]
