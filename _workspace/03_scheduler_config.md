# Collector Scheduler And Run State Recommendation

## Implementation Status
- 2026-03-29: scheduler와 manual `collect/run`은 `enabled/runnable` 외에 source `readiness_status`도 같이 본다.
- `ready`가 아닌 source는 queue 대신 skip reason을 남긴다.

## 오케스트레이터 선택
- 유지: APScheduler + collector 내부 queue
- 교체하지 않음: Airflow 같은 외부 오케스트레이터는 현재 범위 밖

이유:
- 현재 규모에서는 collector 내부 스케줄러가 충분함
- 문제는 오케스트레이터 부재가 아니라 readiness/checkpoint 부족임

## DAG / 작업 구조

현재 구조:
- scheduler -> `enqueue_source_run(source_id)` -> source worker -> submission processing

권장 구조:
- scheduler
  -> readiness check
  -> checkpoint/backoff check
  -> enqueue
  -> run ledger append

## 재시도 / 백오프 전략

### Scheduler
- source별 `cooldown_until`을 존중
- `rate_limited`, `missing_credentials`, `dependency_missing`는 즉시 재시도하지 않음

### Manual `collect/run`
- explicit source:
  - readiness not ready면 4xx 또는 skip reason 반환
- no-arg:
  - `ready` 상태 소스만 queue
  - 나머지는 `skipped_sources`

### Failure Class -> Backoff
- `rate_limited`: reset 시각 또는 exponential backoff
- `auth_not_configured`: 긴 cooldown 또는 manual unblock
- `dependency_missing`: startup-time skip
- transient `fetch_failed`: 짧은 retry allowance

## 백필 전략
- 지금 단계에서는 full historical backfill을 넣지 않는다
- 대신 source별 `watermark_ref`를 수동 조정 가능한 상태로 둔다
- future hook:
  - internal admin endpoint 또는 dashboard control

## 동시성 전략
- 현재 `source_run_worker_concurrency` 유지
- per-source `max_instances=1` 유지
- 추가 권장:
  - same source duplicate queue 방지
  - cooldown source는 enqueue 자체 차단

## 멱등성과 재실행 안전성
- dedupe는 유지
- 다만 dedupe만으로 멱등성을 설명하지 않는다
- source별 `fetch_strategy`
  - `full_snapshot`
  - `incremental`
를 명시하고 그에 맞는 checkpoint를 저장

## 제안 상태 저장소

`SourceRunState`
- `source_id`
- `fetch_strategy`
- `last_attempt_at`
- `last_success_at`
- `cooldown_until`
- `last_cursor`
- `last_seen_ids`
- `last_rate_limit_reset_at`

`SourceRunLedgerEntry`
- `run_id`
- `source_id`
- `submission_id`
- `started_at`
- `finished_at`
- `duration_ms`
- `status`
- `failure_kind`
- `warning_kinds`
- `payload_total`
- `snapshot_total`
- `evidence_total`
- `partial_failure_count`
- `source_agent_status`

## 권장 구현 순서
1. readiness check 추가
2. `cooldown_until` + `last_success_at` 저장
3. run ledger 추가
4. source별 incremental cursor 도입
