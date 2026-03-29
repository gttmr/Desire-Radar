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
  response.json
  response.md
  report.md
```

규칙:
- orchestrator는 항상 `request.json`과 `request.md`를 먼저 쓴다.
- direct provider execution도 결과를 `response.json`으로 정규화한다.
- external mode는 외부 프로세스가 `request.*`를 읽고 `response.json`을 쓴다.
- Discord와 scheduled report는 `response.json` 기반 formatter만 사용한다.

즉 canonical output은 항상 artifact이며, 실행 방식은 교체 가능하다.

## Execution Modes

### `provider_exec`

- orchestrator가 provider adapter를 직접 호출한다.
- phase는 `investment_decision`으로 분리한다.
- provider/model policy도 기존 `verdict`와 독립적으로 둘 수 있다.
- direct provider output은 내부적으로 파싱한 뒤 canonical artifact로 정규화한다.

### `external_artifact`

- orchestrator는 request artifact만 만들고 polling 한다.
- 외부 판단 주체가 `response.json`을 떨어뜨리면 orchestrator가 검증하고 완료 처리한다.
- stdout을 직접 못 받는 bridge나 파일 기반 협업 프로세스와 잘 맞는다.

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
- `INVESTMENT_EQUITY_MAP_PATH`

문제 확인 순서:
1. `status.json`
2. `request.json`
3. `response.json`
4. `report.md`
5. 그 다음 provider health 또는 external writer 상태

## Open Questions

- verdict pipeline과 daily shortlist를 어디까지 결합할지
- beneficiary mapping을 decision request에 어느 수준까지 미리 넣을지
- unresolved `coverage_gaps`를 사람이 보강하기 좋은 입력으로 어떻게 surface할지
- stock-only 이후 자산군 확장을 어떤 contract로 풀지
