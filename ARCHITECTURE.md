# Agentic-World Architecture

## Why This Exists
Agentic-World is not a generic trend dashboard. It is a system for:
1. collecting early evidence of human desire,
2. turning that evidence into structured candidates,
3. debating who captures the value,
4. mapping that value to investable beneficiaries,
5. producing a time-sensitive verdict with explicit risk.

The strategic runtime is `collector + mcp-orchestrator + discord-bot`.

## Runtime Topology
The intended local operator environment is WSL + Docker Compose.

Operational assumption:
- provider CLI auth lives in the WSL home directory
- Docker mounts that auth into `collector` and `mcp-orchestrator`
- Discord bot is the human/control edge, not the place where source routing logic lives
- provider execute truth is validated from WSL-native smoke; Docker health should surface degraded readiness honestly when container execution is broken

## System Boundaries

### Collector
`packages/collector/`

Collector owns:
- ingestion from pull, push, human, agent, and derived sources
- source provenance, source tier, and source validity state
- public-first pull source diversification with readiness/gating separation for credentialed or unstable sources
- submission tracking and human follow-up queues
- normalized evidence and candidate construction
- candidate construction uses canonical entity clusters with optional event/theme/graph facets instead of exposing raw lexical token lists as the primary operator view
- source-specific collector-owned source-agents and external push agents under the same source registry
- event and relationship preservation inside evidence bundles
- low-cost, batch-first CLI analysis for candidate enrichment and human-input routing
- source-level CLI session transport and artifact persistence for source-agent execution
- operator dashboard for collector-owned runtime visibility, source controls, and allowlisted config edits

Collector does not own final investment judgment. It prepares evidence and structured candidate state for downstream analysis.

### MCP Orchestrator
`packages/mcp-orchestrator/`

Orchestrator owns:
- multi-phase reasoning over collector evidence
- research request generation and submission polling
- provider selection and model policy
- provider session orchestration and transport dispatch
- investment-note intake and asset dossier storage
- watchlist-prioritized investable universe assembly
- artifact-first investment decision runs
- deterministic report rendering from decision artifacts
- final verdict generation
- report synthesis

Orchestrator is the decision engine, not the source-of-truth store for raw evidence.

### Discord Bot
`packages/discord-bot/`

Discord bot owns:
- Discord commands and operator-facing outputs
- single-channel human input forwarding
- low-risk auto-action execution for free-form human input
- forwarding investment-module handoffs to orchestrator
- provider health alerts
- light operational controls

Discord bot is a control plane and ingress surface, not the analysis core.

### Shared Types
`packages/shared-types/`

Shared types exist to keep contracts synchronized across services. Any API shape change should be reflected here and in all affected producers and consumers.

## Primary Flows

### 1. Evidence Ingestion
`human/pull/push/agent/derived input -> collector source registry -> submission -> source-run queue or ingest queue -> snapshots -> normalized evidence -> source-agent enrichment -> candidates`

Important property:
- raw snapshots and provenance remain intact even when analysis layers add derived fields.
- normalized evidence is also persisted so candidate generation and investment assembly survive collector restarts; persistence must not mutate raw source facts
- long-running source collection should not block request/health handling; source execution is queued and runtime state is observable separately
- source status should expose partial-failure metadata instead of collapsing mixed outcomes into a binary success/failure view
- source operability is not just `enabled/runnable`; collector also tracks `readiness_status`, fetch strategy, checkpoint/watermark state, quality status, and recent run history
- source-agents may enrich a source submission, but they do not replace raw evidence or make final investment judgments
- queued pull runs may complete raw evidence persistence and candidate enqueue before source-agent enrichment finishes; source-agent completion is tracked separately via `source_agent_status`

### 2. Collector Analysis
`candidate shortlist -> analysis policy -> context packing -> graph-aware bundle -> CLI session execution -> analysis projection`

Important property:
- collector uses cheap, batch-first analysis to improve triage and routing, not to replace final investment judgment.

### 3. Orchestrated Investment Run
`candidate -> bundle(graph included) -> triage -> debate -> research-loop -> verdict -> report`

Important property:
- the expensive model budget is reserved for the verdict phase or explicit premium checks.

### 4. Human Research Loop
`debate identifies gap -> orchestrator creates collector submission -> human or source fulfills request -> collector stores new evidence -> orchestrator resumes`

Important property:
- research requests are first-class tracked objects, not ad hoc chat notes.

### 5. Free-Form Human Investment Input
`Discord message -> collector raw submission -> HumanInputInterpretation -> collector-native route and/or low-risk action and/or investment-module handoff -> orchestrator Markdown archive`

