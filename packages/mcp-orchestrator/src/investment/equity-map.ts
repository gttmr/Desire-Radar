import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InvestmentEquityMapEntry } from '@agentic/shared-types';

type EquityMapFile = {
  version: 1;
  equities: InvestmentEquityMapEntry[];
};

const STARTER_EQUITIES: InvestmentEquityMapEntry[] = [
  {
    asset_key: 'stock:KRX:005930',
    ticker: '005930',
    company_name: '삼성전자',
    aliases: ['Samsung Electronics', 'Samsung', '005930.KS'],
    market: 'KR',
    exchange: 'KRX',
    instrument_code: 'KR7005930003',
  },
  {
    asset_key: 'stock:NASDAQ:MSFT',
    ticker: 'MSFT',
    company_name: 'Microsoft',
    aliases: ['MSFT', 'Xbox'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NASDAQ:NVDA',
    ticker: 'NVDA',
    company_name: 'NVIDIA',
    aliases: ['NVDA', 'GeForce'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NASDAQ:GOOGL',
    ticker: 'GOOGL',
    company_name: 'Alphabet',
    aliases: ['Google', 'GOOGL', 'YouTube', 'Youtube', 'Android'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NASDAQ:META',
    ticker: 'META',
    company_name: 'Meta Platforms',
    aliases: ['Meta', 'Facebook', 'Instagram', 'WhatsApp'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NASDAQ:AMZN',
    ticker: 'AMZN',
    company_name: 'Amazon',
    aliases: ['Amazon', 'AWS', 'Prime Video'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NASDAQ:NFLX',
    ticker: 'NFLX',
    company_name: 'Netflix',
    aliases: ['Netflix'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NASDAQ:TSLA',
    ticker: 'TSLA',
    company_name: 'Tesla',
    aliases: ['Tesla'],
    market: 'US',
    exchange: 'NASDAQ',
  },
  {
    asset_key: 'stock:NYSE:DIS',
    ticker: 'DIS',
    company_name: 'Disney',
    aliases: ['Disney', 'Disney+'],
    market: 'US',
    exchange: 'NYSE',
  },
  {
    asset_key: 'stock:NYSE:SONY',
    ticker: 'SONY',
    company_name: 'Sony Group',
    aliases: ['Sony', 'PlayStation', 'PlayStation 5', 'PS5'],
    market: 'US',
    exchange: 'NYSE',
  },
  {
    asset_key: 'stock:NASDAQ:AAPL',
    ticker: 'AAPL',
    company_name: 'Apple',
    aliases: ['Apple', 'App Store', 'iPhone'],
    market: 'US',
    exchange: 'NASDAQ',
  },
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEntry(entry: Partial<InvestmentEquityMapEntry>): InvestmentEquityMapEntry {
  const assetKey = String(entry.asset_key ?? '').trim();
  const ticker = String(entry.ticker ?? '').trim();
  const companyName = String(entry.company_name ?? '').trim();
  if (!assetKey || !ticker || !companyName) {
    throw new Error('equity map entries require asset_key, ticker, and company_name');
  }
  return {
    asset_key: assetKey,
    ticker,
    company_name: companyName,
    aliases: [...new Set((entry.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))],
    market: entry.market?.trim() || null,
    exchange: entry.exchange?.trim() || null,
    instrument_code: entry.instrument_code?.trim() || null,
  };
}

export class EquityMapStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async ensureExists(): Promise<void> {
    if (existsSync(this.filePath)) {
      const entries = await this.list();
      if (entries.length > 0) {
        return;
      }
      await this.writeDefaults();
      return;
    }
    await this.writeDefaults();
  }

  async list(): Promise<InvestmentEquityMapEntry[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = await readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EquityMapFile>;
    return (parsed.equities ?? []).map((entry) =>
      normalizeEntry({
        asset_key: entry.asset_key ?? `stock:${entry.ticker ?? 'unknown'}`,
        ticker: entry.ticker ?? 'unknown',
        company_name: entry.company_name ?? entry.ticker ?? 'unknown',
        aliases: entry.aliases ?? [],
      }),
    );
  }

  async replace(entries: InvestmentEquityMapEntry[]): Promise<InvestmentEquityMapEntry[]> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const normalized = entries
      .map((entry) => normalizeEntry(entry))
      .sort((left, right) => {
        const tickerCompare = left.ticker.localeCompare(right.ticker);
        if (tickerCompare !== 0) {
          return tickerCompare;
        }
        return left.company_name.localeCompare(right.company_name);
      });
    const payload: EquityMapFile = {
      version: 1,
      equities: normalized,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return normalized;
  }

  async resolveByTicker(ticker: string): Promise<InvestmentEquityMapEntry | null> {
    const normalized = normalize(ticker);
    const entries = await this.list();
    return (
      entries.find((entry) => normalize(entry.ticker) === normalized) ?? null
    );
  }

  async resolveByAlias(label: string): Promise<InvestmentEquityMapEntry | null> {
    const normalized = normalize(label);
    if (!normalized) {
      return null;
    }
    const entries = await this.list();
    return (
      entries.find((entry) => {
        if (normalize(entry.company_name) === normalized) {
          return true;
        }
        if (normalize(entry.ticker) === normalized) {
          return true;
        }
        return entry.aliases.some((alias) => normalize(alias) === normalized);
      }) ?? null
    );
  }

  private async writeDefaults(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: EquityMapFile = {
      version: 1,
      equities: STARTER_EQUITIES.map((entry) => normalizeEntry(entry)),
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
