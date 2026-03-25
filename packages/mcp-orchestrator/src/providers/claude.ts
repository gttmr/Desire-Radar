import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderExecutionRequest, ProviderResult } from './base.js';

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
      const args = ['-p', request.prompt];
      if (model) {
        args.push('--model', model);
      }
      if (request.sessionId) {
        args.push('--continue', request.sessionId);
      }
      const text = await this.run(args, request.timeoutMs);
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
    try {
      await this.run(['--version'], 10_000);
      return true;
    } catch {
      return false;
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
          env: {
            ...process.env,
            // Claude CLI reads auth from $HOME/.claude/
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
    });
  }
}
