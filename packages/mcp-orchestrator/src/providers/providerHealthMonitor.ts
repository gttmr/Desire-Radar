import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderHealth } from '@agentic/shared-types';
import type { ProviderAdapter, ProviderHealthProbe } from './base.js';
import type { ProviderRegistry } from './registry.js';

const execAsync = promisify(exec);

type ProviderHealthMonitorOptions = {
  pollIntervalMs: number;
  repairCooldownMs: number;
  repairCommands: Partial<Record<string, string>>;
  now?: () => Date;
  runRepairCommand?: (provider: string, command: string) => Promise<string>;
};

type ProviderHealthState = ProviderHealth & {
  lastRepairAtMs?: number;
};

type RepairAttempt = {
  attemptedAt: number;
  summary: string;
};

export class ProviderHealthMonitor {
  private timer: NodeJS.Timeout | undefined;
  private inFlightPoll: Promise<void> | undefined;
  private readonly states = new Map<string, ProviderHealthState>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly options: ProviderHealthMonitorOptions,
  ) {}

  async start(): Promise<void> {
    this.stop();
    await this.safePollOnce();
    this.timer = setInterval(() => {
      void this.safePollOnce();
    }, this.options.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  snapshot(): ProviderHealth[] {
    return this.registry.list().map((provider) => {
      const state = this.states.get(provider);
      return (
        state ?? {
          provider,
          available: false,
          status: 'unprobed',
          auth_status: 'unprobed',
          execute_status: 'unprobed',
          transport_status: 'unprobed',
          ready_for_execution: false,
          last_checked_at: new Date(0).toISOString(),
          error: 'provider health has not been probed yet',
          error_summary: 'provider health has not been probed yet',
          recoverable: false,
          repair_configured: this.hasRepairCommand(provider),
          repair_command_preview: this.getRepairCommandPreview(provider),
        }
      );
    });
  }

  async pollOnce(): Promise<void> {
    if (this.inFlightPoll) {
      await this.inFlightPoll;
      return;
    }

    this.inFlightPoll = this.pollProviders().finally(() => {
      this.inFlightPoll = undefined;
    });
    await this.inFlightPoll;
  }

  private async pollProviders(): Promise<void> {
    for (const provider of this.registry.list()) {
      const adapter = this.registry.get(provider);
      if (!adapter) {
        continue;
      }

      let result = await this.probeProvider(adapter);
      const previous = this.states.get(provider);
      let lastRepairAtMs = previous?.lastRepairAtMs;
      let last_repair_at = previous?.last_repair_at;
      let last_repair_summary = previous?.last_repair_summary;

      if (!result.available && this.shouldAttemptRepair(provider, result)) {
        const repairAttempt = await this.tryRepair(provider, previous);
        if (repairAttempt) {
          lastRepairAtMs = repairAttempt.attemptedAt;
          last_repair_at = new Date(repairAttempt.attemptedAt).toISOString();
          last_repair_summary = repairAttempt.summary;
          const afterRepair = await this.probeProvider(adapter);
          if (afterRepair.available) {
            result = afterRepair;
          } else {
            result = {
              available: afterRepair.available,
              status: afterRepair.status,
              error: `${afterRepair.error ?? 'provider unavailable'} | repair: ${repairAttempt.summary}`,
              recoverable: afterRepair.recoverable,
            };
          }
        }
      }

      this.states.set(provider, {
        provider,
        available: result.available,
        status: result.status ?? (result.available ? 'healthy' : 'unknown'),
        auth_status: result.auth_status ?? (result.available ? 'healthy' : 'unprobed'),
        execute_status: result.execute_status ?? (result.available ? 'healthy' : 'unprobed'),
        transport_status: result.transport_status ?? 'unprobed',
        ready_for_execution:
          result.ready_for_execution ?? result.available,
        failure_kind: result.failure_kind,
        error: result.error ?? result.error_summary,
        error_summary: result.error_summary ?? result.error,
        recoverable: result.recoverable,
        last_checked_at: this.now().toISOString(),
        repair_configured: this.hasRepairCommand(provider),
        repair_command_preview: this.getRepairCommandPreview(provider),
        last_repair_at,
        last_repair_summary,
        lastRepairAtMs,
      });
    }
  }

  private async safePollOnce(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[provider-health] monitor poll failed: ${message}`);
    }
  }

  private async probeProvider(adapter: ProviderAdapter): Promise<ProviderHealthProbe> {
    try {
      return adapter.probeHealth
        ? await adapter.probeHealth()
        : {
            available: await adapter.health(),
            status: 'healthy',
            auth_status: 'healthy',
            execute_status: 'healthy',
            transport_status: 'unprobed',
            ready_for_execution: true,
            recoverable: false,
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        status: 'unknown',
        auth_status: 'unprobed',
        execute_status: 'unknown',
        transport_status: 'unprobed',
        ready_for_execution: false,
        error: message,
        error_summary: message,
        recoverable: false,
      };
    }
  }

  private shouldAttemptRepair(provider: string, result: ProviderHealthProbe): boolean {
    if (!this.options.repairCommands[provider]) {
      return false;
    }
    return result.auth_status === 'auth_failed' || result.failure_kind === 'auth_failed';
  }

  private async tryRepair(
    provider: string,
    previous: ProviderHealthState | undefined,
  ): Promise<RepairAttempt | undefined> {
    const command = this.options.repairCommands[provider];
    if (!command) {
      return undefined;
    }

    const attemptedAt = this.now().getTime();
    if (
      previous?.lastRepairAtMs &&
      attemptedAt - previous.lastRepairAtMs < this.options.repairCooldownMs
    ) {
      return undefined;
    }

    try {
      const output = await (this.options.runRepairCommand
        ? this.options.runRepairCommand(provider, command)
        : this.runRepairCommand(provider, command));
      return { attemptedAt, summary: output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { attemptedAt, summary: `repair failed: ${message}` };
    }
  }

  private async runRepairCommand(provider: string, command: string): Promise<string> {
    const { stdout, stderr } = await execAsync(command, {
      shell: '/bin/bash',
      timeout: 60_000,
      env: process.env,
    });
    const combined = `${stdout}\n${stderr}`.trim().replace(/\s+/g, ' ');
    return combined ? `${provider}: ${combined.slice(0, 240)}` : `${provider}: command completed`;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private hasRepairCommand(provider: string): boolean {
    return Boolean(this.options.repairCommands[provider]);
  }

  private getRepairCommandPreview(provider: string): string | undefined {
    const command = this.options.repairCommands[provider];
    if (!command) {
      return undefined;
    }
    return command.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
}
