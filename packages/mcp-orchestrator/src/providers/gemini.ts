import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHealthProbe,
  ProviderResult,
} from './base.js';

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

export class GeminiProvider implements ProviderAdapter {
  readonly name = 'gemini';

  constructor(
    private readonly execPath: string = 'gemini',
    private readonly timeoutMs: number = 120_000,
  ) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model;

    try {
      const args = ['-p', request.prompt];
      if (model) {
        args.push('--model', model);
      }
      const text = await this.run(args, request.timeoutMs);
      return { text, sessionId: sid, durationMs: Date.now() - start, model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[gemini] execution failed: ${message}`);
      return {
        text: JSON.stringify({
          summary: `[gemini-mock] ${message}`,
          confidence: 0.5,
          claims: [],
          evidence_used: [],
          open_questions: ['Gemini CLI not available — mock response'],
          messages_for_other_agents: [],
          recommended_next_step: 'retry_with_gemini',
        }),
        sessionId: sid,
        durationMs: Date.now() - start,
        model,
      };
    }
  }

  async health(): Promise<boolean> {
    return (await this.probeHealth()).available;
  }

  async probeHealth(): Promise<ProviderHealthProbe> {
    try {
      await this.run(['-p', 'Reply with exactly OK'], 20_000);
      return { available: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { available: false, error: classifyGeminiError(message) };
    }
  }

  private run(args: string[], timeoutOverride?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.execPath,
        args,
        {
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
