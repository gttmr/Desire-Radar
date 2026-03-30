import { describe, expect, it } from 'vitest';
import { ReportCommandService } from '../src/services/reportCommandService.js';

describe('ReportCommandService', () => {
  it('normalizes watchlist additions before storing them', async () => {
    const calls: Array<{ ticker: string; entry?: Record<string, unknown> }> = [];
    const service = new ReportCommandService(
      {
        async addTicker(
          _guildId: string,
          _reportChannelId: string,
          ticker: string,
          entry?: Record<string, unknown>,
        ) {
          calls.push({ ticker, entry });
          return {
            guildId: 'guild-1',
            reportChannelId: 'channel-1',
            tickers: ['TSLA'],
            watchlist: [
              {
                assetKey: 'stock:NASDAQ:TSLA',
                ticker: 'TSLA',
                companyName: 'Tesla',
                market: 'US',
                exchange: 'NASDAQ',
                instrumentCode: null,
                normalizationSource: 'equity_map',
                addedAt: '2026-03-30T00:00:00.000Z',
              },
            ],
            enabled: true,
            timezone: 'Asia/Seoul',
            createdAt: '2026-03-30T00:00:00.000Z',
            updatedAt: '2026-03-30T00:00:00.000Z',
          };
        },
      } as never,
      () => 'channel-1',
      async () => {
        throw new Error('not used');
      },
      async (input) => ({
        input,
        resolved: true,
        asset_key: 'stock:NASDAQ:TSLA',
        ticker: 'TSLA',
        company_name: 'Tesla',
        market: 'US',
        exchange: 'NASDAQ',
        instrument_code: null,
        aliases: ['Tesla'],
        normalization_source: 'equity_map',
        normalization_confidence: 1,
      }),
      async () => 'detail',
    );

    const message = await service.addTicker('guild-1', 'Tesla');

    expect(calls).toEqual([
      {
        ticker: 'TSLA',
        entry: {
          assetKey: 'stock:NASDAQ:TSLA',
          companyName: 'Tesla',
          market: 'US',
          exchange: 'NASDAQ',
          instrumentCode: null,
          normalizationSource: 'equity_map',
        },
      },
    ]);
    expect(message).toContain('Tesla (`TSLA`)');
  });
});
