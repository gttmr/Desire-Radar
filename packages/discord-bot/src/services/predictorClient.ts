import type { AgentSignal, KnowledgeEntry, PredictorRequest, PredictorResponse } from '../types/domain.js';

export class PredictorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generateReport(request: PredictorRequest): Promise<PredictorResponse> {
    return this.post<PredictorResponse>('/reports/generate', request);
  }

  // ------------------------------------------------------------------
  // Agent signals
  // ------------------------------------------------------------------

  async getAgentSignals(): Promise<AgentSignal[]> {
    const data = await this.get<{ signals: AgentSignal[] }>('/agents/signals');
    return data.signals;
  }

  async runAgents(agents?: string[]): Promise<AgentSignal[]> {
    const data = await this.post<{ signals: AgentSignal[] }>('/agents/run', agents ? { agents } : {});
    return data.signals;
  }

  // ------------------------------------------------------------------
  // Knowledge base
  // ------------------------------------------------------------------

  async listKnowledge(): Promise<KnowledgeEntry[]> {
    const data = await this.get<{ entries: KnowledgeEntry[] }>('/knowledge');
    return data.entries;
  }

  async addKnowledge(content: string, tags: string[] = []): Promise<KnowledgeEntry> {
    return this.post<KnowledgeEntry>('/knowledge', { content, tags });
  }

  async removeKnowledge(id: string): Promise<void> {
    const response = await this.fetchImpl(new URL(`/knowledge/${id}`, this.baseUrl), {
      method: 'DELETE'
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Predictor request failed (${response.status}): ${text}`);
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl));
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Predictor request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Predictor request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }
}
