# Collector Data Quality Plan

## Implementation Status
- 2026-03-29: collector는 run 완료 시 `quality_status`와 `quality_warnings`를 submission/runtime/source metrics에 남긴다.
- 현재는 공통 규칙 + 일부 source-specific floor만 들어가 있고, source별 상세 P0/P1 contract는 추가 보강 대상이다.

## 품질 목표
- raw evidence 보존
- source별 mixed outcome를 binary success/failure로 뭉개지 않기
- candidate build 전에 명백한 품질 저하를 잡기
- downstream usefulness와 ETL 품질을 연결하되, 서로 다른 층으로 유지하기

## 품질 차원
- Availability: source가 실행 가능한가
- Completeness: 최소 payload / 필수 필드가 채워졌는가
- Freshness: 기대 cadence 대비 지연되지 않았는가
- Deduplication: 중복이 폭증하지 않았는가
- Resolve Quality: entity resolve가 무너졌는가
- Downstream Usefulness: candidate / analysis / research에 기여했는가

## 검증 위치

### Gate A: Snapshot -> Evidence
목적:
- fetch 결과 자체의 품질 확인

공통 P0:
- payload count > 0 또는 source-specific empty 허용 규칙 존재
- required raw field 존재
- parse failure rate가 임계치 이하

공통 P1:
- duplicate ratio ceiling
- freshness lag ceiling
- warning kind별 severity 구분

### Gate B: Evidence -> Candidate
목적:
- evidence가 candidate 단계에서 의미를 잃는지 확인

공통 P0:
- entity resolve floor
- empty candidate emission 차단

공통 P1:
- unresolved cluster 비율
- generic lexical noise 비율
- candidate collapse detection

## Source-specific 규칙

### Reddit
P0:
- credential 없으면 `quality_failed`가 아니라 `missing_credentials`
- OAuth 실패는 readiness/cooldown 문제로 분리

P1:
- subreddit별 partial failure 허용
- `empty listing` 연속 횟수 추적
- `rate_limited` 발생 시 cooldown 부여

### App Store
P0:
- `top-free`, `top-paid` 둘 다 최소 floor 충족

P1:
- chart category 편중 감지
- chart payload 급감 감지

### Google Trends
P0:
- geo별 series 존재

P1:
- geo completeness ratio
- repeated zero-value series 감지

### Naver Datalab / Similarweb / TikTok
P0:
- credential / dependency readiness 분리

P1:
- stale dataset 감지
- schema drift warning

## 결과 상태

권장 상태:
- `completed`
- `completed_with_warnings`
- `quality_degraded`
- `quality_failed`

원칙:
- mixed outcome는 `completed_with_warnings`
- candidate 단계에서 의미가 무너졌지만 source 자체는 살아 있으면 `quality_degraded`
- 필수 계약 위반이면 `quality_failed`

## 데이터 계약

submission metadata에 additive하게 추가:
- `quality_status`
- `quality_warnings`
- `readiness_status`
- `watermark_ref`

source metrics 입력으로 추가:
- recent `quality_failed_total`
- recent `completed_with_warnings_total`
- freshness lag percentile
- empty payload streak

## 이상 탐지
- 3 runs 연속 `missing_credentials`
- 3 runs 연속 `rate_limited`
- evidence_total 급감
- resolve_success_total 급감
- 특정 source만 partial failure_count 급증

## SLA
- scheduled source는 cadence의 2배를 freshness SLO 임계치로 사용
- `last_success_at`가 이를 넘으면 degraded
- rate-limited source는 cooldown 동안 freshness alert 억제 가능
