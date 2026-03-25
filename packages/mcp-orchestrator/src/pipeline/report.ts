import type { DailyReport } from '@agentic/shared-types';
import type { AgentExecutor } from '../orchestrator/agent-executor.js';
import type { RunContextStore } from '../orchestrator/run-context-store.js';
import type { ReportPhaseResult } from './types.js';
import { randomUUID } from 'node:crypto';

export class ReportService {
  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly contextStore: RunContextStore,
  ) {}

  async run(runId: string): Promise<ReportPhaseResult> {
    const verdict = this.contextStore.getVerdict(runId);
    const bundle = this.contextStore.getBundle(runId);
    const researchResults = this.contextStore.getResearchResults(runId);

    const [reportTurn] = await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: 'report',
      phase: 'report',
      evidenceBundle: bundle,
      researchResults,
      verdictSummary: verdict
        ? `${verdict.summary}\nconfidence=${verdict.confidence}\nrecommendation=${verdict.recommendation}`
        : undefined,
    });

    const now = new Date().toISOString();
    const report: DailyReport = {
      report_id: randomUUID(),
      date: now.slice(0, 10),
      summary: reportTurn?.response.summary ?? verdict?.summary ?? 'No report summary',
      agent_highlights: Object.fromEntries(
        [reportTurn, verdict?.primaryTurn, verdict?.crossCheckTurn]
          .filter(Boolean)
          .map((turn) => [turn!.agent_name, turn!.response.summary]),
      ),
      final_verdicts: verdict
        ? [
            {
              entity: verdict.entity,
              verdict: verdict.recommendation,
              confidence: verdict.confidence,
              supporting_agents: verdict.supportingAgents,
            },
          ]
        : [],
      linked_themes: [],
      linked_entities: verdict ? [verdict.entity] : [],
      full_markdown: reportTurn?.response.summary ?? verdict?.summary ?? '',
      created_at: now,
    };

    this.contextStore.setReport(runId, report);
    return {
      report,
      sections: [
        { title: 'Executive Summary', content: report.summary },
        ...(verdict
          ? [
              {
                title: 'Verdict',
                content: `${verdict.entity}: ${verdict.recommendation} (${Math.round(verdict.confidence * 100)}%)`,
              },
            ]
          : []),
      ],
    };
  }
}
