import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHealthProbe,
  ProviderResult,
} from './base.js';

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
        '-',
      ];
      if (model) {
        args.splice(1, 0, '-m', model);
      }
      const stdout = await this.run(args, request.prompt, request.timeoutMs);
      const parsed = extractCodexExecResult(stdout);
      return {
        text: parsed.messageText,
        sessionId: parsed.threadId ?? sid,
        durationMs: Date.now() - start,
        model,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codex] execution failed: ${message}`);
      return {
        text: JSON.stringify({
          summary: `[codex-mock] ${message}`,
          confidence: 0.5,
          claims: [],
          evidence_used: [],
          open_questions: ['Codex CLI not available — mock response'],
          messages_for_other_agents: [],
          recommended_next_step: 'retry_with_codex',
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
      const output = await this.run(['login', 'status'], undefined, 10_000);
      if (/logged in/i.test(output)) {
        return { available: true };
      }
      return {
        available: false,
        error: `Codex login status did not confirm authentication: ${output.trim()}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { available: false, error: message };
    }
  }

  private run(args: string[], stdin?: string, timeoutOverride?: number): Promise<string> {
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
          resolve(stdout.trim());
        },
      );
      if (stdin && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }
    });
  }
}
