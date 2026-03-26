import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHealthProbe,
  ProviderResult,
} from './base.js';

export function parseClaudeAuthStatus(stdout: string): ProviderHealthProbe {
  try {
    const payload = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    if (payload.loggedIn) {
      return { available: true };
    }
    return {
      available: false,
      error: `Claude auth status reported loggedIn=false${payload.authMethod ? ` (${payload.authMethod})` : ''}`,
    };
  } catch {
    return {
      available: false,
      error: `Claude auth status returned non-JSON output: ${stdout.trim()}`,
    };
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
        is_error?: boolean;
        result?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };

      if (payload.type === 'result' && payload.is_error) {
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

  constructor(
    private readonly execPath: string = 'claude',
    private readonly timeoutMs: number = 120_000,
  ) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model;

    try {
      const args = ['-p', request.prompt, '--output-format', 'stream-json', '--verbose'];
      if (model) {
        args.push('--model', model);
      }
      if (request.sessionId) {
        args.push('--resume', request.sessionId);
      }
      const text = extractClaudePrintResult(await this.run(args, request.timeoutMs));
      return { text, sessionId: sid, durationMs: Date.now() - start, model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[claude] execution failed: ${message}`);
      return {
        text: JSON.stringify({
          summary: `[claude-mock] ${message}`,
          confidence: 0.5,
          claims: [],
          evidence_used: [],
          open_questions: ['Claude CLI not available — mock response'],
          messages_for_other_agents: [],
          recommended_next_step: 'retry_with_claude',
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
      const output = await this.run(['auth', 'status'], 10_000);
      return parseClaudeAuthStatus(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { available: false, error: message };
    }
  }

  private run(args: string[], timeoutOverride?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        this.execPath,
        args,
        {
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
            if (stdout.trim()) {
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
}
