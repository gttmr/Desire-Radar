import type { Evidence, EvidenceBundle } from '@agentic/shared-types';

export type CollectorCandidate = {
  entity: string;
  status: 'emerging' | 'preheat' | 'spreading';
  emergence_score: number;
  velocity_score: number;
  source_count: number;
  evidence_ids: string[];
  sources: string[];
  first_seen: string;
  last_seen: string;
  desire_types?: string[];
  behavioral_signals?: string[];
  avg_intensity?: number | null;
  demographic_hints?: string[];
  desire_summary?: string | null;
  analysis_status?: string | null;
  analysis_summary?: string | null;
  analysis_confidence?: number | null;
  analysis_reason?: string | null;
  last_analyzed_at?: string | null;
  analysis_session_domain?: string | null;
};

export type CollectorSourceStatus = {
  kind?: 'pull' | 'push' | 'agent' | 'human' | 'derived';
  ingestion_mode?: 'raw' | 'evidence';
  scheduled: boolean;
  enabled?: boolean;
  last_run: string | null;
  last_submission?: string | null;
  cadence_seconds: number;
  runnable?: boolean;
  source_tier: 1 | 2 | 3;
  configured_tier?: 1 | 2 | 3;
  effective_tier?: 1 | 2 | 3;
  validity_status?: string | null;
  validity_score?: number | null;
  recommended_tier?: 1 | 2 | 3 | null;
  recommended_tier_reason?: string | null;
  pending_submissions?: number;
  failure_count?: number;
  adapter_name?: string;
  default_producer_ref?: string | null;
  tier_override_reason?: string | null;
  description?: string | null;
};

export type CollectorBuildBundleResponse = {
  entity: string;
  evidence_count: number;
  evidence: Evidence[];
  sources: string[];
};

export type CollectorSubmissionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'pending_human';

export type CollectorSubmission = {
  submission_id: string;
  source_id?: string;
  status: CollectorSubmissionStatus;
  evidence_ids: string[];
  error_message?: string;
  producer_ref?: string;
  received_at: string;
  processed_at?: string;
};

export class CollectorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getNextCandidates(onlyNeedsAnalysis = false): Promise<CollectorCandidate[]> {
    const query = onlyNeedsAnalysis ? '?only_needs_analysis=true' : '';
    const response = await this.get<{ candidates: CollectorCandidate[] }>(
      `/internal/next-candidates${query}`,
    );
    return response.candidates ?? [];
  }

  async buildBundle(entity: string, maxEvidence = 50): Promise<EvidenceBundle> {
    const response = await this.post<CollectorBuildBundleResponse>('/internal/build-bundle', {
      entity,
      max_evidence: maxEvidence,
    });
    return {
      bundle_id: `collector-${entity}-${Date.now()}`,
      entity: response.entity,
      time_window: this.deriveTimeWindow(response.evidence),
      evidence_items: response.evidence,
      cross_source_summary: this.buildCrossSourceSummary(response),
      recommended_agents: ['search_intent', 'ranking_momentum', 'scarcity', 'synthesis'],
      quality_flags: [],
    };
  }

  async getSourcesStatus(): Promise<Record<string, CollectorSourceStatus>> {
    const response = await this.get<{ sources: Record<string, CollectorSourceStatus> }>(
      '/sources/status',
    );
    return this.normalizeSourceMap(response.sources ?? {});
  }

  async getSourcesCatalog(): Promise<Record<string, CollectorSourceStatus>> {
    try {
      const response = await this.get<{ sources: Record<string, CollectorSourceStatus> }>(
        '/sources/catalog',
      );
      return this.normalizeSourceMap(response.sources ?? {});
    } catch {
      return this.getSourcesStatus();
    }
  }

  async triggerSource(sourceId: string): Promise<CollectorSubmission> {
    return this.post<CollectorSubmission>(`/internal/sources/run/${encodeURIComponent(sourceId)}`, {});
  }

  async submitManualObservation(note: {
    title: string;
    entities: string[];
    signal_type: string;
    geo?: string;
    url?: string;
    trust_score?: number;
    metric_value?: number | null;
    metric_delta?: number | null;
    reporter?: string;
  }): Promise<CollectorSubmission> {
    return this.post<CollectorSubmission>('/ingest/human-observation', {
      title: note.title,
      entities: note.entities,
      signal_type: note.signal_type,
      geo: note.geo ?? 'global',
      url: note.url ?? '',
      trust_score: note.trust_score ?? 0.8,
      metric_value: note.metric_value ?? null,
      metric_delta: note.metric_delta ?? null,
      reporter: note.reporter ?? 'orchestrator',
    });
  }

  async submitAgentEvidence(body: {
    evidence_items: Array<Record<string, unknown>>;
    producer_ref?: string;
    parent_evidence_ids?: string[];
  }): Promise<CollectorSubmission> {
    return this.post<CollectorSubmission>('/ingest/evidence/agent_evidence', {
      evidence_items: body.evidence_items,
      producer_ref: body.producer_ref ?? 'orchestrator-agent',
      parent_evidence_ids: body.parent_evidence_ids ?? [],
    });
  }

  async requestHumanAnalystNote(body: {
    entity_candidates: string[];
    question: string;
    why_now: string;
    priority: 'low' | 'normal' | 'high';
    producer_ref?: string;
    requested_by_agent?: string;
    run_id?: string;
  }): Promise<CollectorSubmission> {
    return this.post<CollectorSubmission>('/ingest/human-analyst-request', body);
  }

  async getSubmission(submissionId: string): Promise<CollectorSubmission> {
    return this.get<CollectorSubmission>(`/ingest/submissions/${encodeURIComponent(submissionId)}`);
  }

  private deriveTimeWindow(evidence: Evidence[]): { start: string; end: string } {
    if (evidence.length === 0) {
      const now = new Date().toISOString();
      return { start: now, end: now };
    }
    const sorted = [...evidence].sort((a, b) => a.collected_at.localeCompare(b.collected_at));
    return {
      start: sorted[0]!.collected_at,
      end: sorted[sorted.length - 1]!.collected_at,
    };
  }

  private buildCrossSourceSummary(response: CollectorBuildBundleResponse): string {
    if (response.evidence.length === 0) {
      return `No evidence returned for ${response.entity}.`;
    }

    const highlights = response.evidence
      .slice(0, 5)
      .map((item) => `${item.evidence_id}: ${item.title_or_label}`)
      .join(' | ');

    return `${response.entity} has ${response.evidence_count} evidence items across ${response.sources.length} sources. ${highlights}`;
  }

  private normalizeSourceMap(
    sources: Record<string, CollectorSourceStatus>,
  ): Record<string, CollectorSourceStatus> {
    return Object.fromEntries(
      Object.entries(sources).map(([sourceId, source]) => [
        sourceId,
        {
          ...source,
          source_tier:
            source.source_tier ??
            source.effective_tier ??
            source.configured_tier ??
            3,
          last_run: source.last_run ?? null,
          cadence_seconds: source.cadence_seconds ?? 0,
          scheduled: source.scheduled ?? false,
        },
      ]),
    );
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Collector request failed (${response.status}): ${text}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Collector request failed (${response.status}): ${text}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
