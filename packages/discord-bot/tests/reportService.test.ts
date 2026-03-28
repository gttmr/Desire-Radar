import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuildConfigStore } from '../src/services/guildConfigStore.js';
import { ReportService } from '../src/services/reportService.js';
import type { PredictorRequest, PredictorResponse } from '../src/types/domain.js';

class FakeAnalysisGateway {
  lastRequest?: PredictorRequest;

  async generateReport(request: PredictorRequest): Promise<PredictorResponse> {
    this.lastRequest = request;
    return {
      detail: request.detail,
      summary: 'summary',
      marketCommentary: 'market',
      markdown: '# report',
      generatedAt: '2026-03-16T23:00:00.000Z',
      risks: [],
      sources: [],
      items: [
        {
          ticker: request.tickers[0] ?? '005930',
          headline: 'headline',
          direction: 'bullish',
          confidence: 0.7,
          news: [],
          disclosures: [],
          bullCase: ['bull'],
          bearCase: ['bear'],
          watchPoints: ['watch'],
          debateLog: {
            bull: {
              stance: 'bull stance',
              confidence: 0.7,
              arguments: ['bull']
            },
            bear: {
              stance: 'bear stance',
              confidence: 0.4,
              arguments: ['bear']
            },
            judge: {
              verdict: 'judge verdict',
              rationale: ['rationale'],
              selectedRisks: ['risk'],
              selectedWatchPoints: ['watch']
            }
          }
        }
      ]
    };
  }
}

describe('ReportService', () => {
  it('requires at least one ticker before running the report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'report-service-'));
    const store = new GuildConfigStore(path.join(root, 'config.json'));
    const gateway = new FakeAnalysisGateway();
    const service = new ReportService(store, gateway, 'Asia/Seoul');

    await service.ensureGuild('g1', 'c1');
    await expect(service.generateForGuild('g1', 'c1', 'manual', 'summary')).rejects.toThrow('관심 종목이 없습니다');
  });

  it('forwards guild and ticker data to the report gateway', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'report-service-'));
    const store = new GuildConfigStore(path.join(root, 'config.json'));
    const gateway = new FakeAnalysisGateway();
    const service = new ReportService(store, gateway, 'Asia/Seoul');

    await service.addTicker('g1', 'c1', '005930');
    const dispatch = await service.generateForGuild('g1', 'c1', 'manual', 'full');

    expect(dispatch.channelId).toBe('c1');
    expect(gateway.lastRequest).toMatchObject({
      guildId: 'g1',
      tickers: ['005930'],
      mode: 'manual',
      detail: 'full'
    });
    expect(dispatch.response.detail).toBe('full');
  });
});
