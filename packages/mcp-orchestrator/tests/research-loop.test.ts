import { describe, expect, it, vi } from 'vitest';
import type { EvidenceBundle } from '@agentic/shared-types';
import { RunContextStore } from '../src/orchestrator/run-context-store.js';
import { ResearchLoopService } from '../src/pipeline/research-loop.js';
import type { DebatePhaseResult } from '../src/pipeline/types.js';
import type { CollectorSourceStatus } from '../src/collector/client.js';

function makeBundle(): EvidenceBundle {
  return {
    bundle_id: 'bundle-1',
    entity: 'Cursor',
    time_window: { start: '2026-03-25T00:00:00Z', end: '2026-03-25T01:00:00Z' },
    evidence_items: [
      {
        evidence_id: 'ev-1',
        source: 'google_trends',
        source_tier: 2,
        collected_at: '2026-03-25T00:30:00Z',
        entity_candidates: ['Cursor'],
        signal_type: 'search_trend',
        title_or_label: 'Cursor search volume rose',
        metric_value: 10,
        metric_delta: 5,
        rank: null,
        geo: 'global',
        url_or_ref: '',
        raw_snapshot_ref: 'snap-1',
        trust_score: 0.8,
        tos_risk: 'none',
        freshness_ttl: 3600,
      },
    ],
    cross_source_summary: 'Cursor is rising across search data.',
    recommended_agents: ['search_intent'],
    quality_flags: [],
  };
}

function makeDebate(openQuestion: string): DebatePhaseResult {
  return {
    status: 'completed',
    roundsExecuted: 1,
    turns: [
      {
        run_id: 'run-1',
        agent_name: 'search_intent',
        provider: 'mock',
        session_id: 'session-1',
        turn_index: 0,
        prompt_summary: 'summary',
        response: {
          summary: 'Need more evidence',
          confidence: 0.5,
          claims: [],
          evidence_used: [],
          open_questions: [openQuestion],
          messages_for_other_agents: [],
          recommended_next_step: 'research',
        },
        citations: [],
        evidence_refs: [],
        created_at: '2026-03-25T00:40:00Z',
      },
    ],
  };
}

function makeSource(partial: Partial<CollectorSourceStatus>): CollectorSourceStatus {
  return {
    scheduled: true,
    last_run: '2026-03-25T00:20:00Z',
    cadence_seconds: 300,
    source_tier: 2,
    ...partial,
  };
}

