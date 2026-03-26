import type {
  AgentTurn,
  BeneficiaryMapping,
  DailyReport,
  EvidenceBundle,
  RunEvaluationRecord,
} from '@agentic/shared-types';
import type { CollectorCandidate } from '../collector/client.js';
import type { ResearchResult } from '../collector/research-service.js';

export type TriageDecision = {
  approved: boolean;
  reason: string;
  candidate?: CollectorCandidate;
  bundle?: EvidenceBundle;
};

export type DebatePhaseResult = {
  turns: AgentTurn[];
  status: 'completed' | 'max_rounds_reached' | 'consensus';
  roundsExecuted: number;
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

export type ReportPhaseResult = {
  report: DailyReport;
  sections: Array<{ title: string; content: string }>;
  evaluation: RunEvaluationRecord;
};

export type ResearchLoopResult = {
  executed: boolean;
  results: ResearchResult[];
  reranDebate: boolean;
  debate?: DebatePhaseResult;
};
