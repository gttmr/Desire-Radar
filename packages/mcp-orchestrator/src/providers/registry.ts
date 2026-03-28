import type { ProviderAdapter } from './base.js';

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): ProviderAdapter | undefined {
    return this.adapters.get(name);
  }

  async getAvailable(): Promise<ProviderAdapter[]> {
    const results: ProviderAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const probe = adapter.probeHealth
          ? await adapter.probeHealth()
          : { available: await adapter.health() };
        if (probe.ready_for_execution ?? probe.available) {
          results.push(adapter);
        }
      } catch {
        // skip unhealthy provider
      }
    }
    return results;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
