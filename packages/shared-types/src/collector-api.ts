// ---------------------------------------------------------------
// Collector REST API request/response types
// ---------------------------------------------------------------

import type { Evidence, SignalCandidate, SourceStatus, SourceTier } from './evidence.js';

export type CollectorSubmissionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'pending_human';

export type CollectorSourceCatalogEntry = {
  source_id: string;
  kind: 'pull' | 'push' | 'agent' | 'human' | 'derived';
  ingestion_mode: 'raw' | 'evidence';
  configured_tier: SourceTier;
  effective_tier: SourceTier;
  cadence_seconds: number;
  runnable: boolean;
  scheduled: boolean;
  enabled: boolean;
  adapter_name: string;
  default_producer_ref?: string | null;
  tier_override_reason?: string | null;
  validity_status?: string | null;
  validity_score?: number | null;
  recommended_tier?: SourceTier | null;
  recommended_tier_reason?: string | null;
  description?: string | null;
};

export type CollectorSourceCatalogResponse = {
  count: number;
  sources: Record<string, CollectorSourceCatalogEntry>;
};

export type CollectorAnalysisStatusSummary = {
  enabled: boolean;
  queue_size: number;
  execution_mode?: string;
};

// POST /collect/run
export type CollectRunRequest = {
  connector?: string;
  // Legacy field retained for older callers. The current collector only
  // accepts a single connector name.
  sources?: string[];
  force?: boolean;
};
export type CollectRunConnectorResponse = {
  connector: string;
  evidence_count: number;
  submission_id?: string;
};
export type CollectRunAllResponse = {
  total_evidence_count: number;
  per_connector: Record<string, number>;
  submission_ids?: Record<string, string>;
};
export type CollectRunResponse =
  | CollectRunConnectorResponse
  | CollectRunAllResponse;

// GET /candidates/emerging
export type EmergingCandidatesResponse = {
  candidates: SignalCandidate[];
  count: number;
};

// GET /evidence/bundles/:entity
export type EvidenceBundleResponse = {
  entity: string;
  count: number;
  evidence: Evidence[];
};

// GET /sources/status
export type SourcesStatusResponse = {
  sources: Record<string, SourceStatus>;
  analysis: CollectorAnalysisStatusSummary;
  catalog?: CollectorSourceCatalogEntry[];
};

// POST /review/approve
export type ReviewApproveRequest = {
  raw_text: string;
  canonical_name: string;
};
export type ReviewApproveResponse = {
  status: 'approved';
  raw_text: string;
  canonical_name: string;
};

// POST /review/reject
export type ReviewRejectRequest = {
  raw_text: string;
};
export type ReviewRejectResponse = {
  status: 'rejected';
  raw_text: string;
};

export type ManualObservationSubmission = {
  title: string;
  entities?: string[];
  signal_type?: string;
  metric_value?: number | null;
  metric_delta?: number | null;
  rank?: number | null;
  geo?: string;
  url?: string;
  trust_score?: number;
  freshness_ttl?: number;
};

// POST /manual-observation (human input connector)
export type ManualObservationRequest = ManualObservationSubmission;
export type ManualObservationResponse = {
  status: 'submitted';
  evidence_count: number;
  submission_id: string;
};

export type IngestSubmission = {
  submission_id: string;
  source_id: string;
  source_kind: 'pull' | 'push' | 'agent' | 'human' | 'derived';
  ingestion_mode: 'raw' | 'evidence';
  status: CollectorSubmissionStatus;
  snapshot_ids: string[];
  evidence_ids: string[];
  error_message?: string | null;
  producer_ref?: string | null;
  received_at: string;
  processed_at?: string | null;
  parent_evidence_ids?: string[];
  metadata?: Record<string, unknown>;
};

export type RawEnvelopeRequest = {
  payloads: Record<string, unknown>[];
  producer_ref?: string;
  request_params?: Record<string, unknown>;
};

export type EvidenceEnvelopeRequest = {
  evidence_items: Record<string, unknown>[];
  producer_ref?: string;
  parent_evidence_ids?: string[];
};

