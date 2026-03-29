import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHealthProbe,
  ProviderTransportMode,
  ProviderResult,
} from './base.js';
import {
  buildDegradedProviderResult,
  buildFailedHealthProbe,
  buildProviderHealthProbe,
} from './errors.js';
type GeminiProviderOptions = {
  defaultTransportMode?: ProviderTransportMode;
  healthProbeModel?: string;
};

export function classifyGeminiError(message: string): string {
  if (/MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|status 429|Too Many Requests/i.test(message)) {
    return 'Gemini reachable but temporarily unavailable (capacity/rate limit).';
  }
  if (/unauthorized|forbidden|auth|credential|login/i.test(message)) {
    return 'Gemini authentication failed.';
  }
  return message;
}

export function buildGeminiEnv(
  execPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const execDir = path.dirname(execPath);
  const currentPath = baseEnv.PATH ?? '';
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  if (execDir && execDir !== '.' && !pathEntries.includes(execDir)) {
    pathEntries.unshift(execDir);
  }

  return {
    ...baseEnv,
    HOME: baseEnv.HOME ?? '/home/node',
    PATH: pathEntries.join(path.delimiter),
  };
}

export function extractGeminiPromptResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Gemini CLI returned empty output');
  }

  try {
    const payload = JSON.parse(trimmed) as { response?: string };
    if (typeof payload.response === 'string' && payload.response.trim()) {
      return payload.response.trim();
    }
    throw new Error(`Gemini CLI returned empty response payload: ${trimmed.slice(0, 500)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Gemini CLI returned')) {
      throw error;
    }
    return trimmed;
  }
}

export class GeminiProvider implements ProviderAdapter {
  readonly name = 'gemini';
  readonly defaultTransportMode: ProviderTransportMode;
  private readonly healthProbeModel: string;

  constructor(
    private readonly execPath: string = 'gemini',
    private readonly timeoutMs: number = 120_000,
    options: GeminiProviderOptions = {},
  ) {
    this.defaultTransportMode = options.defaultTransportMode ?? 'cli_exec';
    this.healthProbeModel = options.healthProbeModel ?? 'gemini-2.5-flash';
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.logicalSessionId ?? request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model;

    try {
      const args = ['-o', 'json', '-p', request.prompt];
      if ((request.turnCount ?? 0) > 0) {
        args.unshift('latest');
        args.unshift('--resume');
      }
      if (model) {
        args.push('--model', model);
      }
      const text = extractGeminiPromptResult(
        await this.run(args, request.timeoutMs, request.workingDirectory),
      );
      return { text, sessionId: sid, durationMs: Date.now() - start, model, status: 'completed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[gemini] execution failed: ${message}`);
      return buildDegradedProviderResult({
        sessionId: sid,
        durationMs: Date.now() - start,
        model,
        message: classifyGeminiError(message),
      });
    }
  }

  async health(): Promise<boolean> {
    return (await this.probeHealth()).available;
  }

  async probeHealth(): Promise<ProviderHealthProbe> {
    try {
      const output = await this.run(
        ['-o', 'json', '--model', this.healthProbeModel, '-p', 'Reply with exactly OK'],
        20_000,
      );
      extractGeminiPromptResult(output);
      return buildProviderHealthProbe({
        auth_status: 'healthy',
        execute_status: 'healthy',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const classified = buildFailedHealthProbe(classifyGeminiError(message));
      const failureKind = classified.failure_kind ?? 'unknown';
      if (failureKind === 'auth_failed') {
        return classified;
      }
      return buildProviderHealthProbe({
        auth_status: 'healthy',
        execute_status: failureKind,
        error_summary: classified.error_summary ?? classified.error,
      });
    }
  }

  private run(args: string[], timeoutOverride?: number, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.execPath,
        args,
        {
          cwd,
          timeout: timeoutOverride ?? this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: buildGeminiEnv(this.execPath),
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr?.trim() ? `${err.message}: ${stderr.trim()}` : err.message;
            return reject(new Error(detail));
          }
          resolve(stdout.trim());
        },
      );
    });
  }
}
