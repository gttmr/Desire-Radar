# Collector Data Gathering Review Report

## 운영 준비 상태
- 기본 ingestion backbone: 양호
- submission / provenance / source registry: 양호
- background source-agent 분리: 양호
- dashboard 현재 상태 관측성: 개선됨
- source readiness / checkpoint / quality contract / run history: 1차 반영 완료

## 필수 수정

### 1. Readiness 계층 추가
이유:
- credential/API/dependency 문제를 `enabled`로만 설명할 수 없음

영향:
- scheduler
- `collect/run`
- `sources/status`
- dashboard

### 2. Checkpoint / Watermark 상태 도입
이유:
- 현재는 fetch strategy보다 dedupe에 의존
- incremental source 운영 안정성이 약함

영향:
- reddit_mentions
- naver_datalab
- future authenticated API connectors

### 3. Source-specific Quality Contract 도입
이유:
- 운영 warning이 많아졌지만 품질 상태로 정식 승격되지 않음

영향:
- validity engine 입력 품질 향상
- candidate build 오염 감소

## 권장 수정

### 4. Run Ledger 및 freshness/SLA 추세
이유:
- current-state dashboard는 좋아졌지만 trend가 부족함

### 5. Cluster/Event handoff contract 고정
이유:
- collector의 소비자들이 raw lexical noise가 아니라 cluster/event를 기본으로 읽게 해야 함

### 6. Source diversification 단계적 확대
이유:
- public-first source를 기본 활성 세트로 명시하고, credential 또는 endpoint 변동성이 큰 source는 gating 상태로 구분해야 함
- 다양화는 새 source 추가보다 기존 source의 운영 가능성 검증이 먼저임

## 참고 사항
- APScheduler는 당장 충분하다
- 새 infra 도입보다 source 운영 계약을 먼저 다듬는 것이 맞다
- source-agent는 계속 enrichment layer로 유지해야 한다

## 정합성 매트릭스

| 항목 | 현재 | 권장 |
|---|---|---|
| 실행 가능 상태 | enabled/runnable 중심 | readiness 추가 |
| 재실행 안전성 | dedupe 중심 | checkpoint + dedupe |
| 품질 판정 | warnings + validity | quality contract + validity |
| 운영 가시성 | current snapshot | run ledger + freshness trend |
| downstream handoff | cluster 개선 중 | cluster/event contract 고정 |

## 운영 준비도 체크리스트
- [x] readiness status 정의
- [x] scheduler readiness gate
- [x] manual collect no-arg readiness skip
- [x] source run state store
- [x] run ledger store
- [x] quality_status metadata
- [x] freshness lag metric
- [x] public-first source diversification plan 문서화
- [ ] dashboard recent run trend
- [ ] cluster/event output contract 문서화
- [ ] source set 별 운영 레이블 및 trend panel
