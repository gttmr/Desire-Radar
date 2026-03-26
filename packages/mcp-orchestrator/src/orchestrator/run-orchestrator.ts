import type {
  AgentTurn,
  DailyReport,
  EvidenceBundle,
  Evidence,
  AgentResponse,
  AgentClaim,
  ProviderExecution,
  RunResearch,
  RunVerdict,
  HighLevelRun,
  SubmitEvidenceResponse,
  RunDebateResponse,
  SynthesizeReportResponse,
  RunStateResponse,
} from '@agentic/shared-types';
import type { AgentExecutor } from './agent-executor.js';
import type { RunStore } from './run-store.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { CandidateService } from '../collector/candidate-service.js';
import type { CollectorCandidate } from '../collector/client.js';
import type { DebateService } from '../pipeline/debate.js';
import { buildRunEvaluationRecord } from '../pipeline/evaluation.js';
import type { ReportService } from '../pipeline/report.js';
import type { ResearchLoopService } from '../pipeline/research-loop.js';
import type { TriageService } from '../pipeline/triage.js';
import type { VerdictService } from '../pipeline/verdict.js';
import type {
  DebatePhaseResult,
  ReportPhaseResult,
  TriageDecision,
  VerdictResult,
} from '../pipeline/types.js';
import { randomUUID } from 'node:crypto';
import { RunContextStore } from './run-context-store.js';

type RunOrchestratorOptions = {
  sessionStore?: SessionStore;
  contextStore?: RunContextStore;
  candidateService?: CandidateService;
  triageService?: TriageService;
  debateService?: DebateService;
  researchLoopService?: ResearchLoopService;
  verdictService?: VerdictService;
  reportService?: ReportService;
};

