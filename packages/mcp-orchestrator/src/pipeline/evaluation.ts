import type {
  AgentTurn,
  DailyReport,
  EvidenceBundle,
  RunEvaluationRecord,
} from '@agentic/shared-types';
import type { ResearchResult } from '../collector/research-service.js';
import type { VerdictResult } from './types.js';

export const DEFAULT_REPLAY_FIXTURE_PATH =
  'packages/mcp-orchestrator/tests/fixtures/full-run-replay.json';

export function buildRunEvaluationRecord(params: {
  runId: string;
  bundle?: EvidenceBundle;
  debateTurns?: AgentTurn[];
  researchResults?: ResearchResult[];
  verdict?: VerdictResult;
  report?: DailyReport;
}): RunEvaluationRecord {
  const bundle = params.bundle;
  const debateTurns = params.debateTurns ?? [];
  const researchResults = params.researchResults ?? [];
  const verdict = params.verdict;
  const report = params.report;

  return {
    run_id: params.runId,
    entity: verdict?.entity ?? bundle?.entity ?? 'unknown',
    fixture_path: DEFAULT_REPLAY_FIXTURE_PATH,
    recorded_at: new Date().toISOString(),
    evidence_refs: bundle?.evidence_items.map((item) => item.evidence_id) ?? [],
    source_refs:
      bundle?.evidence_items
        .map((item) => item.source)
        .filter((source, index, items) => items.indexOf(source) === index) ?? [],
    research_requests: researchResults.map((result) => ({
      requested_by: result.request.requestedByAgent,
      request_kind: result.request.requestKind,
      question: result.request.question,
      status: result.status,
      requested_input_kind: result.request.requestedInputKind,
    })),
    provider_failures: debateTurns
      .filter(
        (turn) =>
          turn.provider_execution_status === 'degraded' ||
          Boolean(turn.provider_degraded_kind) ||
          Boolean(turn.provider_error),
      )
      .map((turn) => ({
        agent_name: turn.agent_name,
        provider: turn.provider,
        summary:
          turn.provider_error ??
          turn.response.summary ??
          turn.provider_degraded_kind ??
          'provider degraded',
      })),
    beneficiary_mapping: verdict?.beneficiary_mapping ?? null,
    final_verdict: verdict
      ? {
          summary: verdict.summary,
          confidence: verdict.confidence,
          recommendation: verdict.recommendation,
          open_questions: verdict.openQuestions,
        }
      : undefined,
    report: report
      ? {
          report_id: report.report_id,
          summary: report.summary,
        }
      : undefined,
  };
}
