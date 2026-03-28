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


def _get_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.lower() in ("true", "1", "yes")


# Server
COLLECTOR_PORT: int = _get_int("COLLECTOR_PORT", 5002)
COLLECTOR_HOST: str = _get("COLLECTOR_HOST", "0.0.0.0")

# Storage
DATA_DIR: str = _get("DATA_DIR", "data")
SOURCE_RUN_WORKER_CONCURRENCY: int = _get_int("SOURCE_RUN_WORKER_CONCURRENCY", 2)
SOURCE_BOOTSTRAP_ON_START: bool = _get_bool("SOURCE_BOOTSTRAP_ON_START", False)

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
LLM_ANALYSIS_ENABLED: bool = _get_bool(
    "LLM_ANALYSIS_ENABLED",
    _get_bool("LLM_ENRICHMENT_ENABLED", False),
)
LLM_ANALYSIS_EXECUTION_MODE: str = _get("LLM_ANALYSIS_EXECUTION_MODE", "batch")
LLM_ANALYSIS_BATCH_SIZE: int = _get_int("LLM_ANALYSIS_BATCH_SIZE", 3)
LLM_CLI_EXEC_PATH: str = _get("LLM_CLI_EXEC_PATH", "codex")
LLM_CLI_PROVIDER: str = _get("LLM_CLI_PROVIDER", "codex")
LLM_CLI_INITIAL_ARGS: str = _get(
    "LLM_CLI_INITIAL_ARGS",
    "exec --skip-git-repo-check --ephemeral -C /tmp -s read-only --json",
)
LLM_CLI_RESUME_ARGS: str = _get(
    "LLM_CLI_RESUME_ARGS",
    "exec resume --skip-git-repo-check --json",
)
LLM_CLI_USE_STDIN: bool = _get_bool("LLM_CLI_USE_STDIN", True)
LLM_CLI_ARGS: str = _get("LLM_CLI_ARGS", "")
LLM_CLI_PROMPT_MODE: str = _get("LLM_CLI_PROMPT_MODE", "stdin")
LLM_CLI_PROMPT_FLAG: str = _get("LLM_CLI_PROMPT_FLAG", "")
LLM_CLI_MODEL_FLAG: str = _get("LLM_CLI_MODEL_FLAG", "-m")
LLM_CLI_CONTINUE_FLAG: str = _get("LLM_CLI_CONTINUE_FLAG", "")
LLM_DEFAULT_MODEL: str = _get("LLM_DEFAULT_MODEL", "")
LLM_TIMEOUT_SECONDS: int = _get_int("LLM_TIMEOUT_SECONDS", 120)
LLM_CONTEXT_CHAR_BUDGET: int = _get_int("LLM_CONTEXT_CHAR_BUDGET", 6000)
LLM_BATCH_CHAR_BUDGET: int = _get_int("LLM_BATCH_CHAR_BUDGET", 7000)
LLM_PROMPT_FORMAT: str = _get("LLM_PROMPT_FORMAT", "markdown")
LLM_PROMPT_TITLE_MAX_CHARS: int = _get_int("LLM_PROMPT_TITLE_MAX_CHARS", 120)
LLM_PROMPT_INCLUDE_PREVIOUS_ANALYSIS: bool = _get_bool(
    "LLM_PROMPT_INCLUDE_PREVIOUS_ANALYSIS",
    True,
)
LLM_BATCH_INCLUDE_PREVIOUS_ANALYSIS: bool = _get_bool(
    "LLM_BATCH_INCLUDE_PREVIOUS_ANALYSIS",
    True,
)
LLM_PROMPT_INCLUDE_METRICS: str = _get("LLM_PROMPT_INCLUDE_METRICS", "auto")
LLM_PROMPT_INCLUDE_URLS: bool = _get_bool("LLM_PROMPT_INCLUDE_URLS", False)
LLM_PROMPT_INCLUDE_GEO: bool = _get_bool("LLM_PROMPT_INCLUDE_GEO", False)
LLM_PROMPT_INCLUDE_EVIDENCE_IDS: bool = _get_bool(
    "LLM_PROMPT_INCLUDE_EVIDENCE_IDS",
    False,
)
LLM_SESSION_MEMORY_CHAR_BUDGET: int = _get_int("LLM_SESSION_MEMORY_CHAR_BUDGET", 1500)
LLM_SESSION_MEMORY_ENTRY_COUNT: int = _get_int("LLM_SESSION_MEMORY_ENTRY_COUNT", 3)
LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET: int = _get_int(
    "LLM_SESSION_MEMORY_ENTRY_CHAR_BUDGET",
    160,
)
LLM_MAX_EVIDENCE_PER_TASK: int = _get_int("LLM_MAX_EVIDENCE_PER_TASK", 8)
LLM_MAX_CANDIDATES_PER_RUN: int = _get_int("LLM_MAX_CANDIDATES_PER_RUN", 10)
LLM_ENTITY_COOLDOWN_SECONDS: int = _get_int("LLM_ENTITY_COOLDOWN_SECONDS", 21600)
LLM_MIN_SOURCE_COUNT: int = _get_int("LLM_MIN_SOURCE_COUNT", 2)
LLM_MIN_EMERGENCE_DELTA: float = _get_float("LLM_MIN_EMERGENCE_DELTA", 2.0)
LLM_REVIEW_CONFIDENCE_THRESHOLD: float = _get_float("LLM_REVIEW_CONFIDENCE_THRESHOLD", 0.55)
LLM_SESSION_DOMAIN: str = _get("LLM_SESSION_DOMAIN", "trend-analysis")
LLM_SESSION_MAX_IDLE_MINUTES: int = _get_int("LLM_SESSION_MAX_IDLE_MINUTES", 20)
LLM_SESSION_MAX_TURNS: int = _get_int("LLM_SESSION_MAX_TURNS", 5)
LLM_SESSION_WORKDIR_ROOT: str = _get(
    "LLM_SESSION_WORKDIR_ROOT",
    os.path.join(DATA_DIR, "llm-session-workdirs"),
)
LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS: int = _get_int(
    "LLM_SESSION_MAX_UNCACHED_INPUT_TOKENS",
    20000,
)
LLM_PARSE_ERROR_SNIPPET_CHARS: int = _get_int("LLM_PARSE_ERROR_SNIPPET_CHARS", 200)

