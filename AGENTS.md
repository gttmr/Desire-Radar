# Agentic-World Repository Guide

## Mission
This repository exists to detect human desire early, convert that signal into structured evidence, and determine which products, companies, or public equities may benefit before the broader market fully prices it in.

The end goal is not generic trend reporting. The end goal is to build an environment where we can identify monetizable demand shifts early enough to make better investment decisions, especially buying listed stocks slightly ahead of consensus.

## What The System Does
- `packages/collector/` gathers raw demand evidence from multiple sources and turns it into normalized evidence plus candidate entities.
- `packages/mcp-orchestrator/` runs multi-agent analysis using Markdown agent prompts under `packages/mcp-orchestrator/src/agents/`.
- `packages/discord-bot/` exposes reports, commands, and operational controls.
- `packages/predictor-legacy/` remains for compatibility, but the strategic direction is the collector plus orchestrator path.

## Core Product Principle
Every meaningful output should move through these layers in order:
1. Observed behavior: what people are actually doing.
2. Inferred desire: what underlying want or pressure explains that behavior.
3. Monetization path: who captures the value if this desire keeps growing.
4. Investable expression: which company, ticker, asset, or adjacent beneficiary may move.
5. Timing and risk: why the signal matters now, and what could make it false.

Do not collapse these layers into vague storytelling. Keep them explicit.

## Evidence Standard
- Prefer first-order signals over commentary: search growth, ranking changes, sales momentum, repeated mentions, waitlists, resale premium, usage behavior, and human observations tied to concrete actions.
- Separate observed facts from inferred conclusions.
- State confidence and unresolved questions clearly.
- Avoid unsupported claims about revenue impact, market size, or stock implications.
- A signal is more valuable when it is early, repeated across sources, and tied to a credible monetization path.

## Investment Framing
- The repository should increasingly answer: "What can make money from this desire signal?"
- Prefer outputs that connect desire signals to public-market beneficiaries when possible.
- If the direct winner is private, identify second-order public beneficiaries such as suppliers, platforms, distributors, infrastructure providers, or competing listed firms.
- Favor slightly-early, evidence-backed positioning over dramatic predictions.

## Agent Authoring
- Strategy and debate agents are Markdown files in `packages/mcp-orchestrator/src/agents/`.
- New agent roles should usually be added as focused `.md` files with one clear analytical lens.
- Agent prompts should be specialized, evidence-oriented, and complementary rather than redundant.
- When adding an agent, define what unique question it answers that existing agents do not.
- Keep synthesis and report agents disciplined: they should aggregate evidence, not invent it.

## Codex Subagent Policy
- Use Codex subagents aggressively for parallel exploration, verification, and bounded implementation work.
- Delegate independent codebase questions, isolated refactors, and verification tasks whenever parallelism shortens the critical path.
- Keep ownership clear when multiple subagents edit code.
- Subagents should accelerate rigor, not create duplicate analysis.

## Engineering Priorities
- Preserve raw evidence integrity. Derived analysis must not erase source facts.
- Keep collection, analysis, and reporting loosely coupled.
- Optimize for traceability: given a thesis, we should be able to trace it back to source evidence and the agent path that produced it.
- Prefer small, testable steps over large speculative rewrites.
- When changing schemas or APIs, update both producers and consumers in the same change.

## Near-Term Direction
- Expand desire-to-monetization mapping.
- Improve agent specialization through new Markdown prompt files.
- Strengthen candidate scoring, timing logic, and benchmarked low-cost analysis paths.
- Continuously increase the system's usefulness for early investment research, not just descriptive reporting.
