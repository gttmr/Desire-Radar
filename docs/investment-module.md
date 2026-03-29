# Investment Module

This document is the living design note for free-form human investment input and the orchestrator-side investment module.

Daily shortlist 판단과 report artifact 계약은 [docs/investment-decision-module.md](investment-decision-module.md)에서 별도로 관리한다.

Use it for:
- recording how free-form human input is interpreted
- keeping collector, discord-bot, and orchestrator boundaries clear
- evolving the Markdown archive and dossier model without rewriting product intent every time

## Purpose

The investment module is not the final verdict engine.

It exists to:
- receive long-form study or research notes from free-form human input
- preserve those notes as durable Markdown assets
- attach notes to specific investable assets when possible
- expose a stable read interface for future verdict/report integration

It does not:
- replace collector evidence ingestion
- replace orchestrator verdict generation
- auto-execute high-risk actions

## Boundary

### Collector

Collector owns:
- raw human input submission and provenance
- interpretation of free-form input
- classification into collector-native routes
- structured action requests and handoff payloads

Collector does not:
- mutate guild watchlists directly
- write orchestrator investment dossiers directly

### Discord Bot

Discord bot owns:
- forwarding raw free-form input to collector
- executing only low-risk auto-actions
- forwarding investment-module handoffs to orchestrator

### MCP Orchestrator

The orchestrator investment module owns:
- intake Markdown creation
- asset dossier updates
- future read hooks for verdict/report

## Interpretation Contract

Collector returns a `HumanInputInterpretation` object in `submission.metadata.classification`.

Important fields:
- `collector_route`
- `input_kind`
- `action_requests`
- `handoff_targets`
- `asset_candidates`
- `investment_note`
- `user_message`

This lets collector say:
- what collector-native ingest path applies
- what low-risk action can be auto-executed
- whether the input should also be archived as investment research

## Auto Actions

v1 only supports:
- `watchlist_add`
- `watchlist_remove`

Constraints:
- stock only
- guild-scoped report watchlist only
- clear ticker or canonical stock asset required
- confidence threshold must be met

If confidence is weak, the bot should not perform the action automatically.

## Investment Intake

Current API:
- `POST /investment/intake`
- `GET /investment/intakes/:intake_id`
- `GET /investment/assets/:asset_key`

The intake request is the handoff point from collector/bot into the orchestrator investment module.

## Storage Model

Base directory:

`data/investment-module/`

Current layout:
- `intake/YYYY-MM-DD/<intake_id>.md`
- `assets/<asset_type>/<asset_key>.md`
- `intakes.json`
- `assets.json`

Markdown is the durable operator-facing record.
JSON index files exist only to make lookup and rewrite simple.

## Intake Markdown

Required frontmatter:
- `intake_id`
- `source_submission_id`
- `created_at`
- `asset_candidates`
- `asset_type`
- `input_kind`
- `channel_ref`
- `auto_actions`

Required sections:
- `Raw Input`
- `Structured Summary`
- `Why It Might Matter`
- `Beneficiary Hints`
- `Open Questions`
- `References`
- `Asset Candidates`

## Asset Dossier

Required sections:
- `Asset Summary`
- `Recent Notes`
- `Potential Thesis`
- `Risks / Open Questions`
- `Linked Submissions`

Current rule:
- unresolved input creates an intake note only
- dossiers are created only when an asset has a resolved `asset_key`

## Free-Form Input Examples

These are examples, not required templates.

Examples:
- `삼성전자 와치리스트에 추가해`
- a long free-form stock or real-estate study paragraph
- a structured JSON evidence batch

The collector should accept all of them and decide:
- collector-native routing
- low-risk auto actions
- investment-module handoff

## Open Questions

- When should investment notes begin to feed verdict context automatically?
- Should unresolved notes later be re-attached when entity resolution improves?
- How much normalization should happen before writing Markdown, versus leaving notes closer to raw operator language?
- When asset classes expand beyond stocks, what new low-risk actions are safe enough for auto-execution?
