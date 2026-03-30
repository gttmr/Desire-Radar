import type { NormalizedEquityIdentity } from '@agentic/shared-types';

type KisLookupClientOptions = {
  appKey?: string;
  appSecret?: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

type TokenState = {
  token: string;
  expiresAt: number;
};

type KisJsonResponse = {
  rt_cd?: string;
  msg1?: string;
  output?: Record<string, unknown> | Array<Record<string, unknown>>;
};

const US_PRODUCT_TYPES = [
  { code: '512', exchange: 'NASDAQ' },
  { code: '513', exchange: 'NYSE' },
  { code: '529', exchange: 'AMEX' },
] as const;

function firstNonEmptyString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeTicker(input: string): string {
  return input.trim().toUpperCase();
}

function firstOutput(body: KisJsonResponse): Record<string, unknown> | null {
  const output = body.output;
  if (Array.isArray(output)) {
    return (output[0] as Record<string, unknown>) ?? null;
  }
  return (output as Record<string, unknown>) ?? null;
}

export class KisInstrumentLookupClient {
  private readonly fetchImpl: typeof fetch;
  private tokenState: TokenState | null = null;

  constructor(private readonly options: KisLookupClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.options.appKey?.trim() && this.options.appSecret?.trim());
  }

  async lookup(input: string): Promise<NormalizedEquityIdentity | null> {
    if (!this.configured) {
      return null;
    }
    const trimmed = input.trim();
    if (/^\d{6}$/.test(trimmed)) {
      return this.lookupDomesticCode(trimmed);
    }
    if (/^[A-Za-z][A-Za-z0-9.-]{0,11}$/.test(trimmed)) {
      return this.lookupUsTicker(normalizeTicker(trimmed));
    }
    return null;
  }

  private async lookupDomesticCode(code: string): Promise<NormalizedEquityIdentity | null> {
    const body = await this.getJson('/uapi/domestic-stock/v1/quotations/search-stock-info', 'CTPF1002R', {
      PRDT_TYPE_CD: '300',
      PDNO: code,
    });
    const output = firstOutput(body);
    if (!output) {
      return null;
    }
    const companyName =
      firstNonEmptyString(output, ['prdt_name', 'prdt_abrv_name', 'prdt_name120']) ?? code;
    const marketCode = firstNonEmptyString(output, ['mket_id_cd', 'excg_dvsn_cd']);
    const exchange =
      marketCode?.includes('KSQ') || marketCode?.includes('KQ')
        ? 'KOSDAQ'
        : 'KRX';
    const instrumentCode = firstNonEmptyString(output, ['std_pdno', 'pdno']) ?? code;
    return {
      input: code,
      resolved: true,
      asset_key: `stock:${exchange}:${code}`,
      ticker: code,
      company_name: companyName,
      market: 'KR',
      exchange,
      instrument_code: instrumentCode,
      aliases: [],
      normalization_source: 'kis_api',
      normalization_confidence: 0.92,
    };
  }

  private async lookupUsTicker(ticker: string): Promise<NormalizedEquityIdentity | null> {
    for (const product of US_PRODUCT_TYPES) {
      const body = await this.getJson('/uapi/overseas-price/v1/quotations/search-info', 'CTPF1702R', {
        PRDT_TYPE_CD: product.code,
        PDNO: ticker,
      });
      const output = firstOutput(body);
      if (!output) {
        continue;
      }
      const companyName =
        firstNonEmptyString(output, ['ovrs_item_name', 'prdt_name', 'prdt_eng_name']) ?? ticker;
      const exchange =
        firstNonEmptyString(output, ['ovrs_excg_name', 'tr_mket_name']) ?? product.exchange;
      const instrumentCode =
        firstNonEmptyString(output, ['std_pdno', 'pdno', 'blbg_tckr_text']) ?? ticker;
      return {
        input: ticker,
        resolved: true,
        asset_key: `stock:${product.exchange}:${ticker}`,
        ticker,
        company_name: companyName,
        market: 'US',
        exchange: product.exchange,
        instrument_code: instrumentCode,
        aliases: [],
        normalization_source: 'kis_api',
        normalization_confidence: 0.92,
      };
    }
    return null;
  }

  private async getJson(
    path: string,
    trId: string,
    params: Record<string, string>,
  ): Promise<KisJsonResponse> {
    const token = await this.getAccessToken();
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: this.options.appKey!.trim(),
        appsecret: this.options.appSecret!.trim(),
        tr_id: trId,
        custtype: 'P',
      },
    });
    if (!response.ok) {
      return {};
    }
    const body = (await response.json()) as KisJsonResponse;
    if (body.rt_cd && body.rt_cd !== '0') {
      return {};
    }
    return body;
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 60_000) {
      return this.tokenState.token;
    }
    const response = await this.fetchImpl(new URL('/oauth2/tokenP', this.options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.options.appKey!.trim(),
        appsecret: this.options.appSecret!.trim(),
      }),
    });
    if (!response.ok) {
      throw new Error(`KIS token request failed (${response.status})`);
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
    };
    const token = body.access_token?.trim();
    if (!token) {
      throw new Error('KIS token response missing access_token');
    }
    const expiresIn = Number(body.expires_in ?? 3600);
    this.tokenState = {
      token,
      expiresAt: Date.now() + Math.max(300, expiresIn) * 1_000,
    };
    return token;
  }
}
