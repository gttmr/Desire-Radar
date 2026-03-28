import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ProviderExecutionRequest,
  ProviderHealthProbe,
  ProviderResult,
} from './base.js';
import { buildDegradedProviderResult } from './errors.js';

type ExternalInboxOptions = {
  provider: string;
  pollIntervalMs: number;
};

type ExternalSessionRequest = {
  request_id: string;
  provider: string;
  logical_session_id?: string;
  provider_session_id?: string;
  phase: string;
  agent_name: string;
  model_profile: string;
  model?: string;
  response_format?: string;
  turn_count: number;
  prompt: string;
  created_at: string;
};

type ExternalSessionResponse = {
  request_id: string;
  text: string;
  session_id?: string;
  status?: 'completed' | 'degraded';
  degraded_kind?: ProviderResult['degraded_kind'];
  degraded_message?: string;
  recoverable?: boolean;
};

export class ExternalInboxTransport {
  constructor(private readonly options: ExternalInboxOptions) {}

  async probe(target?: string | null): Promise<ProviderHealthProbe> {
    if (!target) {
      return {
        available: false,
        status: 'unknown',
        transport_status: 'unknown',
        ready_for_execution: false,
        error_summary: `${this.options.provider} external injection target is missing`,
        recoverable: true,
      };
    }
    const inboxDir = join(target, 'inbox');
    const outboxDir = join(target, 'outbox');
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    return {
      available: true,
      status: 'healthy',
      auth_status: 'unprobed',
      execute_status: 'unprobed',
      transport_status: 'healthy',
      ready_for_execution: true,
      recoverable: false,
    };
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const startedAt = Date.now();
    const sessionDir = request.transportTarget ?? request.workingDirectory;
    if (!sessionDir) {
      return buildDegradedProviderResult({
        sessionId: request.logicalSessionId ?? request.sessionId ?? randomUUID(),
        durationMs: Date.now() - startedAt,
        model: request.model,
        message: `${this.options.provider} external injection transport requires transportTarget`,
      });
    }

    const requestId = randomUUID();
    const inboxDir = join(sessionDir, 'inbox');
    const outboxDir = join(sessionDir, 'outbox');
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });

    const payload: ExternalSessionRequest = {
      request_id: requestId,
      provider: this.options.provider,
      logical_session_id: request.logicalSessionId,
      provider_session_id: request.sessionId,
      phase: request.phase,
      agent_name: request.agentName,
      model_profile: request.modelProfile,
      model: request.model,
      response_format: request.responseFormat,
      turn_count: request.turnCount ?? 0,
      prompt: request.prompt,
      created_at: new Date().toISOString(),
    };

    writeFileSync(
      join(inboxDir, `${requestId}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf-8',
    );

    const responsePath = join(outboxDir, `${requestId}.json`);
    const deadline = Date.now() + (request.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const raw = readFileSync(responsePath, 'utf-8');
        const response = JSON.parse(raw) as ExternalSessionResponse;
        rmSync(responsePath, { force: true });
        return {
          text: response.text,
          sessionId:
            response.session_id ??
            request.sessionId ??
            request.logicalSessionId ??
            randomUUID(),
          durationMs: Date.now() - startedAt,
          model: request.model,
          status: response.status ?? 'completed',
          degraded_kind: response.degraded_kind,
          degraded_message: response.degraded_message,
          recoverable: response.recoverable,
        };
      }
      await sleep(this.options.pollIntervalMs);
    }

    return buildDegradedProviderResult({
      sessionId: request.sessionId ?? request.logicalSessionId ?? randomUUID(),
      durationMs: Date.now() - startedAt,
      model: request.model,
      message: `${this.options.provider} external inbox timed out waiting for ${responsePath}`,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
