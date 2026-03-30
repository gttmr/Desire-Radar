# Investment Decision Module

이 문서는 orchestrator 내부 `investment decision` 서브시스템의 living design note다.

목적:
- daily shortlist 판단 경계를 고정한다.
- direct CLI 실행과 external file-based execution을 같은 계약으로 묶는다.
- Discord daily/on-demand report가 어떤 artifact를 소비하는지 명확히 한다.

## Purpose

이 모듈은 자동 매매 엔진이 아니다.

v1 목적:
- watchlist-prioritized universe를 만든다.
- collector cluster, investment note, source health를 묶어 판단 요청 아티팩트를 만든다.
- canonical decision artifact를 생성한다.
- Discord와 daily report가 deterministic formatter로 소비할 보고 텍스트를 만든다.

v1 출력 제한:
- `stock-only`

내부 설계 원칙:
- asset-neutral 유지

## Boundary

### Collector

Collector owns:
- raw evidence
- candidate cluster/event handoff
- source health and readiness state
- free-form human input interpretation

Collector does not:
- make final shortlist recommendations
- format Discord investment reports

### MCP Orchestrator

Orchestrator investment decision owns:
- watchlist-prioritized universe assembly
- curated equity mapping resolution
- request/response/report artifact lifecycle
- provider or external execution mode dispatch
- deterministic report formatting

### Discord Bot

Discord bot owns:
- scheduled/manual trigger
- channel delivery
- ephemeral ack

Discord bot does not:
- decide picks itself
- re-run LLM formatting after the decision artifact exists

## Artifact-First Contract

모든 run은 아래 디렉터리를 가진다.

```text
data/investment-decisions/runs/YYYY-MM-DD/<run_id>/
  request.json
  request.md
  status.json
  prepared_request.json
  prepared_request.md
  prepared_request.meta.json
  provider-attempts/
    decision-<provider>-initial.json
    decision-<provider>-retry.json
    decision-<provider>-repair.json
    prepare-<provider>-initial.json
    prepare-<provider>-retry.json
    prepare-<provider>-repair.json
  response.json
  response.md
  report.md
```

규칙:
- orchestrator는 항상 `request.json`과 `request.md`를 먼저 쓴다.
- preprocessing step이 켜져 있으면 `prepared_request.*`를 내부 artifact로 추가 생성한다.
- `provider_exec` 경로는 raw provider output, parse error, parse strategy를 `provider-attempts/` 아래에 남긴다.
- attempt artifact에는 `transport_outcome`, `structured_outcome`, `retry_count`, `used_fallback_provider`도 같이 남긴다.
- direct provider execution도 결과를 `response.json`으로 정규화한다.
- external mode는 외부 프로세스가 `request.*`를 읽고 `response.json`을 쓴다.
- Discord와 scheduled report는 `response.json` 기반 formatter만 사용한다.

즉 canonical output은 항상 artifact이며, 실행 방식은 교체 가능하다.

## Execution Modes

### `provider_exec`

- orchestrator가 provider adapter를 직접 호출한다.
- phase는 `investment_decision`으로 분리한다.
- provider/model policy도 기존 `verdict`와 독립적으로 둘 수 있다.
- 내부적으로는 `prepare -> final decision` 2단 실행을 지원한다.
- `prepare`는 정보 압축과 재구성만 맡고, canonical final artifact는 항상 final decision step이 만든다.
- direct provider output은 내부적으로 파싱한 뒤 canonical artifact로 정규화한다.
- structured output contract는 tagged JSON를 기본으로 한다.
  - 우선 계약은 `<structured_json>...</structured_json>` 블록이다.
  - parser는 tagged block, fenced JSON, balanced JSON 순으로 복구를 시도한다.
  - provider가 reasoning이나 짧은 preamble을 섞어도 downstream artifact 계약은 유지된다.
  - provider가 빈 stream이나 unreadable output으로 끝나면 같은 stage에서 같은 prompt를 fresh하게 한 번 더 시도한다.
  - 이 재시도도 `provider-attempts/*-retry.json`으로 남겨서, prompt 문제인지 transport 문제인지 구분할 수 있게 한다.
  - 같은 provider가 두 번 연속 `empty_stream`이면 같은 provider에 `repair`를 더 걸지 않고 다음 preprocess provider로 넘긴다.
  - `status.json`에는 `active_stage`, `active_provider`, `prepare_status`, `final_status`, `last_attempt_at`가 additive하게 남는다.

