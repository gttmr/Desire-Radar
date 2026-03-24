import type {
  SubmitEvidenceRequest,
  SubmitEvidenceResponse,
  RunDebateRequest,
  RunDebateResponse,
  SynthesizeReportRequest,
  SynthesizeReportResponse,
  RunStateResponse,
  ListSessionsResponse,
  OrchestratorHealthResponse
} from '@agentic/shared-types';

export class OrchestratorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async submitEvidence(req: SubmitEvidenceRequest): Promise<SubmitEvidenceResponse> {
    return this.post('/runs/submit-evidence', req);
  }

  async runDebate(req: RunDebateRequest): Promise<RunDebateResponse> {
    return this.post('/runs/debate', req);
  }

  async synthesizeReport(req: SynthesizeReportRequest): Promise<SynthesizeReportResponse> {
    return this.post('/runs/synthesize', req);
  }

  async getRunState(runId: string): Promise<RunStateResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/state`);
  }

  async listSessions(agentName?: string): Promise<ListSessionsResponse> {
    const query = agentName ? `?agent_name=${encodeURIComponent(agentName)}` : '';
    return this.get(`/sessions${query}`);
  }

  async health(): Promise<OrchestratorHealthResponse> {
    return this.get('/health');
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl));
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Orchestrator request failed (${response.status}): ${text}`);
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
      throw new Error(`Orchestrator request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }
}
