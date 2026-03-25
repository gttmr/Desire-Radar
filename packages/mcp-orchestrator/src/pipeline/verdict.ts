import type { DebatePolicy } from '../config/index.js';
import type { AgentExecutor } from '../orchestrator/agent-executor.js';
import type { RunContextStore } from '../orchestrator/run-context-store.js';
import type { RunStore } from '../orchestrator/run-store.js';
import type { VerdictResult } from './types.js';

export class VerdictService {
  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly contextStore: RunContextStore,
    private readonly policy: DebatePolicy,
    private readonly runStore: RunStore,
  ) {}

  async run(runId: string, providers?: string[]): Promise<VerdictResult> {
    const bundle = this.contextStore.getBundle(runId);
    const entity = this.contextStore.getEntity(runId) ?? bundle?.entity ?? 'unknown';
    const debateTurns = this.runStore.getTurns(runId);
    const researchResults = this.contextStore.getResearchResults(runId);

    const [primaryTurn] = await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: this.policy.verdict.primaryAgent,
      phase: 'verdict',
      providers,
      modelProfile: this.policy.verdict.primaryModelProfile,
      evidenceBundle: bundle,
      debateTurns,
      researchResults,
      orchestratorQuestions: [
        'Produce the final investment judgement. Be explicit about what could make this thesis wrong.',
      ],
    });

    const [crossCheckTurn] = await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: this.policy.verdict.crossCheckAgent,
      phase: 'verdict',
      providers,
      modelProfile: this.policy.verdict.crossCheckModelProfile,
      evidenceBundle: bundle,
      debateTurns,
      researchResults,
      orchestratorQuestions: ['Cross-check the final judgement and point out the largest risk.'],
    });

    const verdict: VerdictResult = {
      runId,
      entity,
      summary:
        primaryTurn?.response.summary ??
        crossCheckTurn?.response.summary ??
        'No verdict produced.',
      confidence: Math.max(
        primaryTurn?.response.confidence ?? 0,
        crossCheckTurn?.response.confidence ?? 0,
      ),
      recommendation:
        primaryTurn?.response.recommended_next_step ??
        crossCheckTurn?.response.recommended_next_step ??
        'hold',
      supportingAgents: [
        primaryTurn?.agent_name,
        crossCheckTurn?.agent_name,
      ].filter((value): value is string => Boolean(value)),
      openQuestions: [
        ...(primaryTurn?.response.open_questions ?? []),
        ...(crossCheckTurn?.response.open_questions ?? []),
      ].filter((value, index, items) => items.indexOf(value) === index),
      primaryTurn,
      crossCheckTurn,
      createdAt: new Date().toISOString(),
    };

    this.contextStore.setVerdict(runId, verdict);
    return verdict;
  }
}
