# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Discord bot that sends KRX (Korean Stock Exchange) morning briefings. It maintains per-guild watchlists and generates AI-powered market analysis reports using a multi-agent system (bull/bear/judge).

Two services run together via Docker Compose:
- **bot-api**: Node.js/TypeScript — Discord slash commands, scheduling, config persistence
- **predictor**: Python — multi-agent report generation pipeline (collect → bull → bear → report)

## Commands

```bash
# Development
npm run dev          # tsx watch (hot reload)
npm run build        # tsc compile to dist/
npm start            # run compiled output

# Testing
npm test             # vitest run (single pass)
npm run test:watch   # vitest watch mode

# Docker
docker-compose up --build   # run both services
```

To run a single test file: `npx vitest run tests/reportService.test.ts`

## Architecture

### Service Wiring (`src/index.ts`)
All services are constructed and injected in `index.ts`: `JobEngine` → `ActionOrchestrator` → `GuildConfigStore` → `PredictorClient` → `ReportService` → `NotificationScheduler` → `BotApp(orchestrator, scheduler, reports)` + Express server.

### Key Service Responsibilities
- **`BotApp`** (`src/bot/botApp.ts`): Discord.js client, slash command dispatch, button interactions, voice channel capture
- **`ReportService`** (`src/services/reportService.ts`): Orchestrates report generation; delegates to `PredictorClient`
- **`PredictorClient`** (`src/services/predictorClient.ts`): HTTP client to the Python predictor (`POST /reports/generate`)
- **`NotificationScheduler`** (`src/services/notificationScheduler.ts`): Timezone-aware weekday scheduling using `setTimeout` loops; triggers per-guild at `REPORT_TIME_KST`. Uses `computeNextOccurrence()` from `src/services/reportSchedule.ts`
- **`GuildConfigStore`** (`src/services/guildConfigStore.ts`): JSON file persistence at `data/guild-report-config.json`
- **`ActionOrchestrator`** (`src/services/actionOrchestrator.ts`): Tracks pending voice transcription actions with TTL; dispatches confirmed actions to `JobEngine`
- **`JobEngine`** (`src/services/jobEngine.ts`): Executes `JobRequest`s produced by the voice pipeline (currently mock)

### Predictor Service (`predictor/server.py`)
Python HTTP server (port 5001) with a multi-phase pipeline:
1. **collect**: Fetches data from KIS API, Naver News, DART
2. **bull/bear agents**: Azure OpenAI analysis (falls back to mock if keys absent)
3. **report agent**: Synthesizes markdown report

### Discord Messaging
Reports are split into ≤1900-char chunks (`chunkMessage()`) to respect Discord's 2000-char limit.

### Voice Pipeline
`VoiceCaptureService` decodes Opus → PCM16LE, segments audio via `SpeechSegmenter`, and creates `ActionOrchestrator` entries. STT provider is abstracted in `src/stt/provider.ts` (`STT_PROVIDER=mock` by default).

## Environment Variables

Minimum required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`

Key optional vars (with defaults):
- `DISCORD_GUILD_ID` — if set, commands are registered to this guild only (faster for dev)
- `DEFAULT_TEXT_CHANNEL_ID` — fallback text channel for voice pipeline and report delivery
- `PREDICTOR_BASE_URL` (default: `http://predictor:5001`)
- `REPORT_TIME_KST` (default: `08:00`) / `REPORT_TIMEZONE` (default: `Asia/Seoul`) — scheduling
- `ACTION_TTL_SEC` (default: `600`) — TTL for pending voice actions
- `HEALTH_PORT` (default: `3000`) — Express API port
- `CONFIG_STORE_PATH` (default: `data/guild-report-config.json`)
- `KIS_APP_KEY` / `KIS_APP_SECRET` — Korean stock API
- `DART_API_KEY`, `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET`
- `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_DEPLOYMENT`

All vars validated with Zod in `src/config.ts`. The predictor runs in fallback/mock mode when external API keys are absent.

## Module System

The project uses `"type": "module"` with `"moduleResolution": "NodeNext"`. All imports must use explicit `.js` extensions (e.g., `import ... from './foo.js'`) even for `.ts` source files.
