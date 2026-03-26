# Agentic-World Architecture

## Why This Exists
Agentic-World is not a generic trend dashboard. It is a system for:
1. collecting early evidence of human desire,
2. turning that evidence into structured candidates,
3. debating who captures the value,
4. mapping that value to investable beneficiaries,
5. producing a time-sensitive verdict with explicit risk.

The strategic runtime is `collector + mcp-orchestrator + discord-bot`. `predictor-legacy` remains only for compatibility.

## System Boundaries

### Collector
`packages/collector/`

Collector owns:
- ingestion from pull, push, human, agent, and derived sources
- source provenance, source tier, and source validity state
- submission tracking and human follow-up queues
- normalized evidence and candidate construction
- low-cost, batch-first CLI analysis for candidate enrichment and human-input routing

Collector does not own final investment judgment. It prepares evidence and structured candidate state for downstream analysis.

### MCP Orchestrator
`packages/mcp-orchestrator/`

Orchestrator owns:
- multi-phase reasoning over collector evidence
- research request generation and submission polling
- provider selection and model policy
- final verdict generation
- report synthesis

Orchestrator is the decision engine, not the source-of-truth store for raw evidence.

### Discord Bot
`packages/discord-bot/`

Discord bot owns:
- Discord commands and operator-facing outputs
- single-channel human input forwarding
- provider health alerts
- light operational controls

Discord bot is a control plane and ingress surface, not the analysis core.

### Shared Types
`packages/shared-types/`

Shared types exist to keep contracts synchronized across services. Any API shape change should be reflected here and in all affected producers and consumers.

## Primary Flows

### 1. Evidence Ingestion
`human/pull/push/agent/derived input -> collector source registry -> submission -> snapshots -> normalized evidence -> candidates`

Important property:
- raw snapshots and provenance remain intact even when analysis layers add derived fields.

### 2. Collector Analysis
`candidate shortlist -> analysis policy -> context packing -> CLI session execution -> analysis projection`

Important property:
- collector uses cheap, batch-first analysis to improve triage and routing, not to replace final investment judgment.

### 3. Orchestrated Investment Run
`candidate -> triage -> debate -> research-loop -> verdict -> report`

Important property:
- the expensive model budget is reserved for the verdict phase or explicit premium checks.

### 4. Human Research Loop
`debate identifies gap -> orchestrator creates collector submission -> human or source fulfills request -> collector stores new evidence -> orchestrator resumes`

Important property:
- research requests are first-class tracked objects, not ad hoc chat notes.

### 5. Provider Operations
`provider health probe -> optional repair attempt -> orchestrator /health -> discord alert`

Important property:
- auth health, execution, repair, and alerting are separate concerns.

## Core Abstractions

### Collector Abstractions

#### SourceDefinition and SourceRegistry
`packages/collector/src/sources/models.py`
`packages/collector/src/sources/registry.py`

Use these to model all inputs, not just scheduled connectors.

Key idea:
- a source is defined by `kind`, `ingestion_mode`, tier fields, validity fields, metrics, and operational flags
- tier is configurable and validity-driven, not a hardcoded constant scattered across collectors

This lets the system treat pull APIs, human input, agent pushes, and derived sources as one operational surface.

#### SubmissionRecord and IngestionEngine
`packages/collector/src/ingest/models.py`
`packages/collector/src/ingest/engine.py`

The ingestion engine is the shared pipeline for all inputs.

Key idea:
- every ingest path becomes a tracked submission with status, snapshots, evidence ids, and errors
- push paths and human paths are not special-case side doors

This keeps traceability and retry behavior consistent.

#### HumanInputRouter
`packages/collector/src/ingest/human_input_router.py`

The router classifies free-form human input into a structured ingest path.

Key idea:
- Discord or other clients do not need to pre-classify human input perfectly
- the collector can route input into observation, study result, curated data, or review

This keeps external ingress clients thin.

#### AnalysisPolicy, ContextPacker, CliSession, SessionPool, AnalysisEngine
`packages/collector/src/analysis/`

These components separate candidate selection, prompt shaping, CLI execution, and persistence.

Key idea:
- `AnalysisPolicy`: decides what deserves model budget
- `ContextPacker`: compresses evidence into stable task packets
- `CliSession` and `SessionPool`: isolate long-lived CLI execution concerns
- `AnalysisEngine`: coordinates queueing, execution mode, and persistence

This keeps cost control, prompt shape, and process management from collapsing into one file.

### Orchestrator Abstractions

#### ProviderAdapter and ProviderExecutionRequest
`packages/mcp-orchestrator/src/providers/base.ts`

All provider-specific CLI/API behavior must be isolated behind the provider adapter boundary.

Key idea:
- the rest of the orchestrator talks in terms of `phase`, `modelProfile`, `agentName`, and `responseFormat`
- only adapters should know concrete flags, command names, and parsing quirks

This is the main defense against fast-changing CLI tools.

