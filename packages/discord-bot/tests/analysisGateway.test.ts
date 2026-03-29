import { describe, expect, it } from 'vitest';
import { OrchestratorGatewayAdapter } from '../src/services/analysisGateway.js';

describe('OrchestratorGatewayAdapter', () => {
  it('maps investment decision artifacts into report responses', async () => {
    const gateway = new OrchestratorGatewayAdapter(
      {
        async createInvestmentDecisionRun() {
          return {
            run: {
              run_id: 'decision-1',
              status: 'completed',
              mode: 'manual',
              runner: 'provider_exec',
              created_at: '2026-03-29T00:00:00Z',
              updated_at: '2026-03-29T00:00:05Z',
              request_path: 'request.json',
              request_markdown_path: 'request.md',
              status_path: 'status.json',
              response_path: 'response.json',
              response_markdown_path: 'response.md',
              report_path: 'report.md',
            },
            request: {
              run_id: 'decision-1',
              created_at: '2026-03-29T00:00:00Z',
              mode: 'manual',
              window: {
                label: '2026-03-29',
                start: '2026-03-23T00:00:00Z',
                end: '2026-03-29T23:59:59Z',
              },
              watchlist: ['005930'],
              resolved_equities: [],
              candidate_clusters: [],
              supporting_evidence_refs: [],
              investment_notes: [],
              source_health_summary: [{ source_id: 'reddit_mentions', readiness_status: 'ready' }],
              coverage_gaps: [],
              schema_version: 1,
            },
            artifact: {
              run_id: 'decision-1',
              status: 'completed',
              generated_at: '2026-03-29T00:00:05Z',
              summary: 'HBM shortlist',
              market_view: 'Selective memory strength',
              top_picks: [
                {
                  asset_key: 'stock:005930',
                  ticker: '005930',
                  company_name: '삼성전자',
                  recommendation: 'accumulate',
                  confidence: 0.8,
                  why_now: 'HBM demand persists',
                  thesis: 'Mix improves',
                  beneficiary_path: 'HBM capacity leverage',
                  linked_clusters: ['cluster-hbm'],
                  linked_evidence_refs: ['ev-1'],
                  risks: ['cycle turn'],
                  missing_information: ['pricing durability'],
                },
              ],
              watch_candidates: [],
              rejected_candidates: [],
              coverage_gaps: [],
              risks: ['macro shock'],
              degraded: false,
              degraded_reason: null,
              schema_version: 1,
            },
            report: {
              run_id: 'decision-1',
              detail: 'summary',
              markdown: '# report',
              generated_at: '2026-03-29T00:00:05Z',
            },
          };
        },
      } as never,
      {} as never,
    );

    const response = await gateway.generateReport({
      guildId: 'guild-1',
      tickers: ['005930'],
      asOfDate: '2026-03-29',
      mode: 'manual',
      detail: 'summary',
    });

    expect(response.summary).toContain('HBM shortlist');
    expect(response.markdown).toBe('# report');
    expect(response.items[0]?.ticker).toBe('005930');
    expect(response.sources).toEqual(['reddit_mentions']);
  });
});
