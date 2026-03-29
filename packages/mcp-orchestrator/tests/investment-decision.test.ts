import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutes } from '../src/api/routes.js';
import { CandidateService } from '../src/collector/candidate-service.js';
import { InvestmentContextProvider } from '../src/investment/context-provider.js';
import { InvestmentDecisionStore } from '../src/investment/decision-store.js';
import {
  ExternalArtifactDecisionRunner,
  ProviderExecDecisionRunner,
} from '../src/investment/decision-runner.js';
import { EquityMapStore } from '../src/investment/equity-map.js';
import { InvestmentEquityMapService } from '../src/investment/equity-map-service.js';
import { InvestmentDecisionService } from '../src/investment/decision-service.js';
import { ExternalInvestmentDecisionWorker } from '../src/investment/external-worker.js';
import { InvestmentMarkdownStore } from '../src/investment/markdown-store.js';
import { InvestmentDecisionPromptBuilder } from '../src/investment/prompt-builder.js';
import { InvestmentReportFormatter } from '../src/investment/report-formatter.js';
import { InvestmentSignalAssembler } from '../src/investment/signal-assembler.js';
import { InvestableUniverseResolver } from '../src/investment/universe-resolver.js';
import { ExecutionPolicyResolver } from '../src/policy/execution.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/session-store.js';

function makeRequest(runId: string) {
  return {
    run_id: runId,
    created_at: '2026-03-29T00:00:00.000Z',
    mode: 'manual' as const,
    window: {
      label: '2026-03-29',
      start: '2026-03-23T00:00:00.000Z',
      end: '2026-03-29T23:59:59.000Z',
    },
    watchlist: ['005930'],
    resolved_equities: [
      {
        asset_key: 'stock:005930',
        ticker: '005930',
        company_name: '삼성전자',
        why_in_scope: 'watchlist member',
        linked_clusters: [],
        linked_notes: [],
        watchlist_member: true,
      },
    ],
    candidate_clusters: [],
    supporting_evidence_refs: [],
    investment_notes: [],
    source_health_summary: [],
    coverage_gaps: [],
    schema_version: 1 as const,
  };
}

function makeRunRecord(root: string, runId: string) {
  const runDir = join(root, '2026-03-29', runId);
  mkdirSync(runDir, { recursive: true });
  return {
    run_id: runId,
    status: 'running' as const,
    mode: 'manual' as const,
    runner: 'external_artifact' as const,
    created_at: '2026-03-29T00:00:00.000Z',
    updated_at: '2026-03-29T00:00:00.000Z',
    request_path: join(runDir, 'request.json'),
    request_markdown_path: join(runDir, 'request.md'),
    status_path: join(runDir, 'status.json'),
    response_path: join(runDir, 'response.json'),
    response_markdown_path: join(runDir, 'response.md'),
    report_path: join(runDir, 'report.md'),
    degraded_reason: null,
    error: null,
  };
}

