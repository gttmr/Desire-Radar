import type { OrchestratorHealthResponse, ProviderHealth } from '@agentic/shared-types';
import type { OrchestratorClient } from './orchestratorClient.js';

type ProviderHealthMonitorOptions = {
  pollIntervalMs: number;
};

type AlertSink = (message: string) => Promise<void>;

type ProviderState = {
  available: boolean;
  status?: string;
  recoverable?: boolean;
  error?: string;
  signature?: string;
  unavailableSince?: string;
  lastRepairAt?: string;
  lastRepairSummary?: string;
};

export class ProviderHealthMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly states = new Map<string, ProviderState>();
  private lastOrchestratorError: string | undefined;

  constructor(
    private readonly orchestrator: OrchestratorClient,
    private readonly options: ProviderHealthMonitorOptions,
  ) {}

  start(sink: AlertSink): void {
    this.stop();
    void this.safePollOnce(sink);
    this.timer = setInterval(() => {
      void this.safePollOnce(sink);
    }, this.options.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return Boolean(this.timer);
  }

  async pollOnce(sink: AlertSink): Promise<void> {
    let health: OrchestratorHealthResponse;
    try {
      health = await this.orchestrator.health();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastOrchestratorError) {
        await this.emit(sink, formatOrchestratorOutage(message));
        this.lastOrchestratorError = message;
      }
      return;
    }

    if (this.lastOrchestratorError) {
      await this.emit(sink, formatOrchestratorRecovery(this.lastOrchestratorError));
      this.lastOrchestratorError = undefined;
    }

    await this.handleHealthResponse(health, sink);
  }

  private async handleHealthResponse(
    health: OrchestratorHealthResponse,
    sink: AlertSink,
  ): Promise<void> {
    for (const provider of health.providers) {
      const previous = this.states.get(provider.provider);
      const signature = buildProviderSignature(provider);

      if (provider.available) {
        if (previous && !previous.available) {
          await this.emit(sink, formatProviderRecovery(provider, previous));
        }
        this.states.set(provider.provider, {
          available: true,
          status: provider.status,
          recoverable: provider.recoverable,
          signature,
          lastRepairAt: provider.last_repair_at,
          lastRepairSummary: provider.last_repair_summary,
        });
        continue;
      }

      const currentError = provider.error ?? 'provider unavailable';
      const changed = !previous || previous.available || previous.signature !== signature;
      const unavailableSince =
        previous && !previous.available ? previous.unavailableSince ?? provider.last_checked_at : provider.last_checked_at;
      if (changed) {
        await this.emit(sink, formatProviderOutage(provider, currentError, unavailableSince));
      }

      this.states.set(provider.provider, {
        available: false,
        status: provider.status,
        recoverable: provider.recoverable,
        error: currentError,
        signature,
        unavailableSince,
        lastRepairAt: provider.last_repair_at,
        lastRepairSummary: provider.last_repair_summary,
      });
    }
  }

  private async safePollOnce(sink: AlertSink): Promise<void> {
    try {
      await this.pollOnce(sink);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[provider-health] alert dispatch failed: ${message}`);
    }
  }

  private async emit(sink: AlertSink, message: string): Promise<void> {
    await sink(message);
  }
}

function buildProviderSignature(provider: ProviderHealth): string {
  return [
    provider.available ? 'up' : 'down',
    provider.status ?? 'unknown',
    provider.recoverable ? 'recoverable' : 'terminal',
    summarize(provider.error ?? 'provider unavailable', 240),
    provider.last_repair_at ?? '',
    summarize(provider.last_repair_summary ?? '', 240),
  ].join('|');
}

function formatProviderOutage(
  provider: ProviderHealth,
  currentError: string,
  unavailableSince: string,
): string {
  const lines = [`[provider-health] ${provider.provider} unavailable`];
  if (provider.status) {
    lines.push(`status: ${provider.status}`);
  }
  lines.push(`error: ${summarize(currentError, 320)}`);
  lines.push(`checked: ${provider.last_checked_at}`);
  lines.push(`down since: ${unavailableSince}`);
  if (typeof provider.recoverable === 'boolean') {
    lines.push(`recoverable: ${provider.recoverable}`);
  }
  lines.push(
    provider.repair_configured
      ? `repair: configured${provider.repair_command_preview ? ` (${provider.repair_command_preview})` : ''}`
      : 'repair: not configured',
  );
  if (provider.last_repair_at) {
    lines.push(`last repair: ${provider.last_repair_at}`);
  }
  if (provider.last_repair_summary) {
    lines.push(`repair result: ${summarize(provider.last_repair_summary, 320)}`);
  }
  return lines.join('\n');
}

function formatProviderRecovery(provider: ProviderHealth, previous: ProviderState): string {
  const lines = [`[provider-health] ${provider.provider} recovered`, `checked: ${provider.last_checked_at}`];
  if (provider.status) {
    lines.push(`status: ${provider.status}`);
  }
  if (previous.unavailableSince) {
    lines.push(`downtime: ${formatDuration(previous.unavailableSince, provider.last_checked_at)}`);
  }
  if (previous.lastRepairAt) {
    lines.push(`last repair: ${previous.lastRepairAt}`);
  }
  if (previous.lastRepairSummary) {
    lines.push(`repair result: ${summarize(previous.lastRepairSummary, 320)}`);
  }
  return lines.join('\n');
}

function formatOrchestratorOutage(message: string): string {
  return `[provider-health] orchestrator unreachable\nerror: ${summarize(message, 320)}`;
}

function formatOrchestratorRecovery(previousError: string): string {
  return [
    '[provider-health] orchestrator recovered',
    `previous error: ${summarize(previousError, 320)}`,
  ].join('\n');
}

function summarize(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatDuration(startIso: string, endIso: string): string {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 'unknown';
  }

  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
