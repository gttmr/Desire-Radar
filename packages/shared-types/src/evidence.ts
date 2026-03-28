// ---------------------------------------------------------------
// Collector evidence types
// ---------------------------------------------------------------

export type SourceTier = 1 | 2 | 3;
export type TosRisk = 'none' | 'low' | 'medium' | 'high';
export type CandidateStatus = 'emerging' | 'preheat' | 'spreading' | 'noisy';
export type CollectorAnalysisStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_review'
  | 'skipped';

export type EvidenceEventFrame = {
  event_type: string;
  summary?: string | null;
  subjects?: string[];
  objects?: string[];
  happened_at?: string | null;
};

export type EvidenceRelationshipHint = {
  from: string;
  to: string;
  kind: string;
  confidence?: number | null;
  rationale?: string | null;
  evidence_id?: string | null;
};

export type BundleGraphNodeKind = 'entity' | 'source' | 'signal' | 'event' | 'theme';

export type BundleGraphNode = {
  node_id: string;
  label: string;
  kind: BundleGraphNodeKind;
  weight?: number | null;
};

export type BundleGraphEdge = {
  from: string;
  to: string;
  kind: string;
  weight?: number | null;
  evidence_ids?: string[];
};

export type BundleGraph = {
  summary: string;
  nodes: BundleGraphNode[];
  edges: BundleGraphEdge[];
};

/** Raw snapshot from a source connector */
export type RawSnapshot = {
  snapshot_id: string;
  source: string;
  fetched_at: string;
  request_params: Record<string, unknown>;
  checksum_sha256: string;
  fetch_status: 'ok' | 'error';
  parser_version: string;
  raw_body_ref: string; // path or inline
};

/** Normalized evidence record */
export type Evidence = {
  evidence_id: string;
  source: string;
  source_tier: SourceTier;
  source_kind?: 'pull' | 'push' | 'agent' | 'human' | 'derived';
  producer_ref?: string;
  parent_evidence_ids?: string[];
  submission_ref?: string;
  collected_at: string;
  entity_candidates: string[];
  signal_type: string;
  title_or_label: string;
  metric_value: number | null;
  metric_delta: number | null;
  rank: number | null;
  geo: string;
  url_or_ref: string;
  raw_snapshot_ref: string;
  trust_score: number;
  tos_risk: TosRisk;
  freshness_ttl: number; // seconds
  event_frame?: EvidenceEventFrame | null;
  relationship_hints?: EvidenceRelationshipHint[];
};

/** Canonical entity */
export type CanonicalEntity = {
  entity_id: string;
  name: string;
  type: 'keyword' | 'brand' | 'product' | 'app' | 'meme';
  aliases: string[];
  review_status: 'auto' | 'pending_review' | 'approved' | 'rejected';
};

/** Evidence bundle for MCP orchestrator consumption */
export type EvidenceBundle = {
  bundle_id: string;
  entity: string;
  time_window: { start: string; end: string };
  evidence_items: Evidence[];
  cross_source_summary: string;
  recommended_agents: string[];
  quality_flags: string[];
  graph?: BundleGraph | null;
};

/** Signal candidate produced by the collector */
export type SignalCandidate = {
  entity: string;
  cluster_id?: string | null;
  candidate_kind?: 'entity_cluster';
  display_label?: string | null;
  primary_entity?: string | null;
  aliases?: string[];
  supporting_terms?: string[];
  theme_tags?: string[];
  event_summary?: string | null;
  graph_summary?: string | null;
  status: CandidateStatus;
  emergence_score: number;
  velocity_score: number;
  source_count: number;
  evidence_ids: string[];
  sources: string[];
  first_seen: string;
  last_seen: string;

  // Collector-enriched analysis fields.
  desire_types?: string[];
  behavioral_signals?: string[];
  avg_intensity?: number | null;
  demographic_hints?: string[];
  desire_summary?: string | null;
  analysis_status?: CollectorAnalysisStatus | null;
  analysis_summary?: string | null;
  analysis_confidence?: number | null;
  analysis_reason?: string | null;
  last_analyzed_at?: string | null;
  analysis_session_domain?: string | null;

  // Legacy / forward-compatible fields kept optional so existing
  // consumers can compile across contract migrations.
  candidate_id?: string;
  primary_sources?: string[];
  conversion_proxy_score?: number;
  scarcity_score?: number;
  next_actions?: string[];
  created_at?: string;
  updated_at?: string;
};

/** Manual observation (human input connector) */
export type ManualObservation = {
  observed_at: string;
  reporter: string;
  geo: string;
  channel: string;
  entity_text: string;
  observation_type: string;
  intensity_1_to_5: number;
  free_note: string;
  related_theme_candidates: string[];
  attached_media_refs: string[];
};

/** Source status */
export type SourceStatus = {
  cadence_seconds: number;
  source_tier: SourceTier;
  last_run: string | null;
  scheduled: boolean;
  enabled?: boolean;
  runnable?: boolean;
  kind?: 'pull' | 'push' | 'agent' | 'human' | 'derived';
  ingestion_mode?: 'raw' | 'evidence';
  last_submission?: string | null;
  last_success?: string | null;
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
  configured_tier?: SourceTier;
  effective_tier?: SourceTier;
  validity_status?: string | null;
  validity_score?: number | null;
  recommended_tier?: SourceTier | null;
  recommended_tier_reason?: string | null;
  capabilities?: string[];
  request_kinds_supported?: string[];
  normalizer_key?: string | null;
  manifest_path?: string | null;
  agent_enabled?: boolean;
  agent_prompt_path?: string | null;
  agent_session_domain?: string | null;
  agent_output_mode?: 'artifact_only' | 'artifact_and_derived';
  last_agent_run?: string | null;
  last_agent_status?: string | null;
  last_agent_error?: string | null;
  adapter_name?: string;
  default_producer_ref?: string | null;
  tier_override_reason?: string | null;
  description?: string | null;
  current_stage?: string | null;
  current_stage_message?: string | null;
  last_progress_at?: string | null;
  payload_total?: number;
  payloads_processed?: number;
  snapshot_total?: number;
  evidence_total?: number;
  resolve_success_total?: number;
  resolve_miss_total?: number;
  last_warning_targets?: string[];
  source_agent_status?: string | null;
  source_agent_artifact_id?: string | null;
  source_agent_error?: string | null;
  derived_evidence_total?: number;

  // Legacy / forward-compatible fields.
  source?: string;
  last_fetched_at?: string | null;
  failure_rate?: number;
  tier?: SourceTier;
  quarantine_status?: 'active' | 'quarantined' | 'review_required';
};
