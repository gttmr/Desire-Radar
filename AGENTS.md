# Agentic-World Codex Guide

## Purpose
This repository builds an evidence pipeline for early desire detection and investment research. The main product path is `collector -> mcp-orchestrator -> discord-bot`. Keep work aligned with that path unless a task explicitly targets compatibility code.

## Read This First
- [README.md](README.md): runtime setup, operator workflow, API surface.
- [ARCHITECTURE.md](ARCHITECTURE.md): service boundaries, abstractions, extension rules.
- [RUNBOOK.md](RUNBOOK.md): WSL-first local runtime, rebuild, smoke, and troubleshooting procedures.
- `packages/mcp-orchestrator/src/agents/*.md`: analysis-agent prompts used by the orchestrator.

Do not duplicate architecture or product rationale in this file. Keep this file focused on how Codex should work in the repo.

## Working Rules
- Preserve raw evidence. Do not let derived analysis overwrite source facts.
- Work from WSL, not PowerShell, unless a task explicitly requires the Windows host.
- Respect service boundaries.
  - `collector`: ingestion, provenance, source registry, submissions, low-cost analysis.
  - `mcp-orchestrator`: debate, research loop, verdict, reports.
  - `discord-bot`: human/control surface and operational alerts.
- When schemas or APIs change, update producers and consumers in the same change.
- Prefer small, testable changes over broad rewrites.
- If a CLI provider changes behavior, fix the adapter layer first. Do not spread provider-specific parsing or flags across the codebase.

## CLI And Provider Discipline
- Treat provider CLIs as unstable integration points.
- Prefer structured output modes such as JSON or JSONL when available.
- Parse outputs permissively and classify failures by category, not exact message text.
- Do not hardcode logic to one rate-limit string, auth prompt, or warning format.
- Keep repair commands configurable. Do not embed brittle login automation directly in business logic.
- When changing provider adapters, add adapter-level tests and update smoke tooling if needed.

## Common Commands
- Install JS workspaces: `npm install`
- Run Discord bot from WSL: `npm run dev:bot`
- Run orchestrator from WSL: `npm run dev:orchestrator`
- TypeScript build: `npm run build`
- Collector tests:
  - `cd packages/collector && PYTHONPATH=. python3 -m pytest -s`
  - Prefer targeted test files when changing one subsystem.
- Orchestrator build:
  - `cd packages/mcp-orchestrator && npm run build`
- Provider smoke:
  - `npm --prefix packages/mcp-orchestrator run smoke:providers`

## WSL Runtime Assumption
- Prefer native WSL tools and paths.
- Do not rely on Windows `node.exe`, PowerShell-specific commands, or Windows-only PATH propagation for normal development.
- If a command works only through Windows binaries, treat that as an environment exception and document it in [RUNBOOK.md](RUNBOOK.md).
- Docker workflows should be launched from WSL so `${HOME}`-based CLI auth mounts resolve to the Linux-side home directory.

## Documentation Expectations
- Update [ARCHITECTURE.md](ARCHITECTURE.md) when changing service boundaries, abstractions, or extension points.
- Update [README.md](README.md) when changing runtime setup, operator workflow, or public API expectations.
- Update [RUNBOOK.md](RUNBOOK.md) when changing local startup steps, health checks, provider auth expectations, or known runtime failure modes.
- Keep agent prompt intent documented in the prompt file itself when adding a new orchestrator agent.

## Testing Expectations
- Run the narrowest tests that prove the change.
- For provider adapter changes, prefer:
  - adapter unit tests
  - health/route tests if the health payload changes
  - real smoke only when the task depends on live CLI behavior
- If a tool in this environment is known-broken, say so clearly and use the strongest available fallback evidence.

## Subagent Policy
- Use Codex subagents aggressively for parallel exploration, bounded implementation, and verification when it shortens the critical path.
- Keep ownership clear when multiple agents edit in parallel.
- Use subagents to answer concrete questions or own isolated write scopes, not to duplicate the same investigation.

## Git Hygiene
- Keep commits scoped to one meaningful change.
- Push progress when a work unit is stable.
- Avoid mixing user-owned local edits into your commits.
- If you need a branch, use the `codex/` prefix unless the user explicitly asks to work on another branch.
