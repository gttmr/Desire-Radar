# Discord Report And Equity Identity Notes

날짜: 2026-03-30

## 이번 변경

- Discord 기본 투자 리포트를 짧은 operator report로 줄였다.
- 기본 리포트는 `오늘의 판단 요약`, `우선 검토 종목`, `관찰 종목` 3섹션만 쓴다.
- 긴 thesis/risk/coverage/source health는 `/report detail`로 분리했다.
- watchlist 입력은 더 이상 6자리 코드 전용이 아니다.
- orchestrator에 canonical stock identity 경계를 추가했다.
- 정규화 순서는 `equity-map -> identity-cache -> KIS -> unresolved`로 고정했다.

## 구조적 의미

- Discord bot은 이제 종목 파서를 직접 들고 있지 않다.
- guild watchlist와 investment decision universe가 같은 canonical 종목 식별 체계를 공유한다.
- KIS는 evidence source가 아니라 normalization fallback이다.
- artifact-first investment decision 경계는 유지하면서 report surface만 짧게 바꿨다.

## 남은 후속 작업

- KIS 해외 종목 lookup coverage를 실제 운영 입력으로 더 검증
- `identity-cache.json` 운영 정책 정리
- `/report detail` 응답 길이 제한과 chunking UX 보강
- short report 품질 회귀용 golden fixture 추가
