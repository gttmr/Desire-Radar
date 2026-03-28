import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  summarizeProviderFailure,
} from './errors.js';

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

const CODEX_HEALTH_PROMPT = 'Reply with exactly OK';

type CodexProviderOptions = {
  defaultTransportMode?: ProviderTransportMode;
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
  readonly defaultTransportMode: ProviderTransportMode;

  constructor(
    private readonly execPath: string = 'codex',
    private readonly timeoutMs: number = 120_000,
    options: CodexProviderOptions = {},
  ) {
    this.defaultTransportMode = options.defaultTransportMode ?? 'cli_exec';
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model;

    try {
      const output = await this.runDetailed(
        this.buildExecuteArgs(request),
        undefined,
        request.timeoutMs,
        request.workingDirectory,
      );
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
      if (!/logged in/i.test(output)) {
        return buildFailedHealthProbe(
          `Codex login status did not confirm authentication: ${output.trim()}`,
        );
      }

      try {
        const execOutput = await this.runDetailed(
          [
            'exec',
            '--skip-git-repo-check',
            '--ephemeral',
            '-C',
            '/tmp',
            '-s',
            'read-only',
            '--json',
            CODEX_HEALTH_PROMPT,
          ],
          undefined,
          20_000,
        );
        extractCodexExecResult(execOutput.stdout);
        return buildProviderHealthProbe({
          auth_status: 'healthy',
          execute_status: 'healthy',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const classified = buildFailedHealthProbe(message);
        return buildProviderHealthProbe({
          auth_status: 'healthy',
          execute_status: classified.failure_kind ?? 'unknown',
          error_summary: classified.error_summary ?? summarizeProviderFailure(message),
          error: message,
        });
      }
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
    cwd?: string,
  ): Promise<CommandOutput> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        this.execPath,
        args,
        {
          cwd,
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

  private buildExecuteArgs(request: ProviderExecutionRequest): string[] {
    const model = request.model;
    const workingDirectory = request.workingDirectory || '/tmp';
    const isResume = (request.turnCount ?? 0) > 0 && Boolean(request.sessionId);

    if (isResume) {
      const args = [
        'exec',
        'resume',
        '--skip-git-repo-check',
        '--json',
      ];
      if (model) {
        args.splice(1, 0, '-m', model);
      }
      args.push(request.sessionId as string, request.prompt);
      return args;
    }

    const args = [
      'exec',
      '--skip-git-repo-check',
      '-C',
      workingDirectory,
      '-s',
      'read-only',
      '--json',
      request.prompt,
    ];
    if (model) {
      args.splice(1, 0, '-m', model);
    }
    return args;
  }
}
