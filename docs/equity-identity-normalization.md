# Equity Identity Normalization

이 문서는 Discord 입력, guild watchlist, investment decision universe가 같은 종목 식별 체계를 공유하도록 하는 규칙을 정리한다.

## 목적

- `TSLA`, `005930`, `삼성전자`, `Tesla` 같은 입력을 canonical stock identity로 정규화한다.
- Discord bot이 로컬 규칙으로 종목을 해석하지 않도록 하고, orchestrator를 단일 정규화 경계로 둔다.
- KIS API는 정규화 fallback으로만 쓰고, 투자 판단 evidence source로는 쓰지 않는다.

## Canonical Shape

정규화 결과는 최소한 아래 필드를 가진다.

- `asset_key`
- `ticker`
- `company_name`
- `market`
- `exchange`
- `instrument_code`
- `normalization_source`
- `normalization_confidence`

정규화가 실패하면 `resolved=false`와 함께 unresolved 결과를 반환한다.

## Resolution Order

정규화 순서는 고정한다.

1. `data/investment-module/equity-map.json`
2. `data/investment-module/identity-cache.json`
3. KIS lookup
4. unresolved

의미:
- `equity-map.json`은 운영자가 검토한 curated exact mapping 입력이다.
- `identity-cache.json`은 런타임 캐시다. repo-tracked source of truth가 아니다.
- KIS는 종목 식별 fallback일 뿐, 로컬 curated map를 대체하지 않는다.

## KIS Scope

사용 범위:
- 국내 6자리 종목 코드 lookup
- 미국 ticker lookup

사용하지 않는 범위:
- 주문
- 잔고
- 계좌
- 체결
- 투자 판단 evidence

필수 env:
- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `KIS_BASE_URL`

## Service Boundary

orchestrator owns:
- canonical identity resolution
- identity cache persistence
- KIS fallback invocation

discord-bot owns:
- raw operator input 전달
- normalized 결과를 watchlist에 저장

collector owns:
- free-form human input interpretation
- watchlist action request 생성

즉, bot은 직접 ticker parsing을 하지 않는다.

## APIs

- `POST /investment/normalize-equity`
- `GET /investment/equity-map`
- `PUT /investment/equity-map`

## 운영 원칙

- watchlist에는 raw 입력 대신 canonicalized ticker/company를 저장한다.
- `TSLA`와 `Tesla`는 같은 종목으로 수렴해야 한다.
- `005930`과 `삼성전자`도 같은 종목으로 수렴해야 한다.
- KIS가 실패하거나 미설정이면 unresolved를 정직하게 반환하고, 가짜 매핑을 만들지 않는다.
