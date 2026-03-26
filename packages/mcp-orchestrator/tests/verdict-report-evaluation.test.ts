import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  AgentResponse,
  AgentTurn,
  EvidenceBundle,
} from '@agentic/shared-types';
import type { ProviderAdapter, ProviderExecutionRequest, ProviderResult } from '../src/providers/base.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/session-store.js';
import { RunStore } from '../src/orchestrator/run-store.js';
import { RunContextStore } from '../src/orchestrator/run-context-store.js';
import { PromptLoader } from '../src/prompt/loader.js';
import { PromptComposer } from '../src/prompt/composer.js';
import { AgentExecutor } from '../src/orchestrator/agent-executor.js';
import { ExecutionPolicyResolver } from '../src/policy/execution.js';
import { VerdictService } from '../src/pipeline/verdict.js';
import { ReportService } from '../src/pipeline/report.js';
import {
  buildBeneficiaryMapping,
  summarizeBeneficiaryMapping,
} from '../src/pipeline/beneficiary-mapping.js';
import { DEFAULT_REPLAY_FIXTURE_PATH } from '../src/pipeline/evaluation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const agentsDir = join(__dirname, '..', 'src', 'agents');
const fixturePath = join(__dirname, 'fixtures', 'full-run-replay.json');

function makeResponse(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    summary: 'default',
    confidence: 0.7,
    claims: [],
    evidence_used: ['ev-001'],
    open_questions: [],
    messages_for_other_agents: [],
    recommended_next_step: 'hold',
    ...overrides,
  };
}

class ScenarioProvider implements ProviderAdapter {
  readonly name = 'scenario';

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const text = (() => {
      if (request.prompt.includes('Beneficiary Mapping Agent')) {
        return JSON.stringify(
          makeResponse({
            summary: 'Cursor captures workflow value first, with Microsoft as the best public proxy.',
            confidence: 0.74,
            claims: [
              {
                claim: 'direct_winner: Cursor | rationale: teams are expanding paid seats around code review workflow',
                supporting_evidence: ['ev-001'],
                confidence: 0.83,
              },
              {
                claim: 'public_beneficiary: Microsoft | rationale: GitHub and enterprise distribution can capture adjacent value',
                supporting_evidence: ['ev-001'],
                confidence: 0.72,
              },
              {
                claim: 'second_order_beneficiary: GitHub | rationale: repository workflow and code review volume can rise with adoption',
                supporting_evidence: ['ev-001'],
                confidence: 0.68,
              },
              {
                claim: 'invalidation_point: adoption remains isolated to small teams and does not convert into durable seat growth',
                supporting_evidence: ['ev-001'],
                confidence: 0.63,
              },
            ],
            recommended_next_step: 'watch_closely',
          }),
        );
      }
      if (request.prompt.includes('Investment Verdict Agent')) {
        return JSON.stringify(
          makeResponse({
            summary: 'Signal is actionable but still needs monitoring.',
            confidence: 0.79,
            claims: [
              {
                claim: 'Seat expansion and workflow lock-in indicate real demand.',
                supporting_evidence: ['ev-001'],
                confidence: 0.79,
              },
            ],
            open_questions: ['How quickly does usage convert into enterprise contracts?'],
            recommended_next_step: 'act_now',
          }),
        );
      }
      if (request.prompt.includes('Synthesis Agent')) {
        return JSON.stringify(
          makeResponse({
            summary: 'Cross-check agrees with a cautious but positive stance.',
            confidence: 0.66,
            claims: [
              {
                claim: 'Evidence is multi-source but monetization still needs confirmation.',
                supporting_evidence: ['ev-001'],
                confidence: 0.66,
              },
            ],
            open_questions: ['What is the strongest public proxy?'],
            recommended_next_step: 'watch_closely',
          }),
        );
      }
      if (request.prompt.includes('Report Agent')) {
        return JSON.stringify(
          makeResponse({
            summary: 'Executive Summary: Cursor demand is rising. Key Signals: workflow adoption is growing. Beneficiary Mapping: Cursor direct, Microsoft public proxy.',
            confidence: 0.71,
            claims: [],
            recommended_next_step: 'publish_report',
          }),
        );
      }
      return JSON.stringify(makeResponse({ summary: 'fallback' }));
    })();

    return {
      text,
      sessionId: request.sessionId ?? randomUUID(),
      durationMs: 25,
      model: request.model,
      status: 'completed',
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}

class DegradedVerdictScenarioProvider extends ScenarioProvider {
  override async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    if (request.prompt.includes('Investment Verdict Agent')) {
      return {
        text: '',
        sessionId: request.sessionId ?? randomUUID(),
        durationMs: 25,
        model: request.model,
        status: 'degraded',
        degraded_kind: 'rate_limited',
        degraded_message: 'provider temporarily rate limited',
        recoverable: true,
      };
    }
    return super.execute(request);
  }
}

