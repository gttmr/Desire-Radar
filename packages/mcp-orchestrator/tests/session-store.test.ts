import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions/session-store.js';

describe('SessionStore', () => {
  it('creates provider-specific session directories and persists provider session ids', () => {
    const dataDir = '/tmp/agentic-session-store-test';
    const sessionRoot = '/tmp/agentic-provider-sessions-test';
    const store = new SessionStore(dataDir, sessionRoot);

    const session = store.createSession('investment_verdict', 'codex', {
      phase: 'verdict',
      modelProfile: 'premium',
      runScope: 'run-001',
      model: 'gpt-5.4',
    });

    expect(session.session_dir).toContain('/codex/');
    expect(existsSync(session.session_dir as string)).toBe(true);
    expect(session.provider_session_id).toBeNull();

    store.updateSession(session.session_id, {
      run_id: 'run-001',
      agent_name: 'investment_verdict',
      provider: 'codex',
      session_id: session.session_id,
      turn_index: 1,
      prompt_summary: 'prompt',
      response: {
        summary: 'summary',
        confidence: 0.5,
        claims: [],
        evidence_used: [],
        open_questions: [],
        messages_for_other_agents: [],
        recommended_next_step: 'watch',
      },
      citations: [],
      evidence_refs: [],
      created_at: new Date().toISOString(),
    }, {
      providerSessionId: 'thread-123',
      transportMode: 'cli_resume',
      transportTarget: session.session_dir ?? null,
    });

    const stored = store.getSession('investment_verdict', 'codex', {
      phase: 'verdict',
      modelProfile: 'premium',
      runScope: 'run-001',
      model: 'gpt-5.4',
      transportMode: 'cli_resume',
      transportTarget: session.session_dir ?? null,
    });

    expect(stored?.provider_session_id).toBe('thread-123');
    expect(stored?.turn_count).toBe(1);
  });
});
