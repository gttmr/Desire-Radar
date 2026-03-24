"""Environment variable parsing with sensible defaults."""

import os


def _get(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _get_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return int(raw)


def _get_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return float(raw)


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

# LLM enrichment
LLM_PROVIDER: str = _get("LLM_PROVIDER", "anthropic")  # "anthropic" or "none"
ANTHROPIC_API_KEY: str = _get("ANTHROPIC_API_KEY")
LLM_MODEL: str = _get("LLM_MODEL", "claude-haiku-4-5-20251001")
LLM_ENRICHMENT_ENABLED: bool = _get("LLM_ENRICHMENT_ENABLED", "true").lower() in ("true", "1", "yes")
LLM_BATCH_SIZE: int = _get_int("LLM_BATCH_SIZE", 10)  # Evidence items per LLM call

# Collector-side CLI analysis
LLM_ANALYSIS_ENABLED: bool = _get(
    "LLM_ANALYSIS_ENABLED",
    _get("LLM_ENRICHMENT_ENABLED", "false"),
).lower() in ("true", "1", "yes")
LLM_CLI_EXEC_PATH: str = _get("LLM_CLI_EXEC_PATH", "mock")
LLM_CLI_ARGS: str = _get("LLM_CLI_ARGS", "")
LLM_CLI_PROMPT_MODE: str = _get("LLM_CLI_PROMPT_MODE", "stdin")
LLM_CLI_PROMPT_FLAG: str = _get("LLM_CLI_PROMPT_FLAG", "")
LLM_CLI_MODEL_FLAG: str = _get("LLM_CLI_MODEL_FLAG", "")
LLM_CLI_CONTINUE_FLAG: str = _get("LLM_CLI_CONTINUE_FLAG", "")
LLM_DEFAULT_MODEL: str = _get("LLM_DEFAULT_MODEL", LLM_MODEL)
LLM_TIMEOUT_SECONDS: int = _get_int("LLM_TIMEOUT_SECONDS", 120)
LLM_CONTEXT_CHAR_BUDGET: int = _get_int("LLM_CONTEXT_CHAR_BUDGET", 6000)
LLM_SESSION_MEMORY_CHAR_BUDGET: int = _get_int("LLM_SESSION_MEMORY_CHAR_BUDGET", 1500)
LLM_MAX_EVIDENCE_PER_TASK: int = _get_int("LLM_MAX_EVIDENCE_PER_TASK", 8)
LLM_MAX_CANDIDATES_PER_RUN: int = _get_int("LLM_MAX_CANDIDATES_PER_RUN", 10)
LLM_ENTITY_COOLDOWN_SECONDS: int = _get_int("LLM_ENTITY_COOLDOWN_SECONDS", 21600)
LLM_MIN_SOURCE_COUNT: int = _get_int("LLM_MIN_SOURCE_COUNT", 2)
LLM_MIN_EMERGENCE_DELTA: float = _get_float("LLM_MIN_EMERGENCE_DELTA", 2.0)
LLM_REVIEW_CONFIDENCE_THRESHOLD: float = _get_float("LLM_REVIEW_CONFIDENCE_THRESHOLD", 0.55)
LLM_SESSION_DOMAIN: str = _get("LLM_SESSION_DOMAIN", "trend-analysis")
