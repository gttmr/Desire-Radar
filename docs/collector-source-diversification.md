# Collector Source Diversification

## 목적

- collector가 `reddit_mentions` 하나에 과도하게 기대지 않도록 public-first pull source를 늘린다.
- source 다양화는 새 connector를 급히 늘리는 방식이 아니라, 이미 구현된 source를 운영 가능한 상태로 정리하는 순서로 진행한다.
- `enabled`, `readiness_status`, `quality_status`, `recent_runs`가 함께 해석되는 운영 계약을 유지한다.

## 현재 기본 세트

### Public-first 기본 활성 세트

- `app_store_top_charts`
- `google_trends`
- `steamdb_top_sellers`
- `similarweb_movers`
- `hackernews`
- `polymarket_markets`

### Credential / gating 세트

- `reddit_mentions`
  - 기본 enabled
  - Reddit OAuth credential이 없으면 `missing_credentials`
- `naver_datalab`
  - 기본 disabled
  - Naver API credential 준비 후 enable
- `tiktok_creative_center`
  - 기본 disabled
  - public endpoint 안정성 확인 전까지 운영 기본 세트에서 제외

## 왜 이렇게 나누는가

- App Store / Google Trends / Steam / public domain ranking / Hacker News / Polymarket은 공개 데이터 기반이라 운영 준비도가 높다.
- Reddit는 수집 가치가 높지만 OAuth와 rate-limit/backoff를 전제로 해야 한다.
- Naver와 TikTok은 가치가 있어도 auth/endpoint 변동성이 더 크므로 기본 세트에 바로 넣지 않는다.

## 다음 구현 배치

- source row에 `source set` 또는 `public-first / gated` 표기를 넣을지 검토
- `steamdb_top_sellers`, `similarweb_movers`의 source-agent 요약 품질 점검
- `app_store_top_charts`의 낮은 resolve rate를 cluster/event 규칙으로 보완
- `tiktok_creative_center`는 readiness를 `ready`보다 더 정직한 gating 상태로 세분할지 검토
- `hackernews`, `polymarket_markets`의 source health/quality trend를 기존 public-first 세트와 같은 기준으로 추적

## 운영 체크

- no-arg `POST /collect/run` 시 현재 기본 활성 세트가 queue되는지 확인
- `sources/status`에서 각 source의 `readiness_status`, `quality_status`, `recent_runs`를 함께 본다
- source diversity 평가는 단순 enabled 개수보다 `최근 성공 run + usable evidence + candidate contribution` 기준으로 본다
