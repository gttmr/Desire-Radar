import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NormalizedEquityIdentity } from '@agentic/shared-types';

type IdentityCacheFile = {
  version: 1;
  entries: Record<string, NormalizedEquityIdentity>;
};

function normalizeKey(input: string): string {
  return input.trim().toLowerCase();
}

export class EquityIdentityCacheStore {
  constructor(private readonly filePath: string) {}

  async get(input: string): Promise<NormalizedEquityIdentity | null> {
    const key = normalizeKey(input);
    if (!key) {
      return null;
    }
    const cache = await this.read();
    return cache.entries[key] ?? null;
  }

  async set(input: string, identity: NormalizedEquityIdentity): Promise<void> {
    const key = normalizeKey(input);
    if (!key || !identity.resolved) {
      return;
    }
    const cache = await this.read();
    cache.entries[key] = identity;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(cache, null, 2), 'utf8');
  }

  private async read(): Promise<IdentityCacheFile> {
    if (!existsSync(this.filePath)) {
      return { version: 1, entries: {} };
    }
    const raw = await readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<IdentityCacheFile>;
    return {
      version: 1,
      entries: parsed.entries ?? {},
    };
  }
}
