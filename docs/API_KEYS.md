# API Keys & 외부 서비스 등록 가이드

## 요약

| 서비스 | 용도 | 무료 | 등록 필요 | 에이전트 |
|---|---|---|---|---|
| Discord Bot | 봇 토큰 | ✅ | ✅ | - |
| Azure OpenAI | LLM 분석 | ❌ (유료) | ✅ | 전체 |
| KIS (한국투자증권) | 주가 시세 | ✅ | ✅ | semiconductor |
| DART (금융감독원) | 기업 공시 | ✅ | ✅ | semiconductor |
| Naver Search API | 뉴스 검색 | ✅ | ✅ | semiconductor, geopolitical |
| FRED (연방준비제도) | 미국 거시지표 | ✅ | ✅ | macro |
| KOBIS (영화진흥위원회) | 박스오피스 | ✅ | ✅ | entertainment |
| EIA (미국 에너지청) | 전력/에너지 | ✅ | ✅ | supply_chain |
| Reddit | 소셜 센티먼트 | ✅ | ❌ | reddit_sentiment |
| HackerNews | 기술 트렌드 | ✅ | ❌ | tech_buzz |
| arXiv | AI 논문 트렌드 | ✅ | ❌ | tech_buzz |
| GDELT | 지정학 뉴스 | ✅ | ❌ | geopolitical |
| Fear & Greed Index | 시장 심리 | ✅ | ❌ | supply_chain |

---

## 즉시 사용 가능 (키 불필요)

- **Reddit** — 공개 JSON API (`reddit.com/r/wallstreetbets/new.json`)
- **HackerNews** — Firebase 공개 API
- **arXiv** — 공개 RSS 피드
- **GDELT** — 완전 무료 공개 API
- **Fear & Greed** — `api.alternative.me/fng/` 무료

---

## 무료 등록 필요

### 1. FRED (Federal Reserve Economic Data)
- **용도**: 미국 금리, 수익률 곡선, 실업률, CPI
- **등록**: https://fred.stlouisfed.org/docs/api/api_key.html
- **환경변수**: `FRED_API_KEY`
- **소요 시간**: 5분 (이메일 인증)

### 2. KOBIS (영화진흥위원회 오픈API)
- **용도**: 한국 일일 박스오피스 (엔터 주식 선행 지표)
- **등록**: https://www.kobis.or.kr/kobisopenapi/homepg/main/main.do → 회원가입 → API 신청
- **환경변수**: `KOBIS_API_KEY`
- **소요 시간**: 10분 (회원가입 후 즉시 발급)

### 3. EIA (U.S. Energy Information Administration)
- **용도**: 미국 전력/에너지 생산 데이터 (산업 가동률 proxy)
- **등록**: https://www.eia.gov/opendata/register.php
- **환경변수**: `EIA_API_KEY`
- **소요 시간**: 5분

### 4. KIS API (한국투자증권) — 이미 있을 수 있음
- **용도**: 실시간 주가 시세
- **등록**: https://apiportal.koreainvestment.com → 앱 등록
- **환경변수**: `KIS_APP_KEY`, `KIS_APP_SECRET`

### 5. DART API (금융감독원) — 이미 있을 수 있음
- **용도**: 기업 공시 조회
- **등록**: https://opendart.fss.or.kr/intro/main.do → 인증키 신청
- **환경변수**: `DART_API_KEY`

### 6. Naver Search API — 이미 있을 수 있음
- **용도**: 한국어 뉴스 검색
- **등록**: https://developers.naver.com/apps → 애플리케이션 등록 → 검색 API
- **환경변수**: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`

---

## 유료 서비스

### Azure OpenAI
- **용도**: 모든 에이전트의 LLM 분석 핵심
- **등록**: Azure Portal → OpenAI 리소스 생성
- **환경변수**:
  - `AZURE_OPENAI_ENDPOINT`
  - `AZURE_OPENAI_API_KEY`
  - `AZURE_OPENAI_DEPLOYMENT` (배포 이름, 예: `gpt-4o`)
- **대안**: 키 없이 실행 시 mock 모드로 동작 (실제 분석 없음)

---

## .env 파일에 추가할 항목

```env
# 거시경제
FRED_API_KEY=

# 엔터테인먼트
KOBIS_API_KEY=

# 에너지/공급망
EIA_API_KEY=
```

---

## 나중에 추가할 수 있는 서비스

| 서비스 | 용도 | 비고 |
|---|---|---|
| ACLED | 무력 충돌 데이터 | 연구용 무료 등록 필요 |
| MarineTraffic | 선박 이동 추적 | 무료 티어 제한적 |
| Spotify Charts | 음악 트렌드 | 개발자 계정 필요 |
| Google Trends (pytrends) | 검색 트렌드 | pip 패키지 추가 필요 |
| SEC EDGAR | 미국 기업 공시 | 완전 무료 |
| UN Comtrade | 국제 무역 통계 | 무료 API |
