import { describe, expect, it } from 'vitest';
import { OpsCommandService } from '../src/services/opsCommandService.js';

class FakeCollectorClient {
  async getSourcesStatus() {
    return {
      analysis: { enabled: true, queue_size: 1 },
      runtime: {
        source_run_queue_size: 2,
        source_run_worker_concurrency: 2,
        active_source_count: 1,
      },
      sources: {},
    };
  }
}

class FakeOrchestratorClient {
  async health() {
    return {
      ok: true,
      active_runs: 2,
      total_sessions: 5,
      providers: [
        {
          provider: 'codex',
          available: true,
          status: 'healthy',
          auth_status: 'healthy',
          execute_status: 'healthy',
          transport_status: 'healthy',
          ready_for_execution: true,
          last_checked_at: '2026-03-28T00:00:00Z',
          repair_configured: false,
        },
        {
          provider: 'gemini',
          available: false,
          status: 'parse_failed',
          auth_status: 'healthy',
          execute_status: 'parse_failed',
          transport_status: 'healthy',
          ready_for_execution: false,
          failure_kind: 'parse_failed',
          error_summary: 'provider returned an unreadable response',
          last_checked_at: '2026-03-28T00:00:00Z',
          repair_configured: false,
        },
      ],
    };
  }
}

describe('OpsCommandService', () => {
  it('combines bot, collector, and orchestrator health', async () => {
    const service = new OpsCommandService(
      new FakeCollectorClient() as never,
      new FakeOrchestratorClient() as never,
      async () => ({
        discordReady: true,
        activeSchedules: 1,
        configuredGuildReports: 2,
        providerHealthMonitorRunning: true,
      }),
    );

    const content = await service.health();
    expect(content).toContain('bot=ready:true');
    expect(content).toContain('collector=reachable');
    expect(content).toContain('orchestrator=reachable');
    expect(content).toContain('ready_providers=1/2');
  });

  it('shows provider auth and execute states', async () => {
    const service = new OpsCommandService(
      new FakeCollectorClient() as never,
      new FakeOrchestratorClient() as never,
      async () => ({
        discordReady: true,
        activeSchedules: 0,
        configuredGuildReports: 0,
        providerHealthMonitorRunning: true,
      }),
    );

    const content = await service.providers();
    expect(content).toContain('**codex**');
    expect(content).toContain('execute=parse_failed');
    expect(content).toContain('transport=healthy');
    expect(content).toContain('checked=2026-03-28T00:00:00Z');
    expect(content).toContain('repair=not_configured');
    expect(content).toContain('error=provider returned an unreadable response');
  });
});
