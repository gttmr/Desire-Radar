import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderExecutionRequest, ProviderHealthProbe, ProviderResult } from '../src/providers/base.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ProviderHealthMonitor } from '../src/providers/providerHealthMonitor.js';

class ProbeProvider implements ProviderAdapter {
  readonly name: string;

  constructor(
    name: string,
    private readonly probes: ProviderHealthProbe[],
  ) {
    this.name = name;
  }

  async execute(_request: ProviderExecutionRequest): Promise<ProviderResult> {
    throw new Error('Not used');
  }

  async health(): Promise<boolean> {
    const next = this.probes[0] ?? { available: false };
    return next.available;
  }

  async probeHealth(): Promise<ProviderHealthProbe> {
    const next = this.probes.shift();
    if (!next) {
      throw new Error(`No more probe results configured for ${this.name}`);
    }
    return next;
  }
}

describe('ProviderHealthMonitor', () => {
  it('stores probed provider state', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ProbeProvider('codex', [{ available: true }]));

    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 60_000,
      repairCommands: {},
    });

    await monitor.pollOnce();

    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({
        provider: 'codex',
        available: true,
        status: 'healthy',
        repair_configured: false,
      }),
    ]);
  });

  it('runs repair command once and records recovered state', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new ProbeProvider('claude', [
        { available: false, status: 'auth_failed', error: 'auth expired', recoverable: true },
        { available: true, status: 'healthy', recoverable: false },
      ]),
    );

    const runRepairCommand = vi.fn(async () => 'claude: auth login completed');
    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 60_000,
      repairCommands: { claude: 'claude auth login' },
      runRepairCommand,
    });

    await monitor.pollOnce();

    expect(runRepairCommand).toHaveBeenCalledWith('claude', 'claude auth login');
    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({
        provider: 'claude',
        available: true,
        status: 'healthy',
        repair_configured: true,
        repair_command_preview: 'claude auth login',
        last_repair_summary: 'claude: auth login completed',
      }),
    ]);
  });

  it('does not rerun repair during cooldown', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new ProbeProvider('gemini', [
        { available: false, status: 'auth_failed', error: 'auth expired', recoverable: true },
        { available: false, status: 'auth_failed', error: 'auth expired', recoverable: true },
        { available: false, status: 'auth_failed', error: 'auth expired', recoverable: true },
      ]),
    );

    let currentTime = Date.parse('2026-03-26T00:00:00Z');
    const now = vi.fn(() => new Date(currentTime));
    const runRepairCommand = vi.fn(async () => 'gemini: repair completed');
    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 3_600_000,
      repairCommands: { gemini: 'repair-gemini' },
      now,
      runRepairCommand,
    });

    await monitor.pollOnce();
    currentTime = Date.parse('2026-03-26T00:10:00Z');
    await monitor.pollOnce();

    expect(runRepairCommand).toHaveBeenCalledTimes(1);
  });

  it('does not run repair for non-auth availability failures', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new ProbeProvider('gemini', [{ available: false, status: 'rate_limited', error: 'rate limited', recoverable: true }]),
    );

    const runRepairCommand = vi.fn(async () => 'gemini: repair completed');
    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 60_000,
      repairCommands: { gemini: 'repair-gemini' },
      runRepairCommand,
    });

    await monitor.pollOnce();

    expect(runRepairCommand).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({
        provider: 'gemini',
        available: false,
        status: 'rate_limited',
        error: 'rate limited',
      }),
    ]);
  });

  it('keeps polling other providers when one probe throws', async () => {
    class ThrowingProvider extends ProbeProvider {
      override async probeHealth(): Promise<ProviderHealthProbe> {
        throw new Error('probe crashed');
      }
    }

    const registry = new ProviderRegistry();
    registry.register(new ThrowingProvider('codex', []));
    registry.register(new ProbeProvider('claude', [{ available: true }]));

    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 60_000,
      repairCommands: {},
    });

    await monitor.pollOnce();

    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({
        provider: 'codex',
        available: false,
        status: 'unknown',
        error: 'probe crashed',
      }),
      expect.objectContaining({
        provider: 'claude',
        available: true,
        status: 'healthy',
      }),
    ]);
  });

  it('dedupes concurrent polls into a single provider probe pass', async () => {
    const probeHealth = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { available: true } satisfies ProviderHealthProbe;
    });

    const registry = new ProviderRegistry();
    registry.register({
      name: 'codex',
      execute: async () => {
        throw new Error('Not used');
      },
      health: async () => true,
      probeHealth,
    });

    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 60_000,
      repairCommands: {},
    });

    await Promise.all([monitor.pollOnce(), monitor.pollOnce(), monitor.pollOnce()]);

    expect(probeHealth).toHaveBeenCalledTimes(1);
  });

  it('advertises configured repair commands before the first successful probe', () => {
    const registry = new ProviderRegistry();
    registry.register(new ProbeProvider('codex', []));

    const monitor = new ProviderHealthMonitor(registry, {
      pollIntervalMs: 60_000,
      repairCooldownMs: 60_000,
      repairCommands: {
        codex: 'printenv OPENAI_API_KEY | codex login --with-api-key',
      },
    });

    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({
        provider: 'codex',
        available: false,
        status: 'unprobed',
        repair_configured: true,
        repair_command_preview: 'printenv OPENAI_API_KEY | codex login --with-api-key',
      }),
    ]);
  });
});
