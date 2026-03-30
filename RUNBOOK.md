# Agentic-World Runbook

## Scope
이 문서는 WSL 기준 로컬 런타임, Docker Compose 재기동, provider 점검, Discord 테스트, collector 상태 확인 절차를 정리한다.

이 문서의 기본 원칙:
- 모든 운영 명령은 WSL/bash에서 실행한다.
- PowerShell이나 Windows `node.exe` 경로는 예외 상황이 아니면 쓰지 않는다.
- 런타임 문제는 먼저 `health`, `runtime/status`, `submission status`로 관찰하고, 그 다음 재기동한다.

## Runtime Shape
기본 런타임은 아래 3개다.

- `collector`
- `mcp-orchestrator`
- `discord-bot`

## WSL Assumptions
- 저장소 루트는 WSL에서 `/mnt/c/Users/ilmas/workspace/Agentic-World`로 접근한다.
- Docker Compose는 WSL 셸에서 실행한다.
- `${HOME}` 기준 mount는 WSL 홈을 가리킨다.
- provider CLI 인증도 WSL 홈 기준으로 준비되어 있어야 한다.

필수 확인:

```bash
which codex
which claude
which gemini
codex login status
claude auth status
gemini -p "Reply with exactly OK"
```

현재 WSL node 경로:

```bash
export PATH=/home/ilmaswsl/.nvm/versions/node/v24.13.0/bin:$PATH
node -v
npm -v
```

`nvm` 초기화가 셸에서 자동으로 안 잡히면 위 경로를 먼저 PATH에 넣고 smoke와 build를 실행한다.

## Start And Rebuild
루트에서 실행:

```bash
docker compose up -d --build collector mcp-orchestrator discord-bot
```

상태 확인:

```bash
docker compose ps
docker compose logs --tail=100 collector
docker compose logs --tail=100 mcp-orchestrator
docker compose logs --tail=100 discord-bot
```

특정 서비스만 재기동:

```bash
docker compose restart collector
docker compose restart mcp-orchestrator
docker compose restart discord-bot
```

특정 서비스만 강제 recreate:

```bash
docker compose up -d --build --force-recreate collector
docker compose up -d --build --force-recreate mcp-orchestrator
docker compose up -d --build --force-recreate discord-bot
```

## Native WSL Startup
Docker Compose가 아니라 WSL에서 각 프로세스를 직접 띄우고 싶을 때는 아래 순서를 사용한다.

사전 준비:

```bash
cd /mnt/c/Users/ilmas/workspace/Agentic-World
npm install
cd packages/collector
python3 -m pip install -e .
```

터미널 1, collector:

```bash
cd /mnt/c/Users/ilmas/workspace/Agentic-World/packages/collector
PYTHONPATH=. python3 -m uvicorn src.server:app --host 127.0.0.1 --port 5002
```

터미널 2, orchestrator:

```bash
export PATH=/home/ilmaswsl/.nvm/versions/node/v24.13.0/bin:$PATH
cd /mnt/c/Users/ilmas/workspace/Agentic-World/packages/mcp-orchestrator
npm run build
npm run start
```

터미널 3, discord-bot:

```bash
export PATH=/home/ilmaswsl/.nvm/versions/node/v24.13.0/bin:$PATH
cd /mnt/c/Users/ilmas/workspace/Agentic-World/packages/discord-bot
npm run build
npm run start
```

개발 모드가 필요하면:

```bash
cd /mnt/c/Users/ilmas/workspace/Agentic-World
npm run dev:orchestrator
npm run dev:bot
```

주의:
- 모든 명령은 WSL/bash에서 실행한다.
- provider CLI도 WSL PATH에서 보여야 한다.
- Windows `node.exe`나 PowerShell을 기본 실행 경로로 섞지 않는다.

## Health Checks
### Collector

```bash
curl http://127.0.0.1:5002/health
curl http://127.0.0.1:5002/sources/status
curl http://127.0.0.1:5002/runtime/status
```

`sources/status`에서 source가 오래 `source_agent_analysis` 단계에 머물면 먼저 `LLM_SOURCE_AGENT_TIMEOUT_SECONDS` 값을 확인한다. 기본값은 `60`이며, source-agent가 불안정할 때 collector 전체 수집 시간이 묶이지 않도록 source-agent timeout을 analysis timeout과 분리해 둔다. 기본 실행이 실패하면 collector는 더 작은 `compact` 또는 `minimal` 컨텍스트로 fresh 재시도를 시도한다.