Important property:
- collector decides what the input means
- discord-bot only executes low-risk actions
- orchestrator owns durable investment-note storage

### 6. Provider Operations
`provider health probe -> optional repair attempt -> orchestrator /health -> discord alert`

Important property:
- auth health, execute readiness, repair, and alerting are separate concerns.

### 7. Daily Investment Decision
`watchlist + collector clusters + investment notes + source health -> investment decision request artifact -> optional preprocessing briefing artifact -> final decision artifact -> deterministic report -> Discord`

Important property:
- downstream consumers depend on the request/response/report artifact contract, not on how the LLM was invoked.
- preprocessing is an internal compression step, not a second source of truth
- preprocessing와 final decision은 provider/model/tool policy를 각각 따로 가질 수 있다

## Core Abstractions

### Collector Abstractions

#### SourceDefinition and SourceRegistry
`packages/collector/src/sources/models.py`
`packages/collector/src/sources/registry.py`

Use these to model all inputs, not just scheduled connectors.

Key idea:
- a source is defined by `kind`, `ingestion_mode`, tier fields, validity fields, metrics, and operational flags
- a source can optionally own a collector-side prompt, logical session domain, and source-agent output mode
- tier is configurable and validity-driven, not a hardcoded constant scattered across collectors

This lets the system treat pull APIs, human input, agent pushes, and derived sources as one operational surface.

#### SubmissionRecord and IngestionEngine
`packages/collector/src/ingest/models.py`
`packages/collector/src/ingest/engine.py`

The ingestion engine is the shared pipeline for all inputs.

Key idea:
- every ingest path becomes a tracked submission with status, snapshots, evidence ids, and errors
- source-agent execution is still submission-scoped and yields tracked artifacts plus optional derived evidence
- push paths and human paths are not special-case side doors

This keeps traceability and retry behavior consistent.

#### HumanInputRouter
`packages/collector/src/ingest/human_input_router.py`

The router classifies free-form human input into a structured interpretation object.

Key idea:
- Discord or other clients do not need to pre-classify human input perfectly
- the collector can route input into observation, study result, curated data, review, or command-only handling
- the same interpretation can include low-risk auto-actions and downstream handoff targets

This keeps external ingress clients thin.

#### SourceAgentRegistry, SourceAgentRunner, SourceAgentArtifactStore
`packages/collector/src/source_agents/`

These components keep source-level prompt execution separate from candidate-level analysis.

Key idea:
- every source can have its own `agent.md` prompt and logical session domain
- source-agent execution happens after raw evidence is persisted, not before
- outputs are stored as artifacts first and may optionally create derived evidence
- provider/model configuration stays global to collector; source-specific behavior lives in source metadata and prompt files

This keeps raw evidence protected while still letting collector attach source-aware event, theme, or relationship structure.

#### AnalysisPolicy, ContextPacker, CliSession, SessionPool, AnalysisEngine
`packages/collector/src/analysis/`

These components separate candidate selection, prompt shaping, CLI execution, and persistence.

Key idea:
- `AnalysisPolicy`: decides what deserves model budget
- `ContextPacker`: compresses evidence into stable task packets
- `CliSession` and `SessionPool`: isolate long-lived CLI execution concerns
- session directories are first-class artifacts, not disposable temp paths
- `AnalysisEngine`: coordinates queueing, execution mode, and persistence

This keeps cost control, prompt shape, and process management from collapsing into one file.

### Orchestrator Abstractions

#### ProviderAdapter and ProviderExecutionRequest
`packages/mcp-orchestrator/src/providers/base.ts`

All provider-specific CLI/API behavior must be isolated behind the provider adapter boundary.

Key idea:
- the rest of the orchestrator talks in terms of `phase`, `modelProfile`, `agentName`, and `responseFormat`
- only adapters should know concrete flags, command names, and parsing quirks
- transport choice is session-scoped; provider adapters keep provider-native CLI logic while external injection stays outside them

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
- session identity and transport identity are separate from one-off prompt execution

#### External Injection Transport
`packages/mcp-orchestrator/src/providers/external-inbox.ts`

This transport covers the case where the caller cannot reliably receive structured stdout from a provider CLI and must instead inject work into a long-lived external conversation bridge.

Key idea:
- request/response exchange happens through a session directory target
- this gives a stable handoff point for future Discord-thread injection, file-based bridges, or provider-owned session daemons
- direct CLI execution and external injection can share the same higher-level session model

The same artifact-first principle now applies to collector source-agents: if provider-owned sessions become externally injectable later, collector should swap transport without changing source-agent contracts.

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

#### InvestmentIntakeService, InvestmentMarkdownStore, InvestmentContextProvider
`packages/mcp-orchestrator/src/investment/`

