# Agentic-World — 욕망 레이더

사람들의 욕망과 초기 행동 신호를 수집하고, 여러 에이전트의 토론을 통해 투자 가능한 해석으로 바꾸는 시스템이다.

현재 기본 런타임은 `discord-bot`, `collector`, `mcp-orchestrator` 3개 서비스다.

## 문서 가이드

- [AGENTS.md](AGENTS.md): Codex CLI 작업 규칙과 저장소 작업 방식
- [ARCHITECTURE.md](ARCHITECTURE.md): 서비스 경계, 핵심 추상화, CLI/provider 변동성 대응 원칙
- [RUNBOOK.md](RUNBOOK.md): WSL 기준 로컬 런타임, 네이티브 실행, 재기동, health, smoke, 장애 대응 절차
- [docs/collector-source-agents.md](docs/collector-source-agents.md): collector source-agent living design
- [docs/investment-module.md](docs/investment-module.md): free-form human input와 orchestrator investment module living design
- `packages/mcp-orchestrator/src/agents/*.md`: 오케스트레이터 분석 에이전트 프롬프트

## 아키텍처

| 서비스 | 경로 | 언어 | 역할 |
|--------|------|------|------|
| `discord-bot` | `packages/discord-bot/` | TypeScript | Discord 명령, 스케줄 리포트, 단일 human input 채널 수집 |
| `collector` | `packages/collector/` | Python | 다중 소스 ingestion, source registry, submission tracking, candidate 생성, collector-side CLI 분석, evidence graph snapshot |
| `mcp-orchestrator` | `packages/mcp-orchestrator/` | TypeScript | `triage -> debate -> research-loop -> verdict -> report` 투자 판단 파이프라인과 provider session orchestration |
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
  - evidence bundle + graph snapshot
        |
        v
 mcp-orchestrator
  - triage
  - debate
  - research-loop
  - verdict
  - report
  - provider session dir + transport dispatch
