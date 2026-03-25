import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ProviderAdapter, ProviderExecutionRequest, ProviderResult } from '../src/providers/base.js';
import type { EvidenceBundle, AgentResponse } from '@agentic/shared-types';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/session-store.js';
import { RunStore } from '../src/orchestrator/run-store.js';
import { RunContextStore } from '../src/orchestrator/run-context-store.js';
import { PromptLoader } from '../src/prompt/loader.js';
import { PromptComposer } from '../src/prompt/composer.js';
import { AgentExecutor } from '../src/orchestrator/agent-executor.js';
import { RunOrchestrator } from '../src/orchestrator/run-orchestrator.js';
import { DebateService } from '../src/pipeline/debate.js';
import { ExecutionPolicyResolver } from '../src/policy/execution.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const agentsDir = join(__dirname, '..', 'src', 'agents');

function makeMockResponse(agentName: string, messages?: Array<{ target_agent: string; content: string }>): AgentResponse {
  return {
    summary: `Mock analysis from ${agentName}`,
    confidence: 0.7,
    claims: [
      {
        claim: `${agentName} detected signal`,
        supporting_evidence: ['ev-001'],
        confidence: 0.8,
      },
    ],
    evidence_used: ['ev-001'],
    open_questions: [`What is the ${agentName} outlook?`],
    messages_for_other_agents: messages ?? [],
    recommended_next_step: 'continue_analysis',
  };
}

