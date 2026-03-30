// ---------------------------------------------------------------
// MCP orchestrator REST API request/response types
// ---------------------------------------------------------------

import type {
  AgentTurn,
  DailyReport,
  InvestmentDecisionArtifact,
  NormalizedEquityIdentity,
  InvestmentEquityMapEntry,
  InvestmentDecisionRequest,
  InvestmentDecisionRunRecord,
  Run,
  ProviderSession,
  ProviderHealth,
  AgentResponse,
  ProviderExecution,
  RunResearch,
  RunVerdict,
  HighLevelRun,
  HighLevelRunStatus,
  ResearchResult,
  VerdictResult,
} from './orchestrator.js';
import type {
  ActionRequest,
  AssetCandidate,
  HumanInputInputKind,
  InvestmentNoteDraft,
} from './collector-api.js';
import type { EvidenceBundle } from './evidence.js';
import type { ReportDetailLevel, ReportRunMode } from './bot.js';

// POST /runs/submit-evidence
export type SubmitEvidenceRequest = {
  run_id?: string;       // create new run if omitted
  topic: string;
  evidence_bundle: EvidenceBundle;
  metadata?: Record<string, unknown>;
};
export type SubmitEvidenceResponse = {
  run_id: string;
  evidence_count: number;
};

// POST /runs/agent-round
export type RunAgentRoundRequest = {
  run_id: string;
  agent_name: string;
  providers?: string[];  // defaults to all available
};
export type RunAgentRoundResponse = {
  turns: AgentTurn[];
  status: string;
};

// POST /runs/debate
export type RunDebateRequest = {
  run_id: string;
  plan?: string[];          // ordered list of agent names
  max_rounds?: number;      // default: 3
  providers?: string[];
};
export type RunDebateResponse = {
  turns: AgentTurn[];
  status: Extract<HighLevelRunStatus, 'completed' | 'max_rounds_reached' | 'consensus'>;
  rounds_executed: number;
};

// POST /runs/synthesize
export type SynthesizeReportRequest = {
  run_id: string;
  report_style?: 'daily' | 'deep_dive' | 'alert';
};
export type SynthesizeReportResponse = {
  report_id: string;
  summary: string;
  sections: Array<{ title: string; content: string }>;
};

// GET /runs/:id/state
export type RunStateResponse = {
  run: Run;
  agents: Array<{ agent_name: string; turns_completed: number; latest_response?: AgentResponse }>;
  sessions: ProviderSession[];
  latest_turns: AgentTurn[];
};

// GET /sessions
export type ListSessionsRequest = {
  agent_name?: string;
};
export type ListSessionsResponse = {
  sessions: ProviderSession[];
};

// POST /sessions/reset
export type ResetSessionRequest = {
  agent_name: string;
  provider: string;
};
export type ResetSessionResponse = {
  ok: boolean;
};

// GET /health
export type OrchestratorHealthResponse = {
  ok: boolean;
  providers: ProviderHealth[];
  active_runs: number;
  total_sessions: number;
};

// GET /reports
export type ListReportsResponse = {
  reports: DailyReport[];
  count: number;
};

// High-level run endpoints
export type CreateHighLevelRunRequest = SubmitEvidenceRequest & {
  plan?: string[];
  max_rounds?: number;
  providers?: string[];
  report_style?: 'daily' | 'deep_dive' | 'alert';
};

export type CreateHighLevelRunResponse = {
  run: HighLevelRun;
  research?: RunResearch;
  verdict?: RunVerdict;
  provider_executions?: ProviderExecution[];
};

export type ListHighLevelRunsResponse = {
  runs: HighLevelRun[];
  count: number;
};

export type GetHighLevelRunResponse = {
  run: HighLevelRun;
};

export type GetRunResearchResponse = {
  run_id: string;
  research: RunResearch;
};

export type GetRunVerdictResponse = {
  run_id: string;
  verdict: RunVerdict;
};

export type GetRunProviderExecutionsResponse = {
  run_id: string;
  executions: ProviderExecution[];
  count: number;
};

