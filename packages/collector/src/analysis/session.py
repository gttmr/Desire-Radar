"""CLI-backed candidate analysis sessions."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .models import (
    AnalysisResponse,
    ExecutionResult,
    ExecutionUsage,
    PackedContext,
    RawExecutionResult,
    SessionState,
)

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CliSession:
    def __init__(
        self,
        domain: str,
        provider: str,
        exec_path: str,
        initial_args: str,
        resume_args: str,
        model: str | None,
        model_flag: str,
        timeout_seconds: int,
        memory_char_budget: int,
        memory_entry_count: int,
        memory_entry_char_budget: int,
        max_idle_minutes: int,
        max_turns: int,
        max_uncached_input_tokens: int,
        parse_error_snippet_chars: int,
        use_stdin: bool,
        base_args: str = "",
        prompt_mode: str = "stdin",
        prompt_flag: str = "",
        continue_flag: str = "",
        working_dir: str | None = None,
    ) -> None:
        self.domain = domain
        self.provider = provider
        self.exec_path = exec_path
        self.initial_args = shlex.split(initial_args) if initial_args else []
        self.resume_args = shlex.split(resume_args) if resume_args else []
        self.model = model
        self.model_flag = model_flag
        self.timeout_seconds = timeout_seconds
        self.memory_char_budget = memory_char_budget
        self.memory_entry_char_budget = memory_entry_char_budget
        self.max_idle_minutes = max_idle_minutes
        self.max_turns = max_turns
        self.max_uncached_input_tokens = max_uncached_input_tokens
        self.parse_error_snippet_chars = parse_error_snippet_chars
        self.use_stdin = use_stdin
        self.base_args = shlex.split(base_args) if base_args else []
        self.prompt_mode = prompt_mode
        self.prompt_flag = prompt_flag
        self.continue_flag = continue_flag
        self.working_dir = os.path.abspath(working_dir or "/tmp")
        os.makedirs(self.working_dir, exist_ok=True)
        logical_session_id = uuid4().hex
        self.state = SessionState(
            session_id=logical_session_id,
            logical_session_id=logical_session_id,
            provider_session_id=None,
            domain=domain,
            model=model,
            session_dir=self.working_dir,
            last_active_at=_now_iso(),
        )
        self._memory_entries: deque[str] = deque(maxlen=memory_entry_count)

    async def execute(
        self,
        context: PackedContext,
        *,
        execution_mode: str,
    ) -> ExecutionResult:
        prompt = self._compose_prompt(context) if execution_mode == "resume" else context.prompt
        turn_index = self.state.turn_count + 1
        self._write_artifact(
            turn_index,
            "request",
            {
                "logical_session_id": self.state.logical_session_id or self.state.session_id,
                "provider_session_id": self.state.provider_session_id,
                "transport_mode": self.state.transport_mode,
                "domain": self.domain,
                "provider": self.provider,
                "execution_mode": execution_mode,
                "response_mode": context.response_mode,
                "bundle": context.bundle.model_dump(),
                "prompt": prompt,
                "created_at": _now_iso(),
            },
        )
        if not self.exec_path or self.exec_path == "mock":
            result = self._mock_result(context)
        elif self.provider == "codex":
            result = await self._run_codex(prompt, context, execution_mode=execution_mode)
        else:
            result = await self._run_generic(prompt, context, execution_mode=execution_mode)

        if execution_mode == "resume":
            self._update_memory(result.responses)
        self.state.turn_count += 1
        self.state.last_active_at = _now_iso()
        self.state.total_input_tokens += result.usage.input_tokens
        self.state.total_cached_input_tokens += result.usage.cached_input_tokens
        self.state.total_uncached_input_tokens += result.usage.uncached_input_tokens
        self.state.provider_session_id = result.session_id
        self.state.session_id = result.session_id
        self._write_artifact(
            turn_index,
            "response",
            {
                "logical_session_id": self.state.logical_session_id or self.state.session_id,
                "provider_session_id": result.session_id,
                "domain": self.domain,
                "provider": self.provider,
                "execution_mode": execution_mode,
                "status": "completed",
                "responses": [response.model_dump() for response in result.responses],
                "usage": result.usage.model_dump(),
                "raw_text": result.raw_text,
                "created_at": _now_iso(),
            },
        )
        return result

    async def execute_json(
        self,
        prompt: str,
        *,
        execution_mode: str,
    ) -> RawExecutionResult:
        turn_index = self.state.turn_count + 1
        request_artifact_path = self._artifact_path(turn_index, "request")
        response_artifact_path = self._artifact_path(turn_index, "response")
        self._write_artifact(
            turn_index,
            "request",
            {
                "logical_session_id": self.state.logical_session_id or self.state.session_id,
                "provider_session_id": self.state.provider_session_id,
                "transport_mode": self.state.transport_mode,
                "domain": self.domain,
                "provider": self.provider,
                "execution_mode": execution_mode,
                "response_mode": "json",
                "prompt": prompt,
                "created_at": _now_iso(),
            },
        )
        if not self.exec_path or self.exec_path == "mock":
            payload = {"route": "needs_review", "confidence": 0.0, "reason": "mock_cli"}
            result = RawExecutionResult(
                session_id=self.state.session_id,
                model=self.model,
                payload=payload,
                usage=ExecutionUsage(),
                raw_text=json.dumps(payload),
                session_dir=self.working_dir,
                turn_index=turn_index,
                request_artifact_path=request_artifact_path,
                response_artifact_path=response_artifact_path,
            )
        elif self.provider == "codex":
            message_text, usage, thread_id, raw_text = await self._invoke_codex(
                prompt,
                execution_mode=execution_mode,
            )
            result = RawExecutionResult(
                session_id=thread_id or self.state.session_id,
                model=self.model,
                payload=self._parse_json_payload(message_text),
                usage=usage,
                raw_text=raw_text,
                session_dir=self.working_dir,
                turn_index=turn_index,
                request_artifact_path=request_artifact_path,
                response_artifact_path=response_artifact_path,
            )
        else:
            message_text, usage, session_id, raw_text = await self._invoke_generic(
                prompt,
                execution_mode=execution_mode,
            )
            result = RawExecutionResult(
                session_id=session_id,
                model=self.model,
                payload=self._parse_json_payload(message_text),
                usage=usage,
                raw_text=raw_text,
                session_dir=self.working_dir,
                turn_index=turn_index,
                request_artifact_path=request_artifact_path,
                response_artifact_path=response_artifact_path,
            )

        self.state.turn_count += 1
        self.state.last_active_at = _now_iso()
        self.state.total_input_tokens += result.usage.input_tokens
        self.state.total_cached_input_tokens += result.usage.cached_input_tokens
        self.state.total_uncached_input_tokens += result.usage.uncached_input_tokens
        self.state.provider_session_id = result.session_id
        self.state.session_id = result.session_id
        self._write_artifact(
            turn_index,
            "response",
            {
                "logical_session_id": self.state.logical_session_id or self.state.session_id,
                "provider_session_id": result.session_id,
                "domain": self.domain,
                "provider": self.provider,
                "execution_mode": execution_mode,
                "status": "completed",
                "payload": result.payload,
                "usage": result.usage.model_dump(),
                "raw_text": result.raw_text,
                "created_at": _now_iso(),
            },
        )
        return result

    def is_stale(self) -> bool:
        last_active = datetime.fromisoformat(self.state.last_active_at)
        idle_cutoff = datetime.now(timezone.utc) - timedelta(minutes=self.max_idle_minutes)
        return (
            self.state.turn_count >= self.max_turns
            or last_active < idle_cutoff
            or self.state.total_uncached_input_tokens >= self.max_uncached_input_tokens
        )

    def _compose_prompt(self, context: PackedContext) -> str:
        memory = self.state.rolling_memory
        sections = []
        if memory:
            sections.append("Session memory:\n" + memory)
        sections.append(context.prompt)
        return "\n\n".join(sections)

    async def _run_codex(
        self,
        prompt: str,
        context: PackedContext,
        *,
        execution_mode: str,
    ) -> ExecutionResult:
        message_text, usage, thread_id, raw_text = await self._invoke_codex(
            prompt,
            execution_mode=execution_mode,
        )
        responses = self._parse_response_payload(message_text, context.response_mode)
        return ExecutionResult(
            session_id=thread_id or self.state.session_id,
            model=self.model,
            responses=responses,
            usage=usage,
            raw_text=raw_text,
        )

    def _build_codex_invocation(
        self,
        prompt: str,
        *,
        execution_mode: str,
    ) -> tuple[list[str], bytes | None]:
        use_resume = execution_mode == "resume" and self.resume_args and self.state.turn_count > 0
        if use_resume:
            args = self._sanitize_codex_args(self.resume_args, allow_ephemeral=False)
        else:
            args = self._sanitize_codex_args(
                self.initial_args,
                allow_ephemeral=False,
            )
            if self.working_dir:
                args.extend(["-C", self.working_dir])

        if self.model and self.model_flag:
            args.extend([self.model_flag, self.model])
        if use_resume:
            args.append(self.state.provider_session_id or self.state.session_id)

        stdin_data: bytes | None = None
        if self.use_stdin:
            args.append("-")
            stdin_data = prompt.encode("utf-8")
        else:
            args.append(prompt)
        return args, stdin_data

    def _sanitize_codex_args(
        self,
        raw_args: list[str],
        *,
        allow_ephemeral: bool,
    ) -> list[str]:
        sanitized: list[str] = []
        skip_next = False
        for arg in raw_args:
            if skip_next:
                skip_next = False
                continue
            if arg == "-":
                continue
            if not allow_ephemeral and arg == "--ephemeral":
                continue
            if arg in {"-C", "--cd"}:
                skip_next = True
                continue
            sanitized.append(arg)
        return sanitized

    async def _run_generic(
        self,
        prompt: str,
        context: PackedContext,
        *,
        execution_mode: str,
    ) -> ExecutionResult:
        message_text, usage, session_id, raw_text = await self._invoke_generic(
            prompt,
            execution_mode=execution_mode,
        )
        responses = self._parse_response_payload(message_text, context.response_mode)
        return ExecutionResult(
            session_id=session_id,
            model=self.model,
            responses=responses,
            usage=usage,
            raw_text=raw_text,
        )

    async def _invoke_codex(
        self,
        prompt: str,
        *,
        execution_mode: str,
    ) -> tuple[str, ExecutionUsage, str | None, str]:
        args, stdin_data = self._build_codex_invocation(prompt, execution_mode=execution_mode)

        proc = await asyncio.create_subprocess_exec(
            self.exec_path,
            *args,
            stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.working_dir,
            env={**os.environ},
        )
        started = time.perf_counter()
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin_data),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as exc:
            proc.kill()
            try:
                await proc.communicate()
            except Exception:
                pass
            raise RuntimeError(f"analysis CLI timed out after {self.timeout_seconds}s") from exc

        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        if proc.returncode != 0:
            raise RuntimeError(
                f"analysis CLI failed ({proc.returncode}): {stderr.decode('utf-8', errors='ignore').strip()}"
            )

        raw_text = stdout.decode("utf-8", errors="ignore").strip()
        message_text, usage, thread_id = self._extract_codex_message(raw_text)
        usage.elapsed_ms = elapsed_ms
        return message_text, usage, thread_id, raw_text

    async def _invoke_generic(
        self,
        prompt: str,
        *,
        execution_mode: str,
    ) -> tuple[str, ExecutionUsage, str, str]:
        args = list(self.base_args)
        if self.model and self.model_flag:
            args.extend([self.model_flag, self.model])
        if execution_mode == "resume" and self.continue_flag and self.state.turn_count > 0:
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
            cwd=self.working_dir,
            env={**os.environ},
        )
        started = time.perf_counter()
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(stdin_data),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as exc:
            proc.kill()
            try:
                await proc.communicate()
            except Exception:
                pass
            raise RuntimeError(f"analysis CLI timed out after {self.timeout_seconds}s") from exc

        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        if proc.returncode != 0:
            raise RuntimeError(
                f"analysis CLI failed ({proc.returncode}): {stderr.decode('utf-8', errors='ignore').strip()}"
            )

        raw_text = stdout.decode("utf-8", errors="ignore").strip()
        return raw_text, ExecutionUsage(elapsed_ms=elapsed_ms), self.state.session_id, raw_text

    def _parse_codex_jsonl(
        self,
        raw_text: str,
        response_mode: str,
    ) -> tuple[list[AnalysisResponse], ExecutionUsage, str | None]:
        message_text, usage, thread_id = self._extract_codex_message(raw_text)
        return self._parse_response_payload(message_text, response_mode), usage, thread_id

    def _extract_codex_message(
        self,
        raw_text: str,
    ) -> tuple[str, ExecutionUsage, str | None]:
        thread_id: str | None = None
        message_text: str | None = None
        usage = ExecutionUsage()

        for line in raw_text.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "thread.started":
                thread_id = obj.get("thread_id")
            elif obj.get("type") == "item.completed":
                item = obj.get("item", {})
                if item.get("type") == "agent_message":
                    message_text = item.get("text", "")
            elif obj.get("type") == "turn.completed":
                usage.input_tokens = int(obj.get("usage", {}).get("input_tokens", 0) or 0)
                usage.cached_input_tokens = int(obj.get("usage", {}).get("cached_input_tokens", 0) or 0)
                usage.output_tokens = int(obj.get("usage", {}).get("output_tokens", 0) or 0)
                usage.uncached_input_tokens = usage.input_tokens - usage.cached_input_tokens

        if not message_text:
            snippet = raw_text[: self.parse_error_snippet_chars]
            raise RuntimeError(f"codex JSONL did not include agent_message: {snippet}")

        return message_text, usage, thread_id

    def _write_artifact(
        self,
        turn_index: int,
        kind: str,
        payload: dict[str, object],
    ) -> None:
        artifacts_dir = os.path.join(self.working_dir, "artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        file_path = os.path.join(
            artifacts_dir,
            f"turn-{turn_index:04d}-{kind}.json",
        )
        with open(file_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

    def _artifact_path(self, turn_index: int, kind: str) -> str:
        artifacts_dir = os.path.join(self.working_dir, "artifacts")
        return os.path.join(
            artifacts_dir,
            f"turn-{turn_index:04d}-{kind}.json",
        )

    def _parse_json_payload(self, raw_text: str) -> object:
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            first_newline = cleaned.find("\n")
            last_fence = cleaned.rfind("```")
            if first_newline != -1 and last_fence > first_newline:
                cleaned = cleaned[first_newline + 1:last_fence].strip()

        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as exc:
            snippet = cleaned[: self.parse_error_snippet_chars]
            raise RuntimeError(f"analysis CLI returned invalid JSON: {snippet}") from exc

    def _parse_response_payload(
        self,
        raw_text: str,
        response_mode: str,
    ) -> list[AnalysisResponse]:
        data = self._parse_json_payload(raw_text)

        if response_mode == "batch":
            if not isinstance(data, list):
                raise RuntimeError("batch response must be a JSON array")
            return [self._to_response(item) for item in data]

        if isinstance(data, list):
            if len(data) != 1:
                raise RuntimeError("single response expected exactly one JSON object")
            data = data[0]

        return [self._to_response(data)]

    def _to_response(self, data: object) -> AnalysisResponse:
        if not isinstance(data, dict):
            raise RuntimeError("analysis response item must be an object")
        return AnalysisResponse(
            entity=str(data.get("entity")).strip() if data.get("entity") else None,
            summary=str(data.get("summary", "")).strip(),
            confidence=max(0.0, min(1.0, float(data.get("confidence", 0.0) or 0.0))),
            desire_types=[str(item) for item in data.get("desire_types", []) if item],
            behavioral_signals=[str(item) for item in data.get("behavioral_signals", []) if item],
            demographic_hints=[str(item) for item in data.get("demographic_hints", []) if item],
            avg_intensity=data.get("avg_intensity"),
            open_questions=[str(item) for item in data.get("open_questions", []) if item],
        )

    def _update_memory(self, responses: list[AnalysisResponse]) -> None:
        for response in responses:
            entity = response.entity or "candidate"
            entry = f"{entity}: {response.summary}"
            self._memory_entries.append(entry[: self.memory_entry_char_budget])
        joined = "\n".join(self._memory_entries)
        if len(joined) > self.memory_char_budget:
            joined = joined[-self.memory_char_budget :]
        self.state.rolling_memory = joined

    def _mock_result(self, context: PackedContext) -> ExecutionResult:
        if context.response_mode == "batch":
            responses = [
                AnalysisResponse(
                    entity=entity,
                    summary=f"{entity} has cross-source momentum and merits watchlist tracking.",
                    confidence=0.55,
                    desire_types=["호기심"],
                    behavioral_signals=[f"사람들이 {entity} 관련 신호를 여러 소스에서 탐색하고 있다"],
                    demographic_hints=[],
                    avg_intensity=0.5,
                    open_questions=[],
                )
                for entity in context.entities
            ]
        else:
            entity = context.entity or (context.entities[0] if context.entities else "candidate")
            responses = [
                AnalysisResponse(
                    entity=entity,
                    summary=f"{entity} has cross-source momentum and merits watchlist tracking.",
                    confidence=0.55,
                    desire_types=["호기심"],
                    behavioral_signals=[f"사람들이 {entity} 관련 신호를 여러 소스에서 탐색하고 있다"],
                    demographic_hints=[],
                    avg_intensity=0.5,
                    open_questions=[],
                )
            ]

        return ExecutionResult(
            session_id=self.state.session_id,
            model=self.model,
            responses=responses,
            usage=ExecutionUsage(
                input_tokens=context.estimated_input_tokens,
                cached_input_tokens=0,
                output_tokens=64 * max(1, len(responses)),
                uncached_input_tokens=context.estimated_input_tokens,
                elapsed_ms=0.0,
            ),
            raw_text=json.dumps([item.model_dump() for item in responses], ensure_ascii=False),
        )


class SessionPool:
    def __init__(
        self,
        exec_path: str,
        provider: str,
        initial_args: str,
        resume_args: str,
        model: str | None,
        model_flag: str,
        timeout_seconds: int,
        memory_char_budget: int,
        memory_entry_count: int,
        memory_entry_char_budget: int,
        max_idle_minutes: int,
        max_turns: int,
        max_uncached_input_tokens: int,
        parse_error_snippet_chars: int,
        use_stdin: bool,
        session_workdir_root: str = "data/llm-session-workdirs",
        *,
        base_args: str = "",
        prompt_mode: str = "stdin",
        prompt_flag: str = "",
        continue_flag: str = "",
    ) -> None:
        self.exec_path = exec_path
        self.provider = provider
        self.initial_args = initial_args
        self.resume_args = resume_args
        self.model = model
        self.model_flag = model_flag
        self.timeout_seconds = timeout_seconds
        self.memory_char_budget = memory_char_budget
        self.memory_entry_count = memory_entry_count
        self.memory_entry_char_budget = memory_entry_char_budget
        self.max_idle_minutes = max_idle_minutes
        self.max_turns = max_turns
        self.max_uncached_input_tokens = max_uncached_input_tokens
        self.parse_error_snippet_chars = parse_error_snippet_chars
        self.use_stdin = use_stdin
        self.session_workdir_root = session_workdir_root
        self.base_args = base_args
        self.prompt_mode = prompt_mode
        self.prompt_flag = prompt_flag
        self.continue_flag = continue_flag
        self._sessions: dict[str, CliSession] = {}

    async def execute(
        self,
        context: PackedContext,
        *,
        domain: str,
        execution_mode: str,
    ) -> ExecutionResult:
        if execution_mode == "resume":
            session = self._sessions.get(domain)
            if session is None or session.is_stale():
                session = self._new_session(domain)
                self._sessions[domain] = session
        else:
            session = self._new_session(domain)

        result = await session.execute(context, execution_mode=execution_mode)

        if execution_mode == "resume":
            if session.is_stale():
                self._sessions.pop(domain, None)
            else:
                self._sessions[domain] = session

        return result

    async def execute_json(
        self,
        prompt: str,
        *,
        domain: str,
        execution_mode: str,
    ) -> RawExecutionResult:
        if execution_mode == "resume":
            session = self._sessions.get(domain)
            if session is None or session.is_stale():
                session = self._new_session(domain)
                self._sessions[domain] = session
        else:
            session = self._new_session(domain)

        result = await session.execute_json(prompt, execution_mode=execution_mode)

        if execution_mode == "resume":
            if session.is_stale():
                self._sessions.pop(domain, None)
            else:
                self._sessions[domain] = session

        return result

    def reset(self, domain: str) -> None:
        self._sessions.pop(domain, None)

    def list_states(self) -> list[SessionState]:
        return [session.state for session in self._sessions.values()]

    def _new_session(self, domain: str) -> CliSession:
        working_dir = os.path.join(
            self.session_workdir_root,
            self.provider,
            _sanitize_path_segment(domain),
            uuid4().hex,
        )
        return CliSession(
            domain=domain,
            provider=self.provider,
            exec_path=self.exec_path,
            initial_args=self.initial_args,
            resume_args=self.resume_args,
            model=self.model,
            model_flag=self.model_flag,
            timeout_seconds=self.timeout_seconds,
            memory_char_budget=self.memory_char_budget,
            memory_entry_count=self.memory_entry_count,
            memory_entry_char_budget=self.memory_entry_char_budget,
            max_idle_minutes=self.max_idle_minutes,
            max_turns=self.max_turns,
            max_uncached_input_tokens=self.max_uncached_input_tokens,
            parse_error_snippet_chars=self.parse_error_snippet_chars,
            use_stdin=self.use_stdin,
            base_args=self.base_args,
            prompt_mode=self.prompt_mode,
            prompt_flag=self.prompt_flag,
            continue_flag=self.continue_flag,
            working_dir=working_dir,
        )


def _sanitize_path_segment(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {".", "_", "-"} else "-" for char in value.strip())
    cleaned = cleaned.strip("-")
    return cleaned or "default"
