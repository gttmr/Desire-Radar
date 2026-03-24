import type {
  CollectRunResponse,
  EmergingCandidatesResponse,
  EvidenceBundleResponse,
  SourcesStatusResponse,
  ManualObservationRequest,
  ManualObservationResponse
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

  async submitManualObservation(obs: ManualObservationRequest): Promise<ManualObservationResponse> {
    return this.post('/manual-observation', obs);
  }

  async triggerCollect(sources?: string[]): Promise<CollectRunResponse> {
    return this.post('/collect/run', { sources });
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