export type RunFromCandidateRequest = {
  entity: string;
  providers?: string[];
  max_rounds?: number;
  plan?: string[];
};

export type RunFromCandidateResponse = {
  run_id: string;
  triage: {
    approved: boolean;
    reason: string;
  };
  debate?: {
    turns: AgentTurn[];
    status: Extract<HighLevelRunStatus, 'completed' | 'max_rounds_reached' | 'consensus'>;
    roundsExecuted: number;
  };
  research?: {
    executed: boolean;
    results: ResearchResult[];
    reranDebate: boolean;
  };
  verdict?: VerdictResult;
  report?: {
    report: DailyReport;
    sections: Array<{ title: string; content: string }>;
  };
};

export type RunResearchLoopResponse = {
  executed: boolean;
  results: ResearchResult[];
  reranDebate: boolean;
  debate?: {
    turns: AgentTurn[];
    status: Extract<HighLevelRunStatus, 'completed' | 'max_rounds_reached' | 'consensus'>;
    roundsExecuted: number;
  };
};

export type RunVerdictResponse = VerdictResult;

export type ListResearchRequestsResponse = {
  run_id: string;
  requests: ResearchResult[];
  count: number;
};

export type InvestmentIntakeRequest = {
  source_submission_id: string;
  input_kind: HumanInputInputKind;
  raw_input: string;
  channel_ref?: string;
  asset_candidates: AssetCandidate[];
  auto_actions: ActionRequest[];
  investment_note: InvestmentNoteDraft;
};

export type InvestmentIntakeRecord = {
  intake_id: string;
  source_submission_id: string;
  created_at: string;
  asset_candidates: AssetCandidate[];
  asset_type: AssetCandidate['asset_type'] | 'unresolved';
  input_kind: HumanInputInputKind;
  channel_ref?: string | null;
  auto_actions: ActionRequest[];
  note_path: string;
  raw_input: string;
  investment_note: InvestmentNoteDraft;
};

export type InvestmentAssetDossier = {
  asset_key: string;
  asset_type: AssetCandidate['asset_type'];
  display_name: string;
  note_count: number;
  linked_submission_ids: string[];
  intake_ids: string[];
  dossier_path: string;
  updated_at: string;
};

export type InvestmentIntakeResponse = {
  intake: InvestmentIntakeRecord;
  dossiers: InvestmentAssetDossier[];
};

export type GetInvestmentIntakeResponse = {
  intake: InvestmentIntakeRecord;
  markdown: string;
};

export type GetInvestmentAssetResponse = {
  asset: InvestmentAssetDossier;
  markdown: string;
};

export type CreateInvestmentDecisionRunRequest = {
  watchlist: string[];
  mode?: ReportRunMode;
  detail?: ReportDetailLevel;
  as_of_date?: string;
  window_days?: number;
};

export type InvestmentDecisionReportResponse = {
  run_id: string;
  detail: ReportDetailLevel;
  markdown: string;
  generated_at: string;
};

export type CreateInvestmentDecisionRunResponse = {
  run: InvestmentDecisionRunRecord;
  request: InvestmentDecisionRequest;
  artifact: InvestmentDecisionArtifact;
  report: InvestmentDecisionReportResponse;
};

export type GetInvestmentDecisionRunResponse = {
  run: InvestmentDecisionRunRecord;
  request: InvestmentDecisionRequest;
  artifact?: InvestmentDecisionArtifact | null;
  report?: InvestmentDecisionReportResponse | null;
};

export type GetLatestInvestmentDecisionResponse = {
  latest: GetInvestmentDecisionRunResponse | null;
};

export type GetInvestmentEquityMapResponse = {
  path: string;
  equities: InvestmentEquityMapEntry[];
};

export type NormalizeInvestmentEquityRequest = {
  input: string;
};

export type NormalizeInvestmentEquityResponse = {
  identity: NormalizedEquityIdentity;
};

export type PutInvestmentEquityMapRequest = {
  equities: InvestmentEquityMapEntry[];
};

export type PutInvestmentEquityMapResponse = {
  path: string;
  equities: InvestmentEquityMapEntry[];
  updated_at: string;
};