collector source gate 해석:
- `enabled=false`: 운영자가 꺼 둔 상태
- `runnable=false`: source 정의상 직접 실행 경로가 없는 상태
- `readiness_status!=ready`: 지금 queue에 넣지 않는 것이 맞는 상태
  - 예: `missing_credentials`, `rate_limited`, `dependency_missing`

현재 기본 public-first pull 세트:
- `app_store_top_charts`
- `google_trends`
- `hackernews`
- `polymarket_markets`
- `steamdb_top_sellers`
- `similarweb_movers`

기본 gating pull 세트:
- `reddit_mentions`: Reddit OAuth credential 필요
- `naver_datalab`: Naver API credential 준비 후 enable
- `tiktok_creative_center`: public endpoint 안정성 검증 전 기본 disabled

추가 public pull source 메모:
- `hackernews`: Algolia public API 사용, `HACKERNEWS_TAGS`/`HACKERNEWS_HITS_PER_TAG`/`HACKERNEWS_COMMENT_ENRICH_LIMIT`로 버킷과 enrichment 범위를 조절
- `polymarket_markets`: Gamma public search 사용, `POLYMARKET_SEARCH_QUERIES`/`POLYMARKET_PAGES_PER_QUERY`로 active market discovery 범위를 조절

`reddit_mentions`는 Reddit OAuth Data API를 전제로 한다. 아래 중 하나가 없으면 source는 `auth_not_configured` warning과 함께 skip된다.

- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` + `REDDIT_REFRESH_TOKEN`
- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` + `REDDIT_USERNAME` + `REDDIT_PASSWORD`

또한 `REDDIT_USER_AGENT`는 고유하고 설명적인 값으로 설정해야 한다.

브라우저 대시보드:

```bash
xdg-open http://127.0.0.1:5002/dashboard
```

대시보드에서 가능한 작업:
- 최근 evidence / submission / candidate 확인
- source enable/disable, tier 변경, source run, source-agent run
- source별 source-agent markdown prompt 수정
- allowlist 된 collector `.env` 값 수정
- candidate 카드는 raw word list보다 canonical cluster/event facet를 우선 보여준다.
- source row subtext는 현재 stage, 마지막 warning/failure, source-agent error 순으로 보여준다.
- source row subtext에는 `readiness_status`, `fetch_strategy`, `freshness_lag_seconds`, `quality_status`, recent warning/failure trend도 포함된다.

주의:
- 대시보드의 `.env` 편집은 파일을 저장하지만, startup-time 설정은 collector 재기동 후 반영된다.
- Docker Compose에서는 `.env`가 collector 컨테이너의 `/app/.env`로 mount 되어 있어야 편집이 host 파일에 반영된다. 현재 compose는 이를 포함한다.

의미:
- `/health`: 빠른 liveness + analysis/source queue 요약
- `/sources/status`: source별 enabled/tier/validity + readiness + 현재 run state + 최근 quality/run summary
- `/runtime/status`: source run queue, worker 수, scheduler 상태 + recent run ledger/freshness snapshot
- `dashboard/api/overview`와 `/health`의 `evidence_count`: 실제 candidate 빌드 입력이 메모리에만 있는지, 또는 `data/evidence.json`에서 정상 복구됐는지 확인하는 빠른 지표

현재 collector는 source run을 request thread에서 직접 끝내지 않는다.
- `POST /collect/run` 또는 `POST /internal/sources/run/{source_id}`는 기본적으로 source run을 queue에 넣고 즉시 `submission_id`를 반환한다.
- 실제 진행 상황은 `submission status`와 `sources/status`에서 본다.
- source freshness가 살아 있어도 `evidence_count=0`이면 재기동 후 shortlist 입력이 비어 있는 상태다. 현재 collector는 `data/evidence.json`을 같이 유지해 이 상태를 줄인다.

### Orchestrator

```bash
curl http://127.0.0.1:5003/health
```

