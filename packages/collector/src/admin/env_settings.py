"""Allowlisted .env editing for the collector dashboard."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


class EnvSettingsError(Exception):
    """Base error for dashboard env settings operations."""


class EnvSettingsUnavailableError(EnvSettingsError):
    """Raised when no editable .env file is available."""


class EnvSettingsValidationError(EnvSettingsError):
    """Raised when a requested key/value update is invalid."""


@dataclass(frozen=True)
class EditableEnvSetting:
    key: str
    label: str
    description: str
    section: str = "Collector"
    input_type: str = "text"
    restart_required: bool = True
    options: tuple[str, ...] = ()


EDITABLE_ENV_SETTINGS: tuple[EditableEnvSetting, ...] = (
    EditableEnvSetting(
        key="GOOGLE_TRENDS_GEO",
        label="Google Trends Regions",
        description="Comma-separated geo codes used by the Google Trends connector.",
    ),
    EditableEnvSetting(
        key="REDDIT_USER_AGENT",
        label="Reddit User Agent",
        description="User-Agent string sent by the Reddit connector.",
    ),
    EditableEnvSetting(
        key="SOURCE_RUN_WORKER_CONCURRENCY",
        label="Source Worker Concurrency",
        description="Number of workers processing queued source runs.",
        section="Runtime",
        input_type="integer",
    ),
    EditableEnvSetting(
        key="SOURCE_BOOTSTRAP_ON_START",
        label="Bootstrap Sources On Start",
        description="Run scheduled source bootstrap automatically when collector starts.",
        section="Runtime",
        input_type="boolean",
    ),
    EditableEnvSetting(
        key="LLM_ANALYSIS_ENABLED",
        label="Collector Analysis Enabled",
        description="Enable collector-side candidate analysis.",
        section="Analysis",
        input_type="boolean",
    ),
    EditableEnvSetting(
        key="LLM_ANALYSIS_EXECUTION_MODE",
        label="Analysis Execution Mode",
        description="Execution mode used for collector candidate analysis.",
        section="Analysis",
        input_type="select",
        options=("batch", "fresh"),
    ),
    EditableEnvSetting(
        key="LLM_ANALYSIS_BATCH_SIZE",
        label="Analysis Batch Size",
        description="Number of candidate tasks grouped into each collector analysis batch.",
        section="Analysis",
        input_type="integer",
    ),
    EditableEnvSetting(
        key="LLM_DEFAULT_MODEL",
        label="Default Analysis Model",
        description="Default model name passed to the collector CLI adapter.",
        section="Analysis",
    ),
    EditableEnvSetting(
        key="LLM_TIMEOUT_SECONDS",
        label="Analysis Timeout Seconds",
        description="Timeout for each collector-side CLI analysis execution.",
        section="Analysis",
        input_type="integer",
    ),
    EditableEnvSetting(
        key="LLM_HUMAN_ROUTING_ENABLED",
        label="Human Routing Enabled",
        description="Enable collector-side routing of free-form human input.",
        section="Human Routing",
        input_type="boolean",
    ),
    EditableEnvSetting(
        key="LLM_HUMAN_ROUTING_EXECUTION_MODE",
        label="Human Routing Execution Mode",
        description="Execution mode for the human input routing model.",
        section="Human Routing",
        input_type="select",
        options=("fresh", "batch"),
    ),
    EditableEnvSetting(
        key="LLM_HUMAN_ROUTING_MODEL",
        label="Human Routing Model",
        description="Model used for human input routing.",
        section="Human Routing",
    ),
    EditableEnvSetting(
        key="LLM_HUMAN_ROUTING_AUTO_THRESHOLD",
        label="Routing Auto Threshold",
        description="Confidence threshold for automatic routing.",
        section="Human Routing",
        input_type="float",
    ),
    EditableEnvSetting(
        key="LLM_HUMAN_ROUTING_REVIEW_THRESHOLD",
        label="Routing Review Threshold",
        description="Confidence threshold below which a message is kept for review.",
        section="Human Routing",
        input_type="float",
    ),
    EditableEnvSetting(
        key="LLM_HUMAN_ROUTING_MAX_INPUT_CHARS",
        label="Routing Max Input Chars",
        description="Maximum text length passed into the routing classifier.",
        section="Human Routing",
        input_type="integer",
    ),
    EditableEnvSetting(
        key="LLM_SOURCE_AGENT_ENABLED",
        label="Source Agents Enabled",
        description="Enable collector source-agent execution after source submissions.",
        section="Source Agents",
        input_type="boolean",
    ),
    EditableEnvSetting(
        key="LLM_SOURCE_AGENT_EXECUTION_MODE",
        label="Source Agent Execution Mode",
        description="Execution mode used by collector source agents.",
        section="Source Agents",
        input_type="select",
        options=("fresh", "resume"),
    ),
    EditableEnvSetting(
        key="LLM_SOURCE_AGENT_MAX_INPUT_CHARS",
        label="Source Agent Max Input Chars",
        description="Maximum prompt context size passed into a source-agent run.",
        section="Source Agents",
        input_type="integer",
    ),
)


class EnvSettingsService:
    """Read and update a safe subset of the repository env file."""

    def __init__(self, env_file: str | Path | None = None) -> None:
        self._env_file = self._resolve_env_file(env_file)
        self._settings = {setting.key: setting for setting in EDITABLE_ENV_SETTINGS}

    @property
    def available(self) -> bool:
        return self._env_file is not None

    @property
    def env_file_path(self) -> str | None:
        return str(self._env_file) if self._env_file is not None else None

    def read(self) -> dict[str, Any]:
        if self._env_file is None:
            return {
                "available": False,
                "env_file_path": None,
                "settings": [],
            }

        current = self._read_env_map(self._env_file)
        settings = []
        for definition in EDITABLE_ENV_SETTINGS:
            value = current.get(definition.key, os.environ.get(definition.key, ""))
            settings.append(
                {
                    "key": definition.key,
                    "label": definition.label,
                    "description": definition.description,
                    "section": definition.section,
                    "input_type": definition.input_type,
                    "restart_required": definition.restart_required,
                    "value": value,
                    "options": list(definition.options),
                }
            )
        return {
            "available": True,
            "env_file_path": str(self._env_file),
            "settings": settings,
        }

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        if self._env_file is None:
            raise EnvSettingsUnavailableError("Editable .env file was not found")
        if not changes:
            raise EnvSettingsValidationError("No settings were provided")

        validated: dict[str, str] = {}
        for key, raw_value in changes.items():
            setting = self._settings.get(key)
            if setting is None:
                raise EnvSettingsValidationError(f"Unsupported setting key: {key}")
            validated[key] = self._normalize_value(setting, raw_value)

        lines = self._env_file.read_text(encoding="utf-8").splitlines(keepends=True)
        updated_lines = list(lines)
        existing_keys: set[str] = set()

        for index, line in enumerate(updated_lines):
            match = _ENV_LINE_RE.match(line.strip())
            if match is None:
                continue
            key = match.group(1)
            if key not in validated:
                continue
            updated_lines[index] = f"{key}={validated[key]}\n"
            existing_keys.add(key)

        if validated.keys() - existing_keys:
            if updated_lines and not updated_lines[-1].endswith("\n"):
                updated_lines[-1] += "\n"
            updated_lines.append("\n# Collector dashboard managed settings\n")
            for key in validated:
                if key in existing_keys:
                    continue
                updated_lines.append(f"{key}={validated[key]}\n")

        self._env_file.write_text("".join(updated_lines), encoding="utf-8")

        return {
            "available": True,
            "env_file_path": str(self._env_file),
            "updated_keys": list(validated.keys()),
            "restart_required": True,
            "settings": self.read()["settings"],
        }

    def _normalize_value(self, setting: EditableEnvSetting, raw_value: Any) -> str:
        text = "" if raw_value is None else str(raw_value).strip()

        if setting.input_type == "boolean":
            lowered = text.lower()
            truthy = {"true", "1", "yes", "on"}
            falsy = {"false", "0", "no", "off"}
            if lowered in truthy:
                return "true"
            if lowered in falsy:
                return "false"
            raise EnvSettingsValidationError(f"{setting.key} expects a boolean value")

        if setting.input_type == "integer":
            try:
                return str(int(text))
            except ValueError as exc:
                raise EnvSettingsValidationError(
                    f"{setting.key} expects an integer value"
                ) from exc

        if setting.input_type == "float":
            try:
                return str(float(text))
            except ValueError as exc:
                raise EnvSettingsValidationError(
                    f"{setting.key} expects a float value"
                ) from exc

        if setting.input_type == "select":
            if text not in setting.options:
                allowed = ", ".join(setting.options)
                raise EnvSettingsValidationError(
                    f"{setting.key} expects one of: {allowed}"
                )
            return text

        return text

    def _resolve_env_file(self, env_file: str | Path | None) -> Path | None:
        if env_file is not None:
            path = Path(env_file).expanduser().resolve()
            return path if path.exists() else None

        explicit = os.environ.get("COLLECTOR_ADMIN_ENV_FILE")
        if explicit:
            path = Path(explicit).expanduser().resolve()
            return path if path.exists() else None

        search_roots = [Path.cwd(), Path(__file__).resolve()]
        for root in search_roots:
            for parent in [root, *root.parents]:
                candidate = parent / ".env"
                if candidate.exists():
                    return candidate.resolve()
        return None

    def _read_env_map(self, path: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            match = _ENV_LINE_RE.match(line)
            if match is None:
                continue
            values[match.group(1)] = match.group(2)
        return values
