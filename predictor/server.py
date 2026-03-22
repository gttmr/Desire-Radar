#!/usr/bin/env python3
"""
MiroFish-inspired stock report sidecar.

The service keeps the architecture small on purpose:
- collect market evidence
- run bullish/bearish agent passes
- synthesize a markdown report

It can operate in two modes:
- live mode: uses KIS/Naver/DART plus Azure OpenAI v1 chat completions when keys exist
- fallback mode: emits a deterministic heuristic report so Discord integration can be tested locally
"""

from __future__ import annotations

import html
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib import error, parse, request


LOG_LEVEL = os.getenv("PREDICTOR_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("predictor")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_text(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", "", value or "")
    collapsed = re.sub(r"\s+", " ", html.unescape(without_tags))
    return collapsed.strip()


def clip(items: list[str], limit: int) -> list[str]:
    return [item for item in items if item][:limit]


def dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for item in items:
      if not item or item in seen:
        continue
      seen.add(item)
      output.append(item)
    return output


def normalize_confidence(value: Any, fallback: float) -> float:
    try:
        numeric = float(value)
        return round(max(0.0, min(1.0, numeric)), 2)
    except (TypeError, ValueError):
        return fallback


def normalize_direction(value: str, fallback: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"bullish", "bearish", "neutral"}:
        return normalized
    return fallback


class PredictorConfig:
    host = os.getenv("PREDICTOR_HOST", "0.0.0.0")
    port = int(os.getenv("PREDICTOR_PORT", "5001"))
    timeout_seconds = float(os.getenv("PREDICTOR_TIMEOUT_SEC", "15"))

    kis_base_url = os.getenv("KIS_BASE_URL", "https://openapi.koreainvestment.com:9443")
    kis_app_key = os.getenv("KIS_APP_KEY", "")
    kis_app_secret = os.getenv("KIS_APP_SECRET", "")

    dart_api_key = os.getenv("DART_API_KEY", "")
    naver_client_id = os.getenv("NAVER_CLIENT_ID", "")
    naver_client_secret = os.getenv("NAVER_CLIENT_SECRET", "")

    azure_openai_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
    azure_openai_api_key = os.getenv("AZURE_OPENAI_API_KEY", "")
    azure_openai_deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")


def azure_openai_base_url(endpoint: str) -> str:
    normalized = endpoint.rstrip("/")
    if normalized.endswith("/openai/v1"):
        return normalized
    if normalized.endswith("/openai"):
        return f"{normalized}/v1"
    return f"{normalized}/openai/v1"


class HttpJsonClient:
    def __init__(self, timeout_seconds: float):
        self.timeout_seconds = timeout_seconds

    def fetch_json(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None
        request_headers = dict(headers or {})
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"

        req = request.Request(url, data=body, headers=request_headers, method=method)
        with request.urlopen(req, timeout=self.timeout_seconds) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}


class KisClient:
    def __init__(self, config: PredictorConfig, http_client: HttpJsonClient):
        self.config = config
        self.http_client = http_client
        self._token: str | None = None
        self._token_expires_at = 0.0

    def configured(self) -> bool:
        return bool(self.config.kis_app_key and self.config.kis_app_secret)

    def fetch_quote(self, ticker: str) -> dict[str, Any]:
        if not self.configured():
            return {}

        token = self._access_token()
        url = (
            f"{self.config.kis_base_url}/uapi/domestic-stock/v1/quotations/inquire-price"
            f"?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD={parse.quote(ticker)}"
        )
        payload = self.http_client.fetch_json(
            url,
            headers={
                "authorization": f"Bearer {token}",
                "appkey": self.config.kis_app_key,
                "appsecret": self.config.kis_app_secret,
                "tr_id": "FHKST01010100"
            },
        )
        return payload.get("output") or {}

    def _access_token(self) -> str:
        if self._token and time.time() < self._token_expires_at - 60:
            return self._token

        payload = self.http_client.fetch_json(
            f"{self.config.kis_base_url}/oauth2/tokenP",
            method="POST",
            payload={
                "grant_type": "client_credentials",
                "appkey": self.config.kis_app_key,
                "appsecret": self.config.kis_app_secret
            },
        )
        self._token = payload["access_token"]
        self._token_expires_at = time.time() + int(payload.get("expires_in", 3600))
        return self._token


