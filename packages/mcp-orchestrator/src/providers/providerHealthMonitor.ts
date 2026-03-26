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
  lastRepairAt?: number;
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
          last_checked_at: new Date(0).toISOString(),
          error: 'provider health has not been probed yet',
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
      let lastRepairAt = previous?.lastRepairAt;

      if (!result.available && this.shouldAttemptRepair(provider, result.error)) {
        const repairAttempt = await this.tryRepair(provider, previous);
        if (repairAttempt) {
          lastRepairAt = repairAttempt.attemptedAt;
          const afterRepair = await this.probeProvider(adapter);
          if (afterRepair.available) {
            result = afterRepair;
          } else {
            result = {
              available: afterRepair.available,
              error: `${afterRepair.error ?? 'provider unavailable'} | repair: ${repairAttempt.summary}`,
            };
          }
        }
      }

      this.states.set(provider, {
        provider,
        available: result.available,
        error: result.error,
        last_checked_at: this.now().toISOString(),
        lastRepairAt,
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
        : { available: await adapter.health() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, error: message };
    }
  }

  private shouldAttemptRepair(provider: string, error?: string): boolean {
    if (!this.options.repairCommands[provider] || !error) {
      return false;
    }
    if (
      /capacity|rate limit|too many requests|resource exhausted|temporarily unavailable/i.test(
        error,
      )
    ) {
      return false;
    }
    return /auth|login|credential|token|session|expired|unauthorized|forbidden/i.test(error);
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
      previous?.lastRepairAt &&
      attemptedAt - previous.lastRepairAt < this.options.repairCooldownMs
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
}
