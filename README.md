# Agentic-World — 욕망 레이더

사람들의 욕망과 초기 행동 신호를 수집하고, 여러 에이전트의 토론을 통해 투자 가능한 해석으로 바꾸는 시스템이다.

현재 기본 런타임은 `discord-bot`, `collector`, `mcp-orchestrator` 3개 서비스다. `packages/predictor-legacy/`는 리포지토리에 남아 있지만 기본 Docker Compose 런타임에는 포함하지 않는다.

## 아키텍처

| 서비스 | 경로 | 언어 | 역할 |
|--------|------|------|------|
| `discord-bot` | `packages/discord-bot/` | TypeScript | Discord 명령, 스케줄 리포트, 단일 human input 채널 수집 |
| `collector` | `packages/collector/` | Python | 다중 소스 ingestion, source registry, submission tracking, candidate 생성, collector-side CLI 분석 |
| `mcp-orchestrator` | `packages/mcp-orchestrator/` | TypeScript | `triage -> debate -> research-loop -> verdict -> report` 투자 판단 파이프라인 |
| `shared-types` | `packages/shared-types/` | TypeScript | 서비스 간 공용 타입 |

```text
Discord human input / slash commands
        |
        v
  discord-bot
        |
        v
    collector
  - pull / push / human / derived sources
  - source registry + dynamic tier/validity
  - submissions + human input routing
  - batch CLI analysis
        |
        v
 mcp-orchestrator
  - triage
  - debate
  - research-loop
  - verdict
  - report
```

## 핵심 동작

### Collector
- 공개 API, 사람 입력, agent push, pull connector를 모두 공통 ingestion pipeline으로 처리한다.
- source registry가 각 source의 `kind`, `ingestion_mode`, `configured_tier`, `effective_tier`, validity 상태를 관리한다.
- candidate 분석은 기본적으로 `batch` 모드로 돌아가며, 상위 후보를 묶어 CLI 기반 LLM 호출을 수행한다.
- `POST /ingest/human-input`는 free-form 입력을 받아 collector 내부에서 다음 중 하나로 라우팅한다.
  - `manual_observation`
  - `human_analyst_note`
  - `human_curated_dataset`
  - `needs_review`

### Orchestrator
- collector 후보를 받아 phase-aware 의사결정 파이프라인으로 처리한다.
- research 부족분은 collector submission API를 통해 다시 요청한다.
- 최종 verdict는 premium model policy를 분리해 사용한다.
- 기본 provider 경로는 `codex, claude, gemini`이며, `OPENAI_API_KEY`가 있을 때만 OpenAI provider를 추가 등록한다.

### Discord Bot
- 하나의 human input 채널만 본다.
- 메시지 내용을 bot이 직접 분류하지 않고 raw envelope 그대로 collector에 전달한다.
- `/human-queue`로 `pending_human` 요청을 조회할 수 있다.

## 빠른 시작

### 1. 환경 변수 준비

```bash
cp .env.example .env
```

최소 권장값:
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_HUMAN_INPUT_CHANNEL_IDS`

선택값:
- `DISCORD_GUILD_ID`
- `DEFAULT_TEXT_CHANNEL_ID`
- `OPENAI_API_KEY`
- collector connector API key들

기본 런타임 전제:
- collector와 orchestrator는 CLI provider를 기본 경로로 사용한다.
- Docker Compose를 쓰려면 호스트에서 `codex`, `claude`, `gemini` 중 필요한 CLI 로그인이 이미 되어 있어야 한다.
- `OPENAI_API_KEY`는 OpenAI provider를 추가로 켤 때만 필요하다.

### 2. Discord 설정

필수:
- Bot scope: `bot`, `applications.commands`
- Intent: `MESSAGE CONTENT INTENT`
- 권한: `View Channels`, `Send Messages`, `Read Message History`, `Add Reactions`, `Use Slash Commands`

### 3. Docker Compose 실행

```bash
docker compose up --build
```

기동 서비스:
- `discord-bot` : `http://localhost:3000/health`
- `collector` : `http://localhost:5002`
- `mcp-orchestrator` : `http://localhost:5003`

## Human Input 운영 방식

human input 채널은 하나만 둔다.

권장 예시:
- `DISCORD_HUMAN_INPUT_CHANNEL_IDS=123456789012345678`

채널에 입력 가능한 형태:

### 1. 빠른 관측

```text
title: Cursor adoption spike
entities: Cursor, OpenAI

개발팀에서 seat 확대 언급이 이번 주에 급증했다.
```

### 2. 분석/스터디 결과

```text
title: Developer workflow study
entities: Cursor
why_now: team-wide rollout expanded this month
supporting_points: review workflow lock-in; repeat seat expansion

코드 리뷰 워크플로우 중심으로 유입이 강하다.
```

### 3. 구조화된 데이터

```json
{
  "evidence_items": [
    {
      "evidence_id": "local-1",
      "entity_candidates": ["Cursor"],
      "signal_type": "channel_check",
      "title_or_label": "Three teams added paid seats",
      "trust_score": 0.9
    }
  ]
}
```

collector는 이를 `human_input_inbox` source로 받고 내부 라우터가 적절한 ingestion 타입으로 fan-out 한다.

## 주요 API

### Collector public
- `POST /collect/run`
- `GET /candidates/emerging`
- `GET /evidence/bundles/{entity}`
- `GET /sources/status`
- `GET /sources/catalog`
- `GET /ingest/submissions`
- `GET /ingest/submissions/{submission_id}`
- `POST /ingest/human-input`
- `POST /ingest/human-observation`
- `POST /ingest/human-study-result`
- `POST /ingest/human-data-source`
- `POST /ingest/human-analyst-request`

