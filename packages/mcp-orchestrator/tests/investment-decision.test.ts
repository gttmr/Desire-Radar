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
import { EquityIdentityResolver } from '../src/investment/equity-identity.js';
import { EquityIdentityCacheStore } from '../src/investment/identity-cache.js';
import { EquityMapStore } from '../src/investment/equity-map.js';
import { InvestmentEquityIdentityService } from '../src/investment/equity-identity-service.js';
import { InvestmentEquityMapService } from '../src/investment/equity-map-service.js';
import { InvestmentDecisionService } from '../src/investment/decision-service.js';
import { ExternalInvestmentDecisionWorker } from '../src/investment/external-worker.js';
import { KisInstrumentLookupClient } from '../src/investment/kis-client.js';
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

function makePromptBuilderStub() {
  return {
    async buildPreparation() {
      return 'prepare-prompt';
    },
    async buildDecision() {
      return 'decision-prompt';
    },
    buildPreparedBriefingFallback(request: ReturnType<typeof makeRequest>) {
      return {
        executive_summary: `fallback briefing for ${request.run_id}`,
        market_context: 'fallback market context',
        watchlist_focus: request.watchlist,
        resolved_equity_briefs: request.resolved_equities.map((item) => ({
          asset_key: item.asset_key,
          ticker: item.ticker,
          company_name: item.company_name,
          priority: 'high' as const,
          why_in_scope: item.why_in_scope,
          key_signals: [],
          key_risks: [],
          linked_clusters: item.linked_clusters,
          linked_notes: item.linked_notes,
          watchlist_member: item.watchlist_member,
        })),
        cluster_briefs: [],
        note_briefs: [],
        source_health_flags: [],
        coverage_gaps: request.coverage_gaps,
      };
    },
    renderPreparedBriefingMarkdown() {
      return '# prepared briefing';
    },
  } as unknown as InvestmentDecisionPromptBuilder;
}

