import type { OrchestratorHealthResponse, ProviderHealth } from '@agentic/shared-types';
import type { CollectorClient } from './collectorClient.js';
import type { OrchestratorClient } from './orchestratorClient.js';

type BotHealthSnapshot = {
  discordReady: boolean;
  activeSchedules: number;
  configuredGuildReports: number;
  providerHealthMonitorRunning: boolean;
};

export class OpsCommandService {
  constructor(
    private readonly collector: CollectorClient,
    private readonly orchestrator: OrchestratorClient,
    private readonly botHealth: () => Promise<BotHealthSnapshot>,
  ) {}

  async health(): Promise<string> {
    const lines: string[] = [];
    const local = await this.botHealth();
    lines.push(`bot=ready:${local.discordReady} | schedules=${local.activeSchedules} | guild_reports=${local.configuredGuildReports} | provider_monitor=${local.providerHealthMonitorRunning}`);

    try {
      const collectorStatus = await this.collector.getSourcesStatus();
      lines.push(
        `collector=reachable | source_run_queue=${collectorStatus.runtime?.source_run_queue_size ?? 'unknown'} | active_sources=${collectorStatus.runtime?.active_source_count ?? 'unknown'} | analysis_queue=${collectorStatus.analysis.queue_size}`,
      );
    } catch (error) {
      lines.push(`collector=unreachable | error=${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const orchestratorHealth = await this.orchestrator.health();
      const readyCount = orchestratorHealth.providers.filter((provider) => provider.ready_for_execution).length;
      lines.push(
        `orchestrator=reachable | active_runs=${orchestratorHealth.active_runs} | sessions=${orchestratorHealth.total_sessions} | ready_providers=${readyCount}/${orchestratorHealth.providers.length}`,
      );
    } catch (error) {
      lines.push(`orchestrator=unreachable | error=${error instanceof Error ? error.message : String(error)}`);
    }

    return lines.join('\n');
  }

  async providers(): Promise<string> {
    const health = await this.orchestrator.health();
    if (health.providers.length === 0) {
      return '등록된 provider가 없습니다.';
    }
    return health.providers.map((provider) => this.formatProvider(provider)).join('\n');
  }

  private formatProvider(provider: ProviderHealth): string {
    const fields = [
      `**${provider.provider}**`,
      `ready=${provider.ready_for_execution ? 'yes' : 'no'}`,
      `status=${provider.status ?? 'unknown'}`,
    ];
    if (provider.auth_status) {
      fields.push(`auth=${provider.auth_status}`);
    }
    if (provider.execute_status) {
      fields.push(`execute=${provider.execute_status}`);
    }
    if (provider.transport_status) {
      fields.push(`transport=${provider.transport_status}`);
    }
    if (provider.failure_kind) {
      fields.push(`failure=${provider.failure_kind}`);
    }
    if (provider.last_checked_at) {
      fields.push(`checked=${provider.last_checked_at}`);
    }
    if (typeof provider.repair_configured === 'boolean') {
      fields.push(`repair=${provider.repair_configured ? 'configured' : 'not_configured'}`);
    }
    if (provider.last_repair_at) {
      fields.push(`last_repair=${provider.last_repair_at}`);
    }
    if (provider.last_repair_summary) {
      fields.push(`repair_summary=${provider.last_repair_summary}`);
    }
    if (provider.error_summary || provider.error) {
      fields.push(`error=${provider.error_summary ?? provider.error}`);
    }
    return fields.join(' | ');
  }
}