### `external_artifact`

- orchestrator는 request artifact만 만들고 polling 한다.
- 외부 판단 주체가 `response.json`을 떨어뜨리면 orchestrator가 검증하고 완료 처리한다.
- stdout을 직접 못 받는 bridge나 파일 기반 협업 프로세스와 잘 맞는다.

기본 worker 스크립트:

```bash
npm --prefix packages/mcp-orchestrator run worker:investment-decisions -- --watch
```

이 worker는 pending external run의 `request.*`를 읽고 canonical `response.json`과 `report.md`를 쓴다.

검증 실패 예:
- `response.json` 누락
- schema mismatch
- timeout

이 경우 run은 `degraded` 또는 `failed`로 남아야 하며, 가짜 리포트를 만들면 안 된다.

## Request Schema

`InvestmentDecisionRequest`

최소 필드:
- `run_id`
- `created_at`
- `mode`
- `window`
- `watchlist`
- `resolved_equities`
- `candidate_clusters`
- `supporting_evidence_refs`
- `investment_notes`
- `source_health_summary`
- `coverage_gaps`
- `schema_version`

`resolved_equities` 최소 필드:
- `asset_key`
- `ticker`
- `company_name`
- `why_in_scope`
- `linked_clusters`
- `linked_notes`
- `watchlist_member`

## Response Schema

`InvestmentDecisionArtifact`

최소 필드:
- `run_id`
- `status`
- `generated_at`
- `summary`
- `market_view`
- `top_picks`
- `watch_candidates`
- `rejected_candidates`
- `coverage_gaps`
- `risks`
- `degraded`
- `degraded_reason`
- `schema_version`

추천 항목 공통 최소 필드:
- `asset_key`
- `ticker`
- `company_name`
- `recommendation`
- `confidence`
- `why_now`
- `thesis`
- `beneficiary_path`
- `linked_clusters`
- `linked_evidence_refs`
- `risks`
- `missing_information`

v1 recommendation enum:
- `buy_now`
- `accumulate`
- `watch`
- `pass`

## Universe Rules

기본 원칙:
- watchlist 종목은 항상 universe에 포함한다.
- collector cluster와 investment note는 보조 입력이다.
- 새 종목은 exact/curated resolution이 될 때만 편입한다.
- 안 되면 `coverage_gaps`로 남긴다.

curated mapping 기본 경로:

```text
data/investment-module/equity-map.json
```

bootstrap 규칙:
- 파일이 없거나 비어 있으면 orchestrator가 보수적인 starter map을 자동으로 채운다.
- starter set은 exact/curated public-equity alias만 포함한다.
- `OpenAI`, `Anthropic`, `Bitcoin`, `Ethereum`처럼 직접 상장사로 고정하기 어려운 항목은 기본적으로 coverage gap으로 남긴다.
- `codex` provider는 큰 investment decision prompt를 argv가 아니라 stdin으로 전달한다. prompt가 커질 때 resume/repair 실행 안정성을 높이기 위한 조치다.
- investment decision prompt에는 full `request.json`을 그대로 다시 싣지 않는다. raw/full artifact는 run dir의 `request.json`에 보존하고, final step에는 `prepared_request.*`와 compact exact scope만 넣는다.
- preprocessing 단계는 “도구 사용 금지, 요약/압축 전용”으로 prompt 계약을 고정한다.
- 기본 권장값은 `prepare=cheap`, `final=premium`이다. 예를 들어 `prepare=codex(gpt-5.4-mini)`, `final=codex(gpt-5.4)` 같은 구성이 가능하다.
- preprocessing provider와 final provider는 env로 따로 바꿀 수 있다. 즉 전처리 provider가 Gemini일 필요는 없다.
- Codex와 Gemini는 모두 “reasoning 후 결과” 형태를 낼 수 있으므로, `prepare` 단계는 prompt 지시만으로 신뢰하지 않고 parser를 함께 둔다.
  - Codex adapter는 `agent_message`가 아닌 stream frame에서도 텍스트를 회수하도록 완화한다.
  - Gemini adapter는 wrapper 없는 direct JSON object도 유효 응답으로 인정한다.
  - 그래도 빈 stream으로 끝나는 경우는 parse failure가 아니라 retryable transport 결과로 분류하고, 다음 provider로 넘어가기 전에 같은 provider를 한 번 더 시도한다.
  - `investment_decision_prepare + tool_policy=none` 조합은 fresh turn 우선으로 실행한다.