### Collector internal
- `GET /internal/next-candidates`
- `POST /internal/build-bundle`
- `POST /internal/analysis/run`
- `GET /internal/analysis/status/{entity}`
- `GET /internal/analysis/preview/{entity}`
- `GET /internal/analysis/preview-batch`
- `POST /internal/sources/run/{source_id}`
- `PATCH /internal/sources/{source_id}/tier`
- `PATCH /internal/sources/{source_id}/enable`
- `GET /internal/sources/{source_id}/validity`

### Orchestrator
- `POST /runs/from-candidate`
- `POST /runs/:id/research`
- `POST /runs/:id/verdict`
- `GET /runs/:id/research-requests`
- `GET /runs/:id/state`
- `GET /runs/:id/verdict`
- `GET /health`

## Collector CLI 분석

collector는 Docker 안에서도 CLI 기반 분석을 수행할 수 있게 구성되어 있다.

기본값:
- execution mode: `batch`
- batch size: `3`
- provider: `codex`
- default model: `gpt-5.4-mini`

human input 라우팅도 별도 domain에서 CLI JSON 분류를 사용한다.

중요:
- collector와 orchestrator는 둘 다 호스트의 CLI 인증 디렉터리와 npm global package mount를 사용한다.
- Docker Compose 기준으로 `${HOME}/.codex`, `${HOME}/.claude`, `${HOME}/.gemini` 및 관련 package 경로가 유효해야 한다.
- orchestrator는 기본적으로 CLI provider만으로 부팅되며, `OPENAI_API_KEY`가 있을 때만 OpenAI provider를 registry에 추가한다.

벤치:

```bash
cd packages/collector
PYTHONPATH=. RUN_REAL_CODEX_SMOKE=1 python3 -m src.analysis.benchmark
```

프롬프트 미리보기:

```bash
curl http://localhost:5002/internal/analysis/preview-batch
curl http://localhost:5002/internal/analysis/preview/ChatGPT
```

## 개발 명령

```bash
# TypeScript workspace install
npm install

# discord-bot dev
npm run dev:bot

# orchestrator dev
npm run dev:orchestrator

# collector tests
cd packages/collector && pytest

# shared-types build
npm exec tsc -b packages/shared-types/tsconfig.json
```

## Discord 명령어

| 명령어 | 설명 |
|--------|------|
| `/ping` | 봇 상태 확인 |
| `/watchlist-add ticker:<코드>` | 관심 종목 추가 |
| `/watchlist-remove ticker:<코드>` | 관심 종목 제거 |
| `/watchlist-list` | 관심 종목 목록 |
| `/report-summary` | 요약 리포트 생성 |
| `/report-full` | 전체 리포트 생성 |
| `/report-status` | 리포트 설정 및 최근 실행 상태 |
| `/agent-status` | 에이전트 상태 조회 |
| `/agent-run` | 에이전트 실행 |
| `/radar-status` | source 상태 조회 |
| `/radar-emerging` | 떠오르는 후보 조회 |
| `/human-queue` | 대기 중인 사람 입력 요청 조회 |
| `/voice-start [channel]` | 음성 수집 시작 |
| `/voice-stop` | 음성 수집 중단 |

## 주요 환경 변수

| 변수 | 서비스 | 설명 |
|------|--------|------|
| `DISCORD_TOKEN` | discord-bot | Discord bot token |
| `DISCORD_CLIENT_ID` | discord-bot | Discord app client id |
| `DISCORD_HUMAN_INPUT_CHANNEL_IDS` | discord-bot | human input 단일 채널 allowlist |
| `DISCORD_HUMAN_QUEUE_CHANNEL_IDS` | discord-bot | `/human-queue` 허용 채널 |
| `ANALYSIS_BACKEND` | discord-bot | 현재 `orchestrator`만 사용 |
| `COLLECTOR_BASE_URL` | discord-bot/orchestrator | collector base URL |
| `ORCHESTRATOR_BASE_URL` | discord-bot | orchestrator base URL |
| `LLM_ANALYSIS_ENABLED` | collector | candidate batch analysis on/off |
| `LLM_ANALYSIS_EXECUTION_MODE` | collector | 기본 `batch` |
| `LLM_ANALYSIS_BATCH_SIZE` | collector | batch prompt 후보 수 |
| `LLM_CLI_EXEC_PATH` | collector | 기본 `codex` |
| `LLM_DEFAULT_MODEL` | collector | 기본 `gpt-5.4-mini` |
| `LLM_HUMAN_ROUTING_ENABLED` | collector | human input collector-side routing on/off |
| `LLM_HUMAN_ROUTING_MODEL` | collector | human input routing model |
| `DEFAULT_PROVIDERS` | mcp-orchestrator | 기본 provider 우선순위 |
| `OPENAI_API_KEY` | mcp-orchestrator | optional OpenAI fallback provider key |

전체 목록과 기본값은 `.env.example`를 기준으로 본다.

## 프로젝트 구조

```text
packages/
  shared-types/       공용 타입
  discord-bot/        Discord 인터페이스
  collector/          ingestion + source registry + candidate analysis
  mcp-orchestrator/   phase-aware 투자 판단 파이프라인
  predictor-legacy/   리포지토리에는 남아 있지만 기본 런타임에서는 미사용
```

## 라이선스

Private
