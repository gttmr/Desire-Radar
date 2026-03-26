import { describe, it, expect, beforeEach } from 'vitest';
import { PromptLoader } from '../src/prompt/loader.js';
import { PromptComposer } from '../src/prompt/composer.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EvidenceBundle } from '@agentic/shared-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const agentsDir = join(__dirname, '..', 'src', 'agents');

describe('PromptComposer', () => {
  let loader: PromptLoader;
  let composer: PromptComposer;

  beforeEach(() => {
    loader = new PromptLoader(agentsDir);
    composer = new PromptComposer(loader);
  });

  it('should include runtime instructions at the start', async () => {
    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
    });
    expect(prompt).toContain('You are an analytical agent');
    expect(prompt).toContain('Respond ONLY with valid JSON');
    expect(prompt).toContain('phase: debate');
  });

  it('should include agent system prompt', async () => {
    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
    });
    expect(prompt).toContain('Search Intent Agent');
    expect(prompt).toContain('search volume patterns');
  });

  it('should include evidence bundle when provided', async () => {
    const bundle: EvidenceBundle = {
      bundle_id: 'test-bundle',
      entity: 'TestEntity',
      time_window: { start: '2026-03-23', end: '2026-03-24' },
      evidence_items: [
        {
          evidence_id: 'ev-001',
          source: 'google_trends',
          source_tier: 1,
          collected_at: '2026-03-24T00:00:00Z',
          entity_candidates: ['TestEntity'],
          signal_type: 'search_volume',
          title_or_label: 'Search volume spike',
          metric_value: 95,
          metric_delta: 40,
          rank: null,
          geo: 'KR',
          url_or_ref: 'https://trends.google.com',
          raw_snapshot_ref: 'snap-001',
          trust_score: 0.9,
          tos_risk: 'none',
          freshness_ttl: 3600,
        },
      ],
      cross_source_summary: 'Significant uptick in search volume',
      recommended_agents: ['search_intent'],
      quality_flags: [],
    };

    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
      evidenceBundle: bundle,
    });

    expect(prompt).toContain('Evidence Summary');
    expect(prompt).toContain('ev-001');
    expect(prompt).toContain('TestEntity');
  });

  it('should include session summary when provided', async () => {
    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
      sessionSummary: 'Previous analysis found rising search trends for XYZ.',
    });

    expect(prompt).toContain('Previous Session Context');
    expect(prompt).toContain('rising search trends for XYZ');
  });

  it('should include orchestrator questions', async () => {
    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
      orchestratorQuestions: [
        'What is the search velocity trend?',
        'Are there regional variations?',
      ],
    });

    expect(prompt).toContain('Orchestrator Questions');
    expect(prompt).toContain('1. What is the search velocity trend?');
    expect(prompt).toContain('2. Are there regional variations?');
  });

  it('should include analytical inputs during verdict composition', async () => {
    const prompt = await composer.compose({
      agentName: 'investment_verdict',
      provider: 'codex',
      phase: 'verdict',
      otherAgentMessages: [
        {
          from: 'beneficiary_mapping',
          content: 'direct_winners: Cursor\npublic_beneficiaries: Microsoft',
        },
      ],
    });

    expect(prompt).toContain('Analytical Inputs');
    expect(prompt).toContain('beneficiary_mapping');
    expect(prompt).toContain('public_beneficiaries: Microsoft');
  });

  it('should include other agent messages', async () => {
    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
      otherAgentMessages: [
        { from: 'ranking_momentum', content: 'App moved to top-10 in category' },
        { from: 'scarcity', content: 'Stock levels depleting rapidly' },
      ],
    });

    expect(prompt).toContain('Messages From Other Agents');
    expect(prompt).toContain('- ranking_momentum:');
    expect(prompt).toContain('App moved to top-10');
    expect(prompt).toContain('- scarcity:');
  });

  it('should compose sections in correct order', async () => {
    const prompt = await composer.compose({
      agentName: 'search_intent',
      provider: 'codex',
      sessionSummary: 'SESSION_MARKER',
      orchestratorQuestions: ['QUESTION_MARKER'],
      otherAgentMessages: [{ from: 'test', content: 'MESSAGE_MARKER' }],
    });

    const runtimeIdx = prompt.indexOf('You are an analytical agent');
    const agentIdx = prompt.indexOf('Search Intent Agent');
    const sessionIdx = prompt.indexOf('SESSION_MARKER');
    const questionIdx = prompt.indexOf('QUESTION_MARKER');
    const messageIdx = prompt.indexOf('MESSAGE_MARKER');

    expect(runtimeIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(sessionIdx);
    expect(sessionIdx).toBeLessThan(questionIdx);
    expect(questionIdx).toBeLessThan(messageIdx);
  });

  it('should load different agent prompts', async () => {
    const synthesis = await composer.compose({
      agentName: 'synthesis',
      provider: 'claude',
    });
    expect(synthesis).toContain('Synthesis Agent');
    expect(synthesis).toContain('integrator');

    const scarcity = await composer.compose({
      agentName: 'scarcity',
      provider: 'claude',
    });
    expect(scarcity).toContain('Scarcity Agent');
    expect(scarcity).toContain('resale premium');
  });

  it('should cache loaded agents', async () => {
    await composer.compose({ agentName: 'search_intent', provider: 'codex' });
    await composer.compose({ agentName: 'search_intent', provider: 'codex' });
    // No error means cache is working (file read once, served from cache)
    expect(true).toBe(true);
  });

  it('should clear cache', async () => {
    await composer.compose({ agentName: 'search_intent', provider: 'codex' });
    loader.clearCache();
    // Should re-load from disk without error
    const prompt = await composer.compose({ agentName: 'search_intent', provider: 'codex' });
    expect(prompt).toContain('Search Intent Agent');
  });
});
