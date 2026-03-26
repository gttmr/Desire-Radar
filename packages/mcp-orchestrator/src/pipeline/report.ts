import type { DailyReport } from '@agentic/shared-types';
import type { AgentExecutor } from '../orchestrator/agent-executor.js';
import type { RunContextStore } from '../orchestrator/run-context-store.js';
import type { RunStore } from '../orchestrator/run-store.js';
import type { ReportPhaseResult } from './types.js';
import { buildRunEvaluationRecord } from './evaluation.js';
import { randomUUID } from 'node:crypto';

export class ReportService {
  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly contextStore: RunContextStore,
    private readonly runStore: RunStore,
  ) {}

  async run(runId: string): Promise<ReportPhaseResult> {
    const verdict = this.contextStore.getVerdict(runId);
    const bundle = this.contextStore.getBundle(runId);
    const researchResults = this.contextStore.getResearchResults(runId);
    const runTurns = this.runStore.getTurns(runId);
    const beneficiaryLines = verdict?.beneficiary_mapping
      ? [
          verdict.beneficiary_mapping.direct_winners.length > 0
            ? `direct_winners=${verdict.beneficiary_mapping.direct_winners
                .map((item) => item.name)
                .join(', ')}`
            : null,
          verdict.beneficiary_mapping.public_beneficiaries.length > 0
            ? `public_beneficiaries=${verdict.beneficiary_mapping.public_beneficiaries
                .map((item) => item.name)
                .join(', ')}`
            : null,
          verdict.beneficiary_mapping.second_order_beneficiaries.length > 0
            ? `second_order_beneficiaries=${verdict.beneficiary_mapping.second_order_beneficiaries
                .map((item) => item.name)
                .join(', ')}`
            : null,
          verdict.beneficiary_mapping.missing_monetization_link
            ? `missing_monetization_link=${verdict.beneficiary_mapping.missing_monetization_link}`
            : null,
        ]
          .filter((value): value is string => Boolean(value))
          .join('\n')
      : '';

    const [reportTurn] = await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: 'report',
      phase: 'report',
      evidenceBundle: bundle,
      researchResults,
      verdictSummary: verdict
        ? `${verdict.summary}\nconfidence=${verdict.confidence}\nrecommendation=${verdict.recommendation}${
            beneficiaryLines ? `\n${beneficiaryLines}` : ''
          }`
        : undefined,
    });

    const now = new Date().toISOString();
    const linkedBeneficiaries = verdict?.beneficiary_mapping
      ? [
          ...verdict.beneficiary_mapping.direct_winners.map((item) => item.name),
          ...verdict.beneficiary_mapping.public_beneficiaries.map((item) => item.name),
          ...verdict.beneficiary_mapping.second_order_beneficiaries.map((item) => item.name),
        ].filter((value, index, items) => items.indexOf(value) === index)
      : [];
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
      linked_beneficiaries: linkedBeneficiaries,
      full_markdown: reportTurn?.response.summary ?? verdict?.summary ?? '',
      created_at: now,
    };
    const evaluation = buildRunEvaluationRecord({
      runId,
      bundle,
      debateTurns: runTurns,
      researchResults,
      verdict,
      report,
    });

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
              {
                title: 'Beneficiary Mapping',
                content: beneficiaryLines || 'No beneficiary mapping available.',
              },
            ]
          : []),
      ],
      evaluation,
    };
  }
}
