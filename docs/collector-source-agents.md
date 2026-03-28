# Collector Source-Agents

This document is the living design note for collector-owned source-agents.

Use it for:
- explaining why source-agents exist
- keeping source-agent contracts stable while provider transports change
- recording decisions and open questions as the design evolves

## Purpose

Collector source-agents exist to enrich a single source submission after raw evidence has already been preserved.

They are meant to:
- summarize what a source run is actually about
- add event, theme, and relationship structure
- emit optional derived evidence with explicit provenance

They are not meant to:
- overwrite raw evidence
- replace normalization or entity resolution
- make final investment judgments

Final investment judgment stays in the orchestrator.

## Terms

`source`
- a collector registry entry with kind, ingestion mode, capabilities, tier, validity, and runtime state

`source-agent`
- a collector-owned prompt and execution policy attached to a source

`collector-owned source-agent`
- a source-agent run by collector through the shared CLI transport/session layer

`external push agent`
- a producer outside collector that submits raw envelopes or normalized evidence through collector APIs

`analysis provider session`
- a collector or orchestrator LLM transport session used to talk to a provider CLI

`source-agent artifact`
- the persisted record of a source-agent request, response, parsed decision, and optional derived evidence ids

## Scope and Non-Goals

Source-agents sit inside collector's ingestion pipeline.

They are responsible for:
- source submission level enrichment
- artifact-first execution
- optional derived evidence creation
- source-specific prompt behavior through `agent.md`

They are not responsible for:
- candidate-level investment reasoning
- verdict generation
- source-specific provider/model selection

Provider/model settings stay global to collector.

## Placement in the Current Architecture

The source-agent execution path is:

1. raw snapshot persistence
2. normalization
3. entity resolution
4. raw evidence persistence
5. source-agent execution
6. source-agent artifact persistence
7. optional derived evidence persistence
8. candidate and candidate-analysis enqueue

Important invariant:
- source-agent failure must never roll back raw evidence persistence

Important boundary:
- source-agent output can add structure, but it cannot rewrite source facts

## Source-Agent Types

### Collector-Owned Runnable Source-Agent

This is the default design target.

Properties:
- has a prompt file under `packages/collector/src/agents/sources/<source_id>.md`
- runs through collector's shared session pool
- stores artifacts in collector-owned storage

### External Push Agent

This is already supported through collector ingest APIs.

Properties:
- collector does not execute the prompt itself
- caller provides raw or normalized evidence
- collector still preserves provenance and submission state

### Derived / Helper Agent

This is a future-facing category for agents that help create derived evidence or research structure.

Properties:
- still constrained by collector's raw-evidence-first rule
- should emit artifacts and derived evidence, not verdicts

## Contracts

Each source can expose the following source-agent metadata:

- `agent_enabled`
- `agent_prompt_path`
- `agent_session_domain`
- `agent_output_mode`

Each submission may expose source-agent metadata:

- `source_agent_status`
- `source_agent_artifact_id`
- `derived_evidence_ids`

Each source-agent artifact stores:

- source id
- submission id
- logical session domain
- provider session id and session dir when available
- request/response artifact paths when available
- parsed summary, confidence, warnings, theme tags
- optional entity hints, relationship hints, event summary
- derived evidence ids
- raw response text
- usage metrics

## Session Model

Source-agents use a logical session domain:

`source-agent:<source_id>`

This is separate from candidate-analysis domains.

Session workdirs follow the collector-wide workdir root:

`LLM_SESSION_WORKDIR_ROOT/<provider>/source-agent/<source_id>/<session_id>/`

Current default transport:
- `cli_exec` / collector session pool with JSON execution

Future-compatible transport rule:
- the caller may receive structured stdout directly
- or the caller may have to rely on request/response artifacts written to a session directory

Collector should treat artifacts as canonical regardless of transport.

## Prompt Rules

Prompt files live in:

`packages/collector/src/agents/sources/`

Rules:
- one prompt file per source id
- prompt should describe source-specific enrichment intent
- prompt must not ask for final investment advice
- prompt should prefer event, theme, and relationship structure
- prompt may suggest derived evidence only when it adds structure beyond raw evidence

## Artifact Schema

Artifacts are first-class records because provider CLI behavior can change.

Minimum artifact requirements:
- request payload or request reference
- response payload or response reference
- parsed decision
- execution status
- error message on failure
- derived evidence references

This keeps source-agent execution debuggable even when stdout parsing changes.

## Source-Agent vs Candidate Analysis

Source-agent:
- runs per source submission
- source-specific prompt
- adds source-aware event/theme/relationship structure
- may create derived evidence

Candidate analysis:
- runs after evidence has already been aggregated
- candidate shortlist oriented
- cost-controlled batch execution
- prepares richer candidate context for orchestrator

These two layers should stay separate.

## Observability

Operator-visible source-agent state should include:
- whether the source-agent is enabled
- prompt path
- logical session domain
- latest run time
- latest status
- latest artifact id

Submission-level observability should include:
- source-agent status
- source-agent artifact id
- derived evidence ids

## Internal API

Current internal endpoints:
- `GET /internal/source-agents/{source_id}/status`
- `GET /internal/source-agents/{source_id}/preview`
- `POST /internal/source-agents/run/{source_id}`

These are meant for inspection and manual operator control.

## Rollout Plan

1. Add source-agent metadata and storage
2. Add prompt files for existing sources
3. Run source-agent after raw evidence persistence
4. Store artifacts and optional derived evidence
5. Observe failures without breaking ingestion
6. Expand session transport and external injection support later

## Open Questions

- Which sources should remain `agent_enabled=false` by default even if a prompt exists?
- When provider CLIs gain stable external injection, should collector switch source-agents from direct execution to bridge-based execution?
- Should source-agent outputs feed source validity directly, or only candidate quality metrics?
- How much source memory should remain inside the session before reset?

## Decision Log

### 2026-03-28

- Added source-level prompt files under `packages/collector/src/agents/sources/`
- Added source-agent metadata to source definitions and source status/catalog output
- Added artifact-first source-agent execution after raw evidence persistence
- Kept provider/model settings global to collector
- Chose living documentation split:
  - `ARCHITECTURE.md` for boundaries and abstractions
  - `README.md` for operator-facing runtime notes
  - `docs/collector-source-agents.md` for ongoing design details
