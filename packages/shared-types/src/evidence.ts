// ---------------------------------------------------------------
// Collector evidence types
// ---------------------------------------------------------------

export type SourceTier = 1 | 2 | 3;
export type TosRisk = 'none' | 'low' | 'medium' | 'high';
export type CandidateStatus = 'emerging' | 'preheat' | 'spreading' | 'noisy';

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
};

/** Signal candidate produced by the collector */
export type SignalCandidate = {
  candidate_id: string;
  entity: string;
  emergence_score: number;
  velocity_score: number;
  conversion_proxy_score: number;
  scarcity_score: number;
  source_count: number;
  primary_sources: string[];
  status: CandidateStatus;
  next_actions: string[];
  created_at: string;
  updated_at: string;
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
  source: string;
  last_fetched_at: string | null;
  failure_rate: number;
  tier: SourceTier;
  quarantine_status: 'active' | 'quarantined' | 'review_required';
  cadence_seconds: number;
};
