import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderExecutionRequest, ProviderResult } from './base.js';

export class OpenAIProvider implements ProviderAdapter {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number = 60_000,
    private readonly baseUrl: string = 'https://api.openai.com/v1',
  ) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderResult> {
    const sid = request.sessionId ?? randomUUID();
    const start = Date.now();
    const model = request.model ?? 'gpt-5';

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? this.timeoutMs,
    );

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You are an analytical agent. Always respond with valid JSON matching this schema: { "summary": string, "confidence": number (0-1), "claims": [{"claim": string, "confidence": number, "supporting_evidence": [string]}], "evidence_used": [string], "open_questions": [string], "messages_for_other_agents": [{"target_agent": string, "content": string}], "recommended_next_step": string }',
            },
            { role: 'user', content: request.prompt },
          ],
          temperature: 0.3,
          max_tokens: request.maxOutputTokens ?? 4096,
          ...(request.responseFormat === 'json'
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errText}`);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const text = data.choices[0]?.message?.content ?? '{}';

      return { text, sessionId: sid, durationMs: Date.now() - start, model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[openai] execution failed: ${message}`);
      return {
        text: JSON.stringify({
          summary: `[openai-error] ${message}`,
          confidence: 0,
          claims: [],
          evidence_used: [],
          open_questions: ['OpenAI API call failed'],
          messages_for_other_agents: [],
          recommended_next_step: 'retry',
        }),
        sessionId: sid,
        durationMs: Date.now() - start,
        model,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}
