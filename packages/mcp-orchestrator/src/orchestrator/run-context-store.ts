import type { AgentTurn, DailyReport, EvidenceBundle } from '@agentic/shared-types';
import type { ResearchResult } from '../collector/research-service.js';
import type { VerdictResult } from '../pipeline/types.js';

type RunContext = {
  bundle?: EvidenceBundle;
  entity?: string;
  researchResults: ResearchResult[];
  verdict?: VerdictResult;
  report?: DailyReport;
  topic?: string;
};

export class RunContextStore {
  private readonly contexts = new Map<string, RunContext>();

  setBundle(runId: string, bundle: EvidenceBundle): void {
    this.ensure(runId).bundle = bundle;
  }

  getBundle(runId: string): EvidenceBundle | undefined {
    return this.contexts.get(runId)?.bundle;
  }

  setEntity(runId: string, entity: string): void {
    this.ensure(runId).entity = entity;
  }

  getEntity(runId: string): string | undefined {
    return this.contexts.get(runId)?.entity;
  }

  setTopic(runId: string, topic: string): void {
    this.ensure(runId).topic = topic;
  }

  getTopic(runId: string): string | undefined {
    return this.contexts.get(runId)?.topic;
  }

  addResearchResults(runId: string, results: ResearchResult[]): void {
    const context = this.ensure(runId);
    context.researchResults.push(...results);
  }

  getResearchResults(runId: string): ResearchResult[] {
    return [...(this.contexts.get(runId)?.researchResults ?? [])];
  }

  setVerdict(runId: string, verdict: VerdictResult): void {
    this.ensure(runId).verdict = verdict;
  }

  getVerdict(runId: string): VerdictResult | undefined {
    return this.contexts.get(runId)?.verdict;
  }

  setReport(runId: string, report: DailyReport): void {
    this.ensure(runId).report = report;
  }

  getReport(runId: string): DailyReport | undefined {
    return this.contexts.get(runId)?.report;
  }

  summarizeDebate(turns: AgentTurn[]): string {
    return turns
      .slice(-6)
      .map((turn) => `${turn.agent_name}: ${turn.response.summary}`)
      .join(' | ');
  }

  private ensure(runId: string): RunContext {
    let context = this.contexts.get(runId);
    if (!context) {
      context = { researchResults: [] };
      this.contexts.set(runId, context);
    }
    return context;
  }
}
