import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderResult } from './base.js';

export class CodexProvider implements ProviderAdapter {
  readonly name = 'codex';

  constructor(
    private readonly execPath: string = 'codex',
    private readonly timeoutMs: number = 120_000,
  ) {}

  async execute(prompt: string, sessionId?: string): Promise<ProviderResult> {
    const sid = sessionId ?? randomUUID();
    const start = Date.now();

    try {
      const text = await this.run(['exec', '--quiet'], prompt);
      return { text, sessionId: sid, durationMs: Date.now() - start };
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
      };
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.run(['--version'], undefined, 10_000);
      return true;
    } catch {
      return false;
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
