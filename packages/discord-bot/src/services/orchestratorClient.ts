import http from 'node:http';
import https from 'node:https';
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
  NormalizeInvestmentEquityRequest,
  NormalizeInvestmentEquityResponse,
  PutInvestmentEquityMapRequest,
  PutInvestmentEquityMapResponse,
} from '@agentic/shared-types';

export class OrchestratorClient {
  constructor(private readonly baseUrl: string) {}

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

  async normalizeInvestmentEquity(
    req: NormalizeInvestmentEquityRequest,
  ): Promise<NormalizeInvestmentEquityResponse> {
    return this.post('/investment/normalize-equity', req);
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
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise<T>((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method,
          headers: payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload).toString(),
              }
            : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`Orchestrator request failed (${status}): ${text}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (error) {
              reject(
                new Error(
                  `Orchestrator returned unreadable JSON: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
              );
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(0);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
