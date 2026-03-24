"""CLI-backed candidate analysis sessions."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
from collections import deque
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .models import AnalysisResponse, PackedContext, SessionState

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CliSession:
    def __init__(
        self,
        domain: str,
        exec_path: str,
        base_args: str,
        model: str | None,
        prompt_mode: str,
        prompt_flag: str,
        model_flag: str,
        continue_flag: str,
        timeout_seconds: int,
        memory_char_budget: int,
    ) -> None:
        self.domain = domain
        self.exec_path = exec_path
        self.base_args = shlex.split(base_args) if base_args else []
        self.model = model
        self.prompt_mode = prompt_mode
        self.prompt_flag = prompt_flag
        self.model_flag = model_flag
        self.continue_flag = continue_flag
        self.timeout_seconds = timeout_seconds
        self.memory_char_budget = memory_char_budget
        self.state = SessionState(
            session_id=uuid4().hex,
            domain=domain,
            model=model,
            last_active_at=_now_iso(),
        )
        self._memory_entries: deque[str] = deque(maxlen=5)

    async def analyze(self, context: PackedContext) -> AnalysisResponse:
        prompt = self._compose_prompt(context)
        raw_text = await self._run(prompt)
        response = self._parse_response(raw_text)
        self._update_memory(context.entity, response)
        self.state.turn_count += 1
        self.state.last_active_at = _now_iso()
        return response

    def is_stale(self, max_idle_minutes: int = 30, max_turns: int = 50) -> bool:
        last_active = datetime.fromisoformat(self.state.last_active_at)
        idle_cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_idle_minutes)
        return self.state.turn_count >= max_turns or last_active < idle_cutoff

    async def _run(self, prompt: str) -> str:
        if not self.exec_path or self.exec_path == "mock":
            return self._mock_response(prompt)

        args = list(self.base_args)
        if self.model and self.model_flag:
            args.extend([self.model_flag, self.model])
        if self.continue_flag:
            args.extend([self.continue_flag, self.state.session_id])
        stdin_data: bytes | None = None
        if self.prompt_mode == "arg":
            if self.prompt_flag:
                args.extend([self.prompt_flag, prompt])
            else:
                args.append(prompt)
        else:
            if self.prompt_flag:
                args.append(self.prompt_flag)
            stdin_data = prompt.encode("utf-8")

        proc = await asyncio.create_subprocess_exec(
            self.exec_path,
            *args,
            stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ},
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin_data),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as exc:
            proc.kill()
            raise RuntimeError(f"analysis CLI timed out after {self.timeout_seconds}s") from exc

        if proc.returncode != 0:
            raise RuntimeError(
                f"analysis CLI failed ({proc.returncode}): {stderr.decode('utf-8', errors='ignore').strip()}"
            )
        return stdout.decode("utf-8", errors="ignore").strip()

    def _compose_prompt(self, context: PackedContext) -> str:
        memory = self.state.rolling_memory
        sections = []
        if memory:
            sections.append("Session memory:\n" + memory)
        sections.append("Analyze this candidate bundle and respond with JSON only.")
        sections.append(context.prompt)
        return "\n\n".join(sections)

    def _parse_response(self, raw_text: str) -> AnalysisResponse:
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            first_newline = cleaned.find("\n")
            last_fence = cleaned.rfind("```")
            if first_newline != -1 and last_fence > first_newline:
                cleaned = cleaned[first_newline + 1:last_fence].strip()

        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"analysis CLI returned invalid JSON: {cleaned[:300]}") from exc

        return AnalysisResponse(
            summary=str(data.get("summary", "")).strip(),
            confidence=max(0.0, min(1.0, float(data.get("confidence", 0.0) or 0.0))),
            desire_types=[str(item) for item in data.get("desire_types", []) if item],
            behavioral_signals=[str(item) for item in data.get("behavioral_signals", []) if item],
            demographic_hints=[str(item) for item in data.get("demographic_hints", []) if item],
            avg_intensity=data.get("avg_intensity"),
            open_questions=[str(item) for item in data.get("open_questions", []) if item],
        )

    def _update_memory(self, entity: str, response: AnalysisResponse) -> None:
        entry = f"{entity}: {response.summary}"
        self._memory_entries.append(entry[:300])
        joined = "\n".join(self._memory_entries)
        if len(joined) > self.memory_char_budget:
            joined = joined[-self.memory_char_budget :]
        self.state.rolling_memory = joined

    def _mock_response(self, prompt: str) -> str:
        entity = "candidate"
        marker = '"entity": "'
        if marker in prompt:
            start = prompt.index(marker) + len(marker)
            end = prompt.find('"', start)
            if end > start:
                entity = prompt[start:end]
        logger.info("Using mock analysis response for entity %s", entity)
        return json.dumps(
            {
                "summary": f"{entity} has cross-source momentum and merits watchlist tracking.",
                "confidence": 0.55,
                "desire_types": ["호기심"],
                "behavioral_signals": [f"사람들이 {entity} 관련 신호를 여러 소스에서 탐색하고 있다"],
                "demographic_hints": [],
                "avg_intensity": 0.5,
                "open_questions": [],
            },
            ensure_ascii=False,
        )


class SessionPool:
    def __init__(
        self,
        exec_path: str,
        base_args: str,
        model: str | None,
        prompt_mode: str,
        prompt_flag: str,
        model_flag: str,
        continue_flag: str,
        timeout_seconds: int,
        memory_char_budget: int,
    ) -> None:
        self.exec_path = exec_path
        self.base_args = base_args
        self.model = model
        self.prompt_mode = prompt_mode
        self.prompt_flag = prompt_flag
        self.model_flag = model_flag
        self.continue_flag = continue_flag
        self.timeout_seconds = timeout_seconds
        self.memory_char_budget = memory_char_budget
        self._sessions: dict[str, CliSession] = {}

    def acquire(self, domain: str) -> CliSession:
        session = self._sessions.get(domain)
        if session is None or session.is_stale():
            session = CliSession(
                domain=domain,
                exec_path=self.exec_path,
                base_args=self.base_args,
                model=self.model,
                prompt_mode=self.prompt_mode,
                prompt_flag=self.prompt_flag,
                model_flag=self.model_flag,
                continue_flag=self.continue_flag,
                timeout_seconds=self.timeout_seconds,
                memory_char_budget=self.memory_char_budget,
            )
            self._sessions[domain] = session
        return session

    def reset(self, domain: str) -> None:
        self._sessions.pop(domain, None)

    def list_states(self) -> list[SessionState]:
        return [session.state for session in self._sessions.values()]