function makeIdentityResolver(dataDir: string, equityMapPath: string): EquityIdentityResolver {
  return new EquityIdentityResolver(
    new EquityMapStore(equityMapPath),
    new EquityIdentityCacheStore(join(dataDir, 'investment-module', 'identity-cache.json')),
    new KisInstrumentLookupClient({
      baseUrl: 'https://example.test',
    }),
  );
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
      makeIdentityResolver(dataDir, equityMapPath),
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

  it('bootstraps a starter equity map when the file is missing or empty', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-equity-map-'));
    const equityMapPath = join(dataDir, 'investment-module', 'equity-map.json');
    const store = new EquityMapStore(equityMapPath);

    await store.ensureExists();
    let entries = await store.list();
    expect(entries.find((entry) => entry.ticker === '005930')?.company_name).toBe('삼성전자');
    expect(entries.find((entry) => entry.ticker === 'MSFT')?.aliases).toContain('Xbox');

    writeFileSync(
      equityMapPath,
      JSON.stringify({ version: 1, equities: [] }, null, 2),
      'utf8',
    );
    await store.ensureExists();
    entries = await store.list();

    expect(entries.find((entry) => entry.ticker === 'SONY')?.aliases).toContain('PlayStation 5');
    expect(entries.find((entry) => entry.ticker === 'GOOGL')?.aliases).toContain('YouTube');
  });

  it('normalizes exact ticker and company-name inputs through the identity resolver', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-identity-'));
    const equityMapPath = join(dataDir, 'investment-module', 'equity-map.json');
    const equityMapStore = new EquityMapStore(equityMapPath);
    await equityMapStore.ensureExists();
    const resolver = makeIdentityResolver(dataDir, equityMapPath);

    const us = await resolver.normalize('TSLA');
    const kr = await resolver.normalize('삼성전자');

    expect(us).toMatchObject({
      resolved: true,
      ticker: 'TSLA',
      company_name: 'Tesla',
      normalization_source: 'equity_map',
    });
    expect(kr).toMatchObject({
      resolved: true,
      ticker: '005930',
      company_name: '삼성전자',
      normalization_source: 'equity_map',
    });
  });

  it('renders compact request markdown without embedding the full request json', () => {
    const formatter = new InvestmentReportFormatter();
    const markdown = formatter.renderRequestMarkdown({
      ...makeRequest('run-compact'),
      supporting_evidence_refs: ['ev-1', 'ev-2', 'ev-3'],
      coverage_gaps: [
        {
          label: 'OpenAI',
          reason: 'No exact equity mapping found',
          linked_cluster_id: 'entity:openai',
          linked_note_ids: [],
        },
      ],
    });

    expect(markdown).toContain('supporting_evidence_ref_count: 3');
    expect(markdown).toContain('coverage_gap_count: 1');
    expect(markdown).not.toContain('## Request JSON');
    expect(markdown).not.toContain('"supporting_evidence_refs"');
  });

  it('renders summary reports with only operator sections and short reasons', () => {
    const formatter = new InvestmentReportFormatter();
    const markdown = formatter.formatReport(
      makeRequest('run-summary'),
      {
        run_id: 'run-summary',
        status: 'completed',
        generated_at: '2026-03-29T00:00:00.000Z',
        summary: 'Long summary that should not be the only operator output',
        report_summary: '오늘은 대형 기술주 중 실적 가시성이 높은 종목만 추려서 봅니다.',
        operator_highlights: ['성장주 전반이 아니라 광고/콘텐츠 실적 가시성 중심입니다.'],
        market_view: 'Neutral',
        top_picks: [
          {
            asset_key: 'stock:NASDAQ:TSLA',
            ticker: 'TSLA',
            company_name: 'Tesla',
            recommendation: 'watch',
            confidence: 0.65,
            why_now: 'verbose why now',
            short_reason: '실적 모멘텀보다 변동성 관리가 더 중요합니다.',
            report_priority: 'high',
            thesis: 'thesis',
            beneficiary_path: 'beneficiary',
            linked_clusters: ['cluster-1'],
            linked_evidence_refs: ['ev-1'],
            risks: ['risk'],
            missing_information: ['info'],
          },
        ],
        watch_candidates: [],
        rejected_candidates: [
          {
            asset_key: 'stock:NASDAQ:AMZN',
            ticker: 'AMZN',
            company_name: 'Amazon',
            recommendation: 'pass',
            confidence: 0.55,
            why_now: 'why',
            short_reason: 'reason',
            report_priority: 'low',
            thesis: 'thesis',
            beneficiary_path: 'beneficiary',
            linked_clusters: [],
            linked_evidence_refs: [],
            risks: [],
            missing_information: [],
          },
        ],
        coverage_gaps: [
          {
            label: 'OpenAI',
            reason: 'No exact equity mapping found',
            linked_cluster_id: 'cluster-openai',
            linked_note_ids: [],
          },
        ],
        risks: ['macro'],
        degraded: false,
        degraded_reason: null,
        schema_version: 1,
      },
      'summary',
    );

    expect(markdown).toContain('## 오늘의 판단 요약');
    expect(markdown).toContain('## 우선 검토 종목');
    expect(markdown).toContain('## 관찰 종목');
    expect(markdown).toContain('실적 모멘텀보다 변동성 관리가 더 중요합니다.');
    expect(markdown).not.toContain('## Rejected Candidates');
    expect(markdown).not.toContain('## Coverage Gaps');
    expect(markdown).not.toContain('## Source Health');
  });

  it('reconciles stale running decision runs into failed status', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'investment-stale-runs-'));
    const store = new InvestmentDecisionStore(runRoot);
    const request = makeRequest('run-stale');
    const run = await store.createRun({
      runId: 'run-stale',
      mode: request.mode,
      runner: 'provider_exec',
      request,
      requestMarkdown: '# request',
    });
    const running = await store.markRunning('run-stale');
    const staleRun = {
      ...running,
      updated_at: '2026-03-29T00:00:00.000Z',
    };
    writeFileSync(
      join(runRoot, '..', 'index.json'),
      JSON.stringify(
        {
          version: 1,
          latest_run_id: staleRun.run_id,
          runs: {
            [staleRun.run_id]: staleRun,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(staleRun.status_path, JSON.stringify(staleRun, null, 2), 'utf8');
    await store.reconcileTimedOutRuns({
      maxAgeMs: 1,
      reason: 'investment decision run exceeded timeout budget (60000ms)',
    });

    const updated = await store.getRun('run-stale');
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toContain('exceeded timeout budget');
    expect(updated?.active_stage).toBeNull();
    expect(updated?.final_status).toBe('failed');
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: false,
        providers: [],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: [],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
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

  it('extracts JSON when the provider wraps it with prose', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-provider-wrapped-'));
    const registry = new ProviderRegistry();
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute() {
        return {
          text: [
            'Here is the final decision artifact.',
            '```json',
            JSON.stringify({
              summary: 'Wrapped shortlist ready',
              market_view: 'Neutral',
              top_picks: [],
              watch_candidates: [],
              rejected_candidates: [],
              coverage_gaps: [],
              risks: [],
              degraded: false,
              degraded_reason: null,
            }),
            '```',
          ].join('\n'),
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: false,
        providers: [],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: [],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-wrap'),
      request: makeRequest('run-wrap'),
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('completed');
    expect(artifact.summary).toContain('Wrapped shortlist');
    const attemptPath = join(
      dataDir,
      '2026-03-29',
      'run-wrap',
      'provider-attempts',
      'decision-mock-initial.json',
    );
    const attempt = JSON.parse(readFileSync(attemptPath, 'utf8')) as { parse_error: string | null };
    expect(attempt.parse_error).toBeNull();
  });

  it('retries once when the initial provider response is invalid JSON', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-provider-retry-'));
    const registry = new ProviderRegistry();
    let attempt = 0;
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute() {
        attempt += 1;
        if (attempt === 1) {
          return {
            text: '{"summary":"partial"',
            sessionId: 'provider-session',
            durationMs: 120,
            status: 'completed' as const,
          };
        }
        return {
          text: JSON.stringify({
            summary: 'Recovered shortlist',
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: false,
        providers: [],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: [],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-retry'),
      request: makeRequest('run-retry'),
      requestMarkdown: '# request',
    });

    expect(attempt).toBe(2);
    expect(artifact.summary).toContain('Recovered shortlist');
    expect(artifact.degraded).toBe(true);
    const initialAttemptPath = join(
      dataDir,
      '2026-03-29',
      'run-retry',
      'provider-attempts',
      'decision-mock-initial.json',
    );
    const repairAttemptPath = join(
      dataDir,
      '2026-03-29',
      'run-retry',
      'provider-attempts',
      'decision-mock-repair.json',
    );
    const initialAttempt = JSON.parse(readFileSync(initialAttemptPath, 'utf8')) as { parse_error: string | null };
    const repairAttempt = JSON.parse(readFileSync(repairAttemptPath, 'utf8')) as { parse_error: string | null };
    expect(initialAttempt.parse_error).toContain('raw={\"summary\":\"partial\"');
    expect(repairAttempt.parse_error).toBeNull();
  });

  it('runs a preprocessing step before the final decision and writes prepared artifacts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-preprocess-'));
    const registry = new ProviderRegistry();
    const seenCalls: Array<{ agentName: string; toolPolicy: string | undefined }> = [];
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute(request) {
        seenCalls.push({ agentName: request.agentName, toolPolicy: request.toolPolicy });
        if (request.agentName === 'investment_decision_prepare') {
          return {
            text: JSON.stringify({
              executive_summary: 'prepared summary',
              market_context: 'prepared context',
              watchlist_focus: ['005930'],
              resolved_equity_briefs: [
                {
                  asset_key: 'stock:005930',
                  ticker: '005930',
                  company_name: '삼성전자',
                  priority: 'high',
                  why_in_scope: 'watchlist member',
                  key_signals: ['HBM demand'],
                  key_risks: ['macro'],
                  linked_clusters: [],
                  linked_notes: [],
                  watchlist_member: true,
                },
              ],
              cluster_briefs: [],
              note_briefs: [],
              source_health_flags: [],
              coverage_gaps: [],
            }),
            sessionId: `provider-session-${request.agentName}`,
            durationMs: 50,
            status: 'completed' as const,
          };
        }
        return {
          text: JSON.stringify({
            summary: 'Final shortlist',
            market_view: 'Constructive',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
          }),
          sessionId: `provider-session-${request.agentName}`,
          durationMs: 60,
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
          agents: {
            investment_decision_prepare: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'cheap',
              responseFormat: 'json',
            },
            investment_decision: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: true,
        providers: ['mock'],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: ['mock'],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-prepare'),
      request: makeRequest('run-prepare'),
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('completed');
    expect(seenCalls).toEqual([
      { agentName: 'investment_decision_prepare', toolPolicy: 'none' },
      { agentName: 'investment_decision', toolPolicy: 'default' },
    ]);
    const prepared = JSON.parse(
      readFileSync(
        join(dataDir, '2026-03-29', 'run-prepare', 'prepared_request.json'),
        'utf8',
      ),
    ) as { executive_summary: string };
    expect(prepared.executive_summary).toBe('prepared summary');
  });

  it('accepts tagged JSON from the preprocessing model even when prose appears before it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-preprocess-tagged-'));
    const registry = new ProviderRegistry();
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute(request) {
        if (request.agentName === 'investment_decision_prepare') {
          return {
            text: [
              'I compressed the request while preserving the source health flags.',
              '<structured_json>',
              JSON.stringify({
                executive_summary: 'prepared summary',
                market_context: 'prepared context',
                watchlist_focus: ['005930'],
                resolved_equity_briefs: [
                  {
                    asset_key: 'stock:005930',
                    ticker: '005930',
                    company_name: '삼성전자',
                    priority: 'high',
                    why_in_scope: 'watchlist member',
                    key_signals: ['HBM demand'],
                    key_risks: ['macro'],
                    linked_clusters: [],
                    linked_notes: [],
                    watchlist_member: true,
                  },
                ],
                cluster_briefs: [],
                note_briefs: [],
                source_health_flags: ['reddit_mentions | readiness=missing_credentials'],
                coverage_gaps: [],
              }),
              '</structured_json>',
            ].join('\n'),
            sessionId: 'provider-session-prepare',
            durationMs: 50,
            status: 'completed' as const,
          };
        }
        return {
          text: JSON.stringify({
            summary: 'Final shortlist',
            market_view: 'Constructive',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
          }),
          sessionId: 'provider-session-final',
          durationMs: 60,
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
          agents: {
            investment_decision_prepare: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'cheap',
              responseFormat: 'json',
            },
            investment_decision: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: true,
        providers: ['mock'],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: ['mock'],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-prepare-tagged'),
      request: makeRequest('run-prepare-tagged'),
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('completed');
    const initialAttempt = JSON.parse(
      readFileSync(
        join(
          dataDir,
          '2026-03-29',
          'run-prepare-tagged',
          'provider-attempts',
          'prepare-mock-initial.json',
        ),
        'utf8',
      ),
    ) as { parse_strategy: string | null; parse_error: string | null };
    expect(initialAttempt.parse_strategy).toBe('tagged');
    expect(initialAttempt.parse_error).toBeNull();
  });

  it('retries the preprocessing stage when the first provider stream is empty and then parses tagged JSON', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-preprocess-retry-'));
    const registry = new ProviderRegistry();
    let prepareCalls = 0;
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute(request) {
        if (request.agentName === 'investment_decision_prepare') {
          prepareCalls += 1;
          if (prepareCalls === 1) {
            return {
              text: '',
              sessionId: 'provider-session-empty',
              durationMs: 25,
              status: 'degraded' as const,
              degraded_message: 'provider returned an empty response',
            };
          }
          return {
            text: [
              '<structured_json>',
              JSON.stringify({
                executive_summary: 'prepared summary',
                market_context: 'prepared context',
                watchlist_focus: ['005930'],
                resolved_equity_briefs: [],
                cluster_briefs: [],
                note_briefs: [],
                source_health_flags: [],
                coverage_gaps: [],
              }),
              '</structured_json>',
            ].join('\n'),
            sessionId: 'provider-session-prepare',
            durationMs: 40,
            status: 'completed' as const,
          };
        }
        return {
          text: JSON.stringify({
            summary: 'Final shortlist',
            market_view: 'Constructive',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
          }),
          sessionId: 'provider-session-final',
          durationMs: 60,
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
          agents: {
            investment_decision_prepare: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'cheap',
              responseFormat: 'json',
            },
            investment_decision: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: true,
        providers: ['mock'],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: ['mock'],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-prepare-retry'),
      request: makeRequest('run-prepare-retry'),
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('completed');
    expect(prepareCalls).toBe(2);
    const initialAttempt = JSON.parse(
      readFileSync(
        join(
          dataDir,
          '2026-03-29',
          'run-prepare-retry',
          'provider-attempts',
          'prepare-mock-initial.json',
        ),
        'utf8',
      ),
    ) as {
      parse_error: string | null;
      transport_outcome: string;
      structured_outcome: string | null;
      retry_count: number;
      used_fallback_provider: boolean;
    };
    const retryAttempt = JSON.parse(
      readFileSync(
        join(
          dataDir,
          '2026-03-29',
          'run-prepare-retry',
          'provider-attempts',
          'prepare-mock-retry.json',
        ),
        'utf8',
      ),
    ) as {
      parse_strategy: string | null;
      transport_outcome: string;
      structured_outcome: string | null;
      retry_count: number;
      used_fallback_provider: boolean;
    };
    expect(initialAttempt.parse_error).toBe('Provider returned an empty response');
    expect(initialAttempt.transport_outcome).toBe('empty_stream');
    expect(initialAttempt.structured_outcome).toBeNull();
    expect(initialAttempt.retry_count).toBe(0);
    expect(initialAttempt.used_fallback_provider).toBe(false);
    expect(retryAttempt.parse_strategy).toBe('tagged');
    expect(retryAttempt.transport_outcome).toBe('text_stream');
    expect(retryAttempt.structured_outcome).toBe('tagged_json');
    expect(retryAttempt.retry_count).toBe(1);
    expect(retryAttempt.used_fallback_provider).toBe(false);
  });

  it('records when a fallback preprocess provider produced the final briefing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-preprocess-fallback-provider-'));
    const registry = new ProviderRegistry();
    const statusPatches: Array<Record<string, string | null | undefined>> = [];
    let emptyProviderCalls = 0;
    registry.register({
      name: 'mock-empty',
      defaultTransportMode: 'cli_exec',
      async execute() {
        emptyProviderCalls += 1;
        return {
          text: '',
          sessionId: 'provider-session-empty',
          durationMs: 20,
          status: 'degraded' as const,
          degraded_message: 'provider returned an empty response',
        };
      },
      async health() {
        return true;
      },
      async probeHealth() {
        return { available: true, ready_for_execution: true, status: 'healthy' as const };
      },
    });
    registry.register({
      name: 'mock-fallback',
      defaultTransportMode: 'cli_exec',
      async execute(request) {
        if (request.agentName === 'investment_decision_prepare') {
          return {
            text: [
              '<structured_json>',
              JSON.stringify({
                executive_summary: 'prepared summary',
                market_context: 'prepared context',
                watchlist_focus: ['005930'],
                resolved_equity_briefs: [],
                cluster_briefs: [],
                note_briefs: [],
                source_health_flags: [],
                coverage_gaps: [],
              }),
              '</structured_json>',
            ].join('\n'),
            sessionId: 'provider-session-prepare',
            durationMs: 40,
            status: 'completed' as const,
          };
        }
        return {
          text: JSON.stringify({
            summary: 'Final shortlist',
            market_view: 'Constructive',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
          }),
          sessionId: 'provider-session-final',
          durationMs: 60,
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
            triage: { providers: ['mock-fallback'], modelProfile: 'cheap', responseFormat: 'json' },
            debate: { providers: ['mock-fallback'], modelProfile: 'cheap', responseFormat: 'json' },
            verdict: { providers: ['mock-fallback'], modelProfile: 'premium', responseFormat: 'json' },
            report: { providers: ['mock-fallback'], modelProfile: 'balanced', responseFormat: 'json' },
            investment_decision: {
              providers: ['mock-fallback'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
          agents: {
            investment_decision_prepare: {
              phase: 'investment_decision',
              providers: ['mock-empty', 'mock-fallback'],
              modelProfile: 'cheap',
              responseFormat: 'json',
            },
            investment_decision: {
              phase: 'investment_decision',
              providers: ['mock-fallback'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
        },
        {
          providers: {
            'mock-empty': {
              cheap: 'mock-empty-cheap',
              balanced: 'mock-empty-balanced',
              premium: 'mock-empty-premium',
            },
            'mock-fallback': {
              cheap: 'mock-fallback-cheap',
              balanced: 'mock-fallback-balanced',
              premium: 'mock-fallback-premium',
            },
          },
        },
        ['mock-empty', 'mock-fallback'],
      ),
      makePromptBuilderStub(),
      5_000,
      {
        enabled: true,
        providers: ['mock-empty', 'mock-fallback'],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: ['mock-fallback'],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-preprocess-fallback-provider'),
      request: makeRequest('run-preprocess-fallback-provider'),
      requestMarkdown: '# request',
      updateStatus: async (patch) => {
        statusPatches.push({
          active_stage: patch.active_stage ?? null,
          active_provider: patch.active_provider ?? null,
          prepare_status: patch.prepare_status ?? null,
          final_status: patch.final_status ?? null,
        });
      },
    });

    expect(artifact.status).toBe('completed');
    expect(emptyProviderCalls).toBe(2);
    const emptyRetryAttempt = JSON.parse(
      readFileSync(
        join(
          dataDir,
          '2026-03-29',
          'run-preprocess-fallback-provider',
          'provider-attempts',
          'prepare-mock-empty-retry.json',
        ),
        'utf8',
      ),
    ) as { transport_outcome: string; structured_outcome: string | null; retry_count: number };
    expect(emptyRetryAttempt.transport_outcome).toBe('empty_stream');
    expect(emptyRetryAttempt.structured_outcome).toBeNull();
    expect(emptyRetryAttempt.retry_count).toBe(1);
    const fallbackAttempt = JSON.parse(
      readFileSync(
        join(
          dataDir,
          '2026-03-29',
          'run-preprocess-fallback-provider',
          'provider-attempts',
          'prepare-mock-fallback-initial.json',
        ),
        'utf8',
      ),
    ) as { used_fallback_provider: boolean; structured_outcome: string };
    expect(fallbackAttempt.used_fallback_provider).toBe(true);
    expect(fallbackAttempt.structured_outcome).toBe('tagged_json');
    expect(statusPatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          active_stage: 'prepare',
          prepare_status: 'running',
        }),
        expect.objectContaining({
          active_stage: 'prepare',
          active_provider: 'mock-empty',
        }),
        expect.objectContaining({
          active_stage: 'prepare',
          active_provider: 'mock-fallback',
        }),
        expect.objectContaining({
          prepare_status: 'completed',
        }),
        expect.objectContaining({
          active_stage: 'final',
          final_status: 'running',
        }),
      ]),
    );
  });

  it('falls back to a deterministic prepared briefing when preprocessing fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'investment-preprocess-fallback-'));
    const registry = new ProviderRegistry();
    registry.register({
      name: 'mock',
      defaultTransportMode: 'cli_exec',
      async execute(request) {
        if (request.agentName === 'investment_decision_prepare') {
          throw new Error('preprocess exploded');
        }
        return {
          text: JSON.stringify({
            summary: 'Final shortlist after fallback',
            market_view: 'Neutral',
            top_picks: [],
            watch_candidates: [],
            rejected_candidates: [],
            coverage_gaps: [],
            risks: [],
            degraded: false,
            degraded_reason: null,
          }),
          sessionId: 'provider-session-final',
          durationMs: 90,
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
          agents: {
            investment_decision_prepare: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'cheap',
              responseFormat: 'json',
            },
            investment_decision: {
              phase: 'investment_decision',
              providers: ['mock'],
              modelProfile: 'premium',
              responseFormat: 'json',
            },
          },
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
      makePromptBuilderStub(),
      5_000,
      {
        enabled: true,
        providers: ['mock'],
        modelProfile: 'cheap',
        toolPolicy: 'none',
        timeoutMs: 1_000,
      },
      {
        providers: ['mock'],
        modelProfile: 'premium',
        toolPolicy: 'default',
        timeoutMs: 5_000,
      },
    );

    const artifact = await runner.run({
      run: makeRunRecord(dataDir, 'run-fallback'),
      request: makeRequest('run-fallback'),
      requestMarkdown: '# request',
    });

    expect(artifact.status).toBe('degraded');
    expect(artifact.degraded).toBe(true);
    expect(artifact.degraded_reason).toContain('Preprocessing failed');
    const meta = JSON.parse(
      readFileSync(
        join(dataDir, '2026-03-29', 'run-fallback', 'prepared_request.meta.json'),
        'utf8',
      ),
    ) as { source: string; warning: string | null };
    expect(meta.source).toBe('fallback_error');
    expect(meta.warning).toContain('preprocess exploded');
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
    const identityService = new InvestmentEquityIdentityService(
      makeIdentityResolver(dataDir, equityMapStore.path),
    );

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
          makeIdentityResolver(dataDir, equityMapStore.path),
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
        makePromptBuilderStub(),
        5_000,
        {
          enabled: false,
          providers: [],
          modelProfile: 'cheap',
          toolPolicy: 'none',
          timeoutMs: 1_000,
        },
        {
          providers: [],
          modelProfile: 'premium',
          toolPolicy: 'default',
          timeoutMs: 5_000,
        },
      ),
      new InvestmentReportFormatter(),
      'provider_exec',
      5_000,
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
        identityService,
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

    const normalizeResponse = await fetch(
      `http://127.0.0.1:${address.port}/investment/normalize-equity`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'MSFT' }),
      },
    );
    expect(normalizeResponse.status).toBe(200);
    const normalized = (await normalizeResponse.json()) as {
      identity: { resolved: boolean; ticker: string; company_name: string };
    };
    expect(normalized.identity).toMatchObject({
      resolved: true,
      ticker: 'MSFT',
      company_name: 'Microsoft',
    });
  });
});
