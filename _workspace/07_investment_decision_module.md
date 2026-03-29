# Investment Decision Module Snapshot

## What Landed

- orchestrator에 artifact-first `investment decision` 서브시스템이 추가됐다.
- canonical run dir는 `data/investment-decisions/runs/YYYY-MM-DD/<run_id>/` 아래에 생성된다.
- 실행 모드는 `provider_exec`와 `external_artifact` 두 가지다.
- Discord `/report run`과 scheduled report는 더 이상 자체 판단을 만들지 않고 orchestrator decision artifact를 소비한다.
- watchlist-prioritized universe와 curated equity mapping 입력 파일 경계가 추가됐다.
- equity-map 조회/교체 API와 external worker 스크립트가 추가돼 운영 입력과 파일 기반 실행 경계가 실제로 동작한다.

## Why This Matters

- provider CLI 직접 호출과 외부 파일 기반 판단 방식이 바뀌어도 downstream 계약은 유지된다.
- Discord report formatting을 판단 단계와 분리해 deterministic 하게 유지할 수 있다.
- future external decision worker를 붙여도 orchestrator API와 report flow를 다시 뒤엎지 않아도 된다.

## Current Gaps

- verdict pipeline과 investment decision의 연결은 아직 느슨하다.
- equity mapping은 exact/curated 수준만 지원한다.
- external artifact writer에 대한 운영 runbook은 추가됐지만 실제 worker는 아직 없다.
- investment decision artifact 품질을 평가하는 replay/golden fixture는 더 보강할 수 있다.

## Next Likely Work

1. decision artifact를 daily report 외의 operator UI에서도 읽게 하기
2. curated equity mapping 관리 UX 정리
3. beneficiary mapping과 decision request 연결 강화
4. external artifact writer를 실제 외부 협업 프로세스와 연결하는 예시 구현 추가