- Gemini readiness probe도 `gemini-2.5-flash`를 명시적으로 사용한다. health가 phase와 다른 default model 상태에 끌려가면 안 되기 때문이다.
- stale `running` run은 timeout budget을 넘기면 자동으로 `failed`로 정리한다. 오래된 status가 영구히 `running`으로 남아 dashboard나 latest API를 오염시키면 안 된다.

Gemini-specific notes:
- prompt는 “추가 질문 금지, workspace 조사 금지, 현재 정보만으로 즉시 결론” 규칙을 명시한다.
- 이 phase에서 provider를 바꾸더라도 canonical output은 계속 `response.json`이다.

권장 shape:

```json
{
  "version": 1,
  "equities": [
    {
      "asset_key": "stock:KRX:005930",
      "ticker": "005930",
      "company_name": "삼성전자",
      "aliases": ["Samsung Electronics", "Samsung", "005930.KS"]
    }
  ]
}
```

이 파일은 저위험 exact alias 매핑만 다루고, fuzzy matching 사전처럼 비대하게 키우지 않는 편이 좋다.

운영 API:
- `GET /investment/equity-map`
- `PUT /investment/equity-map`

## Discord Report Flow

trigger:
- scheduled daily report
- `/report run`

flow:
1. discord-bot이 orchestrator decision run API 호출
2. orchestrator가 request artifact 생성
3. runner가 decision artifact 생성
4. formatter가 `report.md` 생성
5. bot이 결과 markdown을 지정 채널에 전송

즉, Discord는 consumer이고 canonical state owner가 아니다.

## Operational Notes

중요 env:
- `INVESTMENT_DECISION_RUNNER`
- `INVESTMENT_DECISION_RUN_ROOT`
- `INVESTMENT_DECISION_TIMEOUT_MS`
- `INVESTMENT_DECISION_POLL_INTERVAL_MS`
- `INVESTMENT_DECISION_PREPROCESS_ENABLED`
- `INVESTMENT_DECISION_PREPROCESS_PROVIDERS`
- `INVESTMENT_DECISION_PREPROCESS_MODEL_PROFILE`
- `INVESTMENT_DECISION_PREPROCESS_TOOL_POLICY`
- `INVESTMENT_DECISION_PREPROCESS_TIMEOUT_MS`
- `INVESTMENT_DECISION_FINAL_PROVIDERS`
- `INVESTMENT_DECISION_FINAL_MODEL_PROFILE`
- `INVESTMENT_DECISION_FINAL_TOOL_POLICY`
- `INVESTMENT_DECISION_FINAL_TIMEOUT_MS`
- `INVESTMENT_EQUITY_MAP_PATH`

권장 운영 기본값:
- `prepare`: `providers=codex,gemini`, `model_profile=cheap`, `tool_policy=none`
- `final`: `providers=codex,gemini`, `model_profile=premium`, `tool_policy=default`

현재 model profile 기준:
- `codex + cheap` = `gpt-5.4-mini`
- `codex + premium` = `gpt-5.4`

문제 확인 순서:
1. `status.json`
2. `request.json`
3. `provider-attempts/*.json`
4. `response.json`
5. `report.md`
6. 그 다음 provider health 또는 external writer 상태

이 기준으로 바로 봐야 하는 것:
- `status.json`: 지금 `prepare`인지 `final`인지, 어떤 provider가 active였는지
- `provider-attempts/*.json`: empty stream이었는지, tagged JSON였는지, fallback provider가 개입했는지
- `prepared_request.meta.json`: LLM preprocess인지 deterministic fallback인지

## Open Questions

- verdict pipeline과 daily shortlist를 어디까지 결합할지
- beneficiary mapping을 decision request에 어느 수준까지 미리 넣을지
- unresolved `coverage_gaps`를 사람이 보강하기 좋은 입력으로 어떻게 surface할지
- stock-only 이후 자산군 확장을 어떤 contract로 풀지
