# Collector Monitoring And Observability Recommendation

## Implementation Status
- 2026-03-29: `sources/status`, `sources/catalog`, `runtime/status`, collector dashboard source rows에 readiness/freshness/quality/recent run summary가 노출된다.
- 아직 dedicated alert rule까지는 붙지 않았고, 현재 단계는 operator-facing visibility 강화에 초점을 둔다.

## 모니터링 목표
- 지금 왜 멈췄는지 보이기
- 최근 며칠간 어떤 source가 나빠졌는지 보이기
- source quality와 downstream usefulness를 함께 보이기

## 핵심 메트릭

### 실행 메트릭
- source run count
- run duration
- queue depth
- queued vs skipped source count
- cooldown source count

### 품질 메트릭
- payload_total
- snapshot_total
- evidence_total
- duplicate ratio
- resolve success / miss ratio
- quality_status count
- warning kind distribution

### 운영 메트릭
- last_success_at
- freshness_lag_seconds
- repeated auth/rate-limit failures
- cooldown_until
- readiness_status distribution
- source_agent_status distribution

## 대시보드 레이아웃

### Panel 1: Fleet Summary
- ready / cooldown / missing_credentials / dependency_missing source 수
- queue depth
- freshness SLO 위반 source 수

### Panel 2: Source Health Table
열:
- source_id
- readiness_status
- validity_status
- freshness_lag_seconds
- last_success_at
- median duration
- latest warning/failure
- source_agent_status

### Panel 3: Recent Run History
- 최근 N개 run
- source별 status 추세
- payload/evidence 급감 감지

### Panel 4: Quality Trend
- resolve rate
- duplicate ratio
- completed_with_warnings trend
- quality_failed trend

### Panel 5: Downstream Impact
- candidate count trend
- analysis completion trend
- research usefulness trend

## 알림 규칙

### P0
- 3 runs 연속 `missing_credentials`
- freshness lag > 2x cadence
- quality_failed 연속 발생

### P1
- evidence_total 급감
- partial_failure_count 급증
- repeated `rate_limited`

### P2
- source_agent failure 증가
- resolve miss 비율 악화

## 운영 런북 항목
- missing credential이면 source disable이 아니라 readiness downgrade
- rate limit이면 cooldown_until 확인 후 재시도
- evidence collapse면 payload와 quality gate부터 확인
- source-agent failure는 ingestion success와 분리해서 해석

## SLA / SLO
- SLO 1: scheduled source freshness
- SLO 2: successful run ratio
- SLO 3: quality_degraded 이하 비율
- SLO 4: downstream candidate generation continuity

## 현재 collector에 바로 맞는 additive 확장
- `sources/status`
  - `readiness_status`
  - `readiness_reason`
  - `last_success_at`
  - `freshness_lag_seconds`
- `runtime/status`
  - recent run summary
  - warning/failure trend
