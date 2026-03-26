import type { OrchestratorHealthResponse, ProviderHealth } from '@agentic/shared-types';
import type { OrchestratorClient } from './orchestratorClient.js';

type ProviderHealthMonitorOptions = {
  pollIntervalMs: number;
};

type AlertSink = (message: string) => Promise<void>;

type ProviderState = {
  available: boolean;
  error?: string;
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
        await this.emit(sink, `[provider-health] orchestrator unreachable: ${message}`);
        this.lastOrchestratorError = message;
      }
      return;
    }

    if (this.lastOrchestratorError) {
      await this.emit(sink, '[provider-health] orchestrator recovered');
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

      if (provider.available) {
        if (previous && !previous.available) {
          await this.emit(sink, `[provider-health] ${provider.provider} recovered`);
        }
        this.states.set(provider.provider, { available: true });
        continue;
      }

      const currentError = provider.error ?? 'provider unavailable';
      const changed = !previous || previous.available || previous.error !== currentError;
      if (changed) {
        await this.emit(sink, `[provider-health] ${provider.provider} unavailable: ${currentError}`);
      }

      this.states.set(provider.provider, {
        available: false,
        error: currentError,
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
