// ---------------------------------------------------------------
// MCP orchestrator types
// ---------------------------------------------------------------

export type ProviderExecutionStatus = 'queued' | 'running' | 'completed' | 'degraded' | 'failed';
export type ProviderFailureKind =
  | 'auth_failed'
  | 'binary_missing'
  | 'capacity_limited'
  | 'rate_limited'
  | 'transport_failed'
  | 'timeout'
  | 'parse_failed'
  | 'unknown';
export type ProviderExecutionState = 'completed' | 'degraded';
export type ProviderHealthStatus = 'healthy' | 'unprobed' | ProviderFailureKind;
export type ProviderTransportMode = 'cli_exec' | 'cli_resume' | 'external_injection';
export type HighLevelRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'consensus'
  | 'max_rounds_reached';
export type ModelProfile = 'cheap' | 'balanced' | 'premium';
export type ExecutionPhase =
  | 'triage'
  | 'debate'
  | 'verdict'
  | 'report'
  | 'investment_decision';
export type InvestmentDecisionRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'degraded'
  | 'failed';
export type InvestmentDecisionRecommendation =
  | 'buy_now'
  | 'accumulate'
  | 'watch'
  | 'pass';

/** A single run of the orchestrator pipeline */
export type Run = {
  run_id: string;
  date: string;
  topic_or_theme_set: string[];
  evidence_refs: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
};

/** A single turn in an agent debate */
export type AgentTurn = {
  run_id: string;
  agent_name: string;
  provider: string;
  session_id: string;
  provider_execution_status?: ProviderExecutionState;
  provider_degraded_kind?: ProviderFailureKind;
  provider_error?: string;
  provider_recoverable?: boolean;
  turn_index: number;
  prompt_summary: string;
  response: AgentResponse;
  citations: string[];
  evidence_refs: string[];
  created_at: string;
};

/** Standardized agent response contract */
export type AgentResponse = {
  summary: string;
  confidence: number;
  claims: AgentClaim[];
  evidence_used: string[];
  open_questions: string[];
  messages_for_other_agents: AgentMessage[];
  recommended_next_step: string;
};

export type AgentClaim = {
  claim: string;
  supporting_evidence: string[];
  confidence: number;
};

export type AgentMessage = {
  target_agent: string;
  content: string;
};

export type BeneficiaryCategory =
  | 'direct_winner'
  | 'public_beneficiary'
  | 'second_order_beneficiary';

export type BeneficiaryCandidate = {
  name: string;
  category: BeneficiaryCategory;
  rationale: string;
  supporting_evidence: string[];
  confidence: number;
};

export type BeneficiaryMapping = {
  summary: string;
  direct_winners: BeneficiaryCandidate[];
  public_beneficiaries: BeneficiaryCandidate[];
  second_order_beneficiaries: BeneficiaryCandidate[];
  missing_monetization_link?: string | null;
  invalidation_point?: string | null;
  source_agent?: string | null;
};

/** Provider execution derived from an agent/provider turn */
export type ProviderExecution = {
  execution_id: string;
  run_id: string;
  agent_name: string;
  provider: string;
  session_id?: string | null;
  status: ProviderExecutionStatus;
  turn_index?: number;
  prompt_summary?: string | null;
  output_summary?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  error?: string | null;
  degraded_kind?: ProviderFailureKind | null;
  recoverable?: boolean | null;
  turn?: AgentTurn;
};

export type ProviderExecutionRequest = {
  prompt: string;
  sessionId?: string;
  logicalSessionId?: string;
  workingDirectory?: string;
  turnCount?: number;
  transportMode?: ProviderTransportMode;
  transportTarget?: string;
  model?: string;
  modelProfile: ModelProfile;
  phase: ExecutionPhase;
  agentName: string;
  responseFormat?: 'json' | 'text';
  maxOutputTokens?: number;
  timeoutMs?: number;
};