describe('investment decision module', () => {
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

  it('assembles watchlist equities and curated candidate mappings', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-assemble-'));
    const equityMapPath = join(dataDir, 'investment-module', 'equity-map.json');
    mkdirSync(join(dataDir, 'investment-module'), { recursive: true });
    writeFileSync(
      equityMapPath,
      JSON.stringify(
        {
          version: 1,
          equities: [
            {
              asset_key: 'stock:MSFT',
              ticker: 'MSFT',
              company_name: 'Microsoft',
              aliases: ['microsoft', 'Microsoft'],
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    const resolver = new InvestableUniverseResolver(
      new EquityMapStore(equityMapPath),
      new InvestmentContextProvider(new InvestmentMarkdownStore(dataDir)),
    );
    const assembler = new InvestmentSignalAssembler(
      {
        async getEmergingCandidates() {
          return [
            {
              entity: 'Microsoft',
              cluster_id: 'cluster-msft',
              candidate_kind: 'entity_cluster',
              display_label: 'Microsoft',
              primary_entity: 'Microsoft',
              aliases: ['MSFT'],
              supporting_sources: ['reddit_mentions'],
              supporting_terms: ['AV1'],
              theme_tags: ['codec'],
              event_summary: 'AV1 rollout chatter',
              graph_summary: 'entity -> event',
              status: 'emerging',
              emergence_score: 0.8,
              velocity_score: 0.7,
              source_count: 1,
              evidence_ids: ['ev-1'],
              sources: ['reddit_mentions'],
              first_seen: '2026-03-29T00:00:00Z',
              last_seen: '2026-03-29T00:00:00Z',
            },
          ];
        },
        async getSourcesStatus() {
          return {
            reddit_mentions: {
              scheduled: true,
              enabled: true,
              last_run: '2026-03-29T00:00:00Z',
              cadence_seconds: 3600,
              source_tier: 2 as const,
              readiness_status: 'ready',
            },
          };
        },
      } as unknown as CandidateService,
      new InvestmentContextProvider(new InvestmentMarkdownStore(dataDir)),
      resolver,
    );

    const request = await assembler.assemble({
      runId: 'run-1',
      mode: 'manual',
      asOfDate: '2026-03-29',
      watchlist: ['005930'],
      windowDays: 7,
    });

    expect(request.resolved_equities.map((item) => item.ticker)).toEqual(['005930', 'MSFT']);
    expect(request.coverage_gaps).toEqual([]);
  });

  it('normalizes provider_exec output into the canonical response artifact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-provider-'));
    const registry = new ProviderRegistry();
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute() {
        return {
          text: JSON.stringify({
            summary: 'Buy shortlist ready',
            market_view: 'Selective quality bias',
            top_picks: [
              {
                asset_key: 'stock:005930',
                ticker: '005930',
                company_name: '삼성전자',
                recommendation: 'accumulate',
                confidence: 0.82,
                why_now: 'HBM demand remains strong',
                thesis: 'Memory mix improves',
                beneficiary_path: 'HBM cycle leverage',
                linked_clusters: ['cluster-hbm'],
                linked_evidence_refs: ['ev-1'],
                risks: ['cycle reversal'],
                missing_information: ['spot pricing persistence'],
              },
            ],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: ['macro drawdown'],
            degraded: false,
            degraded_reason: null,
          }),
          sessionId: 'provider-session',
          durationMs: 120,
          status: 'completed' as const,
        };
      },
      async health() {
        return true;
      },
      async probeHealth() {
        return { available: true, ready_for_execution: true, status: 'healthy' as const };
      },
    });
    const runner = new ProviderExecDecisionRunner(
      registry,
      new SessionStore(dataDir),
      new ExecutionPolicyResolver(
        {
          defaults: {
            triage: { providers: ['mock'], modelProfile: 'cheap', responseFormat: 'json' },
            debate: { providers: ['mock'], modelProfile: 'cheap', responseFormat: 'json' },
            verdict: { providers: ['mock'], modelProfile: 'premium', responseFormat: 'json' },
            report: { providers: ['mock'], modelProfile: 'balanced', responseFormat: 'json' },
            investment_decision: {
              providers: ['mock'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
          agents: {},
        },
        {
          providers: {
            mock: {
              cheap: 'mock-cheap',
              balanced: 'mock-balanced',
              premium: 'mock-premium',
            },
          },
        },
        ['mock'],
      ),
      { build: async () => 'prompt' } as unknown as InvestmentDecisionPromptBuilder,
      5_000,
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-2'),
      request: makeRequest('run-2'),
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('completed');
    expect(artifact.top_picks[0]?.ticker).toBe('005930');
    expect(artifact.summary).toContain('Buy shortlist');
  });

  it('accepts an external response.json artifact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-external-'));
    const run = makeRunRecord(dataDir, 'run-3');
    const request = makeRequest('run-3');
    setTimeout(() => {
      writeFileSync(
        run.response_path!,
        JSON.stringify(
          {
            status: 'completed',
            summary: 'External response ready',
            market_view: 'Neutral',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
          },
          null,
          2,
        ),
        'utf8',
      );
    }, 50);

    const artifact = await new ExternalArtifactDecisionRunner(2_000, 50).run({
      run,
      request,
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('completed');
    expect(artifact.summary).toContain('External response');
  });

  it('processes pending external_artifact runs through a separate worker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-worker-'));
    const store = new InvestmentDecisionStore(join(dataDir, 'investment-decisions', 'runs'));
    const formatter = new InvestmentReportFormatter();
    const request = makeRequest('run-4');
    const created = await store.createRun({
      runId: 'run-4',
      mode: 'manual',
      runner: 'external_artifact',
      request,
      requestMarkdown: formatter.renderRequestMarkdown(request),
    });
    await store.markRunning(created.run_id);

    const worker = new ExternalInvestmentDecisionWorker(
      store,
      {
        async run() {
          return {
            run_id: 'run-4',
            status: 'completed',
            generated_at: new Date().toISOString(),
            summary: 'Worker-completed shortlist',
            market_view: 'Constructive',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
            schema_version: 1,
          };
        },
      },
      formatter,
    );

    const summary = await worker.processPending();
    const run = await store.getRun('run-4');
    const artifact = await store.getArtifact('run-4');
    const report = await store.getReportMarkdown('run-4');

    expect(summary.completed).toBe(1);
    expect(run?.status).toBe('completed');
    expect(artifact?.summary).toContain('Worker-completed shortlist');
    expect(report).toContain('Worker-completed shortlist');
  });

  it('exposes the investment decision routes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-routes-'));
    const equityMapStore = new EquityMapStore(join(dataDir, 'investment-module', 'equity-map.json'));
    await equityMapStore.ensureExists();
    const equityMapService = new InvestmentEquityMapService(equityMapStore);

    const service = new InvestmentDecisionService(
      new InvestmentDecisionStore(join(dataDir, 'investment-decisions', 'runs')),
      new InvestmentSignalAssembler(
        {
          async getEmergingCandidates() {
            return [];
          },
          async getSourcesStatus() {
            return {};
          },
        } as unknown as CandidateService,
        new InvestmentContextProvider(new InvestmentMarkdownStore(dataDir)),
        new InvestableUniverseResolver(
          equityMapStore,
          new InvestmentContextProvider(new InvestmentMarkdownStore(dataDir)),
        ),
      ),
      new ProviderExecDecisionRunner(
        (() => {
          const registry = new ProviderRegistry();
          registry.register({
            name: 'mock',
            defaultTransportMode: 'cli_exec',
            async execute() {
              return {
                text: JSON.stringify({
                  status: 'completed',
                  summary: 'Route-created shortlist',
                  market_view: 'Neutral',
                  top_picks: [],
                  watch_candidates: [],
                  rejected_candidates: [],
                  coverage_gaps: [],
                  risks: [],
                  degraded: false,
                  degraded_reason: null,
                }),
                sessionId: 'provider-session',
                durationMs: 100,
                status: 'completed' as const,
              };
            },
            async health() {
              return true;
            },
            async probeHealth() {
              return { available: true, ready_for_execution: true, status: 'healthy' as const };
            },
          });
          return registry;
        })(),
        new SessionStore(dataDir),
        new ExecutionPolicyResolver(
          {
            defaults: {
              triage: { providers: ['mock'], modelProfile: 'cheap', responseFormat: 'json' },
              debate: { providers: ['mock'], modelProfile: 'cheap', responseFormat: 'json' },
              verdict: { providers: ['mock'], modelProfile: 'premium', responseFormat: 'json' },
              report: { providers: ['mock'], modelProfile: 'balanced', responseFormat: 'json' },
              investment_decision: {
                providers: ['mock'],
                modelProfile: 'premium',
                responseFormat: 'json',
              },
            },
            agents: {},
          },
          {
            providers: {
              mock: {
                cheap: 'mock-cheap',
                balanced: 'mock-balanced',
                premium: 'mock-premium',
              },
            },
          },
          ['mock'],
        ),
        { build: async () => 'prompt' } as unknown as InvestmentDecisionPromptBuilder,
        5_000,
      ),
      new InvestmentReportFormatter(),
      'provider_exec',
    );

    const app = express();
    app.use(express.json());
    app.use(
      createRoutes(
        {
          getReports: () => [],
          listHighLevelRuns: () => [],
          getHighLevelRun: () => null,
          getRunResearch: () => null,
          getRunVerdict: () => null,
          getProviderExecutions: () => [],
          listResearchRequests: () => [],
        } as never,
        new SessionStore(dataDir),
        new ProviderRegistry(),
        undefined,
        undefined,
        service,
        equityMapService,
      ),
    );
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine test server address');
    }

    const createResponse = await fetch(`http://127.0.0.1:${address.port}/investment/decisions/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        watchlist: ['005930'],
        mode: 'manual',
        detail: 'summary',
        as_of_date: '2026-03-29',
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { run: { run_id: string } };

    const reportResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/decisions/runs/${encodeURIComponent(created.run.run_id)}/report?detail=summary`,
    );
    expect(reportResponse.status).toBe(200);

    const latestResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/decisions/latest?detail=summary`,
    );
    expect(latestResponse.status).toBe(200);

    const putMapResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/equity-map`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          equities: [
            {
              asset_key: 'stock:MSFT',
              ticker: 'MSFT',
              company_name: 'Microsoft',
              aliases: ['microsoft'],
            },
          ],
        }),
      },
    );
    expect(putMapResponse.status).toBe(200);

    const getMapResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/equity-map`,
    );
    expect(getMapResponse.status).toBe(200);
    const mapPayload = (await getMapResponse.json()) as { equities: Array<{ ticker: string }> };
    expect(mapPayload.equities[0]?.ticker).toBe('MSFT');
  });
});
