// ---------------------------------------------------------------
// MCP orchestrator types
// ---------------------------------------------------------------

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

/** Provider session */
export type ProviderSession = {
  session_id: string;
  agent_name: string;
  provider: string;
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
