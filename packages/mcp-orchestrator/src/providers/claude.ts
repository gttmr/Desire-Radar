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
} from './errors.js';
type ClaudeProviderOptions = {
  defaultTransportMode?: ProviderTransportMode;
};

export function parseClaudeAuthStatus(stdout: string): ProviderHealthProbe {
  try {
    const payload = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    if (payload.loggedIn) {
      return { available: true, status: 'healthy', recoverable: false };
    }
    return buildFailedHealthProbe(
      `Claude auth status reported loggedIn=false${payload.authMethod ? ` (${payload.authMethod})` : ''}`,
    );
  } catch {
    return buildFailedHealthProbe(
      `Claude auth status returned non-JSON output: ${stdout.trim()}`,
    );
  }
}

export function extractClaudePrintResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Claude CLI returned empty output');
  }

  const assistantChunks: string[] = [];
  let resultText: string | undefined;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) {
      continue;
    }

    try {
      const payload = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };

      if (
        payload.type === 'result' &&
        (payload.is_error || /error/i.test(payload.subtype ?? ''))
      ) {
        const detail =
          typeof payload.result === 'string' && payload.result.trim()
            ? payload.result.trim()
            : line.slice(0, 500);
        throw new Error(`Claude CLI returned error output: ${detail}`);
      }

      if (payload.type === 'result' && typeof payload.result === 'string' && payload.result.trim()) {
        resultText = payload.result.trim();
      }

      if (payload.type !== 'assistant') {
        continue;
      }

      const content = Array.isArray(payload.message?.content) ? payload.message.content : [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          assistantChunks.push(block.text);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Claude CLI returned')) {
        throw error;
      }
    }
  }

  const text = assistantChunks.join('\n').trim();
  if (text) {
    return text;
  }
  if (resultText) {
    return resultText;
  }

  // Fallback for unexpected plain-text output formats.
  if (!trimmed.startsWith('{') && !trimmed.includes('\n')) {
    return trimmed;
  }

  throw new Error(`Claude CLI returned no assistant message: ${trimmed.slice(0, 500)}`);
}

export class ClaudeProvider implements ProviderAdapter {
  readonly name = 'claude';
  readonly defaultTransportMode: ProviderTransportMode;

  constructor(
    private readonly execPath: string = 'claude',
    private readonly timeoutMs: number = 120_000,
    options: ClaudeProviderOptions = {},
  ) {
    this.defaultTransportMode = options.defaultTransportMode ?? 'cli_exec';
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.logicalSessionId ?? request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model;
    const resumeId = request.sessionId ?? request.logicalSessionId ?? sid;

    try {
      const args = ['-p', request.prompt, '--output-format', 'stream-json', '--verbose'];
      if (model) {
        args.push('--model', model);
      }
      if ((request.turnCount ?? 0) > 0) {
        args.push('--resume', resumeId);
      } else {
        args.push('--session-id', sid);
      }
      const text = extractClaudePrintResult(
        await this.run(args, request.timeoutMs, request.workingDirectory),
      );
      return {
        text,
        sessionId: resumeId,
        durationMs: Date.now() - start,
        model,
        status: 'completed',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[claude] execution failed: ${message}`);
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
      const output = await this.run(['auth', 'status'], 10_000);
      const auth = parseClaudeAuthStatus(output);
      if (!auth.available) {
        return auth;
      }

      try {
        const executeOutput = await this.run(
          ['-p', 'Reply with exactly OK', '--output-format', 'stream-json', '--verbose'],
          20_000,
        );
        extractClaudePrintResult(executeOutput);
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
          error_summary: classified.error_summary ?? classified.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildFailedHealthProbe(message);
    }
  }

  private run(args: string[], timeoutOverride?: number, cwd?: string): Promise<string> {
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
            // Claude CLI reads auth from $HOME/.claude/
            HOME: process.env.HOME ?? '/home/node',
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            if (this.shouldAcceptStdoutOnError(stdout, stderr)) {
              return resolve(stdout.trim());
            }
            const detail = stderr?.trim() ? `${err.message}: ${stderr.trim()}` : err.message;
            return reject(new Error(detail));
          }
          resolve(stdout.trim());
        },
      );
      proc.stdin?.end();
    });
  }

  private shouldAcceptStdoutOnError(stdout: string, stderr: string): boolean {
    const trimmed = stdout.trim();
    if (!trimmed || stderr.trim()) {
      return false;
    }
    return trimmed.includes('"type":"assistant"') || trimmed.includes('"type":"result"');
  }
}
