# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

"욕망 레이더" — 소비자 욕구 탐지 및 투자 신호 생성 시스템. 다중 소스에서 트렌드 데이터를 수집하고, AI 에이전트가 토론하여 일일 분석 리포트를 생성한다.

4개 서비스가 Docker Compose로 실행된다:
- **discord-bot** (`packages/discord-bot/`): TypeScript — Discord 슬래시 커맨드, 스케줄링, 길드 설정
- **collector** (`packages/collector/`): Python — 다중 소스 데이터 수집, evidence 생산, 신호 후보 생성
- **mcp-orchestrator** (`packages/mcp-orchestrator/`): TypeScript — 세션형 CLI 다중 프로바이더 MCP 오케스트레이터, 에이전트 토론 중계
- **predictor-legacy** (`packages/predictor-legacy/`): Python — 기존 KRX 주식 리포트 파이프라인 (점진적 축소 예정)

## Monorepo Structure

```
packages/
  shared-types/     # @agentic/shared-types — 모듈 간 공유 타입
  discord-bot/      # @agentic/discord-bot — Discord 인터페이스
  collector/        # agentic-collector — Python 수집 서비스
  mcp-orchestrator/ # @agentic/mcp-orchestrator — 에이전트 오케스트레이션
  predictor-legacy/ # 기존 predictor (호환 유지)
```

npm workspaces로 TypeScript 패키지를 관리한다. Python 패키지(collector, predictor-legacy)는 독립 관리.

## Commands

```bash
# Root level
npm run build              # 전체 TypeScript 패키지 빌드
npm run test               # 전체 테스트
npm run dev:bot            # discord-bot 핫 리로드
npm run dev:orchestrator   # mcp-orchestrator 핫 리로드

# Package level
cd packages/discord-bot && npm test
cd packages/mcp-orchestrator && npm test
cd packages/collector && pytest

# Docker
docker-compose up --build  # 4개 서비스 실행
```

## Architecture

### Discord Bot (`packages/discord-bot/`)
슬래시 커맨드 디스패치, 길드 설정 관리, 스케줄 리포트 발송.
`ANALYSIS_BACKEND` 설정으로 predictor-legacy 또는 mcp-orchestrator를 선택.

서비스 와이어링: `JobEngine` → `ActionOrchestrator` → `GuildConfigStore` → `PredictorClient` / `OrchestratorClient` / `CollectorClient` → `ReportService` → `NotificationScheduler` → `BotApp` + Express.

### Collector (`packages/collector/`)
5계층 구조: Source Connectors → Raw Snapshot Store → Normalizer → Entity Resolver → Signal Candidate Builder.
소스 스캔 우선 전략: 먼저 top movers를 훑고, 새 엔티티를 발견하면 tracking에 승격.
소스별 혼합 cadence: 1h (Reddit, SteamDB, AppStore), 6h (Google Trends), 12h (Naver DataLab), 24h (resale).
티어드 검역: T1(자동), T2(자동, trust↓), T3(review queue 필수).

### MCP Orchestrator (`packages/mcp-orchestrator/`)
세션형 CLI 다중 프로바이더 오케스트레이터.
Provider: codex exec, claude -p, gemini -p.
에이전트: search_intent, ranking_momentum, conversion_proxy, scarcity, diffusion, human_intel, theme_mapper, synthesis, report.
핵심 에이전트는 2+ provider 병렬 실행 후 비교/합성.

### Inter-Service Communication
```
Discord Bot → Collector (GET /candidates/emerging, GET /evidence/bundles/:entity)
Discord Bot → MCP Orchestrator (POST /runs/submit-evidence, POST /runs/debate, POST /runs/synthesize)
Discord Bot → Predictor Legacy (POST /reports/generate) [ANALYSIS_BACKEND=predictor]
MCP Orchestrator → Collector (GET /internal/next-candidates, POST /internal/build-bundle)
```

### Shared Types (`packages/shared-types/`)
모듈 간 계약: bot.ts, evidence.ts, orchestrator.ts, collector-api.ts, orchestrator-api.ts.

## Environment Variables

### Discord Bot
Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`
Optional: `DISCORD_GUILD_ID`, `DEFAULT_TEXT_CHANNEL_ID`, `PREDICTOR_BASE_URL` (default `http://predictor-legacy:5001`), `COLLECTOR_BASE_URL` (default `http://collector:5002`), `ORCHESTRATOR_BASE_URL` (default `http://mcp-orchestrator:5003`), `ANALYSIS_BACKEND` (default `predictor`), `REPORT_TIME_KST`, `REPORT_TIMEZONE`, `ACTION_TTL_SEC`, `HEALTH_PORT`, `CONFIG_STORE_PATH`, `STT_PROVIDER`

### Collector
`COLLECTOR_PORT` (default 5002), `DATA_DIR`, `REDDIT_USER_AGENT`, 각 소스별 API 키 (선택)

### MCP Orchestrator
`ORCHESTRATOR_PORT` (default 5003), `COLLECTOR_BASE_URL`, `DATA_DIR`, `CODEX_PATH`, `CLAUDE_PATH`, `GEMINI_PATH`, `DEFAULT_PROVIDERS`, `PROVIDER_TIMEOUT_MS`

### Predictor Legacy
`KIS_APP_KEY`/`KIS_APP_SECRET`, `DART_API_KEY`, `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`, `AZURE_OPENAI_*`

## Git Workflow

GitHub remote 없음 — 로컬 git으로 관리.

```bash
git add <files>
git commit -m "..."
git log --oneline
```

작업 단위마다 커밋. 브랜치 전략: 실험적 기능은 feature 브랜치, 안정된 것은 main에 merge.

## Module System

TypeScript packages use `"type": "module"` with `"moduleResolution": "NodeNext"`. All imports must use explicit `.js` extensions (e.g., `import ... from './foo.js'`).
