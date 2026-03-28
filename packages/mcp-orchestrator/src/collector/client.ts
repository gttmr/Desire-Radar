import type {
  BundleGraph,
  BundleGraphEdge,
  BundleGraphNode,
  Evidence,
  EvidenceBundle,
} from '@agentic/shared-types';

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
  capabilities?: string[];
  request_kinds_supported?: string[];
  normalizer_key?: string | null;
  manifest_path?: string | null;
  pending_submissions?: number;
  failure_count?: number;
  partial_failure_count?: number;
  last_failure_kind?: string | null;
  last_failure_message?: string | null;
  last_warning_kind?: string | null;
  last_warning_message?: string | null;
  last_warning_count?: number;
  last_error?: string | null;
  last_outcome?: string | null;
  run_state?: string;
  queued_runs?: number;
  active_runs?: number;
  active_submission_ids?: string[];
  last_trigger?: string | null;
  last_submission_id?: string | null;
  last_started_at?: string | null;
  last_finished_at?: string | null;
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
  metadata?: Record<string, unknown>;
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
    const graph = buildBundleGraph(response.entity, response.evidence);
    return {
      bundle_id: `collector-${entity}-${Date.now()}`,
      entity: response.entity,
      time_window: this.deriveTimeWindow(response.evidence),
      evidence_items: response.evidence,
      cross_source_summary: this.buildCrossSourceSummary(response),
      recommended_agents: ['search_intent', 'ranking_momentum', 'scarcity', 'synthesis'],
      quality_flags: [],
      graph,
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

  async triggerSource(
    sourceId: string,
    body?: {
      producer_ref?: string;
      request_params?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CollectorSubmission> {
    return this.post<CollectorSubmission>(`/internal/sources/run/${encodeURIComponent(sourceId)}`, {
      producer_ref: body?.producer_ref,
      request_params: body?.request_params ?? {},
      metadata: body?.metadata ?? {},
    });
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
    intent?:
      | 'demand'
      | 'ranking'
      | 'pricing'
      | 'supply'
      | 'monetization'
      | 'beneficiary'
      | 'validation';
    requested_input_kind?:
      | 'study_result'
      | 'data_source'
      | 'channel_check'
      | 'beneficiary_mapping'
      | 'validation_note';
    required_fields?: string[];
    preferred_capabilities?: string[];
    source_hints?: string[];
  }): Promise<CollectorSubmission> {
    return this.post<CollectorSubmission>('/ingest/human-analyst-request', body);
  }

  async getSubmission(submissionId: string): Promise<CollectorSubmission> {
    return this.get<CollectorSubmission>(`/ingest/submissions/${encodeURIComponent(submissionId)}`);
  }

  async listSubmissions(params?: {
    status?: CollectorSubmissionStatus;
    source_id?: string;
    limit?: number;
  }): Promise<{ count: number; submissions: CollectorSubmission[] }> {
    const search = new URLSearchParams();
    if (params?.status) {
      search.set('status', params.status);
    }
    if (params?.source_id) {
      search.set('source_id', params.source_id);
    }
    if (params?.limit != null) {
      search.set('limit', String(params.limit));
    }
    const query = search.size > 0 ? `?${search.toString()}` : '';
    return this.get<{ count: number; submissions: CollectorSubmission[] }>(
      `/ingest/submissions${query}`,
    );
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

function buildBundleGraph(entity: string, evidence: Evidence[]): BundleGraph {
  const nodes = new Map<string, BundleGraphNode>();
  const edges = new Map<string, BundleGraphEdge>();
  const summaryParts = new Set<string>();

  const ensureNode = (node: BundleGraphNode): void => {
    if (!nodes.has(node.node_id)) {
      nodes.set(node.node_id, node);
    }
  };

  const upsertEdge = (edge: BundleGraphEdge): void => {
    const key = `${edge.from}|${edge.kind}|${edge.to}`;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, {
        ...edge,
        evidence_ids: [...(edge.evidence_ids ?? [])],
      });
      return;
    }
    existing.weight = (existing.weight ?? 0) + (edge.weight ?? 0);
    existing.evidence_ids = dedupeStrings([
      ...(existing.evidence_ids ?? []),
      ...(edge.evidence_ids ?? []),
    ]);
  };

  const entityNodeId = `entity:${entity}`;
  ensureNode({ node_id: entityNodeId, label: entity, kind: 'entity', weight: evidence.length });

  for (const item of evidence) {
    const sourceNodeId = `source:${item.source}`;
    const signalLabel = item.signal_type || 'signal';
    const signalNodeId = `signal:${signalLabel}`;

    ensureNode({ node_id: sourceNodeId, label: item.source, kind: 'source' });
    ensureNode({ node_id: signalNodeId, label: signalLabel, kind: 'signal' });
    upsertEdge({
      from: entityNodeId,
      to: signalNodeId,
      kind: 'expresses_signal',
      weight: 1,
      evidence_ids: [item.evidence_id],
    });
    upsertEdge({
      from: sourceNodeId,
      to: entityNodeId,
      kind: 'observed_entity',
      weight: 1,
      evidence_ids: [item.evidence_id],
    });

    if (item.event_frame?.summary) {
      const eventNodeId = `event:${item.evidence_id}`;
      ensureNode({
        node_id: eventNodeId,
        label: item.event_frame.summary,
        kind: 'event',
      });
      upsertEdge({
        from: eventNodeId,
        to: entityNodeId,
        kind: item.event_frame.event_type || 'event_for',
        weight: 1,
        evidence_ids: [item.evidence_id],
      });
      summaryParts.add(item.event_frame.summary);
    }

    for (const hint of item.relationship_hints ?? []) {
      const fromNodeId = `entity:${hint.from}`;
      const toNodeId = `entity:${hint.to}`;
      ensureNode({ node_id: fromNodeId, label: hint.from, kind: 'entity' });
      ensureNode({ node_id: toNodeId, label: hint.to, kind: 'entity' });
      upsertEdge({
        from: fromNodeId,
        to: toNodeId,
        kind: hint.kind,
        weight: hint.confidence ?? 1,
        evidence_ids: [hint.evidence_id ?? item.evidence_id],
      });
      if (hint.rationale) {
        summaryParts.add(hint.rationale);
      }
    }

    if (!item.event_frame?.summary) {
      summaryParts.add(`${item.source} -> ${signalLabel}`);
    }
  }

  const summary =
    summaryParts.size > 0
      ? [...summaryParts].slice(0, 5).join(' | ')
      : `${entity} graph built from ${evidence.length} evidence items`;

  return {
    summary,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

function dedupeStrings(values: string[]): string[] {
  return values.filter((value, index, items) => items.indexOf(value) === index);
}