/** Aggregated research extracted from one or more agent turns */
export type ResearchFinding = {
  agent_name: string;
  provider?: string;
  summary: string;
  confidence: number;
  provider_execution_status?: ProviderExecutionState;
  provider_degraded_kind?: ProviderFailureKind;
  provider_error?: string;
  provider_recoverable?: boolean;
  claims: AgentClaim[];
  citations: string[];
  evidence_refs: string[];
  open_questions: string[];
  recommended_next_step?: string;
};

export type RunResearch = {
  run_id: string;
  status: HighLevelRunStatus;
  findings: ResearchFinding[];
  latest_turns: AgentTurn[];
  updated_at?: string;
};

export type ResearchRequest = {
  runId: string;
  entity: string;
  requestedByAgent: string;
  intent:
    | 'demand'
    | 'ranking'
    | 'pricing'
    | 'supply'
    | 'monetization'
    | 'beneficiary'
    | 'validation';
  requestKind: 'run_source' | 'submit_agent_evidence' | 'request_human_note';
  targetSourceId?: string;
  requestedInputKind?:
    | 'study_result'
    | 'data_source'
    | 'channel_check'
    | 'beneficiary_mapping'
    | 'validation_note';
  requiredFields?: string[];
  preferredCapabilities?: string[];
  question: string;
  whyNow: string;
  priority: 'low' | 'normal' | 'high';
};

export type ResearchResult = {
  request: ResearchRequest;
  submissionId: string;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'rejected'
    | 'pending_human';
  evidenceIds: string[];
  errorMessage?: string;
};

/** Daily report produced by synthesis */
export type DailyReport = {
  report_id: string;
  date: string;
  summary: string;
  agent_highlights: Record<string, string>;
  final_verdicts: ReportVerdict[];
  linked_themes: string[];
  linked_entities: string[];
  linked_beneficiaries?: string[];
  full_markdown: string;
  created_at: string;
};

export type ReportVerdict = {
  entity: string;
  verdict: string;
  confidence: number;
  supporting_agents: string[];
};

export type RunVerdict = {
  run_id: string;
  summary: string;
  confidence?: number | null;
  report_id?: string | null;
  beneficiary_mapping?: BeneficiaryMapping | null;
  verdicts?: ReportVerdict[];
  sections?: Array<{ title: string; content: string }>;
  risks?: string[];
  opportunities?: string[];
  generated_at?: string;
};

export type VerdictResult = {
  runId: string;
  entity: string;
  summary: string;
  confidence: number;
  recommendation: string;
  beneficiary_mapping: BeneficiaryMapping | null;
  supportingAgents: string[];
  openQuestions: string[];
  primaryTurn?: AgentTurn;
  crossCheckTurn?: AgentTurn;
  beneficiaryMappingTurn?: AgentTurn;
  createdAt: string;
};

export type RunEvaluationRecord = {
  run_id: string;
  entity: string;
  fixture_path: string;
  recorded_at: string;
  evidence_refs: string[];
  source_refs: string[];
  research_requests: Array<{
    requested_by: string;
    request_kind: string;
    question: string;
    status: string;
    requested_input_kind?: string;
  }>;
  provider_failures: Array<{
    agent_name: string;
    provider: string;
    summary: string;
  }>;
  beneficiary_mapping?: BeneficiaryMapping | null;
  final_verdict?: {
    summary: string;
    confidence: number;
    recommendation: string;
    open_questions: string[];
  };
  report?: {
    report_id: string;
    summary: string;
  };
};

export type HighLevelRun = {
  run_id: string;
  topic: string;
  status: HighLevelRunStatus;
  created_at: string;
  updated_at: string;
  evidence_count?: number;
  plan?: string[];
  providers?: string[];
  research?: RunResearch;
  verdict?: RunVerdict;
};

/** Provider session */
export type ProviderSession = {
  session_id: string;
  provider_session_id?: string | null;
  session_dir?: string;
  transport_mode?: ProviderTransportMode;
  transport_target?: string | null;
  agent_name: string;
  provider: string;
  phase?: ExecutionPhase;
  model_profile?: ModelProfile;
  run_scope?: string;
  model?: string;
  created_at: string;
  last_active_at: string;
  turn_count: number;
};