긴 investment decision run:
- `POST /investment/decisions/runs`는 provider_exec 경로에서 수 분 이상 걸릴 수 있다.
- 현재 orchestrator와 discord-bot API server는 Node 기본 5분 request timeout을 비활성화해 long-running report trigger를 허용한다.
- Discord bot은 orchestrator 호출에 Node `http/https` client를 사용한다. long-running decision run에서 `fetch` 계열 header timeout이 재발하지 않도록 하기 위한 조치다.
- 그래도 Discord bot에서 `fetch failed`가 보이면, 먼저 orchestrator run dir의 `status.json`과 `provider-attempts/`가 계속 갱신되는지 확인한다.

주의:
- `/health`는 provider probe 때문에 즉시가 아니라 수 초 이상 걸릴 수 있다.
- 이것은 현재 설계상 정상이다.
- provider 항목은 `available`만 보지 말고 아래 필드를 같이 본다.
  - `auth_status`
  - `execute_status`
  - `transport_status`
  - `ready_for_execution`
  - `failure_kind`
  - `error_summary`
- `auth_status=healthy`여도 `ready_for_execution=false`면 실제 debate/verdict 경로에서는 제외된다.
- Docker에서 `codex`가 `transport_failed`와 `no native root CA certificates found`로 보이면, `mcp-orchestrator` 이미지에 `ca-certificates`가 포함되어 있는지 먼저 확인한다.
- Docker에서 Codex가 WebSocket fallback 뒤 `Read-only file system (os error 30)`로 실패하면, `mcp-orchestrator`의 `${HOME}/.codex` mount가 writable인지 같이 확인한다.
- collector source-agent나 collector candidate analysis에서도 같은 오류가 보이면, `collector`의 `${HOME}/.codex` mount도 writable인지 같이 확인한다.
- Docker shell에서 직접 Codex를 칠 때 `OPENAI_BASE_URL` deprecation이 보이면, compose runtime이 최신인지와 컨테이너 env override가 반영됐는지 같이 확인한다.
- Docker에서 Gemini가 `parse_failed`인데 stderr가 비어 있거나 stdout이 계속 비면, `${HOME}/.gemini` mount가 writable인지 먼저 확인한다.
- 특정 runtime에서 provider를 아예 빼고 싶으면 `.env`의 `ENABLED_PROVIDERS`를 줄여서 재기동한다.
  - 예: `ENABLED_PROVIDERS=claude,gemini`
  - `DEFAULT_PROVIDERS`는 등록된 provider 안에서만 우선순위를 정한다.

investment decision run 확인:

```bash
curl -X POST http://127.0.0.1:5003/investment/decisions/runs \
  -H 'Content-Type: application/json' \
  -d '{"mode":"manual","detail":"summary"}'

curl http://127.0.0.1:5003/investment/decisions/latest
curl http://127.0.0.1:5003/investment/decisions/runs/<run_id>
curl 'http://127.0.0.1:5003/investment/decisions/runs/<run_id>/report?detail=summary'
```

의미:
- run은 항상 artifact-first다. `request.json`과 `request.md`가 먼저 생성된다.
- `INVESTMENT_DECISION_RUNNER=provider_exec`면 orchestrator가 직접 provider를 호출한다.
- `provider_exec`에서 전처리 단계가 켜져 있으면 `prepared_request.json`, `prepared_request.md`, `prepared_request.meta.json`이 먼저 생성된다.
- `provider_exec` 경로는 provider raw output, parse error, parse strategy를 `provider-attempts/`에 남긴다.
- attempt artifact에는 `transport_outcome`, `structured_outcome`, `retry_count`, `used_fallback_provider`도 남는다.
- `INVESTMENT_DECISION_RUNNER=external_artifact`면 외부 판단 주체가 `response.json`을 쓸 때까지 polling 한다.
- 결정 결과와 Discord 리포트는 모두 `response.json`을 기준으로 생성된다.

artifact 경로 기본값:

```text
data/investment-decisions/runs/YYYY-MM-DD/<run_id>/
  request.json
  request.md
  status.json
  prepared_request.json
  prepared_request.md
  prepared_request.meta.json
  provider-attempts/
  response.json
  response.md
  report.md
```

curated equity mapping 기본 경로:

```text
data/investment-module/equity-map.json
```