class DARTClient:
    def __init__(self, config: PredictorConfig, http_client: HttpJsonClient):
        self.config = config
        self.http_client = http_client

    def configured(self) -> bool:
        return bool(self.config.dart_api_key)

    def fetch_disclosures(self, ticker: str) -> list[str]:
        if not self.configured():
            return []

        corp_code = self._find_corp_code(ticker)
        if not corp_code:
            return []

        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        url = (
            "https://opendart.fss.or.kr/api/list.json"
            f"?crtfc_key={parse.quote(self.config.dart_api_key)}"
            f"&corp_code={parse.quote(corp_code)}"
            f"&bgn_de={today[:4]}0101"
            f"&end_de={today}"
            "&last_reprt_at=Y"
        )
        payload = self.http_client.fetch_json(url)
        reports = payload.get("list") or []
        return clip(
            [f"{item.get('report_nm', '공시')} ({item.get('rcept_dt', '')})" for item in reports],
            3,
        )

    def _find_corp_code(self, ticker: str) -> str | None:
        url = (
            "https://opendart.fss.or.kr/api/company.json"
            f"?crtfc_key={parse.quote(self.config.dart_api_key)}"
            f"&stock_code={parse.quote(ticker)}"
        )
        payload = self.http_client.fetch_json(url)
        return payload.get("corp_code")


class NaverNewsClient:
    def __init__(self, config: PredictorConfig, http_client: HttpJsonClient):
        self.config = config
        self.http_client = http_client

    def configured(self) -> bool:
        return bool(self.config.naver_client_id and self.config.naver_client_secret)

    def fetch_news(self, query_text: str) -> list[str]:
        if not self.configured() or not query_text:
            return []

        url = (
            "https://openapi.naver.com/v1/search/news.json"
            f"?query={parse.quote(query_text)}&display=3&sort=date"
        )
        payload = self.http_client.fetch_json(
            url,
            headers={
                "X-Naver-Client-Id": self.config.naver_client_id,
                "X-Naver-Client-Secret": self.config.naver_client_secret
            },
        )
        items = payload.get("items") or []
        return clip([clean_text(item.get("title", "")) for item in items], 3)