# Source-agent analysis
LLM_SOURCE_AGENT_ENABLED: bool = _get_bool(
    "LLM_SOURCE_AGENT_ENABLED",
    LLM_ANALYSIS_ENABLED,
)
LLM_SOURCE_AGENT_EXECUTION_MODE: str = _get(
    "LLM_SOURCE_AGENT_EXECUTION_MODE",
    "resume",
)
LLM_SOURCE_AGENT_MAX_INPUT_CHARS: int = _get_int(
    "LLM_SOURCE_AGENT_MAX_INPUT_CHARS",
    8000,
)

# Human input routing
LLM_HUMAN_ROUTING_ENABLED: bool = _get_bool(
    "LLM_HUMAN_ROUTING_ENABLED",
    LLM_ANALYSIS_ENABLED,
)
LLM_HUMAN_ROUTING_EXECUTION_MODE: str = _get(
    "LLM_HUMAN_ROUTING_EXECUTION_MODE",
    "fresh",
)
LLM_HUMAN_ROUTING_MODEL: str = _get("LLM_HUMAN_ROUTING_MODEL", LLM_DEFAULT_MODEL)
LLM_HUMAN_ROUTING_SESSION_DOMAIN: str = _get(
    "LLM_HUMAN_ROUTING_SESSION_DOMAIN",
    "human-input-routing",
)
LLM_HUMAN_ROUTING_AUTO_THRESHOLD: float = _get_float(
    "LLM_HUMAN_ROUTING_AUTO_THRESHOLD",
    0.75,
)
LLM_HUMAN_ROUTING_REVIEW_THRESHOLD: float = _get_float(
    "LLM_HUMAN_ROUTING_REVIEW_THRESHOLD",
    0.45,
)
LLM_HUMAN_ROUTING_MAX_INPUT_CHARS: int = _get_int(
    "LLM_HUMAN_ROUTING_MAX_INPUT_CHARS",
    4000,
)
