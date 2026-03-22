import { describe, expect, it, vi } from 'vitest';
import { ActionOrchestrator } from '../src/services/actionOrchestrator.js';
import { JobEngine } from '../src/services/jobEngine.js';

describe('ActionOrchestrator', () => {
  it('executes approved action', async () => {
    const engine = new JobEngine();
    const orchestrator = new ActionOrchestrator(5000, engine);

    const action = orchestrator.createPending({
      transcript: { text: '테스트', durationMs: 1000 },
      userId: 'u',
      guildId: 'g',
      channelId: 'c'
    });

    const outcome = await orchestrator.execute(action.id);
    expect(outcome.status).toBe('executed');
    expect(orchestrator.stats().pendingCount).toBe(0);
    orchestrator.dispose();
  });

  it('expires action after ttl', async () => {
    vi.useFakeTimers();
    const engine = new JobEngine();
    const orchestrator = new ActionOrchestrator(1000, engine);

    const action = orchestrator.createPending({
      transcript: { text: '만료', durationMs: 1000 },
      userId: 'u',
      guildId: 'g',
      channelId: 'c'
    });

    vi.advanceTimersByTime(1500);
    const outcome = await orchestrator.execute(action.id);
    expect(outcome.status).toBe('expired');

    orchestrator.dispose();
    vi.useRealTimers();
  });

  it('skips action', () => {
    const engine = new JobEngine();
    const orchestrator = new ActionOrchestrator(5000, engine);

    const action = orchestrator.createPending({
      transcript: { text: '스킵', durationMs: 1000 },
      userId: 'u',
      guildId: 'g',
      channelId: 'c'
    });

    const outcome = orchestrator.skip(action.id);
    expect(outcome.status).toBe('skipped');
    expect(orchestrator.stats().pendingCount).toBe(0);
    orchestrator.dispose();
  });
});