```

## 핵심 동작

### Collector
- 공개 API, 사람 입력, agent push, pull connector를 모두 공통 ingestion pipeline으로 처리한다.
- source registry가 각 source의 `kind`, `ingestion_mode`, `configured_tier`, `effective_tier`, validity 상태를 관리한다.
- source별 `agent.md`를 통해 source submission 단위 요약과 파생 evidence를 만들 수 있다.
- candidate 분석은 기본적으로 `batch` 모드로 돌아가며, 상위 후보를 묶어 CLI 기반 LLM 호출을 수행한다.
- `POST /ingest/human-input`는 free-form 입력을 받아 collector 내부에서 해석 결과 객체를 만든다.
  - `collector_route`
  - `input_kind`
  - `action_requests`
  - `handoff_targets`
  - `asset_candidates`
  - `investment_note`
  - `user_message`
- collector는 collector-native route가 있으면 evidence ingest로 fan-out 하고, command-only 입력이면 raw submission만 보존한 채 후속 서비스가 쓸 구조화 결과를 남긴다.

### Orchestrator
- collector 후보를 받아 phase-aware 의사결정 파이프라인으로 처리한다.
- research 부족분은 collector submission API를 통해 다시 요청한다.
- 최종 verdict는 premium model policy를 분리해 사용한다.
- 기본 provider 경로는 `codex, claude, gemini`다.
- `ENABLED_PROVIDERS`가 실제 등록과 health monitoring 대상을 결정하고, `DEFAULT_PROVIDERS`는 그 안에서 실행 우선순위를 결정한다.
- `OPENAI_API_KEY`만으로는 OpenAI provider가 자동 등록되지 않고, `ENABLED_PROVIDERS`에 `openai`를 넣었을 때만 추가 등록된다.
- provider session마다 request/response artifact를 JSON으로 남긴다.
- transport는 `cli_exec`, `cli_resume`, `external_injection` 중 하나를 사용한다.
- free-form human study 입력은 orchestrator 내부 investment module이 Markdown intake와 asset dossier로 축적한다.

### Discord Bot
- 하나의 human input 채널만 본다.
- 메시지 내용을 bot이 직접 분류하지 않고 raw envelope 그대로 collector에 전달한다.
- collector가 돌려준 `action_requests` 중 저위험 주식 watchlist add/remove만 자동 실행한다.
- collector가 돌려준 `investment_module` handoff는 orchestrator investment intake API로 전달한다.
- slash command 표면은 `report`, `radar`, `run`, `queue`, `ops` 5개 namespace로 고정한다.

## 빠른 시작

기본 전제:
- 모든 운영/개발 명령은 WSL/bash에서 실행한다.
- Docker Compose도 WSL에서 실행한다.
- provider CLI 인증은 WSL 홈 기준으로 준비한다.
- provider smoke와 실제 CLI 실행 신뢰성의 기준값도 WSL 네이티브에서 본다.

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
- `DISCORD_DAILY_REPORT_CHANNEL_ID`
- `DISCORD_STATUS_CHANNEL_IDS`
- `DISCORD_PROVIDER_ALERT_CHANNEL_IDS`
- `OPENAI_API_KEY`
- collector connector API key들

기본 런타임 전제:
- collector와 orchestrator는 CLI provider를 기본 경로로 사용한다.
- Docker Compose를 쓰려면 호스트에서 `codex`, `claude`, `gemini` 중 필요한 CLI 로그인이 이미 되어 있어야 한다.
- `${HOME}` 기준 Docker mount는 WSL 홈을 바라본다.
- `OPENAI_API_KEY`는 OpenAI provider를 추가로 켤 때만 필요하다.
- Docker compose runtime은 Codex CLI에 불필요한 `OPENAI_BASE_URL` env를 넘기지 않도록 container env에서 빈 값으로 덮고, 앱 내부에서만 기본값으로 복원한다.
- Docker에서 특정 provider가 TLS/CA 같은 이유로 계속 깨지면 `ENABLED_PROVIDERS`에서 빼고 재기동하는 쪽이 맞다.
- `mcp-orchestrator` Docker 이미지는 Codex/Gemini TLS probe를 위해 system CA bundle을 포함해야 한다. 현재 이미지는 `ca-certificates`와 `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`를 같이 설정한다.
- `mcp-orchestrator`에서 Codex를 실제로 쓸 때는 `${HOME}/.codex` mount를 writable로 두는 편이 낫다. WebSocket 고부하 시 HTTPS fallback과 모델 cache 갱신이 read-only mount에서 실패할 수 있다.
- Gemini도 `${HOME}/.gemini` 아래에 state/history/tmp를 쓰므로, Docker에서 실제 실행/health probe를 돌릴 때는 writable mount가 안전하다.
- provider session artifact는 `data/provider-sessions`, collector CLI session artifact는 `data/llm-session-workdirs` 아래에 쌓인다.
- collector source-agent artifact는 `data/source_agent_artifacts.json`과 source-agent session workdir 아래에 남는다.
- provider 장애 알림은 discord-bot이 `/health`를 polling해서 보내고, optional repair command는 orchestrator가 인증/로그인 계열 실패에 한해 수행한다.
- Discord provider alert에는 현재 에러 요약, check 시각, repair 설정 여부, 마지막 repair 결과가 같이 포함된다.

CLI 상태 확인/복구 기준:
- Codex: `codex login status`로 인증 상태를 확인한다. 비대화형 복구가 필요하면 `printenv OPENAI_API_KEY | codex login --with-api-key` 같은 wrapper command를 `PROVIDER_REPAIR_CODEX_COMMAND`에 넣는다.
- Claude: `claude auth status`로 상태를 확인한다. 복구는 `claude auth login --claudeai` 또는 `claude auth login --console` wrapper를 `PROVIDER_REPAIR_CLAUDE_COMMAND`에 넣는다.
- Gemini: 현재 설치된 CLI에서는 별도 `auth status/login` 서브커맨드가 보이지 않으므로, health probe는 headless prompt 실행으로 판단하고 자동 repair는 기본 비활성으로 두는 편이 안전하다.

provider health 의미:
- `/health`의 provider 항목은 단순 `available`만 보지 않는다.
- `auth_status`, `execute_status`, `transport_status`, `ready_for_execution`, `failure_kind`, `error_summary`를 함께 본다.
- `ready_for_execution=false`면 로그인은 살아 있어도 debate/verdict 경로에는 투입하지 않는다.

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

운영용 collector 대시보드:
- `http://localhost:5002/dashboard`
- source enable/disable, tier 변경, source run, source-agent run, 최근 evidence/submission/candidate 조회를 한 화면에서 볼 수 있다.
- source별 `packages/collector/src/agents/sources/*.md` 프롬프트를 대시보드에서 수정할 수 있다.
- allowlist 된 일부 collector `.env` 값도 편집할 수 있다.
- `.env` 저장 후 collector 재기동 전까지는 startup-time 설정이 즉시 반영되지 않는다.