function makeBundle(): EvidenceBundle {
  return {
    bundle_id: 'bundle-001',
    entity: 'Cursor',
    time_window: { start: '2026-03-25', end: '2026-03-26' },
    evidence_items: [
      {
        evidence_id: 'ev-001',
        source: 'google_trends',
        source_tier: 1,
        collected_at: '2026-03-26T00:00:00Z',
        entity_candidates: ['Cursor'],
        signal_type: 'search_trend',
        title_or_label: 'Cursor search volume spike',
        metric_value: 93,
        metric_delta: 35,
        rank: null,
        geo: 'global',
        url_or_ref: 'https://trends.google.com',
        raw_snapshot_ref: 'snap-001',
        trust_score: 0.92,
        tos_risk: 'none',
        freshness_ttl: 3600,
      },
    ],
    cross_source_summary: 'Demand is expanding across developer workflow chatter and search.',
    recommended_agents: ['search_intent', 'theme_mapper'],
    quality_flags: [],
  };
}

describe('beneficiary mapping / verdict / report / evaluation', () => {
  let runStore: RunStore;
  let contextStore: RunContextStore;
  let verdictService: VerdictService;
  let reportService: ReportService;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orchestrator-beneficiary-'));
    const registry = new ProviderRegistry();
    registry.register(new ScenarioProvider());
    const sessionStore = new SessionStore(dataDir);
    runStore = new RunStore(dataDir);
    contextStore = new RunContextStore();
    const promptLoader = new PromptLoader(agentsDir);
    const promptComposer = new PromptComposer(promptLoader);
    const policyResolver = new ExecutionPolicyResolver(
      {
        defaults: {
          triage: { providers: ['scenario'], modelProfile: 'cheap', responseFormat: 'json' },
          debate: { providers: ['scenario'], modelProfile: 'cheap', responseFormat: 'json' },
          verdict: { providers: ['scenario'], modelProfile: 'premium', responseFormat: 'json' },
          report: { providers: ['scenario'], modelProfile: 'balanced', responseFormat: 'json' },
        },
        agents: {},
      },
      {
        providers: {
          scenario: {
            cheap: 'scenario-cheap',
            balanced: 'scenario-balanced',
            premium: 'scenario-premium',
          },
        },
      },
      ['scenario'],
    );
    const agentExecutor = new AgentExecutor(
      registry,
      sessionStore,
      promptComposer,
      runStore,
      policyResolver,
    );
    const debatePolicy = {
      defaultPlan: ['search_intent', 'synthesis'],
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
        primaryModelProfile: 'premium' as const,
        crossCheckModelProfile: 'balanced' as const,
      },
    };
    verdictService = new VerdictService(agentExecutor, contextStore, debatePolicy, runStore);
    reportService = new ReportService(agentExecutor, contextStore, runStore);

    const bundle = makeBundle();
    contextStore.setBundle('run-001', bundle);
    contextStore.setEntity('run-001', bundle.entity);
    const priorTurn: AgentTurn = {
      run_id: 'run-001',
      agent_name: 'search_intent',
      provider: 'scenario',
      session_id: 'session-001',
      turn_index: 0,
      prompt_summary: 'mock prompt',
      response: makeResponse({
        summary: 'Search demand is expanding quickly.',
        confidence: 0.78,
        claims: [
          {
            claim: 'Search interest is rising across developer workflow queries.',
            supporting_evidence: ['ev-001'],
            confidence: 0.78,
          },
        ],
      }),
      citations: ['ev-001'],
      evidence_refs: ['ev-001'],
      created_at: new Date().toISOString(),
    };
    runStore.saveTurn(priorTurn);
  });

  it('parses a structured beneficiary mapping artifact from agent claims', () => {
    const turn: AgentTurn = {
      run_id: 'run-001',
      agent_name: 'beneficiary_mapping',
      provider: 'scenario',
      session_id: 'session-002',
      turn_index: 0,
      prompt_summary: 'beneficiary prompt',
      response: makeResponse({
        summary: 'Cursor first, Microsoft proxy.',
        claims: [
          {
            claim: 'direct_winner: Cursor | rationale: direct workflow adoption',
            supporting_evidence: ['ev-001'],
            confidence: 0.8,
          },
          {
            claim: 'public_beneficiary: Microsoft | rationale: enterprise distribution',
            supporting_evidence: ['ev-001'],
            confidence: 0.7,
          },
          {
            claim: 'missing_monetization_link: pricing durability is not yet proven',
            supporting_evidence: ['ev-001'],
            confidence: 0.5,
          },
        ],
      }),
      citations: ['ev-001'],
      evidence_refs: ['ev-001'],
      created_at: new Date().toISOString(),
    };

    const mapping = buildBeneficiaryMapping(turn);
    expect(mapping?.direct_winners[0]?.name).toBe('Cursor');
    expect(mapping?.public_beneficiaries[0]?.name).toBe('Microsoft');
    expect(mapping?.missing_monetization_link).toContain('pricing durability');
    expect(summarizeBeneficiaryMapping(mapping)).toContain('public_beneficiaries: Microsoft');
  });

  it('includes beneficiary mapping in verdict output and report evaluation scaffold', async () => {
    const verdict = await verdictService.run('run-001', ['scenario']);
    expect(verdict.beneficiary_mapping?.direct_winners[0]?.name).toBe('Cursor');
    expect(verdict.beneficiary_mapping?.public_beneficiaries[0]?.name).toBe('Microsoft');
    expect(verdict.beneficiaryMappingTurn?.agent_name).toBe('beneficiary_mapping');
    expect(verdict.recommendation).toBe('act_now');

    const report = await reportService.run('run-001');
    expect(report.sections.some((section) => section.title === 'Beneficiary Mapping')).toBe(true);
    expect(report.sections.find((section) => section.title === 'Beneficiary Mapping')?.content).toContain(
      'public_beneficiaries=Microsoft',
    );
    expect(report.report.linked_beneficiaries).toContain('Microsoft');
    expect(report.evaluation.fixture_path).toBe(DEFAULT_REPLAY_FIXTURE_PATH);
    expect(report.evaluation.final_verdict?.recommendation).toBe('act_now');

    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      expected_sections: string[];
      expected_beneficiaries: { public_beneficiaries: string[] };
    };
    expect(fixture.expected_sections).toContain('Beneficiary Mapping');
    expect(fixture.expected_beneficiaries.public_beneficiaries).toContain('Microsoft');
  });

  it('captures structured degraded provider failures in the evaluation scaffold', async () => {
    const degradedTurn: AgentTurn = {
      run_id: 'run-001',
      agent_name: 'human_intel',
      provider: 'scenario',
      session_id: 'session-degraded',
      provider_execution_status: 'degraded',
      provider_degraded_kind: 'rate_limited',
      provider_error: 'provider temporarily rate limited',
      turn_index: 99,
      prompt_summary: 'degraded prompt',
      response: makeResponse({
        summary: '[provider-degraded] scenario:rate_limited provider temporarily rate limited',
        confidence: 0,
      }),
      citations: [],
      evidence_refs: [],
      created_at: new Date().toISOString(),
    };
    runStore.saveTurn(degradedTurn);

    const verdict = await verdictService.run('run-001', ['scenario']);
    const report = await reportService.run('run-001');

    expect(verdict.beneficiary_mapping?.public_beneficiaries[0]?.name).toBe('Microsoft');
    expect(report.evaluation.provider_failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_name: 'human_intel',
          provider: 'scenario',
          summary: 'provider temporarily rate limited',
        }),
      ]),
    );
  });

  it('downgrades verdict confidence and recommendation when the primary verdict provider degrades', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orchestrator-beneficiary-degraded-'));
    const registry = new ProviderRegistry();
    registry.register(new DegradedVerdictScenarioProvider());
    const sessionStore = new SessionStore(dataDir);
    const localRunStore = new RunStore(dataDir);
    const localContextStore = new RunContextStore();
    const promptLoader = new PromptLoader(agentsDir);
    const promptComposer = new PromptComposer(promptLoader);
    const policyResolver = new ExecutionPolicyResolver(
      {
        defaults: {
          triage: { providers: ['scenario'], modelProfile: 'cheap', responseFormat: 'json' },
          debate: { providers: ['scenario'], modelProfile: 'cheap', responseFormat: 'json' },
          verdict: { providers: ['scenario'], modelProfile: 'premium', responseFormat: 'json' },
          report: { providers: ['scenario'], modelProfile: 'balanced', responseFormat: 'json' },
        },
        agents: {},
      },
      {
        providers: {
          scenario: {
            cheap: 'scenario-cheap',
            balanced: 'scenario-balanced',
            premium: 'scenario-premium',
          },
        },
      },
      ['scenario'],
    );
    const agentExecutor = new AgentExecutor(
      registry,
      sessionStore,
      promptComposer,
      localRunStore,
      policyResolver,
    );
    const debatePolicy = {
      defaultPlan: ['search_intent', 'synthesis'],
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
        primaryModelProfile: 'premium' as const,
        crossCheckModelProfile: 'balanced' as const,
      },
    };
    const localVerdictService = new VerdictService(
      agentExecutor,
      localContextStore,
      debatePolicy,
      localRunStore,
    );

    const bundle = makeBundle();
    localContextStore.setBundle('run-degraded', bundle);
    localContextStore.setEntity('run-degraded', bundle.entity);
    localRunStore.saveTurn({
      run_id: 'run-degraded',
      agent_name: 'search_intent',
      provider: 'scenario',
      session_id: 'session-001',
      turn_index: 0,
      prompt_summary: 'mock prompt',
      response: makeResponse({
        summary: 'Search demand is expanding quickly.',
        confidence: 0.78,
      }),
      citations: ['ev-001'],
      evidence_refs: ['ev-001'],
      created_at: new Date().toISOString(),
    });

    const verdict = await localVerdictService.run('run-degraded', ['scenario']);

    expect(verdict.recommendation).toBe('hold');
    expect(verdict.confidence).toBeLessThanOrEqual(0.32);
    expect(verdict.openQuestions).toContain('provider temporarily rate limited');
  });
});
