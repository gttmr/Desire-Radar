# Investment Decision Module Snapshot

## What Landed

- orchestrator에 artifact-first `investment decision` 서브시스템이 추가됐다.
- canonical run dir는 `data/investment-decisions/runs/YYYY-MM-DD/<run_id>/` 아래에 생성된다.
- 실행 모드는 `provider_exec`와 `external_artifact` 두 가지다.
- Discord `/report run`과 scheduled report는 더 이상 자체 판단을 만들지 않고 orchestrator decision artifact를 소비한다.
- watchlist-prioritized universe와 curated equity mapping 입력 파일 경계가 추가됐다.
- equity-map 조회/교체 API와 external worker 스크립트가 추가돼 운영 입력과 파일 기반 실행 경계가 실제로 동작한다.
- `provider_exec` 경로는 provider raw output과 parse error를 `provider-attempts/` 아래에 남긴다.
- `investment_decision`은 JSON parse 실패 시 같은 세션으로 한 번 더 엄격한 JSON-only repair prompt를 보낸다.
- `codex` 초기 실행은 session workdir를 절대경로 `-C`로 넘기고, process `cwd`와 중복 전달하지 않는다.

## Why This Matters

- provider CLI 직접 호출과 외부 파일 기반 판단 방식이 바뀌어도 downstream 계약은 유지된다.
- Discord report formatting을 판단 단계와 분리해 deterministic 하게 유지할 수 있다.
- future external decision worker를 붙여도 orchestrator API와 report flow를 다시 뒤엎지 않아도 된다.

## 2026-03-30 Update

- direct investment decision run은 이제 정상 완료되지만, `equity-map`이 비어 있으면 shortlist 품질이 크게 떨어진다.
- 그래서 `data/investment-module/equity-map.json`이 missing/empty일 때만 starter map을 자동 bootstrap 하도록 바꿨다.
- starter set은 exact/curated public-equity alias만 포함한다.
  - 포함 예: 삼성전자, Microsoft, NVIDIA, Alphabet/Google/YouTube, Meta, Amazon, Netflix, Tesla, Disney, Sony/PlayStation, Apple
  - 제외 예: OpenAI, Claude, Bitcoin, Ethereum
- 목적은 “coverage gap 전부 제거”가 아니라, public company/product 수준의 저위험 exact mapping을 즉시 usable 상태로 만드는 것이다.
- 추가로 `codex` investment decision prompt는 argv가 아니라 stdin으로 넘기도록 바꿨다. resolved equity가 많아질수록 prompt가 길어지기 때문에, large request에서 provider 실행이 붙잡히는 문제를 줄이기 위한 조치다.
- 같은 이유로 provider prompt에는 full `request.json`을 다시 싣지 않고 compact projection만 넣도록 줄였다. raw/full artifact는 계속 run dir의 `request.json`에 보존한다.
- 그리고 `investment_decision` phase 기본 profile을 `cheap`으로 낮췄다. structured shortlist 생성에는 `gpt-5.4-mini` 수준이 더 적합하고, latency 절감 이득이 더 크다고 판단했다.
- 추가 조사 결과, 현재 Docker 런타임의 Codex CLI는 이 phase의 긴 판단 prompt를 받으면 tool/workspace inspection으로 들어가고 user-namespace 제한 때문에 응답이 길게 묶였다.
- 그래서 `investment_decision` phase 기본 provider를 당분간 `gemini` 단독으로 바꿨다.
- 그리고 Gemini readiness probe도 `gemini-2.5-flash`로 고정했다. provider health가 실제 decision phase 모델과 어긋나면 실행 전에 false negative가 나기 때문이다.
- prompt에도 “workspace 조사 금지, follow-up 질문 금지, 지금 결론” 제약을 더 명시했다.
- 예전 버그로 남은 stale `running` run은 timeout budget 초과 시 자동으로 `failed`로 정리한다.

## Current Gaps

- verdict pipeline과 investment decision의 연결은 아직 느슨하다.
- equity mapping은 exact/curated 수준만 지원한다.
- external artifact writer에 대한 운영 runbook은 추가됐지만 실제 worker는 아직 없다.
- investment decision artifact 품질을 평가하는 replay/golden fixture는 더 보강할 수 있다.
- provider session dir에는 아직 raw turn transcript가 남지 않는다. 현재 디버깅 기준 원문은 run dir의 `provider-attempts/`다.
- `gemini` decision quality는 provider availability와 prompt tuning에 더 좌우될 수 있다.

## Next Likely Work

1. decision artifact를 daily report 외의 operator UI에서도 읽게 하기
2. curated equity mapping 관리 UX 정리
3. beneficiary mapping과 decision request 연결 강화
4. external artifact writer를 실제 외부 협업 프로세스와 연결하는 예시 구현 추가