자세한 재기동/강제 recreate/troubleshooting은 [RUNBOOK.md](RUNBOOK.md)를 따른다.

## Human Input 운영 방식

human input 채널은 하나만 둔다.

권장 예시:
- `DISCORD_HUMAN_INPUT_CHANNEL_IDS=123456789012345678`

채널 입력은 자유 형식이 기본이다. 아래는 가능한 예시일 뿐 필수 템플릿이 아니다.

### 1. 자연어 명령

```text
삼성전자 와치리스트에 추가해
```

### 2. 자유 형식 스터디 메모

```text
삼성전자 쪽을 이번 달 내내 다시 보고 있다.
HBM과 패키징 투자, 그리고 고객사 확보 속도 때문에 메모리 사이클보다
상향 여지가 더 클 수 있다고 본다.
```

### 3. 구조화된 데이터(JSON도 계속 지원)

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

collector는 이를 `human_input_inbox` source로 받고 다음을 판단한다.
- collector-native evidence ingest route
- 저위험 watchlist auto-action 가능 여부
- investment module handoff 여부

장문 스터디/리서치 입력은 orchestrator의 investment module에 Markdown으로 축적된다.

## Session And Graph Strategy

- collector의 목적은 단어만 모으는 것이 아니라 매일의 사건, 신호, 관계를 evidence bundle로 정리하는 것이다.
- 각 bundle은 `evidence_items`와 함께 `graph` snapshot을 가진다. 이 graph는 최소한 `entity`, `source`, `signal`, `event` 관계를 보존한다.
- orchestrator는 graph summary를 prompt에 같이 넣어 “어떤 사건이 누구에게 연결되는지”를 더 일관되게 판단한다.
- provider 결과는 가능하면 즉시 stdout/json으로 받고, 동시에 session directory에도 기록한다.
- collector source-agent session은 collector candidate analysis session과 별개다. 전자는 source submission enrichment용, 후자는 candidate shortlist enrichment용이다.
- caller가 결과를 직접 회수할 수 없거나 future Discord/bridge 주입이 필요하면 `external_injection` transport가 같은 session directory를 통해 결과를 회수한다.

## 주요 API

### Collector public
- `POST /collect/run`
- `GET /candidates/emerging`
- `GET /evidence/bundles/{entity}`
- `GET /sources/status`
- `GET /sources/catalog`
- `GET /runtime/status`
- `GET /ingest/submissions`
- `GET /ingest/submissions/{submission_id}`
- `POST /ingest/human-input`
- `POST /ingest/human-observation`
- `POST /ingest/human-study-result`
- `POST /ingest/human-data-source`
- `POST /ingest/human-analyst-request`
- `GET /dashboard`
- `GET /dashboard/api/overview`
- `GET /dashboard/api/env-settings`
- `PATCH /dashboard/api/env-settings`
- `GET /dashboard/api/source-prompts`
- `GET /dashboard/api/source-prompts/{source_id}`
- `PATCH /dashboard/api/source-prompts/{source_id}`

