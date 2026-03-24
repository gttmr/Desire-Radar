# Agentic-World — 욕망 레이더

소비자 욕구 탐지 및 투자 신호 생성 시스템. 다중 소스에서 트렌드 데이터를 수집하고, AI 에이전트가 토론하여 일일 분석 리포트를 생성한다.

## 아키텍처

4개 서비스가 Docker Compose로 실행된다.

| 서비스 | 경로 | 언어 | 설명 |
|--------|------|------|------|
| **discord-bot** | `packages/discord-bot/` | TypeScript | Discord 슬래시 커맨드, 스케줄링, 길드 설정 |
| **collector** | `packages/collector/` | Python | 다중 소스 데이터 수집, evidence 생산, 신호 후보 생성 |
| **mcp-orchestrator** | `packages/mcp-orchestrator/` | TypeScript | 세션형 다중 프로바이더 MCP 오케스트레이터, 에이전트 토론 |
| **predictor-legacy** | `packages/predictor-legacy/` | Python | 기존 KRX 주식 리포트 파이프라인 (점진적 축소 예정) |

공유 타입은 `packages/shared-types/`에서 관리한다.

```
┌──────────────┐     ┌────────────┐     ┌───────────────────┐
│  Discord Bot │────▶│  Collector  │────▶│  MCP Orchestrator │
│  (commands,  │     │  (8 source  │     │  (multi-provider  │
│   schedule)  │     │  connectors)│     │   agent debate)   │
└──────┬───────┘     └────────────┘     └───────────────────┘
       │
       ▼
┌──────────────┐
│  Predictor   │
│  (legacy)    │
└──────────────┘
```

## Collector 데이터 소스

| 커넥터 | 주기 | 설명 |
|--------|------|------|
| Google Trends | 6h | 검색 트렌드 변화 감지 |
| Reddit Mentions | 1h | 서브레딧 언급 급증 탐지 |
| Naver DataLab | 12h | 네이버 검색어 트렌드 |
| App Store Top Charts | 1h | 앱스토어 순위 변동 |
| SteamDB Top Sellers | 1h | Steam 판매 순위 |
| TikTok Creative Center | 1h | TikTok 트렌드 |
| SimilarWeb Movers | 24h | 웹 트래픽 급증 사이트 |
| Manual Observation | — | 수동 입력 |

## MCP 오케스트레이터 에이전트

`search_intent` · `ranking_momentum` · `conversion_proxy` · `scarcity` · `diffusion` · `human_intel` · `theme_mapper` · `synthesis` · `report`

핵심 에이전트는 2개 이상 provider(Codex, Claude, Gemini)로 병렬 실행 후 비교/합성한다.

## 빠른 시작

### 1. 환경 변수 설정

```bash
cp .env.example .env
```

최소 필수 값:
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`

### 2. Docker Compose 실행

```bash
docker compose up --build
```

4개 서비스가 함께 기동된다:
- discord-bot: `:3000/health`
- collector: `:5002`
- mcp-orchestrator: `:5003`
- predictor-legacy: `:5001`

### 3. 개발 모드 (개별 실행)

```bash
# TypeScript 패키지 빌드
npm install
npm run build

# discord-bot 핫 리로드
npm run dev:bot

# mcp-orchestrator 핫 리로드
npm run dev:orchestrator

# collector 테스트
cd packages/collector && pytest
```

## Discord 명령어

| 명령어 | 설명 |
|--------|------|
| `/ping` | 봇 상태 확인 |
| `/watchlist-add ticker:<코드>` | 관심 종목 추가 |
| `/watchlist-remove ticker:<코드>` | 관심 종목 제거 |
| `/watchlist-list` | 관심 종목 목록 |
| `/report-summary` | 요약 리포트 |
| `/report-full` | 전체 리포트 |
| `/report-status` | 리포트 상태 |
| `/voice-start [channel]` | 음성 수집 시작 |
| `/voice-stop` | 음성 수집 중단 |

## 환경 변수

| 변수 | 서비스 | 필수 | 설명 |
|------|--------|------|------|
| `DISCORD_TOKEN` | discord-bot | O | Discord 봇 토큰 |
| `DISCORD_CLIENT_ID` | discord-bot | O | Discord 앱 클라이언트 ID |
| `DISCORD_GUILD_ID` | discord-bot | | 테스트 길드 ID |
| `ANALYSIS_BACKEND` | discord-bot | | `predictor` (기본) 또는 `orchestrator` |
| `COLLECTOR_PORT` | collector | | 기본 5002 |
| `ORCHESTRATOR_PORT` | mcp-orchestrator | | 기본 5003 |
| `DEFAULT_PROVIDERS` | mcp-orchestrator | | 기본 `codex,claude` |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | predictor-legacy | | 한국투자증권 API |
| `DART_API_KEY` | predictor-legacy | | DART 공시 API |
| `AZURE_OPENAI_*` | predictor-legacy | | Azure OpenAI 설정 |

전체 목록은 `.env.example` 참조.

## 프로젝트 구조

```
packages/
  shared-types/       # @agentic/shared-types — 모듈 간 공유 타입
  discord-bot/        # @agentic/discord-bot — Discord 인터페이스
  collector/          # agentic-collector — Python 수집 서비스
  mcp-orchestrator/   # @agentic/mcp-orchestrator — 에이전트 오케스트레이션
  predictor-legacy/   # 기존 predictor (호환 유지)
```

npm workspaces로 TypeScript 패키지를 관리한다. Python 패키지(collector, predictor-legacy)는 독립 관리.

## 라이선스

Private