이 파일은 exact alias/ticker/company_name 매칭만 다루는 저위험 매핑 입력이다.
- 파일이 없거나 비어 있으면 orchestrator startup 시 starter map이 자동으로 채워진다.
- starter map은 exact/curated public-equity alias만 포함한다.
- `OpenAI`, `Claude`, `Bitcoin`처럼 직접 상장사로 고정하기 어려운 항목은 기본 starter set에 넣지 않는다.
- 권장 기본값은 `INVESTMENT_DECISION_PREPROCESS_MODEL_PROFILE=cheap`, `INVESTMENT_DECISION_FINAL_MODEL_PROFILE=premium`이다.
- provider 우선순위는 `INVESTMENT_DECISION_PREPROCESS_PROVIDERS`, `INVESTMENT_DECISION_FINAL_PROVIDERS`로 따로 바꿀 수 있다.
- `codex`를 최종 판단에 쓰고, 전처리에는 `codex` cheap 또는 `gemini` cheap을 두는 구성이 가능하다.
- `codex + cheap`은 현재 model profile 기준으로 `gpt-5.4-mini`를 뜻한다.
- 전처리와 최종 판단은 `<structured_json>...</structured_json>` 계약을 기본으로 쓰고, parser는 tagged JSON, fenced JSON, balanced JSON 순으로 복구한다.
- `status.json`에는 `active_stage`, `active_provider`, `prepare_status`, `final_status`, `last_attempt_at`가 additive하게 남는다.
- Gemini health probe는 `gemini-2.5-flash`를 명시적으로 사용한다. provider readiness가 실제 decision phase 모델과 동떨어진 default model 때문에 흔들리면 안 된다.
- 전처리 단계는 기본적으로 `INVESTMENT_DECISION_PREPROCESS_TOOL_POLICY=none`을 권장한다.
- 최종 판단 단계는 `INVESTMENT_DECISION_FINAL_TOOL_POLICY`로 분리해서 조정할 수 있다.
- `investment_decision_prepare + tool_policy=none`이면 fresh turn 우선으로 실행한다.
- 같은 preprocess provider가 `empty_stream`으로 두 번 연속 끝나면 같은 provider에 repair를 더 시도하지 않고 다음 provider fallback으로 넘긴다.
- full request artifact는 run dir의 `request.json`에 남기고, 최종 판단 prompt에는 `prepared_request.*`와 compact exact scope만 넣는다.
- stale `running` investment decision run은 timeout budget을 넘기면 다음 조회 시 자동으로 `failed`로 정리된다.

equity-map 조회/교체:

```bash
curl http://127.0.0.1:5003/investment/equity-map

curl -X PUT http://127.0.0.1:5003/investment/equity-map \
  -H 'Content-Type: application/json' \
  -d '{
    "equities": [
      {
        "asset_key": "stock:KRX:005930",
        "ticker": "005930",
        "company_name": "삼성전자",
        "aliases": ["Samsung Electronics", "005930.KS"]
      }
    ]
  }'
```

종목 정규화 API:

```bash
curl -X POST http://127.0.0.1:5003/investment/normalize-equity \
  -H 'Content-Type: application/json' \
  -d '{"input":"TSLA"}'

curl -X POST http://127.0.0.1:5003/investment/normalize-equity \
  -H 'Content-Type: application/json' \
  -d '{"input":"005930"}'
```

정규화 순서:
- `local equity-map`
- `identity cache`
- `KIS API`
- `unresolved`

운영 메모:
- KIS는 정규화 전용 fallback이다. order/account/balance API는 쓰지 않는다.
- KIS를 쓰려면 orchestrator에 `KIS_APP_KEY`, `KIS_APP_SECRET`를 넣는다.

external artifact worker:

```bash
npm --prefix packages/mcp-orchestrator run build
npm --prefix packages/mcp-orchestrator run worker:investment-decisions -- --watch
```

의미:
- 이 worker는 pending `external_artifact` run의 `request.*`를 읽고 `response.json`을 쓴다.
- worker를 따로 안 띄우면 `external_artifact` 모드는 timeout이 나는 것이 정상이다.
- provider CLI 직접 호출 대신 외부 협업 프로세스로 전환하고 싶을 때도 이 worker contract를 기준으로 맞추면 된다.

### Discord Bot

```bash
curl http://127.0.0.1:3000/health
```

## Collector Source Run Runbook
수집 상태를 보는 기본 흐름:

1. source enable

```bash
curl -X PATCH http://127.0.0.1:5002/internal/sources/reddit_mentions/enable \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

2. async source run queue

```bash
curl -X POST http://127.0.0.1:5002/collect/run \
  -H 'Content-Type: application/json' \
  -d '{"connector":"reddit_mentions","async_mode":true}'