`POST /collect/run` 기본 의미:
- connector를 지정하지 않으면 현재 `enabled=true` 인 pull source만 queue에 넣는다.
- disabled source는 자동 skip 하며 응답에 `queued_sources`, `skipped_sources`, `skipped_disabled_count`가 포함된다.
- disabled connector를 명시하면 500이 아니라 structured `409`를 반환한다.

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
- `GET /internal/source-agents/{source_id}/status`
- `GET /internal/source-agents/{source_id}/preview`
- `POST /internal/source-agents/run/{source_id}`

### Orchestrator
- `POST /runs/from-candidate`
- `POST /runs/:id/research`
- `POST /runs/:id/verdict`
- `GET /runs/:id/research-requests`
- `GET /runs/:id/state`
- `GET /runs/:id/verdict`
- `GET /health`
- `POST /investment/intake`
- `GET /investment/intakes/:intake_id`
- `GET /investment/assets/:asset_key`

## Collector CLI 분석

collector는 Docker 안에서도 CLI 기반 분석을 수행할 수 있게 구성되어 있다.

기본값:
- execution mode: `batch`
- batch size: `3`
- provider: `codex`
- default model: `gpt-5.4-mini`

human input 라우팅도 별도 domain에서 CLI JSON 분류를 사용한다.
source-agent 실행도 collector 전체 공통 provider/model 설정을 쓰고, source별 차이는 `packages/collector/src/agents/sources/*.md`와 source metadata로만 준다.

중요:
- collector와 orchestrator는 둘 다 호스트의 CLI 인증 디렉터리와 npm global package mount를 사용한다.
- Docker Compose 기준으로 `${HOME}/.codex`, `${HOME}/.claude`, `${HOME}/.gemini` 및 관련 package 경로가 유효해야 한다.
- orchestrator는 기본적으로 CLI provider만으로 부팅되며, `OPENAI_API_KEY`가 있을 때만 OpenAI provider를 registry에 추가한다.
- provider session은 provider/phase/agent/run 단위 디렉터리에 유지되고, request/response artifact를 turn별 JSON으로 기록한다.
- direct stdout 회수가 불안정하거나 future bridge가 필요하면 provider별 `external_injection` transport로 전환할 수 있다.
- collector source run은 기본적으로 queue 기반 비동기 실행이다. 장시간 수집은 `submission_id`와 `/sources/status`, `/runtime/status`로 추적한다.
- `sources/status`와 `runtime/status`는 `last_failure_kind`, `partial_failure_count`, `last_warning_kind`, `last_warning_message` 같은 partial failure metadata도 함께 보여준다.
- collector evidence bundle은 prompt용 요약뿐 아니라 graph snapshot도 같이 만든다.

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

# orchestrator provider smoke (real CLI auth + execute)
npm --prefix packages/mcp-orchestrator run build
npm --prefix packages/mcp-orchestrator run smoke:providers

# orchestrator + collector end-to-end smoke (requires both services running)
npm --prefix packages/mcp-orchestrator run smoke:end-to-end

# collector tests
cd packages/collector && pytest

