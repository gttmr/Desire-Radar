# Collector Data Gathering 보강 입력 정리

## 요청 요약
- 대상: `packages/collector`
- 목적: collector의 데이터 수집 방식을 데이터 파이프라인 관점에서 점검하고, 억지 수정 없이 보강이 권장되는 부분을 실행 가능한 설계 문서로 정리
- 성격: 구현 계획 문서화, 코드 수정 최소화

## 현재 파이프라인 전제
- 주 경로: `source registry -> submission -> raw snapshot -> normalized evidence -> candidate`
- 보조 경로:
  - background source-agent enrichment
  - collector dashboard / runtime status
  - human input routing
- 소비자:
  - `mcp-orchestrator`
  - `discord-bot`
  - collector dashboard

## 현재 소스 범위
- Pull source:
  - `reddit_mentions`
  - `google_trends`
  - `naver_datalab`
  - `app_store_top_charts`
  - `steamdb_top_sellers`
  - `tiktok_creative_center`
  - `similarweb_movers`
- Human / push / derived source도 같은 registry에 존재

## 운영 환경과 제약
- 런타임: WSL + Docker Compose
- 스케줄러: APScheduler 기반 cadence runner
- provider CLI와 source-agent는 이미 별도 관측/timeout/fallback 구조가 있음
- raw evidence 보존 원칙은 유지해야 함
- 새 인프라 도입은 범위 밖
  - Airflow
  - Kafka
  - 별도 warehouse

## 실행 모드
- `풀 파이프라인` 문서 모드
- 구현 우선순위만 정리하고, 실제 코드 변경은 후속 배치에서 진행

## 이번 문서 세트의 핵심 질문
1. 현재 source를 언제 실행 가능한 상태로 볼 것인가
2. source별 재실행 안전성과 fetch 전략을 어떻게 명시할 것인가
3. source-specific 품질 규칙을 어디에 둘 것인가
4. 운영자가 “지금/최근” 상태를 어떻게 해석하게 만들 것인가
5. collector 산출물을 downstream에 어떤 단위로 고정할 것인가
