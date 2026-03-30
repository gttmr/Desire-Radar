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
- 또 하나의 병목은 collector 재기동 뒤 source freshness/history는 남아도 normalized evidence가 비어, investment decision request의 `candidate_clusters`가 다시 0이 되는 점이었다.
- 이를 줄이기 위해 collector가 normalized evidence를 `data/evidence.json`에 영속화하고, 재기동 시 TTL을 적용해 다시 로드하도록 바꿨다.
- 그래서 `data/investment-module/equity-map.json`이 missing/empty일 때만 starter map을 자동 bootstrap 하도록 바꿨다.
- starter set은 exact/curated public-equity alias만 포함한다.
  - 포함 예: 삼성전자, Microsoft, NVIDIA, Alphabet/Google/YouTube, Meta, Amazon, Netflix, Tesla, Disney, Sony/PlayStation, Apple
  - 제외 예: OpenAI, Claude, Bitcoin, Ethereum
- 목적은 “coverage gap 전부 제거”가 아니라, public company/product 수준의 저위험 exact mapping을 즉시 usable 상태로 만드는 것이다.
- 추가로 `codex` investment decision prompt는 argv가 아니라 stdin으로 넘기도록 바꿨다. resolved equity가 많아질수록 prompt가 길어지기 때문에, large request에서 provider 실행이 붙잡히는 문제를 줄이기 위한 조치다.
- 같은 이유로 provider prompt에는 full `request.json`을 다시 싣지 않고 compact projection만 넣도록 줄였다. raw/full artifact는 계속 run dir의 `request.json`에 보존한다.
- 그 시점에는 `investment_decision`을 단일 provider/cheap profile 중심으로 단순화했지만, 이 구조는 이후 2단 preprocessor + final decision 구조로 다시 정리됐다.
- 추가 조사 결과, 긴 판단 prompt에서 provider별 행동 편차가 커서 “전처리 provider”와 “최종 판단 provider”를 분리할 필요가 있었다.
- Gemini readiness probe를 `gemini-2.5-flash`로 고정한 점은 유지한다. provider health가 실제 phase 모델과 어긋나면 실행 전에 false negative가 나기 때문이다.
- prompt에도 “workspace 조사 금지, follow-up 질문 금지, 지금 결론” 제약을 더 명시했다.
- 예전 버그로 남은 stale `running` run은 timeout budget 초과 시 자동으로 `failed`로 정리한다.

## 2026-03-30 Late Update

- investment decision는 이제 `prepare -> final decision` 2단 구조를 지원한다.
- `prepare` 단계는 canonical output이 아니고, request를 loss-aware briefing으로 압축하는 내부 단계다.
- `prepared_request.json`, `prepared_request.md`, `prepared_request.meta.json`이 run dir에 남는다.
- 전처리 provider는 Gemini 고정이 아니다. env로 provider 우선순위와 model profile을 따로 바꿀 수 있다.
- 권장 기본값은 `prepare=cheap`, `final=premium`이다.
- 실무적으로는 `prepare=codex(gpt-5.4-mini)`, `final=codex(gpt-5.4)` 또는 `prepare=gemini flash`, `final=codex(gpt-5.4)` 둘 다 가능하다.
- 전처리 단계는 `INVESTMENT_DECISION_PREPROCESS_TOOL_POLICY=none`을 기본으로 두고, 최종 판단 단계는 별도 tool policy를 가질 수 있게 분리했다.
- 전처리 실패 시 run 전체를 버리지 않고 deterministic fallback briefing을 생성한 뒤 final decision을 계속 진행한다.

## 2026-03-30 Structured Output Update

- `prepare` 단계는 이제 공통 structured-output 모듈을 사용한다.
- 기본 계약은 `<structured_json>...</structured_json>` tagged block이며, parser는 tagged JSON를 우선 읽는다.
- provider가 reasoning/preamble을 먼저 내더라도 parser는 fenced JSON와 balanced JSON까지 순차적으로 복구를 시도한다.
- `provider-attempts/*.json`에는 `parse_strategy`가 같이 남는다. 즉 실제로 `tagged`, `balanced`, `repair` 중 어떤 경로로 회수됐는지 사후 점검 가능하다.
- Codex나 Gemini가 빈 stream이나 unreadable output으로 끝나는 경우는 parse failure 이전의 retryable transport 결과로 본다.
- 이 경우 같은 stage에서 같은 prompt를 fresh하게 한 번 더 시도하고, 결과는 `provider-attempts/*-retry.json`으로 별도 남긴다.
- Codex adapter는 `agent_message` 외 stream shape에서도 텍스트를 회수하도록 완화했다.
- Gemini adapter는 `{"response":"..."}` wrapper뿐 아니라 model이 직접 뱉은 JSON object도 유효 응답으로 인정한다.
- 목적은 프롬프트 튜닝만으로 버티는 것이 아니라, provider 출력 습관이 조금 변해도 `prepared_request.json`과 최종 `response.json` 계약이 유지되게 만드는 것이다.

## Current Gaps

- verdict pipeline과 investment decision의 연결은 아직 느슨하다.
- equity mapping은 exact/curated 수준만 지원한다.
- external artifact worker는 들어갔지만, 실제 운영에서 어떤 외부 판단 주체가 `response.json`을 쓰는지 절차는 더 구체화할 여지가 있다.
- investment decision artifact 품질을 평가하는 replay/golden fixture는 더 보강할 수 있다.
- provider session dir에는 아직 raw turn transcript가 남지 않는다. 현재 디버깅 기준 원문은 run dir의 `provider-attempts/`다.
- preprocessing provider와 final provider를 phase가 아니라 agent 단위로 더 세밀하게 policy 관리할 여지는 있다.
- preprocess prompt를 다른 agent에도 그대로 재사용할지, 아니면 `investment decision` 전용 contract로 계속 둘지는 후속 판단이 필요하다.

## Next Likely Work

1. decision artifact를 daily report 외의 operator UI에서도 읽게 하기
2. curated equity mapping 관리 UX 정리
3. beneficiary mapping과 decision request 연결 강화
4. external artifact writer를 실제 외부 협업 프로세스와 연결하는 예시 구현 추가
