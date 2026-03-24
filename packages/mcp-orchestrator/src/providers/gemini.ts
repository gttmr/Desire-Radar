import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderResult } from './base.js';

export class GeminiProvider implements ProviderAdapter {
  readonly name = 'gemini';

  constructor(
    private readonly execPath: string = 'gemini',
    private readonly timeoutMs: number = 120_000,
  ) {}

  async execute(prompt: string, sessionId?: string): Promise<ProviderResult> {
    const sid = sessionId ?? randomUUID();
    const start = Date.now();

    try {
      const args = ['-p', prompt];
      const text = await this.run(args);
      return { text, sessionId: sid, durationMs: Date.now() - start };
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