These components store free-form study and research input as durable Markdown assets.

Key idea:
- intake notes preserve structured summaries of free-form human research
- asset dossiers provide a stable future hook for verdict/report context
- this module is an interface and archive layer first, not a second verdict engine

#### InvestmentSignalAssembler, InvestableUniverseResolver, InvestmentDecisionRunner, InvestmentDecisionStore, InvestmentReportFormatter, InvestmentEquityMapService
`packages/mcp-orchestrator/src/investment/`

These components own the daily shortlist path separately from the debate/verdict pipeline.

Key idea:
- `InvestmentSignalAssembler` builds a canonical request bundle from watchlist state, collector clusters, source health, and investment notes
- `InvestableUniverseResolver` keeps the universe watchlist-prioritized and only admits exact or curated equity mappings
- `InvestmentDecisionRunner` can execute directly through providers or wait for an external artifact writer without changing downstream contracts
- `InvestmentDecisionStore` is the canonical run directory owner
- `InvestmentReportFormatter` renders the final operator-facing text deterministically from `response.json`
- `InvestmentEquityMapService` is the operational input boundary for curated exact alias/ticker/company_name mappings

This keeps provider transport decisions, artifact storage, and report generation decoupled.

#### ProviderHealthMonitor
`packages/mcp-orchestrator/src/providers/providerHealthMonitor.ts`

Health, repair, and readiness state are handled separately from normal inference calls.

Key idea:
- auth failures, missing binaries, transport failures, capacity limits, and stale probes should not all collapse into one boolean
- a provider can be auth-healthy and still execution-unready

### Discord-Bot Abstractions

#### CollectorClient and OrchestratorClient
`packages/discord-bot/src/services/`

The bot should forward human input and consume status through service clients, not inline fetch logic in command handlers.

#### HumanInputFollowUpService
`packages/discord-bot/src/services/humanInputFollowUpService.ts`

This component executes only the safe side effects from collector's human input interpretation.

Key idea:
- collector decides what the message means
- bot may auto-apply only low-risk stock watchlist actions
- investment-note handoff is forwarded to orchestrator, not stored locally

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
- If direct structured stdout is not dependable, write/read structured artifacts in the session directory instead of guessing from logs.

### Rule 3: Parse Semantically, Not Literally
- Do not key system behavior off one exact rate-limit sentence.
- Normalize failures into categories such as:
  - auth failure
  - binary missing
  - capacity limited
  - parse failure
  - timeout
  - unknown provider failure

These rules apply both to orchestrator debate/verdict transports and to collector source-agent transports.

### Rule 4: Separate Auth Probe, Execute Probe, And Repair
- A command that proves installation is not the same as a command that proves login.
- A command that proves login is not the same as a real execution smoke.
- Repair commands should be config-driven and optional.
- debate and verdict phases should only consume providers that are execution-ready, not merely login-healthy.

### Rule 5: Make Failure Surfaces Rich
- Carry structured health state, error summaries, and repair metadata through the API.
- Alerts and UIs should not need to reverse-engineer raw stderr.
- Keep transport health separate from auth/execute health when an external injection bridge is involved.

The same rule applies to investment decision runs:
- if a direct provider execution fails, normalize the failure into the decision artifact
- if an external artifact writer times out or writes an invalid response, surface that as a degraded or failed run instead of inventing a fake report

## Graph Position

The system should not think in terms of isolated keywords only.

- Collector evidence bundles should preserve an event/entity/source/signal graph snapshot.
- The graph does not need to start as a graph database; a bundle-local graph artifact is enough.
- Orchestrator prompts and verdicts should consume that graph summary so beneficiary mapping is grounded in relationships, not just raw evidence snippets.

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

### Artifact-First Decision Contracts
- investment decision request and response artifacts are the canonical interface
- optional preprocessing artifacts may exist, but they are auxiliary and never replace `request.json` or `response.json`
- `provider_exec` and `external_artifact` are interchangeable execution modes behind that contract
- Discord and scheduled reports should consume `response.json`, not re-run LLM formatting

### Keep Human Input Thin At The Edge
- The Discord bot should forward envelopes.
- Collector should decide how free-form human input is routed and stored.

## Document Map
- [AGENTS.md](AGENTS.md): Codex workflow, WSL assumptions, contributor rules
- [README.md](README.md): operator-facing runtime overview and environment setup
- [RUNBOOK.md](RUNBOOK.md): rebuild, health checks, provider checks, live troubleshooting
- [docs/investment-module.md](docs/investment-module.md): free-form human research intake and dossier archive
- [docs/investment-decision-module.md](docs/investment-decision-module.md): daily shortlist decision contract and report flow

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