export class RunOrchestrator {
  private readonly contextStore: RunContextStore;
  private reports: DailyReport[] = [];

  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly runStore: RunStore,
    private readonly defaultProviders: string[],
    private readonly options: RunOrchestratorOptions = {},
  ) {
    this.contextStore = options.contextStore ?? new RunContextStore();
  }

  async submitEvidence(
    topic: string,
    bundle: EvidenceBundle,
    runId?: string,
  ): Promise<SubmitEvidenceResponse> {
    let run;
    if (runId) {
      run = this.runStore.getRun(runId);
      if (run) {
        const refs = bundle.evidence_items.map((e: Evidence) => e.evidence_id);
        this.runStore.updateRun(runId, {
          evidence_refs: [...run.evidence_refs, ...refs],
        });
      }
    }
    if (!run) {
      const refs = bundle.evidence_items.map((e: Evidence) => e.evidence_id);
      run = this.runStore.createRun(topic, refs);
    }

    this.contextStore.setBundle(run.run_id, bundle);
    this.contextStore.setEntity(run.run_id, bundle.entity);
    this.contextStore.setTopic(run.run_id, topic);

    return {
      run_id: run.run_id,
      evidence_count: bundle.evidence_items.length,
    };
  }

  async runAgentRound(
    runId: string,
    agentName: string,
    providers?: string[],
  ): Promise<AgentTurn[]> {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    this.runStore.updateRun(runId, { status: 'running' });

    return this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName,
      phase: agentName === 'report' ? 'report' : 'debate',
      providers: providers ?? this.defaultProviders,
      evidenceBundle: this.contextStore.getBundle(runId),
      otherAgentMessages: this.collectMessagesForAgent(runId, agentName),
      researchResults: this.contextStore.getResearchResults(runId),
    });
  }

  async runDebate(
    runId: string,
    plan?: string[],
    maxRounds?: number,
    providers?: string[],
  ): Promise<RunDebateResponse> {
    if (!this.options.debateService) {
      throw new Error('Debate service not configured');
    }

    const sourceStatus = this.options.candidateService
      ? await this.options.candidateService.getSourcesCatalog()
      : undefined;

    const result = await this.options.debateService.run({
      runId,
      plan,
      maxRounds,
      providers: providers ?? this.defaultProviders,
      sourceStatus,
    });

    return {
      turns: result.turns,
      status: result.status,
      rounds_executed: result.roundsExecuted,
    };
  }

  async synthesizeReport(
    runId: string,
    _style?: string,
  ): Promise<SynthesizeReportResponse> {
    if (this.options.verdictService && !this.contextStore.getVerdict(runId)) {
      await this.options.verdictService.run(runId, this.defaultProviders);
    }

    const reportResult = this.options.reportService
      ? await this.options.reportService.run(runId)
      : this.buildCompatibilityReport(runId);

    this.reports.push(reportResult.report);
    return {
      report_id: reportResult.report.report_id,
      summary: reportResult.report.summary,
      sections: reportResult.sections,
    };
  }

  async runFromCandidate(params: {
    entity: string;
    providers?: string[];
    maxRounds?: number;
    plan?: string[];
  }): Promise<{
    run_id: string;
    triage: TriageDecision;
    debate?: DebatePhaseResult;
    research?: Awaited<ReturnType<ResearchLoopService['run']>>;
    verdict?: VerdictResult;
    report?: ReportPhaseResult;
  }> {
    if (!this.options.candidateService || !this.options.triageService) {
      throw new Error('Collector-backed run dependencies are not configured');
    }

    const bundle = await this.options.candidateService.buildBundle(params.entity);
    const candidates = await this.options.candidateService.getNextCandidates(false);
    const candidate =
      candidates.find((item) => item.entity === params.entity) ??
      this.syntheticCandidate(bundle.entity, bundle);
    const triage = this.options.triageService.evaluate(candidate, bundle);

    const { run_id } = await this.submitEvidence(
      `Candidate pipeline for ${bundle.entity}`,
      bundle,
    );

    if (!triage.approved) {
      return { run_id, triage };
    }

    const debate = this.options.debateService
      ? await this.options.debateService.run({
          runId: run_id,
          plan: params.plan,
          maxRounds: params.maxRounds,
          providers: params.providers ?? this.defaultProviders,
          sourceStatus: await this.options.candidateService.getSourcesCatalog(),
        })
      : undefined;

    const research =
      this.options.researchLoopService && debate
        ? await this.options.researchLoopService.run({
            runId: run_id,
            entity: bundle.entity,
            latestDebate: debate,
            providers: params.providers ?? this.defaultProviders,
          })
        : undefined;

    const verdict = this.options.verdictService
      ? await this.options.verdictService.run(run_id, params.providers ?? this.defaultProviders)
      : undefined;

    const report = this.options.reportService
      ? await this.options.reportService.run(run_id)
      : undefined;

    if (report) {
      this.reports.push(report.report);
    }

    return {
      run_id,
      triage,
      debate,
      research,
      verdict,
      report,
    };
  }

  async rerunResearch(runId: string): Promise<Awaited<ReturnType<ResearchLoopService['run']>>> {
    if (!this.options.researchLoopService) {
      throw new Error('Research loop service not configured');
    }

    const entity = this.contextStore.getEntity(runId);
    if (!entity) {
      throw new Error(`Run ${runId} has no bound entity`);
    }

    const latestDebate: DebatePhaseResult = {
      turns: this.runStore.getTurns(runId),
      status: 'completed',
      roundsExecuted: 1,
    };

    return this.options.researchLoopService.run({
      runId,
      entity,
      latestDebate,
      providers: this.defaultProviders,
    });
  }

  async rerunVerdict(runId: string): Promise<VerdictResult> {
    if (!this.options.verdictService) {
      throw new Error('Verdict service not configured');
    }
    return this.options.verdictService.run(runId, this.defaultProviders);
  }

  listResearchRequests(runId: string) {
    return this.contextStore.getResearchResults(runId);
  }

  getRunState(runId: string): RunStateResponse {
    const run = this.runStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const turns = this.runStore.getTurns(runId);

    const agentMap = new Map<
      string,
      { turns_completed: number; latest_response?: AgentResponse }
    >();
    for (const turn of turns) {
      const existing = agentMap.get(turn.agent_name);
      if (!existing) {
        agentMap.set(turn.agent_name, {
          turns_completed: 1,
          latest_response: turn.response,
        });
      } else {
        existing.turns_completed += 1;
        existing.latest_response = turn.response;
      }
    }

    const agents = [...agentMap.entries()].map(([agent_name, data]) => ({
      agent_name,
      ...data,
    }));

    const latestTurns = turns.slice(-10);
    const sessions = this.options.sessionStore?.listSessions(undefined, runId) ?? [];

    return {
      run,
      agents,
      sessions,
      latest_turns: latestTurns,
    };
  }

  getReports(): DailyReport[] {
    return [...this.reports];
  }

  listHighLevelRuns(): { runs: HighLevelRun[]; count: number } {
    const runs = this.runStore.listRuns().map((run) => this.toHighLevelRun(run.run_id));
    return { runs, count: runs.length };
  }

  getHighLevelRun(runId: string): { run: HighLevelRun } {
    return { run: this.toHighLevelRun(runId) };
  }

  getRunResearch(runId: string): { run_id: string; research: RunResearch } {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const turns = this.runStore.getTurns(runId);
    const findings = turns.map((turn) => ({
      agent_name: turn.agent_name,
      provider: turn.provider,
      summary: turn.response.summary,
      confidence: turn.response.confidence,
      provider_execution_status: turn.provider_execution_status,
      provider_degraded_kind: turn.provider_degraded_kind,
      provider_error: turn.provider_error,
      provider_recoverable: turn.provider_recoverable,
      claims: turn.response.claims,
      citations: turn.citations,
      evidence_refs: turn.evidence_refs,
      open_questions: turn.response.open_questions,
      recommended_next_step: turn.response.recommended_next_step,
    }));

    return {
      run_id: runId,
      research: {
        run_id: runId,
        status: run.status,
        findings,
        latest_turns: turns.slice(-10),
        updated_at: run.updated_at,
      },
    };
  }

  getRunVerdict(runId: string): { run_id: string; verdict: RunVerdict } {
    const verdict = this.contextStore.getVerdict(runId);
    if (!verdict) {
      throw new Error(`Verdict not found for run: ${runId}`);
    }

    return {
      run_id: runId,
      verdict: {
        run_id: runId,
        summary: verdict.summary,
        confidence: verdict.confidence,
        beneficiary_mapping: verdict.beneficiary_mapping,
        verdicts: [
          {
            entity: verdict.entity,
            verdict: verdict.recommendation,
            confidence: verdict.confidence,
            supporting_agents: verdict.supportingAgents,
          },
        ],
        risks: verdict.openQuestions,
        generated_at: verdict.createdAt,
      },
    };
  }

  getProviderExecutions(runId: string): { run_id: string; executions: ProviderExecution[]; count: number } {
    const executions = this.runStore.getTurns(runId).map((turn) => ({
      execution_id: `${turn.run_id}:${turn.agent_name}:${turn.provider}:${turn.turn_index}`,
      run_id: turn.run_id,
      agent_name: turn.agent_name,
      provider: turn.provider,
      session_id: turn.session_id,
      status: turn.provider_execution_status ?? 'completed',
      turn_index: turn.turn_index,
      prompt_summary: turn.prompt_summary,
      output_summary: turn.response.summary,
      completed_at: turn.created_at,
      created_at: turn.created_at,
      updated_at: turn.created_at,
      error: turn.provider_error,
      degraded_kind: turn.provider_degraded_kind,
      recoverable: turn.provider_recoverable,
      turn,
    }));
    return { run_id: runId, executions, count: executions.length };
  }

  private collectMessagesForAgent(runId: string, agentName: string): Array<{ from: string; content: string }> {
    const existingTurns = this.runStore.getTurns(runId);
    const otherAgentMessages: Array<{ from: string; content: string }> = [];
    for (const turn of existingTurns) {
      for (const msg of turn.response.messages_for_other_agents) {
        if (msg.target_agent === agentName) {
          otherAgentMessages.push({
            from: turn.agent_name,
            content: msg.content,
          });
        }
      }
    }
    return otherAgentMessages;
  }

  private buildCompatibilityReport(runId: string): ReportPhaseResult {
    const turns = this.runStore.getTurns(runId);
    const summary = turns.at(-1)?.response.summary ?? 'No synthesis available';
    const now = new Date().toISOString();
    const report: DailyReport = {
      report_id: randomUUID(),
      date: now.slice(0, 10),
      summary,
      agent_highlights: this.buildAgentHighlights(runId),
      final_verdicts: [],
      linked_themes: [],
      linked_entities: [],
      full_markdown: summary,
      created_at: now,
    };

    const sections: Array<{ title: string; content: string }> = [
      {
        title: 'Executive Summary',
        content: summary,
      },
    ];

    const synthesisResponse = turns.at(-1)?.response;
    if (synthesisResponse?.claims.length) {
      sections.push({
        title: 'Key Claims',
        content: synthesisResponse.claims
          .map(
            (c: AgentClaim) =>
              `- **${c.claim}** (confidence: ${c.confidence})\n  Evidence: ${c.supporting_evidence.join(', ')}`,
          )
          .join('\n'),
      });
    }

    if (synthesisResponse?.open_questions.length) {
      sections.push({
        title: 'Open Questions',
        content: synthesisResponse.open_questions
          .map((question: string) => `- ${question}`)
          .join('\n'),
      });
    }

    return {
      report,
      sections,
      evaluation: buildRunEvaluationRecord({
        runId,
        bundle: this.contextStore.getBundle(runId),
        debateTurns: turns,
        researchResults: this.contextStore.getResearchResults(runId),
        verdict: this.contextStore.getVerdict(runId),
        report,
      }),
    };
  }

  private buildAgentHighlights(runId: string): Record<string, string> {
    const turns = this.runStore.getTurns(runId);
    const highlights: Record<string, string> = {};
    for (const turn of turns) {
      highlights[turn.agent_name] = turn.response.summary;
    }
    return highlights;
  }

  private syntheticCandidate(entity: string, bundle?: EvidenceBundle): CollectorCandidate {
    const now = new Date().toISOString();
    const sources = bundle
      ? bundle.evidence_items
          .map((item) => item.source)
          .filter((source, index, items) => items.indexOf(source) === index)
      : [];
    return {
      entity,
      status: 'emerging',
      emergence_score: bundle ? Math.min(10, bundle.evidence_items.length * 0.5 + sources.length * 2) : 0,
      velocity_score: bundle ? Math.min(10, bundle.evidence_items.length) : 0,
      source_count: sources.length,
      evidence_ids: bundle?.evidence_items.map((item) => item.evidence_id) ?? [],
      sources,
      first_seen: bundle?.time_window.start ?? now,
      last_seen: bundle?.time_window.end ?? now,
    };
  }

  private toHighLevelRun(runId: string): HighLevelRun {
    const run = this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    return {
      run_id: run.run_id,
      topic: this.contextStore.getTopic(run.run_id) ?? run.topic_or_theme_set.join(', '),
      status: run.status,
      created_at: run.created_at,
      updated_at: run.updated_at,
      evidence_count: this.contextStore.getBundle(run.run_id)?.evidence_items.length ?? run.evidence_refs.length,
      plan: undefined,
      providers: this.defaultProviders,
      research: this.safeGetResearch(run.run_id),
      verdict: this.safeGetVerdict(run.run_id),
    };
  }

  private safeGetResearch(runId: string): RunResearch | undefined {
    try {
      return this.getRunResearch(runId).research;
    } catch {
      return undefined;
    }
  }

  private safeGetVerdict(runId: string): RunVerdict | undefined {
    try {
      return this.getRunVerdict(runId).verdict;
    } catch {
      return undefined;
    }
  }
}