class LLMClient:
    def __init__(self, config: PredictorConfig, http_client: HttpJsonClient):
        self.config = config
        self.http_client = http_client

    def configured(self) -> bool:
        return bool(
            self.config.azure_openai_endpoint
            and self.config.azure_openai_api_key
            and self.config.azure_openai_deployment
        )

    def chat_json(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        content = self._chat(messages, json_mode=True)
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON from chat API: {content}") from exc

    def chat_text(self, messages: list[dict[str, str]]) -> str:
        return self._chat(messages, json_mode=False)

    def _chat(self, messages: list[dict[str, str]], *, json_mode: bool) -> str:
        payload: dict[str, Any] = {
            "model": self.config.azure_openai_deployment,
            "messages": messages,
            "temperature": 0.2,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        response = self.http_client.fetch_json(
            f"{azure_openai_base_url(self.config.azure_openai_endpoint)}/chat/completions",
            method="POST",
            headers={"api-key": self.config.azure_openai_api_key},
            payload=payload,
        )
        choices = response.get("choices") or []
        if not choices:
            raise ValueError("empty chat completion response")
        return (choices[0].get("message") or {}).get("content", "").strip()


class PredictorEngine:
    def __init__(self, config: PredictorConfig):
        self.config = config
        self.http_client = HttpJsonClient(config.timeout_seconds)
        self.kis = KisClient(config, self.http_client)
        self.dart = DARTClient(config, self.http_client)
        self.naver = NaverNewsClient(config, self.http_client)
        self.llm = LLMClient(config, self.http_client)

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "services": {
                "kis": self.kis.configured(),
                "dart": self.dart.configured(),
                "naver": self.naver.configured(),
                "azureOpenAi": self.llm.configured(),
            }
        }

    def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        guild_id = str(payload.get("guildId", "")).strip()
        tickers = [str(item).strip().upper() for item in payload.get("tickers", []) if str(item).strip()]
        as_of_date = str(payload.get("asOfDate", "")).strip() or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        mode = str(payload.get("mode", "manual")).strip() or "manual"
        detail = str(payload.get("detail", "summary")).strip().lower() or "summary"
        if not guild_id:
            raise ValueError("guildId is required")
        if not tickers:
            raise ValueError("tickers must not be empty")
        if detail not in {"summary", "full"}:
            raise ValueError("detail must be summary or full")

        items: list[dict[str, Any]] = []
        source_urls: list[str] = []
        market_notes: list[str] = []

        for ticker in tickers:
            item = self._build_item(ticker, as_of_date)
            items.append(item)
            source_urls.extend(item.pop("_sources", []))
            market_notes.append(f"{ticker} {item['headline']}")

        summary = f"{len(items)}개 종목 기준 KRX 개장 전 브리핑입니다."
        market_commentary = " / ".join(market_notes[:3]) if market_notes else "핵심 종목 데이터가 준비되지 않았습니다."
        risks = dedupe([point for item in items for point in item["bearCase"]])[:5]
        markdown = self._render_report(
            guild_id=guild_id,
            as_of_date=as_of_date,
            summary=summary,
            market_commentary=market_commentary,
            risks=risks,
            items=items,
            detail=detail,
        )

        return {
            "detail": detail,
            "summary": summary,
            "marketCommentary": market_commentary,
            "markdown": markdown,
            "items": items,
            "risks": risks,
            "generatedAt": utc_now_iso(),
            "sources": dedupe(source_urls),
        }

    def _build_item(self, ticker: str, as_of_date: str) -> dict[str, Any]:
        quote = {}
        try:
            quote = self.kis.fetch_quote(ticker)
        except Exception as exc:
            logger.warning("KIS quote fetch failed for %s: %s", ticker, exc)

        stock_name = clean_text(str(quote.get("hts_kor_isnm", ""))) or ticker
        news: list[str] = []
        disclosures: list[str] = []
        source_urls: list[str] = []

        try:
            news = self.naver.fetch_news(stock_name)
            if news:
                source_urls.append("https://openapi.naver.com/v1/search/news.json")
        except Exception as exc:
            logger.warning("Naver news fetch failed for %s: %s", ticker, exc)

        try:
            disclosures = self.dart.fetch_disclosures(ticker)
            if disclosures:
                source_urls.append("https://opendart.fss.or.kr/api/list.json")
        except Exception as exc:
            logger.warning("DART disclosure fetch failed for %s: %s", ticker, exc)

        if quote:
            source_urls.append("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price")

        heuristic = self._heuristic_analysis(ticker, stock_name, quote, news, disclosures)
        if self.llm.configured():
            try:
                enriched = self._llm_analysis(
                    ticker=ticker,
                    stock_name=stock_name,
                    quote=quote,
                    news=news,
                    disclosures=disclosures,
                    heuristic=heuristic,
                    as_of_date=as_of_date,
                )
                heuristic.update({key: value for key, value in enriched.items() if value})
            except Exception as exc:
                logger.warning("LLM analysis failed for %s: %s", ticker, exc)

        heuristic["_sources"] = source_urls
        return heuristic

    def _heuristic_analysis(
        self,
        ticker: str,
        stock_name: str,
        quote: dict[str, Any],
        news: list[str],
        disclosures: list[str],
    ) -> dict[str, Any]:
        price = clean_text(str(quote.get("stck_prpr", "")))
        delta = clean_text(str(quote.get("prdy_vrss", "")))
        delta_rate = clean_text(str(quote.get("prdy_ctrt", "")))
        change = self._safe_float(delta_rate)
        direction = "neutral"
        if change >= 1.0:
            direction = "bullish"
        elif change <= -1.0:
            direction = "bearish"

        bull_case = [
            "전일 수급/가격 흐름이 단기 모멘텀으로 이어질 수 있습니다." if change >= 0 else "",
            "최근 뉴스 플로우가 우호적이면 개장 직후 추격 수요가 붙을 수 있습니다." if news else "",
            "특이 공시가 없으면 수급이 가격 결정에 더 직접적으로 반영될 수 있습니다." if not disclosures else "",
        ]
        bear_case = [
            "전일 변동성이 컸다면 차익실현 압력이 반복될 수 있습니다.",
            "공시 또는 뉴스 해석이 엇갈리면 갭 상승 이후 눌림이 나올 수 있습니다." if disclosures or news else "",
            "개별 종목 리포트는 장 초반 수급 왜곡에 취약합니다.",
        ]
        watch_points = [
            "시초가 형성 이후 15분 거래대금",
            "기관/외국인 동시 순매수 여부",
            "전일 종가 대비 갭 방향 유지 여부",
        ]
        price_summary = (
            f"현재가 {price} / 전일 대비 {delta} / 등락률 {delta_rate}%"
            if price or delta or delta_rate
            else "실시간 시세 키가 없어 예시 브리핑 모드로 생성했습니다."
        )

        confidence = 0.58
        if direction == "bullish":
            confidence = 0.66
        elif direction == "bearish":
            confidence = 0.63

        headline = f"{stock_name}({ticker}) 개장 전 체크"
        return {
            "ticker": ticker,
            "headline": headline,
            "direction": direction,
            "confidence": confidence,
            "priceSummary": price_summary,
            "news": clip(news or ["주요 뉴스 데이터 없음"], 3),
            "disclosures": clip(disclosures or ["최근 공시 데이터 없음"], 3),
            "bullCase": clip(dedupe([item for item in bull_case if item]), 3),
            "bearCase": clip(dedupe([item for item in bear_case if item]), 3),
            "watchPoints": clip(dedupe([item for item in watch_points if item]), 3),
            "debateLog": {
                "bull": {
                    "stance": "모멘텀 유지 가능성",
                    "confidence": confidence,
                    "arguments": clip(dedupe([item for item in bull_case if item]), 3),
                },
                "bear": {
                    "stance": "단기 변동성 경계",
                    "confidence": confidence,
                    "arguments": clip(dedupe([item for item in bear_case if item]), 3),
                },
                "judge": {
                    "verdict": "중립 / 장 초반 확인 필요" if direction == "neutral" else direction,
                    "rationale": clip(
                        dedupe(
                            [
                                "가격 데이터가 제한적이어서 뉴스·공시 해석 비중이 높습니다." if not price_summary.startswith("현재가") else "",
                                "상승/하락 요인이 함께 존재해 수급 확인 전 단정이 어렵습니다.",
                            ]
                        ),
                        3,
                    ),
                    "selectedRisks": clip(dedupe([item for item in bear_case if item]), 3),
                    "selectedWatchPoints": clip(dedupe([item for item in watch_points if item]), 3),
                },
            },
        }

    def _llm_analysis(
        self,
        *,
        ticker: str,
        stock_name: str,
        quote: dict[str, Any],
        news: list[str],
        disclosures: list[str],
        heuristic: dict[str, Any],
        as_of_date: str,
    ) -> dict[str, Any]:
        shared_context = json.dumps(
            {
                "ticker": ticker,
                "stock_name": stock_name,
                "as_of_date": as_of_date,
                "quote": quote,
                "news": news,
                "disclosures": disclosures,
                "heuristic": heuristic,
            },
            ensure_ascii=False,
        )

        bull = self.llm.chat_json(
            [
                {
                    "role": "system",
                    "content": "You are a bullish Korean equity analyst. Return JSON with keys: points (array of 2-3 strings), confidence (0-1), headline.",
                },
                {"role": "user", "content": shared_context},
            ]
        )
        bear = self.llm.chat_json(
            [
                {
                    "role": "system",
                    "content": "You are a skeptical Korean equity analyst. Return JSON with keys: points (array of 2-3 strings), confidence (0-1), watch_points (array of 2-3 strings).",
                },
                {"role": "user", "content": shared_context},
            ]
        )

        bull_points = clip([str(item).strip() for item in bull.get("points", [])], 3)
        bear_points = clip([str(item).strip() for item in bear.get("points", [])], 3)
        watch_points = clip([str(item).strip() for item in bear.get("watch_points", [])], 3)

        bull_confidence = normalize_confidence(bull.get("confidence"), heuristic["confidence"])
        bear_confidence = normalize_confidence(bear.get("confidence"), heuristic["confidence"])
        direction = "neutral"
        if bull_confidence > bear_confidence + 0.05:
            direction = "bullish"
        elif bear_confidence > bull_confidence + 0.05:
            direction = "bearish"

        judge = self.llm.chat_json(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the judge agent in a Korean equity debate. "
                        "Return JSON with keys: verdict, direction, confidence, rationale (array of 2-3 strings), "
                        "selected_risks (array of 2-3 strings), selected_watch_points (array of 2-3 strings)."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "context": json.loads(shared_context),
                            "bull": bull,
                            "bear": bear,
                        },
                        ensure_ascii=False,
                    ),
                },
            ]
        )

        judge_direction = normalize_direction(judge.get("direction"), direction)
        judge_confidence = normalize_confidence(judge.get("confidence"), round(max(bull_confidence, bear_confidence), 2))
        judge_rationale = clip([str(item).strip() for item in judge.get("rationale", [])], 3)
        selected_risks = clip([str(item).strip() for item in judge.get("selected_risks", [])], 3)
        selected_watch_points = clip([str(item).strip() for item in judge.get("selected_watch_points", [])], 3)

        return {
            "headline": clean_text(str(bull.get("headline", heuristic["headline"]))) or heuristic["headline"],
            "direction": judge_direction,
            "confidence": judge_confidence,
            "bullCase": bull_points or heuristic["bullCase"],
            "bearCase": bear_points or heuristic["bearCase"],
            "watchPoints": selected_watch_points or watch_points or heuristic["watchPoints"],
            "debateLog": {
                "bull": {
                    "stance": clean_text(str(bull.get("headline", "상승 논리"))) or "상승 논리",
                    "confidence": bull_confidence,
                    "arguments": bull_points or heuristic["bullCase"],
                },
                "bear": {
                    "stance": "하락/리스크 관점",
                    "confidence": bear_confidence,
                    "arguments": bear_points or heuristic["bearCase"],
                },
                "judge": {
                    "verdict": clean_text(str(judge.get("verdict", judge_direction))) or judge_direction,
                    "rationale": judge_rationale or heuristic["debateLog"]["judge"]["rationale"],
                    "selectedRisks": selected_risks or heuristic["bearCase"],
                    "selectedWatchPoints": selected_watch_points or watch_points or heuristic["watchPoints"],
                },
            },
        }

    def _render_report(
        self,
        *,
        guild_id: str,
        as_of_date: str,
        summary: str,
        market_commentary: str,
        risks: list[str],
        items: list[dict[str, Any]],
        detail: str,
    ) -> str:
        if detail == "summary":
            lines = [
                "# KRX Morning Summary",
                f"- 기준일: {as_of_date}",
                f"- 요약: {summary}",
                f"- 시장 코멘트: {market_commentary}",
                "",
                "## 핵심 리스크",
            ]
            for risk in risks[:3] or ["외부 API 일부가 실패하면 리포트가 부분 생성될 수 있습니다."]:
                lines.append(f"- {risk}")

            for item in items:
                lines.extend(
                    [
                        "",
                        f"## {item['headline']}",
                        f"- 방향성: {item['direction']} ({item['confidence']})",
                        f"- 가격 요약: {item['priceSummary']}",
                        f"- Bull: {item['debateLog']['bull']['arguments'][0] if item['debateLog']['bull']['arguments'] else '상승 논리 없음'}",
                        f"- Bear: {item['debateLog']['bear']['arguments'][0] if item['debateLog']['bear']['arguments'] else '하락 논리 없음'}",
                        f"- Judge: {item['debateLog']['judge']['verdict']}",
                        f"- 체크포인트: {item['debateLog']['judge']['selectedWatchPoints'][0] if item['debateLog']['judge']['selectedWatchPoints'] else '체크포인트 없음'}",
                    ]
                )

            lines.extend(
                [
                    "",
                    "_면책: 이 리포트는 정보 제공용이며 투자 자문이 아닙니다._",
                ]
            )
            return "\n".join(lines)

        lines = [
            "# KRX Morning Report",
            f"- 기준일: {as_of_date}",
            f"- 요약: {summary}",
            f"- 시장 코멘트: {market_commentary}",
            "",
            "## 주요 리스크",
        ]
        for risk in risks or ["외부 API 일부가 실패하면 리포트가 부분 생성될 수 있습니다."]:
            lines.append(f"- {risk}")

        for item in items:
            lines.extend(
                [
                    "",
                    f"## {item['headline']}",
                    f"- 방향성: {item['direction']} ({item['confidence']})",
                    f"- 시세: {item['priceSummary']}",
                    "- 상승 시나리오:",
                ]
            )
            lines.extend([f"  - {point}" for point in item["bullCase"]])
            lines.append("- 하락 시나리오:")
            lines.extend([f"  - {point}" for point in item["bearCase"]])
            lines.append("- 뉴스:")
            lines.extend([f"  - {point}" for point in item["news"]])
            lines.append("- 공시:")
            lines.extend([f"  - {point}" for point in item["disclosures"]])
            lines.append("- 관전 포인트:")
            lines.extend([f"  - {point}" for point in item["watchPoints"]])
            lines.append("### Agent Debate Log")
            lines.append(
                f"- Bull [{item['debateLog']['bull']['confidence']}]: {item['debateLog']['bull']['stance']}"
            )
            lines.extend([f"  - {point}" for point in item["debateLog"]["bull"]["arguments"]])
            lines.append(
                f"- Bear [{item['debateLog']['bear']['confidence']}]: {item['debateLog']['bear']['stance']}"
            )
            lines.extend([f"  - {point}" for point in item["debateLog"]["bear"]["arguments"]])
            lines.append(f"- Judge: {item['debateLog']['judge']['verdict']}")
            lines.append("- Judge rationale:")
            lines.extend([f"  - {point}" for point in item["debateLog"]["judge"]["rationale"]])
            lines.append("- Judge selected risks:")
            lines.extend([f"  - {point}" for point in item["debateLog"]["judge"]["selectedRisks"]])
            lines.append("- Judge selected watch points:")
            lines.extend([f"  - {point}" for point in item["debateLog"]["judge"]["selectedWatchPoints"]])

        lines.extend(
            [
                "",
                "_면책: 이 리포트는 정보 제공용이며 투자 자문이 아닙니다._",
            ]
        )
        return "\n".join(lines)

    @staticmethod
    def _safe_float(value: str) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0


