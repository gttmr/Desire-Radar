import type {
  BeneficiaryCandidate,
  GetHighLevelRunResponse,
  GetRunResearchResponse,
  GetRunVerdictResponse,
  ListResearchRequestsResponse,
  RunFromCandidateResponse,
  VerdictResult,
} from '@agentic/shared-types';
import type { OrchestratorClient } from './orchestratorClient.js';

function formatBeneficiaries(label: string, items: BeneficiaryCandidate[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return [`${label}: ${items.map((item) => item.name).join(', ')}`];
}

function isVerdictDegraded(verdict?: VerdictResult): boolean {
  if (!verdict) {
    return false;
  }
  return [verdict.primaryTurn, verdict.crossCheckTurn, verdict.beneficiaryMappingTurn]
    .some((turn) => turn?.provider_execution_status === 'degraded');
}

export class RunCommandService {
  constructor(private readonly orchestrator: OrchestratorClient) {}

  async start(entity: string): Promise<string> {
    const result = await this.orchestrator.runFromCandidate({ entity });
    return this.formatRunStart(entity, result);
  }

  async status(runId: string): Promise<string> {
    const result = await this.orchestrator.getRun(runId);
    return this.formatRunStatus(result);
  }

  async verdict(runId: string): Promise<string> {
    const result = await this.orchestrator.getRunVerdict(runId);
    return this.formatVerdict(result);
  }

  async research(runId: string): Promise<string> {
    const result = await this.orchestrator.getRunResearch(runId);
    return this.formatResearch(result);
  }

  async requests(runId: string): Promise<string> {
    const result = await this.orchestrator.getResearchRequests(runId);
    return this.formatRequests(result);
  }

  private formatRunStart(subject: string, result: RunFromCandidateResponse): string {
    const lines = [
      `subject=${subject}`,
      `run_id=${result.run_id}`,
      `triage=${result.triage.approved ? 'approved' : 'rejected'} | ${result.triage.reason}`,
    ];
    if (result.debate) {
      lines.push(`debate=${result.debate.status} | rounds=${result.debate.roundsExecuted} | turns=${result.debate.turns.length}`);
    }
    if (result.research) {
      lines.push(
        `research=executed:${result.research.executed} | results=${result.research.results.length} | reran_debate=${result.research.reranDebate}`,
      );
    }
    if (result.verdict) {
      lines.push(
        `verdict=${result.verdict.recommendation} | confidence=${Math.round(result.verdict.confidence * 100)}% | degraded=${isVerdictDegraded(result.verdict)}`,
      );
      lines.push(`summary=${result.verdict.summary}`);
      if (result.verdict.entity) {
        lines.push(`topic=${result.verdict.entity}`);
      }
      if (result.verdict.beneficiary_mapping) {
        lines.push(...formatBeneficiaries('direct', result.verdict.beneficiary_mapping.direct_winners));
        lines.push(...formatBeneficiaries('public', result.verdict.beneficiary_mapping.public_beneficiaries));
      }
    }
    if (result.report) {
      lines.push(`report_id=${result.report.report.report_id}`);
    }
    return lines.join('\n');
  }

  private formatRunStatus(result: GetHighLevelRunResponse): string {
    const run = result.run;
    const lines = [
      `run_id=${run.run_id}`,
      `topic=${run.topic}`,
      `status=${run.status}`,
      `created_at=${run.created_at}`,
      `updated_at=${run.updated_at}`,
    ];
    if (typeof run.evidence_count === 'number') {
      lines.push(`evidence_count=${run.evidence_count}`);
    }
    if (run.providers && run.providers.length > 0) {
      lines.push(`providers=${run.providers.join(', ')}`);
    }
    if (run.research) {
      lines.push(`research_findings=${run.research.findings.length}`);
    }
    if (run.verdict?.summary) {
      lines.push(`verdict=${run.verdict.summary}`);
    }
    return lines.join('\n');
  }

  private formatVerdict(result: GetRunVerdictResponse): string {
    const verdict = result.verdict;
    const lines = [
      `run_id=${result.run_id}`,
      `summary=${verdict.summary}`,
    ];
    if (typeof verdict.confidence === 'number') {
      lines.push(`confidence=${Math.round(verdict.confidence * 100)}%`);
    }
    if (verdict.beneficiary_mapping) {
      lines.push(...formatBeneficiaries('direct', verdict.beneficiary_mapping.direct_winners));
      lines.push(...formatBeneficiaries('public', verdict.beneficiary_mapping.public_beneficiaries));
      lines.push(...formatBeneficiaries('second_order', verdict.beneficiary_mapping.second_order_beneficiaries));
      if (verdict.beneficiary_mapping.invalidation_point) {
        lines.push(`invalidation=${verdict.beneficiary_mapping.invalidation_point}`);
      }
    }
    if (verdict.risks && verdict.risks.length > 0) {
      lines.push(`risks=${verdict.risks.join('; ')}`);
    }
    return lines.join('\n');
  }

  private formatResearch(result: GetRunResearchResponse): string {
    const lines = [
      `run_id=${result.run_id}`,
      `status=${result.research.status}`,
      `findings=${result.research.findings.length}`,
      `latest_turns=${result.research.latest_turns.length}`,
    ];
    for (const finding of result.research.findings.slice(0, 5)) {
      lines.push(
        `- ${finding.agent_name} | confidence=${Math.round(finding.confidence * 100)}% | ${finding.summary}`,
      );
    }
    return lines.join('\n');
  }

  private formatRequests(result: ListResearchRequestsResponse): string {
    if (result.count === 0) {
      return `run_id=${result.run_id}\nrequests=0`;
    }
    const lines = [`run_id=${result.run_id}`, `requests=${result.count}`];
    for (const item of result.requests.slice(0, 10)) {
      lines.push(
        [
          `entity=${item.request.entity}`,
          `intent=${item.request.intent}`,
          `kind=${item.request.requestKind}`,
          `status=${item.status}`,
          `question=${item.request.question}`,
        ].join(' | '),
      );
    }
    return lines.join('\n');
  }
}
