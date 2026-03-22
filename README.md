# Discord KRX Morning Reporter

KRX 관심 종목 아침 브리핑을 디스코드로 보내는 봇이다. 현재 저장소는 두 프로세스로 나뉜다.

- `bot-api`: Discord slash command, 스케줄링, 설정 저장
- `predictor`: MiroFish 구조를 좁혀서 적용한 다중 에이전트 예측/리포트 서비스

## 기능

- 평일 `08:00 Asia/Seoul` 자동 리포트 발송
- `/watchlist-add`, `/watchlist-remove`, `/watchlist-list`
- `/report-summary`, `/report-full`, `/report-status`
- 음성 수집 mock 기능 유지 (`/voice-start`, `/voice-stop`)
- 헬스체크
  - bot: `GET /health`
  - predictor: `GET /health`

## 구조

- 디스코드 봇은 길드별 설정을 `data/guild-report-config.json`에 저장한다.
- predictor는 `collect -> bull agent -> bear agent -> report agent` 흐름으로 Markdown 리포트를 생성한다.
- LLM 연동은 Azure OpenAI 기준으로 설정한다.
- 외부 API 키가 없으면 fallback 모드로 동작해 구조 검증용 리포트를 생성한다.

## 빠른 시작

1. `.env.example`를 복사해 `.env` 생성
2. 최소 필수 값 입력
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DISCORD_GUILD_ID`
   - `DEFAULT_TEXT_CHANNEL_ID`
3. 선택 값 입력
   - `KIS_APP_KEY`, `KIS_APP_SECRET`
   - `DART_API_KEY`
   - `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`
   - `AZURE_OPENAI_ENDPOINT`
   - `AZURE_OPENAI_API_KEY`
   - `AZURE_OPENAI_DEPLOYMENT`
4. 실행

```bash
npm install
npm run dev
```

predictor를 함께 띄우려면 Docker를 권장한다.

```bash
docker compose up --build
```

## 명령어

- `/ping`
- `/watchlist-add ticker:<005930>`
- `/watchlist-remove ticker:<005930>`
- `/watchlist-list`
- `/report-summary`
- `/report-full`
- `/report-status`
- `/voice-start [channel]`
- `/voice-stop`

## 운영 메모

- 리포트 자동 발송 시각은 `REPORT_TIME_KST`, 시간대는 `REPORT_TIMEZONE`로 제어한다.
- 자동 발송은 `summary` 형식으로 나간다.
- 길드별 리포트 채널은 첫 명령이 실행된 채널 또는 `DEFAULT_TEXT_CHANNEL_ID`로 고정된다.
- Azure OpenAI를 쓰려면 `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`를 채워야 한다.
- predictor는 `predictor/server.py`에 있다.
- MiroFish 참조 메모는 `docs/mirofish-integration.md`에 있다.
