import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHealthProbe,
  ProviderResult,
} from './base.js';
import { buildDegradedProviderResult, buildFailedHealthProbe } from './errors.js';

type CodexUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  uncachedInputTokens?: number;
};

type CodexExecResult = {
  messageText: string;
  threadId?: string;
  usage?: CodexUsage;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

export function extractCodexExecResult(stdout: string): CodexExecResult {
  let messageText: string | undefined;
  let threadId: string | undefined;
  let usage: CodexUsage | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) {
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (payload.type === 'thread.started' && typeof payload.thread_id === 'string') {
      threadId = payload.thread_id;
      continue;
    }

    if (payload.type === 'item.completed') {
      const item =
        payload.item && typeof payload.item === 'object'
          ? (payload.item as Record<string, unknown>)
          : undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        messageText = item.text;
      }
      continue;
    }

    if (payload.type === 'turn.completed') {
      const rawUsage =
        payload.usage && typeof payload.usage === 'object'
          ? (payload.usage as Record<string, unknown>)
          : undefined;
      if (rawUsage) {
        const inputTokens =
          typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : undefined;
        const cachedInputTokens =
          typeof rawUsage.cached_input_tokens === 'number'
            ? rawUsage.cached_input_tokens
            : undefined;
        const outputTokens =
          typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : undefined;
        usage = {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          uncachedInputTokens:
            typeof inputTokens === 'number' && typeof cachedInputTokens === 'number'
              ? inputTokens - cachedInputTokens
              : undefined,
        };
      }
    }
  }

  if (!messageText) {
    throw new Error(`Codex response missing agent_message: ${stdout.slice(0, 500)}`);
  }

  return { messageText, threadId, usage };
}

export class CodexProvider implements ProviderAdapter {
  readonly name = 'codex';

  constructor(
    private readonly execPath: string = 'codex',
    private readonly timeoutMs: number = 120_000,
  ) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model;

    try {
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '-C',
        '/tmp',
        '-s',
        'read-only',
        '--json',
        request.prompt,
      ];
      if (model) {
        args.splice(1, 0, '-m', model);
      }
      const output = await this.runDetailed(args, undefined, request.timeoutMs);
      const parsed = extractCodexExecResult(output.stdout);
      return {
        text: parsed.messageText,
        sessionId: parsed.threadId ?? sid,
        durationMs: Date.now() - start,
        model,
        status: 'completed',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codex] execution failed: ${message}`);
      return buildDegradedProviderResult({
        sessionId: sid,
        durationMs: Date.now() - start,
        model,
        message,
      });
    }
  }

  async health(): Promise<boolean> {
    return (await this.probeHealth()).available;
  }

  async probeHealth(): Promise<ProviderHealthProbe> {
    try {
      const output = await this.runCombined(['login', 'status'], undefined, 10_000);
      if (/logged in/i.test(output)) {
        return { available: true, status: 'healthy', recoverable: false };
      }
      return buildFailedHealthProbe(
        `Codex login status did not confirm authentication: ${output.trim()}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildFailedHealthProbe(message);
    }
  }

  private run(args: string[], stdin?: string, timeoutOverride?: number): Promise<string> {
    return this.runDetailed(args, stdin, timeoutOverride).then((result) => result.stdout);
  }

  private async runCombined(
    args: string[],
    stdin?: string,
    timeoutOverride?: number,
  ): Promise<string> {
    const result = await this.runDetailed(args, stdin, timeoutOverride);
    return `${result.stdout}\n${result.stderr}`.trim();
  }

  private runDetailed(
    args: string[],
    stdin?: string,
    timeoutOverride?: number,
  ): Promise<CommandOutput> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        this.execPath,
        args,
        {
          timeout: timeoutOverride ?? this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            // Ensure codex finds its auth config at $HOME/.codex
            HOME: process.env.HOME ?? '/home/node',
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr?.trim() ? `${err.message}: ${stderr.trim()}` : err.message;
            return reject(new Error(detail));
          }
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        },
      );
      if (stdin && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }
    });
  }
}
