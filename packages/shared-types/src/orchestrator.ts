// ---------------------------------------------------------------
// MCP orchestrator types
// ---------------------------------------------------------------

export type ProviderExecutionStatus = 'queued' | 'running' | 'completed' | 'failed';
export type HighLevelRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'consensus'
  | 'max_rounds_reached';
export type ModelProfile = 'cheap' | 'balanced' | 'premium';
export type ExecutionPhase = 'triage' | 'debate' | 'verdict' | 'report';

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
  turn?: AgentTurn;
};

export type ProviderExecutionRequest = {
  prompt: string;
  sessionId?: string;
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
  requestKind: 'run_source' | 'submit_agent_evidence' | 'request_human_note';
  targetSourceId?: string;
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
  supportingAgents: string[];
  openQuestions: string[];
  primaryTurn?: AgentTurn;
  crossCheckTurn?: AgentTurn;
  createdAt: string;
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
  last_checked_at: string;
  error?: string;
};
