import type {
  AgentTurn,
  EvidenceBundle,
  Evidence,
  DailyReport,
  AgentResponse,
  AgentClaim,
  SubmitEvidenceResponse,
  RunDebateResponse,
  SynthesizeReportResponse,
  RunStateResponse,
} from '@agentic/shared-types';
import type { AgentExecutor } from './agent-executor.js';
import type { RunStore } from './run-store.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_PLAN = [
  'search_intent',
  'ranking_momentum',
  'conversion_proxy',
  'scarcity',
  'diffusion',
  'human_intel',
  'theme_mapper',
  'synthesis',
];

export class RunOrchestrator {
  private evidenceBundles = new Map<string, EvidenceBundle>();
  private reports: DailyReport[] = [];

  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly runStore: RunStore,
    private readonly defaultProviders: string[],
  ) {}

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

    this.evidenceBundles.set(run.run_id, bundle);

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
    if (!run) throw new Error(`Run not found: ${runId}`);

    this.runStore.updateRun(runId, { status: 'running' });

    const bundle = this.evidenceBundles.get(runId);
    const existingTurns = this.runStore.getTurns(runId);

    // Collect messages directed at this agent from previous turns
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

    return this.agentExecutor.executeAgent({
      runId,
      agentName,
      providers: providers ?? this.defaultProviders,
      evidenceBundle: bundle,
      otherAgentMessages,
    });
  }

  async runDebate(
    runId: string,
    plan?: string[],
    maxRounds?: number,
    providers?: string[],
  ): Promise<RunDebateResponse> {
    const agentPlan = plan ?? DEFAULT_PLAN;
    const rounds = maxRounds ?? 3;
    const allTurns: AgentTurn[] = [];
    let roundsExecuted = 0;

    for (let round = 0; round < rounds; round++) {
      let hasNewMessages = false;

      for (const agentName of agentPlan) {
        const turns = await this.runAgentRound(runId, agentName, providers);
        allTurns.push(...turns);

        // Check if any agent produced messages for others
        for (const turn of turns) {
          if (turn.response.messages_for_other_agents.length > 0) {
            hasNewMessages = true;
          }
        }
      }

      roundsExecuted++;

      // If no agents produced inter-agent messages, we've reached consensus
      if (!hasNewMessages && round > 0) {
        this.runStore.updateRun(runId, { status: 'completed' });
        return {
          turns: allTurns,
          status: 'consensus',
          rounds_executed: roundsExecuted,
        };
      }
    }

    this.runStore.updateRun(runId, { status: 'completed' });
    return {
      turns: allTurns,
      status: roundsExecuted >= rounds ? 'max_rounds_reached' : 'completed',
      rounds_executed: roundsExecuted,
    };
  }

  async synthesizeReport(
    runId: string,
    _style?: string,
  ): Promise<SynthesizeReportResponse> {
    // Run the report agent
    const reportTurns = await this.runAgentRound(runId, 'report');

    const synthesisResponse = reportTurns[0]?.response;
    const now = new Date().toISOString();
    const reportId = randomUUID();

    const report: DailyReport = {
      report_id: reportId,
      date: now.slice(0, 10),
      summary: synthesisResponse?.summary ?? 'No synthesis available',
      agent_highlights: this.buildAgentHighlights(runId),
      final_verdicts: [],
      linked_themes: [],
      linked_entities: [],
      full_markdown: synthesisResponse?.summary ?? '',
      created_at: now,
    };

    this.reports.push(report);

    // Build sections from synthesis claims
    const sections: Array<{ title: string; content: string }> = [];
    if (synthesisResponse) {
      sections.push({
        title: 'Executive Summary',
        content: synthesisResponse.summary,
      });
      if (synthesisResponse.claims.length > 0) {
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
      if (synthesisResponse.open_questions.length > 0) {
        sections.push({
          title: 'Open Questions',
          content: synthesisResponse.open_questions
            .map((q: string) => `- ${q}`)
            .join('\n'),
        });
      }
    }

    return {
      report_id: reportId,
      summary: report.summary,
      sections,
    };
  }

  getRunState(runId: string): RunStateResponse {
    const run = this.runStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const turns = this.runStore.getTurns(runId);

    // Group turns by agent
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
        existing.turns_completed++;
        existing.latest_response = turn.response;
      }
    }

    const agents = [...agentMap.entries()].map(([agent_name, data]) => ({
      agent_name,
      ...data,
    }));

    // Get the last N turns
    const latestTurns = turns.slice(-10);

    return {
      run,
      agents,
      sessions: [],
      latest_turns: latestTurns,
    };
  }

  getReports(): DailyReport[] {
    return [...this.reports];
  }

  private buildAgentHighlights(runId: string): Record<string, string> {
    const turns = this.runStore.getTurns(runId);
    const highlights: Record<string, string> = {};
    for (const turn of turns) {
      highlights[turn.agent_name] = turn.response.summary;
    }
    return highlights;
  }
}
