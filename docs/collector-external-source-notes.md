# Collector External Source Notes

이 메모는 외부 source/skill 구현을 collector에 편입할 때의 기준만 짧게 남긴다.

## `last30days-skill`와 collector의 차이

- `last30days-skill`의 목적은 ad-hoc 주제 리서치와 cross-source synthesis다.
- `collector`의 목적은 지속 수집, raw evidence 보존, provenance 유지, source별 runtime/quality 관리다.
- 따라서 외부 구현을 그대로 가져오기보다, collector 경계에 맞는 source connector 단위만 편입하는 것이 맞다.

## 이번에 편입한 것

- `hackernews`
  - public Algolia API
  - no-auth
  - collector의 public-first pull source와 바로 맞음
- `polymarket_markets`
  - public Gamma search API
  - no-auth
  - 투자 리서치용 확률/유동성 signal을 raw evidence로 보존 가능

## 이번에 보류한 것

- ScrapeCreators 기반 Reddit/TikTok/Instagram backend
- ad-hoc subreddit discovery
- cross-source ranking / synthesis scoring

보류 이유:
- credential과 과금이 들어가는 gated source 성격이다.
- `last30days-skill`의 query-driven 검색 흐름은 collector의 scheduled pull/source registry 경계와 다르다.
- 향후 도입하더라도 기존 source의 숨은 backend 교체가 아니라, collector source registry에 명시적인 새 gated source로 넣는 것이 원칙이다.