ENGINE = PredictorEngine(PredictorConfig())

# ------------------------------------------------------------------
# Multi-agent system — signal store + knowledge store
# ------------------------------------------------------------------
import sys as _sys
_sys.path.insert(0, os.path.dirname(__file__))

from store.signal_store import SignalStore
from store.knowledge_store import KnowledgeStore

SIGNAL_STORE = SignalStore(os.getenv("SIGNAL_STORE_DIR", "data/signals"))
KNOWLEDGE_STORE = KnowledgeStore(os.getenv("KNOWLEDGE_STORE_PATH", "data/knowledge.json"))

from llm.client import build_llm_client
from agents.macro_agent import MacroAgent
from agents.semiconductor_agent import SemiconductorAgent
from agents.geopolitical_agent import GeopoliticalAgent
from agents.reddit_sentiment_agent import RedditSentimentAgent
from agents.tech_buzz_agent import TechBuzzAgent
from agents.entertainment_agent import EntertainmentAgent
from agents.supply_chain_agent import SupplyChainAgent
from agents.synthesis_agent import SynthesisAgent

DOMAIN_AGENTS = ["macro", "semiconductor", "geopolitical", "reddit_sentiment", "tech_buzz", "entertainment", "supply_chain"]

def _build_agent_registry(config: PredictorConfig, http_client: HttpJsonClient) -> dict:
    llm = build_llm_client(
        endpoint=config.azure_openai_endpoint,
        api_key=config.azure_openai_api_key,
        deployment=config.azure_openai_deployment,
    )
    naver = NaverNewsClient(config, http_client)
    dart = DARTClient(config, http_client)
    return {
        "macro":            MacroAgent(llm_client=llm),
        "semiconductor":    SemiconductorAgent(llm_client=llm, naver_client=naver, dart_client=dart),
        "geopolitical":     GeopoliticalAgent(llm_client=llm, naver_client=naver),
        "reddit_sentiment": RedditSentimentAgent(llm_client=llm),
        "tech_buzz":        TechBuzzAgent(llm_client=llm),
        "entertainment":    EntertainmentAgent(llm_client=llm),
        "supply_chain":     SupplyChainAgent(llm_client=llm),
        "synthesis":        SynthesisAgent(llm_client=llm),
    }