describe('ResearchLoopService', () => {
  it('prefers runnable collector sources and reruns debate on completed submissions', async () => {
    const contextStore = new RunContextStore();
    contextStore.setBundle('run-1', makeBundle());

    const submitRequest = vi.fn(async (request) => ({
      request,
      submissionId: 'sub-1',
      status: 'running' as const,
      evidenceIds: [],
    }));
    const awaitCompletion = vi.fn(async (result) => ({
      ...result,
      status: 'completed' as const,
      evidenceIds: ['ev-new'],
    }));
    const buildBundle = vi.fn(async () => makeBundle());
    const getSourcesCatalog = vi.fn(
      async () =>
        ({
          google_trends: makeSource({
            kind: 'pull',
            ingestion_mode: 'raw',
            enabled: true,
            runnable: true,
          }),
        }) satisfies Record<string, CollectorSourceStatus>,
    );
    const debateRun = vi.fn(async () => makeDebate('rerun'));

    const service = new ResearchLoopService(
      { submitRequest } as never,
      { awaitCompletion } as never,
      { buildBundle, getSourcesCatalog } as never,
      contextStore,
      { run: debateRun } as never,
      {
        directAwait: true,
        pollIntervalMs: 1,
        timeoutMs: 100,
        maxRequestsPerRun: 1,
        openQuestionThreshold: 1,
        defaultRequestKind: 'run_source',
        defaultPriority: 'normal',
      },
      {
        defaultPlan: ['search_intent'],
        maxRounds: 1,
        consensusRequiresQuietRound: true,
        triage: {
          agentName: 'triage',
          minimumEmergenceScore: 0,
          minimumSourceCount: 1,
        },
        verdict: {
          primaryAgent: 'investment_verdict',
          crossCheckAgent: 'synthesis',
          primaryModelProfile: 'premium',
          crossCheckModelProfile: 'balanced',
        },
      },
    );

    const result = await service.run({
      runId: 'run-1',
      entity: 'Cursor',
      latestDebate: makeDebate('Which source should we refresh?'),
      providers: ['mock'],
    });

    expect(submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'demand',
        requestKind: 'run_source',
        targetSourceId: 'google_trends',
        requestedInputKind: 'study_result',
        preferredCapabilities: expect.arrayContaining(['demand']),
        requiredFields: expect.arrayContaining(['entity', 'observed_behavior', 'timeframe']),
      }),
    );
    expect(awaitCompletion).toHaveBeenCalledOnce();
    expect(buildBundle).toHaveBeenCalledWith('Cursor');
    expect(debateRun).toHaveBeenCalledOnce();
    expect(result.reranDebate).toBe(true);
  });

  it('falls back to pending human requests when no runnable source is available', async () => {
    const contextStore = new RunContextStore();
    contextStore.setBundle('run-1', makeBundle());

    const submitRequest = vi.fn(async (request) => ({
      request,
      submissionId: 'sub-human-1',
      status: 'pending_human' as const,
      evidenceIds: [],
    }));

    const service = new ResearchLoopService(
      { submitRequest } as never,
      { awaitCompletion: vi.fn(async (result) => result) } as never,
      {
        buildBundle: vi.fn(async () => makeBundle()),
        getSourcesCatalog: vi.fn(
          async () =>
            ({
              google_trends: makeSource({
                kind: 'pull',
                ingestion_mode: 'raw',
                enabled: true,
                runnable: false,
              }),
            }) satisfies Record<string, CollectorSourceStatus>,
        ),
      } as never,
      contextStore,
      { run: vi.fn() } as never,
      {
        directAwait: true,
        pollIntervalMs: 1,
        timeoutMs: 100,
        maxRequestsPerRun: 1,
        openQuestionThreshold: 1,
        defaultRequestKind: 'run_source',
        defaultPriority: 'high',
      },
      {
        defaultPlan: ['search_intent'],
        maxRounds: 1,
        consensusRequiresQuietRound: true,
        triage: {
          agentName: 'triage',
          minimumEmergenceScore: 0,
          minimumSourceCount: 1,
        },
        verdict: {
          primaryAgent: 'investment_verdict',
          crossCheckAgent: 'synthesis',
          primaryModelProfile: 'premium',
          crossCheckModelProfile: 'balanced',
        },
      },
    );

    const result = await service.run({
      runId: 'run-1',
      entity: 'Cursor',
      latestDebate: makeDebate('We need human channel check datapoints'),
      providers: ['mock'],
    });

    expect(submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKind: 'request_human_note',
        targetSourceId: undefined,
        intent: 'supply',
        requestedInputKind: 'channel_check',
        requiredFields: expect.arrayContaining(['availability_or_inventory', 'timeframe']),
      }),
    );
    expect(result.reranDebate).toBe(false);
    expect(result.results[0]?.status).toBe('pending_human');
  });

  it('prefers sources with matching capabilities and stronger validity', async () => {
    const contextStore = new RunContextStore();
    contextStore.setBundle('run-1', makeBundle());

    const submitRequest = vi.fn(async (request) => ({
      request,
      submissionId: 'sub-1',
      status: 'completed' as const,
      evidenceIds: ['ev-new'],
    }));

    const service = new ResearchLoopService(
      { submitRequest } as never,
      { awaitCompletion: vi.fn(async (result) => result) } as never,
      {
        buildBundle: vi.fn(async () => makeBundle()),
        getSourcesCatalog: vi.fn(
          async () =>
            ({
              google_trends: makeSource({
                kind: 'pull',
                ingestion_mode: 'raw',
                enabled: true,
                runnable: true,
                validity_status: 'noisy',
                validity_score: 0.55,
              }),
              supply_tightness_proxy: makeSource({
                kind: 'derived',
                ingestion_mode: 'evidence',
                enabled: true,
                runnable: true,
                validity_status: 'healthy',
                validity_score: 0.95,
                capabilities: ['supply', 'pricing', 'channel_check'],
              }),
            }) satisfies Record<string, CollectorSourceStatus>,
        ),
      } as never,
      contextStore,
      { run: vi.fn() } as never,
      {
        directAwait: true,
        pollIntervalMs: 1,
        timeoutMs: 100,
        maxRequestsPerRun: 1,
        openQuestionThreshold: 1,
        defaultRequestKind: 'run_source',
        defaultPriority: 'normal',
      },
      {
        defaultPlan: ['search_intent'],
        maxRounds: 1,
        consensusRequiresQuietRound: true,
        triage: {
          agentName: 'triage',
          minimumEmergenceScore: 0,
          minimumSourceCount: 1,
        },
        verdict: {
          primaryAgent: 'investment_verdict',
          crossCheckAgent: 'synthesis',
          primaryModelProfile: 'premium',
          crossCheckModelProfile: 'balanced',
        },
      },
    );

    await service.run({
      runId: 'run-1',
      entity: 'Cursor',
      latestDebate: makeDebate('What does channel check data say about supply tightness?'),
      providers: ['mock'],
    });

    expect(submitRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'supply',
        targetSourceId: 'supply_tightness_proxy',
      }),
    );
  });
});
