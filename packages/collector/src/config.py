"""Environment variable parsing with sensible defaults."""

import os


def _get(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _get_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return int(raw)


# Server
COLLECTOR_PORT: int = _get_int("COLLECTOR_PORT", 5002)
COLLECTOR_HOST: str = _get("COLLECTOR_HOST", "0.0.0.0")

# Storage
DATA_DIR: str = _get("DATA_DIR", "data")

# Reddit
REDDIT_USER_AGENT: str = _get(
    "REDDIT_USER_AGENT",
    "agentic-collector/0.1 (research bot; contact@example.com)",
)

# Optional API keys
NAVER_CLIENT_ID: str = _get("NAVER_CLIENT_ID")
NAVER_CLIENT_SECRET: str = _get("NAVER_CLIENT_SECRET")
GOOGLE_TRENDS_GEO: str = _get("GOOGLE_TRENDS_GEO", "KR,US")  # comma-separated geo codes
APP_STORE_API_KEY: str = _get("APP_STORE_API_KEY")
SIMILARWEB_API_KEY: str = _get("SIMILARWEB_API_KEY")
TIKTOK_API_KEY: str = _get("TIKTOK_API_KEY")
