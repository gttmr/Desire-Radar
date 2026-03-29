# Collector ETL Architecture Recommendation

## Implementation Status
- 2026-03-29: `readiness_status`, `fetch_strategy`, source run state store, incremental checkpoint filtering, quality metadata, recent run ledger exposure가 collector core에 반영되었다.
- 남은 큰 항목은 cluster/event handoff를 downstream 기본 계약으로 더 강하게 고정하는 일이다.

## 데이터 소스 인벤토리

### Pull Sources
| Source | 현재 전략 | 리스크 | 권장 보강 |
|---|---|---|---|
| `reddit_mentions` | OAuth listing fetch + raw snapshot | credential/rate-limit/cursor 부재 | readiness + incremental checkpoint |
| `google_trends` | snapshot pull | dependency/geo completeness | readiness + snapshot watermark |
| `naver_datalab` | API pull | credential/API error | readiness + cooldown + time-window watermark |
| `app_store_top_charts` | snapshot pull | chart completeness/redirect changes | quality contract + run ledger |
| `steamdb_top_sellers` | snapshot pull | endpoint shape drift | quality contract + readiness |
| `tiktok_creative_center` | public/auth 혼합 가능성 | auth/dependency drift | readiness + explicit strategy |
| `similarweb_movers` | API/snapshot pull | auth / dataset freshness | readiness + checkpoint |

### Non-pull Sources
- `human_input_inbox`
- `manual_observation`
- `human_analyst_note`
- `human_curated_dataset`
- derived source family

이 문서의 주 대상은 pull source다.

## 레이어 아키텍처

현재 collector는 사실상 아래 레이어를 이미 가지고 있다.

1. `Source Registry`
2. `Submission / Queue`
3. `Raw Snapshot`
4. `Normalized Evidence`
5. `Candidate / Cluster`
6. `Background Enrichment`

권장 보강은 이 레이어를 바꾸는 게 아니라, 각 레이어 사이의 운영 계약을 더 명확히 만드는 것이다.

## 권장 아키텍처 보강

### 1. Readiness Layer 추가
`enabled`와 `runnable` 사이에 운영 준비 상태를 분리한다.

권장 상태:
- `ready`
- `missing_credentials`
- `cooldown`
- `rate_limited`
- `manual_blocked`
- `dependency_missing`

의미:
- `enabled`: 운영자가 소스를 쓰기로 했는가
- `runnable`: 구조적으로 실행 가능한 소스인가
- `readiness_status`: 지금 당장 queue에 넣어도 되는가

권장 데이터 흐름:
- source startup / env load / last run outcome를 읽어 readiness 계산
- scheduler와 `POST /collect/run`은 `readiness_status=ready`만 queue
- 나머지는 `skipped_sources`에 사유를 남김

### 2. SourceRunState 계층 추가
현재 dedupe 중심 상태에서 source 전략 상태로 올린다.

권장 저장 필드:
- `last_success_at`
- `last_attempt_at`
- `cooldown_until`
- `last_cursor`
- `last_seen_ids`
- `last_rate_limit_reset_at`
- `fetch_strategy`

권장 fetch strategy:
- `full_snapshot`
- `incremental`

초기 권장 매핑:
- `reddit_mentions`: `incremental`
- `naver_datalab`: `incremental`
- `google_trends`: `full_snapshot`
- `app_store_top_charts`: `full_snapshot`

### 3. Quality Gate를 두 지점에 둔다
품질 검증 위치:
- `snapshot -> normalized evidence`
- `evidence -> candidate`

이렇게 두면:
- source payload 문제와
- semantic candidate 문제를
분리해서 볼 수 있다.

### 4. Run Ledger를 추가한다
source의 현재 상태만이 아니라 최근 히스토리를 본다.

권장 저장 필드:
- `run_id`
- `source_id`
- `started_at`
- `finished_at`
- `duration_ms`
- `status`
- `payload_total`
- `snapshot_total`
- `evidence_total`
- `partial_failure_count`
- `failure_kind`
- `warning_kinds`
- `source_agent_status`

### 5. Collector Output Contract를 Cluster/Event 중심으로 고정
operator-facing 주 산출물은 raw word list가 아니라 cluster/event여야 한다.

권장 candidate contract:
- `cluster_id`
- `display_label`
- `candidate_kind`
- `supporting_sources`
- `supporting_terms`
- `event_summary`
- `theme_tags`
- `graph_summary`

## 적재 전략

### 유지할 것
- raw snapshot 저장
- evidence provenance
- source-agent는 background enrichment
- submission 단위 추적

### 바꿀 것
- `fetch 후 dedupe` 단일 전략
  -> `fetch strategy + checkpoint + dedupe`

## 스키마 진화 대응

새 필드는 additive하게 넣는다.

우선순위:
1. `sources/status`, `sources/catalog`
2. `runtime/status`
3. submission metadata
4. internal state store

호환 방침:
- 기존 consumer가 깨지지 않도록 additive fields만 우선 추가
- event/cluster contract는 기존 필드 위에 보강 후, 점진적으로 기본 출력으로 승격

## 구현 우선순위
1. readiness
2. checkpoint / watermark
3. quality contract
4. run ledger
5. cluster/event handoff 고정
