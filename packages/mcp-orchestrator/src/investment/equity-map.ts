import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type EquityMapEntry = {
  asset_key: string;
  ticker: string;
  company_name: string;
  aliases: string[];
};

type EquityMapFile = {
  version: 1;
  equities: EquityMapEntry[];
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export class EquityMapStore {
  constructor(private readonly filePath: string) {}

  async ensureExists(): Promise<void> {
    if (existsSync(this.filePath)) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: EquityMapFile = { version: 1, equities: [] };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async list(): Promise<EquityMapEntry[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = await readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EquityMapFile>;
    return (parsed.equities ?? []).map((entry) => ({
      asset_key: entry.asset_key ?? `stock:${entry.ticker ?? 'unknown'}`,
      ticker: entry.ticker ?? 'unknown',
      company_name: entry.company_name ?? entry.ticker ?? 'unknown',
      aliases: [...new Set((entry.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))],
    }));
  }

  async resolveByTicker(ticker: string): Promise<EquityMapEntry | null> {
    const normalized = normalize(ticker);
    const entries = await this.list();
    return (
      entries.find((entry) => normalize(entry.ticker) === normalized) ?? null
    );
  }

  async resolveByAlias(label: string): Promise<EquityMapEntry | null> {
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
}
