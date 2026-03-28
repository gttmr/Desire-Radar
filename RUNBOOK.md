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

`predictor-legacy`는 기본 테스트/운영 경로에서 제외한다.

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

의미:
- `/health`: 빠른 liveness + analysis/source queue 요약
- `/sources/status`: source별 enabled/tier/validity + 현재 run state
- `/runtime/status`: source run queue, worker 수, scheduler 상태

현재 collector는 source run을 request thread에서 직접 끝내지 않는다.
- `POST /collect/run` 또는 `POST /internal/sources/run/{source_id}`는 기본적으로 source run을 queue에 넣고 즉시 `submission_id`를 반환한다.
- 실제 진행 상황은 `submission status`와 `sources/status`에서 본다.

### Orchestrator

```bash
curl http://127.0.0.1:5003/health
```

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
- `active_submission_ids`
- `last_started_at`
- `last_finished_at`
- `last_error`
- `last_outcome`
- `last_failure_kind`
- `partial_failure_count`
- `last_warning_kind`
- `last_warning_count`
- `last_warning_message`

## Discord Human Input Test
현재 구조는 단일 human input 채널 기준이다.

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
