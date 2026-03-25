import type {
  CollectRunRequest,
  CollectRunResponse,
  CollectorSourceCatalogResponse,
  EmergingCandidatesResponse,
  EvidenceBundleResponse,
  HumanAnalystNoteRequest,
  HumanEvidenceBatchRequest,
  IngestSubmissionListResponse,
  IngestSubmission,
  SourcesStatusResponse,
  ManualObservationRequest,
  ManualObservationResponse,
  ReviewApproveRequest,
  ReviewApproveResponse,
  ReviewRejectRequest,
  ReviewRejectResponse,
} from '@agentic/shared-types';

export class CollectorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getEmergingCandidates(): Promise<EmergingCandidatesResponse> {
    return this.get('/candidates/emerging');
  }

  async getEvidenceBundle(entity: string): Promise<EvidenceBundleResponse> {
    return this.get(`/evidence/bundles/${encodeURIComponent(entity)}`);
  }

  async getSourcesStatus(): Promise<SourcesStatusResponse> {
    return this.get('/sources/status');
  }

  async getSourcesCatalog(): Promise<CollectorSourceCatalogResponse> {
    return this.get('/sources/catalog');
  }

  async listSubmissions(status?: string, sourceId?: string, limit = 20): Promise<IngestSubmissionListResponse> {
    const params = new URLSearchParams();
    if (status) {
      params.set('status', status);
    }
    if (sourceId) {
      params.set('source_id', sourceId);
    }
    params.set('limit', String(limit));
    const query = params.toString();
    return this.get(`/ingest/submissions${query ? `?${query}` : ''}`);
  }

  async submitManualObservation(obs: ManualObservationRequest): Promise<ManualObservationResponse> {
    return this.post('/manual-observation', obs);
  }

  async submitHumanObservation(obs: ManualObservationRequest & { reporter?: string }): Promise<IngestSubmission> {
    return this.post('/ingest/human-observation', obs);
  }

  async submitHumanStudyResult(note: HumanAnalystNoteRequest): Promise<IngestSubmission> {
    return this.post('/ingest/human-study-result', note);
  }

  async submitHumanDataSource(batch: HumanEvidenceBatchRequest): Promise<IngestSubmission> {
    return this.post('/ingest/human-data-source', batch);
  }

  async approveReview(req: ReviewApproveRequest): Promise<ReviewApproveResponse> {
    return this.post('/review/approve', req);
  }

  async rejectReview(req: ReviewRejectRequest): Promise<ReviewRejectResponse> {
    return this.post('/review/reject', req);
  }

  async triggerCollect(connector?: string | string[]): Promise<CollectRunResponse> {
    const body: CollectRunRequest = {};
    if (typeof connector === 'string') {
      body.connector = connector;
    } else if (Array.isArray(connector) && connector.length > 0) {
      body.connector = connector[0];
      body.sources = connector;
    }
    return this.post('/collect/run', body);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl));
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Collector request failed (${response.status}): ${text}`);
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
      throw new Error(`Collector request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }
}