```

connector를 생략하면:

```bash
curl -X POST http://127.0.0.1:5002/collect/run \
  -H 'Content-Type: application/json' \
  -d '{}'
```

의미:
- 현재 `enabled=true` 인 pull source만 queue에 넣는다.
- disabled source는 자동 skip 한다.
- 응답에는 `queued_sources`, `skipped_sources`, `skipped_disabled_count`가 포함된다.
- enabled pull source가 하나도 없으면 `409 no_enabled_pull_sources`가 반환된다.

3. submission 상태 확인

```bash
curl 'http://127.0.0.1:5002/ingest/submissions?source_id=reddit_mentions&limit=5'
```

4. source runtime 상태 확인

```bash
curl http://127.0.0.1:5002/sources/status
curl http://127.0.0.1:5002/runtime/status
```

보는 필드:
- `submission.status`: `pending | running | completed | failed`
- `run_state`: `idle | queued | running | failed`
- `current_stage`
- `current_stage_message`
- `last_progress_at`
- `active_submission_ids`
- `last_started_at`
- `last_finished_at`
- `last_error`
- `last_outcome`
- `last_failure_kind`
- `payload_total`
- `payloads_processed`
- `snapshot_total`
- `evidence_total`
- `resolve_success_total`
- `resolve_miss_total`
- `partial_failure_count`
- `last_warning_kind`
- `last_warning_count`
- `last_warning_message`
- `last_warning_targets`

`GET /ingest/submissions/{submission_id}` 의 `metadata.progress`는 개별 submission의 정규 progress snapshot이다.
- `stage`
- `updated_at`
- counters (`payload_total`, `payloads_processed`, `snapshot_total`, `evidence_total`, ...)

느린 source를 볼 때 해석 기준:
- `current_stage=fetching`: connector fetch가 아직 안 끝난 상태
- `current_stage=processing_payloads`: fetch는 끝났고 snapshot/normalizer/resolve를 진행 중인 상태
- `current_stage=triggering_analysis`: evidence 적재는 끝났고 analysis enqueue 직전/직후
- `submission.status=completed` 이고 `metadata.source_agent_status=queued|running` 이면 raw evidence 저장과 candidate enqueue는 끝났고 source-agent enrichment만 background로 남아 있는 상태
- `last_warning_targets`가 있으면 partial failure가 source 전체 실패가 아니라 특정 target/subreddit에 국한된 상태다

## Discord Human Input Test
현재 구조는 단일 human input 채널 기준이다.

입력은 자유 형식이 기본이다.

예:
- `삼성전자 와치리스트에 추가해`
- 장문 주식/부동산 스터디 메모
- 구조화된 JSON evidence batch

collector가 이를 해석해서:
- collector-native ingest route
- low-risk watchlist auto action
- orchestrator investment-module handoff
를 결정한다.

## Discord Slash Commands
현재 운영 명령 표면은 5개 namespace로 고정한다.

- `report`
  - `watchlist add/remove/list`
  - `run`
  - `detail`
  - `status`
- `radar`
  - `sources`
  - `candidates`
  - `collect`
- `run`
  - `start`
  - `status`
  - `verdict`
  - `research`
  - `requests`
- `queue`
  - `human`
- `ops`
  - `health`
  - `providers`

운영 smoke 예시:

- Discord 채널에서 `/radar sources`
- Discord 채널에서 `/radar candidates limit:10`
- Discord 채널에서 `/radar collect`
- Discord 채널에서 `/run start entity:Cursor`
- Discord 채널에서 `/queue human limit:5`
- Discord 채널에서 `/ops providers`

운영 정책:
- slash command 응답은 기본적으로 ephemeral이다.
- `/queue human`은 `DISCORD_HUMAN_QUEUE_CHANNEL_IDS`가 설정된 경우 해당 채널에서만 허용된다.
- `/ops health`, `/ops providers`는 `DISCORD_STATUS_CHANNEL_IDS` 또는 `DISCORD_PROVIDER_ALERT_CHANNEL_IDS`에 포함된 채널에서 허용된다.
- `/report run`은 짧은 3섹션 operator report만 전송한다.
- `/report detail`은 최신 또는 특정 run의 상세 리포트를 ephemeral로 보여준다.
- `/report run`은 ephemeral ack를 반환하고 실제 리포트 본문은 `DISCORD_DAILY_REPORT_CHANNEL_ID` 또는 guild 기본 보고 채널로 전송된다.
- 봇은 investment decision 결과 artifact를 그대로 렌더링하므로, report formatting 문제를 볼 때는 Discord보다 먼저 orchestrator `response.json`과 `report.md`를 확인하는 편이 빠르다.

필수 env:
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_HUMAN_INPUT_CHANNEL_IDS`