# shared-types build
npm exec tsc -b packages/shared-types/tsconfig.json
```

## Discord 명령어

### `/report`
- `/report watchlist add ticker:<코드>`: 관심 종목 추가
- `/report watchlist remove ticker:<코드>`: 관심 종목 제거
- `/report watchlist list`: 관심 종목 목록 조회
- `/report run [detail:summary|full]`: 일일 리포트를 실행하고 보고 채널로 전송
- `/report status`: 리포트 설정과 최근 실행 상태 조회

### `/radar`
- `/radar sources`: collector source 상태 조회
- `/radar candidates [limit]`: 떠오르는 후보 조회
- `/radar collect [source]`: enabled pull source 전체 또는 특정 source 수집 실행

### `/run`
- `/run start entity:<이름>`: orchestrator run 시작
- `/run status run_id:<id>`: run 상태 요약
- `/run verdict run_id:<id>`: verdict와 beneficiary mapping 요약
- `/run research run_id:<id>`: research loop 상태 요약
- `/run requests run_id:<id>`: research request 목록 조회

### `/queue`
- `/queue human [limit]`: `pending_human` 요청 조회

### `/ops`
- `/ops health`: bot, collector, orchestrator 종합 상태 조회
- `/ops providers`: provider별 auth/execute/readiness 상태 조회

## Smoke 해석 기준

- `smoke:providers`
  - `healthStatus`가 `healthy`면 provider health probe 통과
  - `executeStatus=degraded`면 provider 실패가 구조적으로 surface된 것
- `smoke:end-to-end`
  - human input submission과 pull source submission이 둘 다 settle 되어야 한다
  - candidate가 생성되고 `POST /runs/from-candidate`가 verdict를 반환해야 한다
  - beneficiary mapping이 비어 있으면 실패로 본다
  - provider가 degraded 상태라면 verdict confidence가 cap되어야 한다

## 주요 환경 변수

| 변수 | 서비스 | 설명 |
|------|--------|------|
| `DISCORD_TOKEN` | discord-bot | Discord bot token |
| `DISCORD_CLIENT_ID` | discord-bot | Discord app client id |
| `DISCORD_HUMAN_INPUT_CHANNEL_IDS` | discord-bot | human input 단일 채널 allowlist |
| `DISCORD_HUMAN_QUEUE_CHANNEL_IDS` | discord-bot | `/queue human` 허용 채널 |
| `DISCORD_DAILY_REPORT_CHANNEL_ID` | discord-bot | 매일 리포트 기본 채널 |
| `DISCORD_STATUS_CHANNEL_IDS` | discord-bot | 서버 상태/운영 알림 채널 |
| `DISCORD_PROVIDER_ALERT_CHANNEL_IDS` | discord-bot | provider 장애/복구 알림 채널 |
| `PROVIDER_ALERT_POLL_INTERVAL_SEC` | discord-bot | provider 알림 polling 주기 |
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
| `LLM_SESSION_WORKDIR_ROOT` | collector | collector CLI session/artifact 루트 |
| `ENABLED_PROVIDERS` | mcp-orchestrator | 실제 등록 + health monitoring 대상 provider 목록 |
| `DEFAULT_PROVIDERS` | mcp-orchestrator | 기본 provider 우선순위 |
| `CODEX_TRANSPORT` | mcp-orchestrator | codex transport 기본값 (`cli_exec` 또는 `external_injection`) |
| `CLAUDE_TRANSPORT` | mcp-orchestrator | claude transport 기본값 |
| `GEMINI_TRANSPORT` | mcp-orchestrator | gemini transport 기본값 |
| `PROVIDER_SESSION_ROOT_DIR` | mcp-orchestrator | provider session/artifact 루트 |
| `PROVIDER_EXTERNAL_POLL_INTERVAL_MS` | mcp-orchestrator | external injection 응답 polling 간격 |
| `PROVIDER_HEALTH_POLL_INTERVAL_SEC` | mcp-orchestrator | provider health probe 주기 |
| `PROVIDER_REPAIR_COOLDOWN_SEC` | mcp-orchestrator | provider repair 재시도 cooldown |
| `PROVIDER_REPAIR_CODEX_COMMAND` | mcp-orchestrator | optional Codex repair command |
| `PROVIDER_REPAIR_CLAUDE_COMMAND` | mcp-orchestrator | optional Claude repair command |
| `PROVIDER_REPAIR_GEMINI_COMMAND` | mcp-orchestrator | optional Gemini repair command |
| `OPENAI_API_KEY` | mcp-orchestrator | optional OpenAI fallback provider key |

전체 목록과 기본값은 `.env.example`를 기준으로 본다.

## 프로젝트 구조

```text
packages/
  shared-types/       공용 타입
  discord-bot/        Discord 인터페이스
  collector/          ingestion + source registry + candidate analysis
  mcp-orchestrator/   phase-aware 투자 판단 파이프라인
```

## 라이선스

Private
