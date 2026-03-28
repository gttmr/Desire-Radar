import express from 'express';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/session-store.js';
import { createRoutes } from '../src/api/routes.js';
import { InvestmentMarkdownStore } from '../src/investment/markdown-store.js';
import { InvestmentIntakeService } from '../src/investment/intake-service.js';

function makeOrchestratorStub() {
  return {
    getReports: () => [],
    listHighLevelRuns: () => [],
    getHighLevelRun: () => null,
    getRunResearch: () => null,
    getRunVerdict: () => null,
    getProviderExecutions: () => [],
    listResearchRequests: () => [],
  } as never;
}

describe('investment intake', () => {
  let server: ReturnType<express.Express['listen']> | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = undefined;
    });
  });

  it('stores intake markdown and updates an asset dossier', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-intake-'));
    const store = new InvestmentMarkdownStore(dataDir);
    const service = new InvestmentIntakeService(store);

    const result = await service.submit({
      source_submission_id: 'submission-1',
      input_kind: 'study_note',
      raw_input: '삼성전자 HBM 스터디 메모',
      channel_ref: 'discord://guild/channel/message',
      asset_candidates: [
        {
          asset_type: 'stock',
          asset_key: 'stock:005930',
          display_name: '삼성전자',
          ticker: '005930',
          market: 'KRX',
          confidence: 0.94,
        },
      ],
      auto_actions: [
        {
          action: 'watchlist_add',
          asset_type: 'stock',
          asset_key: 'stock:005930',
          ticker: '005930',
          display_name: '삼성전자',
          confidence: 0.96,
        },
      ],
      investment_note: {
        title: '삼성전자 HBM note',
        summary: 'HBM 수요와 고객사 확보 속도를 본다.',
        structured_summary: ['HBM 공급 확장', '고객사 수요 증가'],
        why_it_might_matter: 'AI 서버 확대로 메모리 mix가 달라질 수 있다.',
        beneficiary_hints: ['HBM 공급망'],
        open_questions: ['실제 실적 가시화 시점은 언제인가?'],
        references: ['https://discord.example/message/1'],
        asset_candidates: [
          {
            asset_type: 'stock',
            asset_key: 'stock:005930',
            display_name: '삼성전자',
            ticker: '005930',
            market: 'KRX',
            confidence: 0.94,
          },
        ],
        status: 'resolved',
      },
    });

    expect(result.intake.source_submission_id).toBe('submission-1');
    expect(result.dossiers).toHaveLength(1);
    const storedIntake = await service.getIntake(result.intake.intake_id);
    expect(storedIntake?.markdown).toContain('# Raw Input');
    const storedAsset = await service.getAsset('stock:005930');
    expect(storedAsset?.asset.note_count).toBe(1);
    expect(storedAsset?.markdown).toContain('# Potential Thesis');
    expect(readFileSync(result.intake.note_path, 'utf8')).toContain('삼성전자 HBM note');
  });

  it('exposes investment intake routes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-routes-'));
    const service = new InvestmentIntakeService(new InvestmentMarkdownStore(dataDir));
    const app = express();
    app.use(express.json());
    app.use(
      createRoutes(
        makeOrchestratorStub(),
        new SessionStore(dataDir),
        new ProviderRegistry(),
        undefined,
        service,
      ),
    );
    server = app.listen(0);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine test server address');
    }

    const createResponse = await fetch(`http://127.0.0.1:${address.port}/investment/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_submission_id: 'submission-2',
        input_kind: 'study_note',
        raw_input: 'SK hynix note',
        asset_candidates: [
          {
            asset_type: 'stock',
            asset_key: 'stock:000660',
            display_name: 'SK하이닉스',
            ticker: '000660',
            market: 'KRX',
            confidence: 0.9,
          },
        ],
        auto_actions: [],
        investment_note: {
          title: 'SK hynix note',
          summary: 'memory cycle',
          structured_summary: ['HBM'],
          why_it_might_matter: 'HBM pricing power',
          beneficiary_hints: [],
          open_questions: ['margin durability'],
          references: [],
          asset_candidates: [],
          status: 'resolved',
        },
      }),
    });
    const created = (await createResponse.json()) as {
      intake: { intake_id: string };
      dossiers: Array<{ asset_key: string }>;
    };

    expect(createResponse.status).toBe(200);
    expect(created.dossiers[0]?.asset_key).toBe('stock:000660');

    const intakeResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/intakes/${encodeURIComponent(created.intake.intake_id)}`,
    );
    expect(intakeResponse.status).toBe(200);

    const assetResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/assets/${encodeURIComponent('stock:000660')}`,
    );
    expect(assetResponse.status).toBe(200);
  });
});
