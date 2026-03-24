import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GuildReportConfig, GuildReportConfigStore, ReportRunMode } from '../types/domain.js';

const EMPTY_STORE: GuildReportConfigStore = {
  version: 1,
  guilds: {}
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTicker(input: string): string {
  return input.trim().toUpperCase();
}

export class GuildConfigStore {
  private readonly filePath: string;
  private writeChain = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(): Promise<GuildReportConfig[]> {
    const store = await this.readStore();
    return Object.values(store.guilds).sort((left, right) => left.guildId.localeCompare(right.guildId));
  }

  async get(guildId: string): Promise<GuildReportConfig | undefined> {
    const store = await this.readStore();
    return store.guilds[guildId];
  }

  async ensureGuild(
    guildId: string,
    defaults: { reportChannelId: string; timezone: string; enabled?: boolean }
  ): Promise<GuildReportConfig> {
    const existing = await this.get(guildId);
    if (existing) {
      return existing;
    }

    return this.updateStore((store) => {
      const timestamp = nowIso();
      const created: GuildReportConfig = {
        guildId,
        reportChannelId: defaults.reportChannelId,
        tickers: [],
        enabled: defaults.enabled ?? true,
        timezone: defaults.timezone,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      store.guilds[guildId] = created;
      return created;
    });
  }

  async setReportChannel(guildId: string, reportChannelId: string): Promise<GuildReportConfig> {
    return this.updateGuild(guildId, (current) => ({ ...current, reportChannelId }));
  }

  async addTicker(guildId: string, ticker: string): Promise<GuildReportConfig> {
    const normalized = normalizeTicker(ticker);
    return this.updateGuild(guildId, (current) => ({
      ...current,
      tickers: current.tickers.includes(normalized)
        ? current.tickers
        : [...current.tickers, normalized].sort((left, right) => left.localeCompare(right))
    }));
  }

  async removeTicker(guildId: string, ticker: string): Promise<GuildReportConfig> {
    const normalized = normalizeTicker(ticker);
    return this.updateGuild(guildId, (current) => ({
      ...current,
      tickers: current.tickers.filter((item) => item !== normalized)
    }));
  }

  async markRun(
    guildId: string,
    run: { status: 'ok' | 'error'; mode: ReportRunMode; error?: string }
  ): Promise<GuildReportConfig> {
    return this.updateGuild(guildId, (current) => ({
      ...current,
      lastReport: {
        status: run.status,
        mode: run.mode,
        ranAt: nowIso(),
        error: run.error
      }
    }));
  }

  async setEnabled(guildId: string, enabled: boolean): Promise<GuildReportConfig> {
    return this.updateGuild(guildId, (current) => ({ ...current, enabled }));
  }

  private async updateGuild(
    guildId: string,
    updater: (current: GuildReportConfig) => GuildReportConfig
  ): Promise<GuildReportConfig> {
    return this.updateStore((store) => {
      const current = store.guilds[guildId];
      if (!current) {
        throw new Error(`Guild config not found: ${guildId}`);
      }
      const updated = {
        ...updater(current),
        guildId,
        updatedAt: nowIso()
      };
      store.guilds[guildId] = updated;
      return updated;
    });
  }

  private async updateStore<T>(updater: (store: GuildReportConfigStore) => T): Promise<T> {
    const operation = this.writeChain.then(async () => {
      const store = await this.readStore();
      const result = updater(store);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(store, null, 2), 'utf8');
      return result;
    });

    this.writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readStore(): Promise<GuildReportConfigStore> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<GuildReportConfigStore>;
      return {
        version: 1,
        guilds: parsed.guilds ?? {}
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return structuredClone(EMPTY_STORE);
      }
      throw error;
    }
  }
}