class MockProvider implements ProviderAdapter {
  readonly name: string;
  callCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    this.callCount++;
    // Extract agent name from prompt to generate appropriate mock
    const agentMatch = request.prompt.match(/# (\w[\w\s]+) Agent/);
    const agentName = agentMatch ? agentMatch[1]!.trim().toLowerCase().replace(/\s+/g, '_') : 'unknown';

    const response = makeMockResponse(agentName);
    return {
      text: JSON.stringify(response),
      sessionId: request.sessionId ?? randomUUID(),
      durationMs: 50,
      model: request.model,
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}

function makeBundle(): EvidenceBundle {
  return {
    bundle_id: 'test-bundle-001',
    entity: 'TestProduct',
    time_window: { start: '2026-03-23', end: '2026-03-24' },
    evidence_items: [
      {
        evidence_id: 'ev-001',
        source: 'google_trends',
        source_tier: 1,
        collected_at: '2026-03-24T00:00:00Z',
        entity_candidates: ['TestProduct'],
        signal_type: 'search_volume',
        title_or_label: 'Rising search interest',
        metric_value: 85,
        metric_delta: 30,
        rank: null,
        geo: 'KR',
        url_or_ref: 'https://trends.google.com',
        raw_snapshot_ref: 'snap-001',
        trust_score: 0.9,
        tos_risk: 'none',
        freshness_ttl: 3600,
      },
    ],
    cross_source_summary: 'Strong search signal detected',
    recommended_agents: ['search_intent', 'ranking_momentum'],
    quality_flags: [],
  };
}

describe('RunOrchestrator', () => {
  let orchestrator: RunOrchestrator;
  let mockProvider: MockProvider;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));

    const registry = new ProviderRegistry();
    mockProvider = new MockProvider('mock');
    registry.register(mockProvider);

    const sessionStore = new SessionStore(dataDir);
    const runStore = new RunStore(dataDir);
    const contextStore = new RunContextStore();
    const promptLoader = new PromptLoader(agentsDir);
    const promptComposer = new PromptComposer(promptLoader);
    const executionPolicy = new ExecutionPolicyResolver(
      {
        defaults: {
          triage: { providers: ['mock'], modelProfile: 'cheap', responseFormat: 'json' },
          debate: { providers: ['mock'], modelProfile: 'cheap', responseFormat: 'json' },
          verdict: { providers: ['mock'], modelProfile: 'premium', responseFormat: 'json' },
          report: { providers: ['mock'], modelProfile: 'balanced', responseFormat: 'json' },
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
    );
    const agentExecutor = new AgentExecutor(
      registry,
      sessionStore,
      promptComposer,
      runStore,
      executionPolicy,
    );
    const debatePolicy = {
      defaultPlan: [
        'search_intent',
        'ranking_momentum',
        'conversion_proxy',
        'scarcity',
        'diffusion',
        'human_intel',
        'theme_mapper',
        'synthesis',
      ],
      maxRounds: 3,
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
    const debateService = new DebateService(
      agentExecutor,
      runStore,
      contextStore,
      debatePolicy,
    );

    orchestrator = new RunOrchestrator(agentExecutor, runStore, ['mock'], {
      sessionStore,
      contextStore,
      debateService,
    });
  });

  it('should submit evidence and create a run', async () => {
    const bundle = makeBundle();
    const result = await orchestrator.submitEvidence('TestProduct analysis', bundle);

    expect(result.run_id).toBeDefined();
    expect(result.evidence_count).toBe(1);
  });

  it('should submit evidence to existing run', async () => {
    const bundle = makeBundle();
    const first = await orchestrator.submitEvidence('TestProduct analysis', bundle);
    const second = await orchestrator.submitEvidence('TestProduct analysis', bundle, first.run_id);

    expect(second.run_id).toBe(first.run_id);
    expect(second.evidence_count).toBe(1);
  });

  it('should run a single agent round', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);

    const turns = await orchestrator.runAgentRound(run_id, 'search_intent', ['mock']);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.agent_name).toBe('search_intent');
    expect(turns[0]!.provider).toBe('mock');
    expect(turns[0]!.response.summary).toContain('search_intent');
    expect(turns[0]!.response.confidence).toBeGreaterThan(0);
  });

  it('should throw for non-existent run', async () => {
    await expect(
      orchestrator.runAgentRound('non-existent', 'search_intent'),
    ).rejects.toThrow('Run not found');
  });

  it('should run a debate with default plan', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);

    const result = await orchestrator.runDebate(run_id, undefined, 1, ['mock']);

    expect(result.rounds_executed).toBe(1);
    expect(result.turns.length).toBeGreaterThan(0);
    // Should have one turn per agent in the plan (8 agents * 1 provider)
    expect(result.turns).toHaveLength(8);
    expect(result.status).toBe('max_rounds_reached');
  });

  it('should run a debate with custom plan', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);

    const result = await orchestrator.runDebate(
      run_id,
      ['search_intent', 'synthesis'],
      1,
      ['mock'],
    );

    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]!.agent_name).toBe('search_intent');
    expect(result.turns[1]!.agent_name).toBe('synthesis');
  });

  it('should track run state', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);
    await orchestrator.runAgentRound(run_id, 'search_intent', ['mock']);

    const state = orchestrator.getRunState(run_id);

    expect(state.run.run_id).toBe(run_id);
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]!.agent_name).toBe('search_intent');
    expect(state.agents[0]!.turns_completed).toBe(1);
    expect(state.latest_turns).toHaveLength(1);
  });

  it('should synthesize a report', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);
    await orchestrator.runDebate(run_id, ['search_intent', 'synthesis'], 1, ['mock']);

    const report = await orchestrator.synthesizeReport(run_id);

    expect(report.report_id).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(report.sections.length).toBeGreaterThan(0);
  });

  it('should list reports', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);
    await orchestrator.synthesizeReport(run_id);

    const reports = orchestrator.getReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report_id).toBeDefined();
  });

  it('should increment provider call count through debate', async () => {
    const bundle = makeBundle();
    const { run_id } = await orchestrator.submitEvidence('Test', bundle);

    await orchestrator.runDebate(run_id, ['search_intent', 'scarcity'], 1, ['mock']);

    // 2 agents * 1 round = 2 calls
    expect(mockProvider.callCount).toBe(2);
  });
});
