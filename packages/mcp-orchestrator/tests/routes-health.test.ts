import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderExecutionRequest, ProviderHealthProbe, ProviderResult } from '../src/providers/base.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SessionStore } from '../src/sessions/session-store.js';
import { createRoutes } from '../src/api/routes.js';

class StaticHealthProvider implements ProviderAdapter {
  readonly name: string;

  constructor(
    name: string,
    private readonly probe: ProviderHealthProbe,
  ) {
    this.name = name;
  }

  async execute(_request: ProviderExecutionRequest): Promise<ProviderResult> {
    throw new Error('Not used in health route test');
  }

  async health(): Promise<boolean> {
    return this.probe.available;
  }

  async probeHealth(): Promise<ProviderHealthProbe> {
    return this.probe;
  }
}

function makeOrchestratorStub() {
  return {
    getReports: () => [],
    listHighLevelRuns: () => [],
    getHighLevelRun: () => null,
    getRunResearch: () => null,
    getRunVerdict: () => null,
    getProviderExecutions: () => [],
    listResearchRequests: () => [],
  } as never;
}

describe('/health route', () => {
  let server: ReturnType<express.Express['listen']> | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = undefined;
    });
  });

  it('returns provider availability and error details', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new StaticHealthProvider('codex', {
        available: true,
        status: 'healthy',
        auth_status: 'healthy',
        execute_status: 'healthy',
        ready_for_execution: true,
      }),
    );
    registry.register(
      new StaticHealthProvider('claude', {
        available: false,
        status: 'auth_failed',
        auth_status: 'auth_failed',
        execute_status: 'unprobed',
        ready_for_execution: false,
        failure_kind: 'auth_failed',
        error: 'Claude auth status reported loggedIn=false (claude.ai)',
        recoverable: true,
      }),
    );

    const app = express();
    app.use(express.json());
    app.use(createRoutes(makeOrchestratorStub(), new SessionStore('/tmp/mcp-health-test'), registry));
    server = app.listen(0);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine test server address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const payload = (await response.json()) as {
      providers: Array<{
        provider: string;
        available: boolean;
        status?: string;
        auth_status?: string;
        execute_status?: string;
        ready_for_execution?: boolean;
        failure_kind?: string;
        recoverable?: boolean;
        error?: string;
      }>;
    };

    expect(payload.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'codex', available: true }),
        expect.objectContaining({
          provider: 'claude',
          available: false,
          status: 'auth_failed',
          auth_status: 'auth_failed',
          execute_status: 'unprobed',
          ready_for_execution: false,
          failure_kind: 'auth_failed',
          recoverable: true,
          error: 'Claude auth status reported loggedIn=false (claude.ai)',
        }),
      ]),
    );
  });
});