#### ExecutionPolicyResolver
`packages/mcp-orchestrator/src/policy/execution.ts`

Model and provider choice is policy, not inline business logic.

Key idea:
- choose providers and model profiles per phase and agent
- keep premium model spend concentrated in the verdict layer

This prevents provider churn from rewriting core orchestration logic.

#### SessionStore
`packages/mcp-orchestrator/src/sessions/session-store.ts`

Session state is keyed by phase, agent, provider, profile, and run scope.

Key idea:
- cheap debate context must not contaminate premium verdict context

#### CandidateService, ResearchService, SubmissionPoller
`packages/mcp-orchestrator/src/collector/`

These form the collector gateway layer.

Key idea:
- orchestrator should depend on collector-facing services, not raw HTTP calls spread across pipelines

#### RunOrchestrator and Phase Services
`packages/mcp-orchestrator/src/orchestrator/run-orchestrator.ts`
`packages/mcp-orchestrator/src/pipeline/`

The run orchestrator coordinates phases, but each phase stays replaceable.

Key idea:
- `triage`, `debate`, `research-loop`, `verdict`, and `report` are separable services with distinct cost profiles and responsibilities

#### ProviderHealthMonitor
`packages/mcp-orchestrator/src/providers/providerHealthMonitor.ts`

Health, repair, and readiness state are handled separately from normal inference calls.

Key idea:
- auth failures, missing binaries, capacity limits, and stale probes should not all collapse into one boolean

### Discord-Bot Abstractions

#### CollectorClient and OrchestratorClient
`packages/discord-bot/src/services/`

The bot should forward human input and consume status through service clients, not inline fetch logic in command handlers.

#### ProviderHealthMonitor
`packages/discord-bot/src/services/providerHealthMonitor.ts`

The bot consumes orchestrator health state and turns it into operator-visible alerts.

Key idea:
- operator notifications belong at the edge, not inside analysis logic

## CLI Volatility Rules

Provider CLIs change quickly. Commands, flags, output envelopes, auth prompts, and rate-limit wording can all drift. Design for that drift explicitly.

### Rule 1: Keep CLI Knowledge Inside Adapters
- No business logic should rely on raw CLI command strings.
- Command-line flags, stdout parsing, and login repair hooks belong in provider adapters or provider-health components.

### Rule 2: Prefer Structured Output
- Use JSON or JSONL modes whenever the CLI supports them.
- Treat plain text parsing as a fallback, not the main contract.

### Rule 3: Parse Semantically, Not Literally
- Do not key system behavior off one exact rate-limit sentence.
- Normalize failures into categories such as:
  - auth failure
  - binary missing
  - capacity limited
  - parse failure
  - timeout
  - unknown provider failure

### Rule 4: Separate Auth Probe, Execute Probe, And Repair
- A command that proves installation is not the same as a command that proves login.
- A command that proves login is not the same as a real execution smoke.
- Repair commands should be config-driven and optional.

### Rule 5: Make Failure Surfaces Rich
- Carry structured health state, error summaries, and repair metadata through the API.
- Alerts and UIs should not need to reverse-engineer raw stderr.

### Rule 6: Test Adapter Boundaries
- When a provider changes, add tests at the adapter boundary.
- Use live smoke tools only when the change depends on real installed CLIs.

## Design Positions

### Preserve Facts, Derive Separately
- Raw evidence, normalized evidence, and derived analysis must remain distinguishable.

### Centralize Shared Contracts
- `shared-types` must move with API changes.
- Local convenience types should not silently diverge from cross-service contracts.

### Keep Policy Out Of Transport Code
- Provider choice, model tiering, retry rules, and escalation rules belong in policy/config layers.
- HTTP clients and CLI adapters should stay transport-focused.

### Keep Human Input Thin At The Edge
- The Discord bot should forward envelopes.
- Collector should decide how free-form human input is routed and stored.

### Optimize For Traceability
- Given a report or verdict, it should be possible to trace:
  - the evidence used,
  - the source it came from,
  - the collector submissions involved,
  - the provider/agent path used in orchestration.

## Extension Guidelines

### Adding A New Source
- Register it in collector through the source registry.
- Decide whether it is `raw` or `evidence` ingestion.
- Add source metrics and validity behavior instead of inventing a separate operational path.

### Adding A New Orchestrator Agent
- Add a focused Markdown prompt under `packages/mcp-orchestrator/src/agents/`.
- Give it one distinct analytical role.
- Update policy only if the new agent changes provider or model requirements.

### Adding Or Changing A Provider
- Keep provider-specific logic in one adapter.
- Add health probing, error classification, and smoke coverage together.
- Do not let provider-specific response parsing leak into debate or verdict code.

### Changing Contracts
- Update producer, consumer, shared types, and docs in the same change.

## Document Map
- [README.md](README.md): quickstart and runtime operations
- [AGENTS.md](AGENTS.md): Codex CLI working instructions
- `packages/mcp-orchestrator/src/agents/*.md`: analytical agent prompts
