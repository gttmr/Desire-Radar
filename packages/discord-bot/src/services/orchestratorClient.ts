import type {
  SubmitEvidenceRequest,
  SubmitEvidenceResponse,
  RunDebateRequest,
  RunDebateResponse,
  SynthesizeReportRequest,
  SynthesizeReportResponse,
  RunStateResponse,
  ListSessionsResponse,
  OrchestratorHealthResponse,
  RunFromCandidateRequest,
  RunFromCandidateResponse,
  ListHighLevelRunsResponse,
  GetHighLevelRunResponse,
  GetRunResearchResponse,
  GetRunVerdictResponse,
  GetRunProviderExecutionsResponse,
  RunResearchLoopResponse,
  RunVerdictResponse,
  ListResearchRequestsResponse,
  InvestmentIntakeRequest,
  InvestmentIntakeResponse,
  GetInvestmentIntakeResponse,
  GetInvestmentAssetResponse,
  CreateInvestmentDecisionRunRequest,
  CreateInvestmentDecisionRunResponse,
  GetInvestmentDecisionRunResponse,
  GetLatestInvestmentDecisionResponse,
  InvestmentDecisionReportResponse,
  GetInvestmentEquityMapResponse,
  PutInvestmentEquityMapRequest,
  PutInvestmentEquityMapResponse,
} from '@agentic/shared-types';

export class OrchestratorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async submitEvidence(req: SubmitEvidenceRequest): Promise<SubmitEvidenceResponse> {
    return this.post('/runs/submit-evidence', req);
  }

  async runFromCandidate(req: RunFromCandidateRequest): Promise<RunFromCandidateResponse> {
    return this.post('/runs/from-candidate', req);
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

  async listRuns(): Promise<ListHighLevelRunsResponse> {
    return this.get('/runs');
  }

  async getRun(runId: string): Promise<GetHighLevelRunResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}`);
  }

  async getRunResearch(runId: string): Promise<GetRunResearchResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/research`);
  }

  async getRunVerdict(runId: string): Promise<GetRunVerdictResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/verdict`);
  }

  async getRunProviderExecutions(runId: string): Promise<GetRunProviderExecutionsResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/provider-executions`);
  }

  async rerunResearch(runId: string): Promise<RunResearchLoopResponse> {
    return this.post(`/runs/${encodeURIComponent(runId)}/research`, {});
  }

  async rerunVerdict(runId: string): Promise<RunVerdictResponse> {
    return this.post(`/runs/${encodeURIComponent(runId)}/verdict`, {});
  }

  async getResearchRequests(runId: string): Promise<ListResearchRequestsResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/research-requests`);
  }

  async submitInvestmentIntake(req: InvestmentIntakeRequest): Promise<InvestmentIntakeResponse> {
    return this.post('/investment/intake', req);
  }

  async getInvestmentIntake(intakeId: string): Promise<GetInvestmentIntakeResponse> {
    return this.get(`/investment/intakes/${encodeURIComponent(intakeId)}`);
  }

  async getInvestmentAsset(assetKey: string): Promise<GetInvestmentAssetResponse> {
    return this.get(`/investment/assets/${encodeURIComponent(assetKey)}`);
  }

  async createInvestmentDecisionRun(
    req: CreateInvestmentDecisionRunRequest,
  ): Promise<CreateInvestmentDecisionRunResponse> {
    return this.post('/investment/decisions/runs', req);
  }

  async getInvestmentDecisionRun(
    runId: string,
    detail: 'summary' | 'full' = 'full',
  ): Promise<GetInvestmentDecisionRunResponse> {
    return this.get(
      `/investment/decisions/runs/${encodeURIComponent(runId)}?detail=${encodeURIComponent(detail)}`,
    );
  }

  async getLatestInvestmentDecision(
    detail: 'summary' | 'full' = 'full',
  ): Promise<GetLatestInvestmentDecisionResponse> {
    return this.get(`/investment/decisions/latest?detail=${encodeURIComponent(detail)}`);
  }

  async getInvestmentDecisionReport(
    runId: string,
    detail: 'summary' | 'full' = 'full',
  ): Promise<InvestmentDecisionReportResponse> {
    return this.get(
      `/investment/decisions/runs/${encodeURIComponent(runId)}/report?detail=${encodeURIComponent(detail)}`,
    );
  }

  async getInvestmentEquityMap(): Promise<GetInvestmentEquityMapResponse> {
    return this.get('/investment/equity-map');
  }

  async replaceInvestmentEquityMap(
    req: PutInvestmentEquityMapRequest,
  ): Promise<PutInvestmentEquityMapResponse> {
    return this.put('/investment/equity-map', req);
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

  private async put<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'PUT',
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
