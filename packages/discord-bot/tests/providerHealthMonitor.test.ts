import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorHealthResponse, ProviderHealthStatus } from '@agentic/shared-types';
import { ProviderHealthMonitor } from '../src/services/providerHealthMonitor.js';

class MockOrchestratorClient {
  constructor(
    private readonly responses: Array<OrchestratorHealthResponse | Error>,
  ) {}

  async health(): Promise<OrchestratorHealthResponse> {
    const next = this.responses.shift();
    if (!next) {
      throw new Error('No more health responses configured');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

function healthResponse(
  providers: Array<{
    provider: string;
    available: boolean;
    status?: ProviderHealthStatus;
    auth_status?: ProviderHealthStatus;
    execute_status?: ProviderHealthStatus;
    recoverable?: boolean;
    error?: string;
    error_summary?: string;
    repair_configured?: boolean;
    repair_command_preview?: string;
    last_repair_at?: string;
    last_repair_summary?: string;
  }>,
): OrchestratorHealthResponse {
  return {
    ok: true,
    active_runs: 0,
    total_sessions: 0,
    providers: providers.map((provider) => ({
      ...provider,
      last_checked_at: '2026-03-26T00:00:00Z',
    })),
  };
}

describe('ProviderHealthMonitor', () => {
  it('alerts once on unhealthy transition and again on recovery', async () => {
    const orchestrator = new MockOrchestratorClient([
      healthResponse([{ provider: 'codex', available: true }]),
      healthResponse([{ provider: 'codex', available: false, error: 'login expired' }]),
      healthResponse([{ provider: 'codex', available: false, error: 'login expired' }]),
      healthResponse([{ provider: 'codex', available: true }]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    const sink = vi.fn(async (message: string) => {
      messages.push(message);
    });

    await monitor.pollOnce(sink);
    await monitor.pollOnce(sink);
    await monitor.pollOnce(sink);
    await monitor.pollOnce(sink);

    expect(messages).toEqual([
      [
        '[provider-health] codex unavailable',
        'error: login expired',
        'checked: 2026-03-26T00:00:00Z',
        'down since: 2026-03-26T00:00:00Z',
        'repair: not configured',
      ].join('\n'),
      [
        '[provider-health] codex recovered',
        'checked: 2026-03-26T00:00:00Z',
        'downtime: unknown',
      ].join('\n'),
    ]);
  });

  it('dedupes repeated identical provider failures', async () => {
    const orchestrator = new MockOrchestratorClient([
      healthResponse([{ provider: 'claude', available: false, error: 'auth expired' }]),
      healthResponse([{ provider: 'claude', available: false, error: 'auth expired' }]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      [
        '[provider-health] claude unavailable',
        'error: auth expired',
        'checked: 2026-03-26T00:00:00Z',
        'down since: 2026-03-26T00:00:00Z',
        'repair: not configured',
      ].join('\n'),
    ]);
  });

  it('dedupes repeated failures when only the raw error changes', async () => {
    const orchestrator = new MockOrchestratorClient([
      healthResponse([
        {
          provider: 'codex',
          available: false,
          status: 'transport_failed',
          recoverable: true,
          error_summary: 'transport failed (TLS/CA, websocket, or network issue)',
          error:
            'Codex response missing agent_message: {"type":"thread.started","thread_id":"thread-a"} {"type":"error","message":"Reconnecting... 1/5 (no native root CA certificates found)"}',
        },
      ]),
      healthResponse([
        {
          provider: 'codex',
          available: false,
          status: 'transport_failed',
          recoverable: true,
          error_summary: 'transport failed (TLS/CA, websocket, or network issue)',
          error:
            'Codex response missing agent_message: {"type":"thread.started","thread_id":"thread-b"} {"type":"error","message":"Reconnecting... 2/5 (no native root CA certificates found)"}',
        },
      ]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      [
        '[provider-health] codex unavailable',
        'status: transport_failed',
        'error: transport failed (TLS/CA, websocket, or network issue)',
        'checked: 2026-03-26T00:00:00Z',
        'down since: 2026-03-26T00:00:00Z',
        'recoverable: true',
        'repair: not configured',
      ].join('\n'),
    ]);
  });

  it('alerts on orchestrator recovery after an outage', async () => {
    const orchestrator = new MockOrchestratorClient([
      new Error('connection refused'),
      healthResponse([{ provider: 'codex', available: true }]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      '[provider-health] orchestrator unreachable\nerror: connection refused',
      '[provider-health] orchestrator recovered\nprevious error: connection refused',
    ]);
  });

  it('dedupes orchestrator unreachable alerts until the message changes', async () => {
    const orchestrator = new MockOrchestratorClient([
      new Error('connection refused'),
      new Error('connection refused'),
      new Error('timeout'),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      '[provider-health] orchestrator unreachable\nerror: connection refused',
      '[provider-health] orchestrator unreachable\nerror: timeout',
    ]);
  });

  it('does not relabel sink failures as orchestrator outages', async () => {
    const orchestrator = new MockOrchestratorClient([
      healthResponse([{ provider: 'codex', available: false, error: 'login expired' }]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    await expect(
      monitor.pollOnce(async () => {
        throw new Error('discord send failed');
      }),
    ).rejects.toThrow('discord send failed');
  });

  it('includes repair configuration and repair result in provider alerts', async () => {
    const orchestrator = new MockOrchestratorClient([
      healthResponse([
        {
          provider: 'codex',
          available: false,
          error: 'login expired',
          repair_configured: true,
          repair_command_preview: 'printenv OPENAI_API_KEY | codex login --with-api-key',
          last_repair_at: '2026-03-26T00:00:30Z',
          last_repair_summary: 'codex: command completed',
        },
      ]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      [
        '[provider-health] codex unavailable',
        'error: login expired',
        'checked: 2026-03-26T00:00:00Z',
        'down since: 2026-03-26T00:00:00Z',
        'repair: configured (printenv OPENAI_API_KEY | codex login --with-api-key)',
        'last repair: 2026-03-26T00:00:30Z',
        'repair result: codex: command completed',
      ].join('\n'),
    ]);
  });

  it('uses semantic status and recoverability in provider alerts', async () => {
    const orchestrator = new MockOrchestratorClient([
      healthResponse([
        {
          provider: 'claude',
          available: false,
          status: 'rate_limited',
          auth_status: 'healthy',
          execute_status: 'rate_limited',
          recoverable: true,
          error: "You've hit your limit",
        },
      ]),
    ]);

    const monitor = new ProviderHealthMonitor(orchestrator as never, {
      pollIntervalMs: 60_000,
    });

    const messages: string[] = [];
    await monitor.pollOnce(async (message) => {
      messages.push(message);
    });

    expect(messages).toEqual([
      [
        '[provider-health] claude unavailable',
        'status: rate_limited',
        'auth: healthy',
        'execute: rate_limited',
        "error: You've hit your limit",
        'checked: 2026-03-26T00:00:00Z',
        'down since: 2026-03-26T00:00:00Z',
        'recoverable: true',
        'repair: not configured',
      ].join('\n'),
    ]);
  });
});