export type HumanAnalystNoteRequest = {
  title: string;
  observation: string;
  entity_candidates?: string[];
  why_now?: string;
  confidence?: number;
  geo?: string;
  channel?: string;
  producer_ref?: string;
  beneficiary_hints?: string[];
  research_questions?: string[];
};

export type HumanAnalystRequest = {
  entity_candidates?: string[];
  question: string;
  why_now?: string;
  priority?: 'low' | 'normal' | 'high';
  producer_ref?: string;
  requested_by_agent?: string;
  run_id?: string;
};

// --- Internal APIs (MCP orchestrator consumption) ---

// GET /internal/next-candidates
export type NextCandidatesResponse = {
  count: number;
  candidates: SignalCandidate[];
};

// POST /internal/build-bundle
export type BuildBundleRequest = {
  entity: string;
  max_evidence?: number;
};
export type BuildBundleResponse = {
  entity: string;
  evidence_count: number;
  evidence: Evidence[];
  sources: string[];
};

// GET /internal/entity-history/:entity
export type EntityHistoryResponse = {
  entity: string;
  total_evidence: number;
  history: Evidence[];
};

export type CollectorAnalysisTask = {
  task_id: string;
  entity: string;
  session_domain: string;
  reason: string;
  emergence_score: number;
  velocity_score: number;
  source_count: number;
  evidence_ids: string[];
  sources: string[];
  first_seen: string;
  last_seen: string;
  enqueued_at: string;
};

export type CollectorAnalysisProjection = {
  entity: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'needs_review' | 'skipped';
  session_domain: string;
  session_id?: string | null;
  model?: string | null;
  summary?: string | null;
  confidence?: number | null;
  desire_types?: string[];
  behavioral_signals?: string[];
  demographic_hints?: string[];
  avg_intensity?: number | null;
  open_questions?: string[];
  reason?: string | null;
  evidence_ids?: string[];
  sources?: string[];
  source_count?: number;
  last_emergence_score?: number | null;
  last_velocity_score?: number | null;
  first_enqueued_at?: string | null;
  analyzed_at?: string | null;
  last_execution_mode?: 'batch' | 'fresh' | 'resume' | null;
  last_prompt_char_count?: number | null;
  last_estimated_input_tokens?: number | null;
  last_input_tokens?: number | null;
  last_cached_input_tokens?: number | null;
  last_uncached_input_tokens?: number | null;
  last_output_tokens?: number | null;
  last_batch_size?: number | null;
  updated_at: string;
};

export type CollectorSessionState = {
  session_id: string;
  domain: string;
  model?: string | null;
  turn_count: number;
  last_active_at: string;
  rolling_memory: string;
  total_input_tokens: number;
  total_cached_input_tokens: number;
  total_uncached_input_tokens: number;
};

export type AnalysisRunRequest = {
  entity: string;
};

export type AnalysisRunResponse = {
  entity: string;
  queued: boolean;
  tasks: CollectorAnalysisTask[];
};

export type AnalysisStatusResponse = {
  entity: string;
  queued: boolean;
  queue_size: number;
  execution_mode: 'batch' | 'fresh' | 'resume';
  projection: CollectorAnalysisProjection | null;
  sessions: CollectorSessionState[];
};

export type AnalysisPreviewResponse =
  | {
      entity: string;
      execution_mode: 'batch' | 'fresh' | 'resume';
      found: false;
    }
  | {
      entity: string | null;
      entities: string[];
      execution_mode: 'batch' | 'fresh' | 'resume';
      prompt_format: 'json' | 'markdown';
      prompt_char_count: number;
      estimated_input_tokens: number;
      selected_evidence_count: number;
      selected_sources: string[];
      omitted_fields: string[];
      prompt_preview: string;
      model: string | null;
      batch_size: number;
      response_mode: 'single' | 'batch';
      count?: number;
      candidates?: Array<{
        entity: string;
        reason: string;
        source_count: number;
        emergence_score: number;
        velocity_score: number;
      }>;
    };