/** Provider health */
export type ProviderHealth = {
  provider: string;
  available: boolean;
  status?: ProviderHealthStatus;
  auth_status?: ProviderHealthStatus;
  execute_status?: ProviderHealthStatus;
  transport_status?: ProviderHealthStatus;
  ready_for_execution?: boolean;
  failure_kind?: ProviderFailureKind;
  last_checked_at: string;
  error?: string;
  error_summary?: string;
  recoverable?: boolean;
  repair_configured?: boolean;
  repair_command_preview?: string;
  last_repair_at?: string;
  last_repair_summary?: string;
};

export type InvestmentCandidateCluster = {
  cluster_id?: string | null;
  display_label: string;
  candidate_kind: 'entity_cluster';
  primary_entity?: string | null;
  aliases: string[];
  supporting_sources: string[];
  supporting_terms: string[];
  theme_tags: string[];
  event_summary?: string | null;
  graph_summary?: string | null;
  evidence_ids: string[];
  emergence_score: number;
  velocity_score: number;
  status: string;
};

export type ResolvedEquityCandidate = {
  asset_key: string;
  ticker: string;
  company_name: string;
  why_in_scope: string;
  linked_clusters: string[];
  linked_notes: string[];
  watchlist_member: boolean;
};

export type InvestmentEquityMapEntry = {
  asset_key: string;
  ticker: string;
  company_name: string;
  aliases: string[];
};

export type InvestmentDecisionNote = {
  intake_id: string;
  asset_key?: string | null;
  title: string;
  summary: string;
  why_it_might_matter: string;
  open_questions: string[];
  source_submission_id: string;
  created_at: string;
};

export type InvestmentSourceHealth = {
  source_id: string;
  readiness_status?: string | null;
  readiness_reason?: string | null;
  quality_status?: string | null;
  freshness_lag_seconds?: number | null;
  last_success_at?: string | null;
  last_failure_kind?: string | null;
};

export type InvestmentCoverageGap = {
  label: string;
  reason: string;
  linked_cluster_id?: string | null;
  linked_note_ids?: string[];
};

export type InvestmentDecisionRequest = {
  run_id: string;
  created_at: string;
  mode: 'scheduled' | 'manual' | 'api';
  window: {
    label: string;
    start: string;
    end: string;
  };
  watchlist: string[];
  resolved_equities: ResolvedEquityCandidate[];
  candidate_clusters: InvestmentCandidateCluster[];
  supporting_evidence_refs: string[];
  investment_notes: InvestmentDecisionNote[];
  source_health_summary: InvestmentSourceHealth[];
  coverage_gaps: InvestmentCoverageGap[];
  schema_version: 1;
};

export type InvestmentDecisionRecommendationItem = {
  asset_key: string;
  ticker: string;
  company_name: string;
  recommendation: InvestmentDecisionRecommendation;
  confidence: number;
  why_now: string;
  thesis: string;
  beneficiary_path: string;
  linked_clusters: string[];
  linked_evidence_refs: string[];
  risks: string[];
  missing_information: string[];
};

export type InvestmentDecisionArtifact = {
  run_id: string;
  status: Exclude<InvestmentDecisionRunStatus, 'queued' | 'running'>;
  generated_at: string;
  summary: string;
  market_view: string;
  top_picks: InvestmentDecisionRecommendationItem[];
  watch_candidates: InvestmentDecisionRecommendationItem[];
  rejected_candidates: InvestmentDecisionRecommendationItem[];
  coverage_gaps: InvestmentCoverageGap[];
  risks: string[];
  degraded: boolean;
  degraded_reason?: string | null;
  schema_version: 1;
};

export type InvestmentDecisionRunRecord = {
  run_id: string;
  status: InvestmentDecisionRunStatus;
  mode: 'scheduled' | 'manual' | 'api';
  runner: 'provider_exec' | 'external_artifact';
  created_at: string;
  updated_at: string;
  request_path: string;
  request_markdown_path: string;
  status_path: string;
  response_path?: string | null;
  response_markdown_path?: string | null;
  report_path?: string | null;
  degraded_reason?: string | null;
  error?: string | null;
};