_HTTP_CLIENT = HttpJsonClient(PredictorConfig.timeout_seconds)
AGENT_REGISTRY = _build_agent_registry(PredictorConfig(), _HTTP_CLIENT)


def run_agents(names: list[str] | None = None) -> list:
    """Run specified agents (or all domain agents) and persist signals. Returns saved signals."""
    targets = [n for n in (names or DOMAIN_AGENTS) if n in AGENT_REGISTRY and n != "synthesis"]
    knowledge = [e.content for e in KNOWLEDGE_STORE.list_all()]
    results = []

    for name in targets:
        agent = AGENT_REGISTRY[name]
        if SIGNAL_STORE.is_fresh(name, agent.ttl_seconds):
            logger.info("[agents] %s is fresh, skipping", name)
            signal = SIGNAL_STORE.get_latest(name)
        else:
            logger.info("[agents] running %s", name)
            signal = agent.run(knowledge=knowledge)
            SIGNAL_STORE.save(signal)
        if signal:
            results.append(signal)

    # Always re-run synthesis with fresh domain signals
    synth_agent: SynthesisAgent = AGENT_REGISTRY["synthesis"]
    synth_signal = synth_agent.run_with_signals(results, knowledge)
    SIGNAL_STORE.save(synth_signal)
    results.append(synth_signal)
    return results


class PredictorHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._write_json(200, ENGINE.health())
            return
        if self.path == "/agents/signals":
            signals = [s.to_dict() for s in SIGNAL_STORE.get_all_latest()]
            self._write_json(200, {"signals": signals, "count": len(signals)})
            return
        if self.path.startswith("/agents/signals/"):
            agent_name = self.path.removeprefix("/agents/signals/")
            signal = SIGNAL_STORE.get_latest(agent_name)
            if signal:
                self._write_json(200, signal.to_dict())
            else:
                self._write_json(404, {"ok": False, "error": f"no signal for agent: {agent_name}"})
            return
        if self.path == "/knowledge":
            entries = [e.to_dict() for e in KNOWLEDGE_STORE.list_all()]
            self._write_json(200, {"entries": entries, "count": len(entries)})
            return
        self._write_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path in {"/reports/generate", "/reports/dry-run"}:
            try:
                payload = self._read_json()
                response = ENGINE.generate(payload)
                self._write_json(200, response)
            except ValueError as exc:
                self._write_json(400, {"ok": False, "error": str(exc)})
            except error.HTTPError as exc:
                self._write_json(502, {"ok": False, "error": f"upstream http error: {exc.code}"})
            except Exception as exc:
                logger.exception("report generation failed")
                self._write_json(500, {"ok": False, "error": str(exc)})
            return

        if self.path == "/knowledge":
            try:
                payload = self._read_json()
                content = str(payload.get("content", "")).strip()
                if not content:
                    self._write_json(400, {"ok": False, "error": "content is required"})
                    return
                tags = [str(t).strip() for t in payload.get("tags", []) if str(t).strip()]
                entry = KNOWLEDGE_STORE.add(content, tags)
                self._write_json(201, entry.to_dict())
            except Exception as exc:
                self._write_json(500, {"ok": False, "error": str(exc)})
            return

        if self.path in {"/agents/run", "/agents/run/"}:
            try:
                payload = self._read_json()
                names = payload.get("agents")  # optional list of agent names
                signals = run_agents(names)
                self._write_json(200, {
                    "ok": True,
                    "signals": [s.to_dict() for s in signals],
                    "count": len(signals),
                })
            except Exception as exc:
                logger.exception("agent run failed")
                self._write_json(500, {"ok": False, "error": str(exc)})
            return

        if self.path.startswith("/agents/run/"):
            agent_name = self.path.removeprefix("/agents/run/")
            if agent_name not in AGENT_REGISTRY or agent_name == "synthesis":
                self._write_json(404, {"ok": False, "error": f"unknown agent: {agent_name}. available: {DOMAIN_AGENTS}"})
                return
            try:
                signals = run_agents([agent_name])
                self._write_json(200, {
                    "ok": True,
                    "signals": [s.to_dict() for s in signals],
                    "count": len(signals),
                })
            except Exception as exc:
                self._write_json(500, {"ok": False, "error": str(exc)})
            return

        if self.path.startswith("/knowledge/") and self.path.count("/") == 2:
            # DELETE via POST body workaround — real DELETE handled below
            self._write_json(405, {"ok": False, "error": "use DELETE /knowledge/<id>"})
            return

        self._write_json(404, {"ok": False, "error": "not found"})

    def do_DELETE(self) -> None:
        if self.path.startswith("/knowledge/"):
            entry_id = self.path.removeprefix("/knowledge/")
            removed = KNOWLEDGE_STORE.remove(entry_id)
            if removed:
                self._write_json(200, {"ok": True, "id": entry_id})
            else:
                self._write_json(404, {"ok": False, "error": f"entry not found: {entry_id}"})
            return
        self._write_json(404, {"ok": False, "error": "not found"})

    def log_message(self, format: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), format % args)

    def _read_json(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length) if content_length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    server = ThreadingHTTPServer((PredictorConfig.host, PredictorConfig.port), PredictorHandler)
    logger.info("predictor listening on %s:%s", PredictorConfig.host, PredictorConfig.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
