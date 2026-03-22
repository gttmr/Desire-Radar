import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuildConfigStore } from '../src/services/guildConfigStore.js';

describe('GuildConfigStore', () => {
  it('creates and updates guild report settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'guild-config-store-'));
    const store = new GuildConfigStore(path.join(root, 'config.json'));

    const created = await store.ensureGuild('g1', {
      reportChannelId: 'c1',
      timezone: 'Asia/Seoul'
    });
    expect(created.tickers).toEqual([]);

    const afterAdd = await store.addTicker('g1', '005930');
    expect(afterAdd.tickers).toEqual(['005930']);

    const afterRemove = await store.removeTicker('g1', '005930');
    expect(afterRemove.tickers).toEqual([]);

    await store.markRun('g1', { status: 'ok', mode: 'manual' });
    const saved = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')) as {
      guilds: Record<string, { lastReport?: { status: string } }>;
    };

    expect(saved.guilds.g1.lastReport?.status).toBe('ok');
  });
});