필수 Discord 설정:
- `MESSAGE CONTENT INTENT`
- `bot`
- `applications.commands`

Discord bot이 `Used disallowed intents`로 재시작 루프에 들어가면, 거의 항상 Discord Developer Portal에서 privileged intent가 꺼져 있는 경우다.

## Provider Health Runbook
Provider smoke:

```bash
npm --prefix packages/mcp-orchestrator run smoke:providers
```

이 workstation에서는 WSL node를 명시해서 돌리는 편이 안전하다:

```bash
export PATH=/home/ilmaswsl/.nvm/versions/node/v24.13.0/bin:$PATH
npm --prefix packages/mcp-orchestrator run smoke:providers
```

end-to-end smoke:

```bash
npm --prefix packages/mcp-orchestrator run build
npm --prefix packages/mcp-orchestrator run smoke:end-to-end
```

provider health:

```bash
curl http://127.0.0.1:5003/health
```

기준:
- `codex`: `codex login status`
- `claude`: `claude auth status`
- `gemini`: 별도 status 명령이 불안정하면 headless prompt probe 기준
- 실제 readiness 판단은 auth probe가 아니라 execute probe까지 통과했는지로 본다.
- external injection transport를 쓰는 경우에는 provider stdout이 아니라 session directory의 `inbox/`, `outbox/`, `artifacts/`를 같이 본다.
- investment decision에서 `external_artifact` 모드를 쓸 때도 같은 원칙을 따른다. provider CLI stdout이 아니라 investment decision run dir의 `response.json`이 canonical output이다.

session artifact 위치 예시:

```bash
find data/provider-sessions -maxdepth 5 -type d | sed -n '1,40p'
find data/llm-session-workdirs -maxdepth 5 -type d | sed -n '1,40p'
```

## Collector Test Mode
로컬 Discord 테스트에서 collector pull source 때문에 noisy startup이 문제면, pull source를 잠시 꺼도 된다.

예:

```bash
curl -X PATCH http://127.0.0.1:5002/internal/sources/google_trends/enable \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

이 모드에서:
- human input
- orchestrator run
- provider health

를 우선 확인하고, pull source는 하나씩 다시 켠다.

## Known Runtime Notes
- collector source bootstrap은 기본적으로 즉시 몰아서 돌지 않게 두는 편이 안전하다.
- collector source run worker 수는 `SOURCE_RUN_WORKER_CONCURRENCY`로 제어한다.
- orchestrator `/health`는 빠른 ping가 아니라 provider-aware health다.
- Discord 테스트는 코드보다 portal 설정이 더 자주 원인이다.

## Troubleshooting
### Collector가 source 수집 중 응답하지 않는 경우
확인:

```bash
curl http://127.0.0.1:5002/health
curl http://127.0.0.1:5002/runtime/status
curl http://127.0.0.1:5002/sources/status
```

대응:
- `SOURCE_BOOTSTRAP_ON_START=false`
- `SOURCE_RUN_WORKER_CONCURRENCY`를 낮춘다
- noisy pull source를 잠시 disable 한다
- `collect/run`은 sync가 아니라 async 기본값으로 사용한다
- `sources/status`와 `runtime/status`가 오래 걸리면 active source run 중 cooperative yield가 충분한지, connector fetch 또는 normalizer가 event loop를 오래 점유하는지 본다

### Orchestrator health가 느린 경우
- provider probe가 돌고 있는지 먼저 본다
- `docker compose logs mcp-orchestrator`
- 단순 지연과 hang를 구분한다

### Discord bot이 반복 재시작하는 경우
- `docker compose logs discord-bot`
- `Used disallowed intents`면 Discord Portal 설정부터 확인한다

### Docker recreate가 꼬이는 경우

```bash
docker compose ps -a
docker rm -f <stale-container-id>
docker compose up -d --build <service>
```
