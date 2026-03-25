import type { AgentTurn } from '@agentic/shared-types';
import type { DebatePolicy } from '../config/index.js';
import type { AgentExecutor } from '../orchestrator/agent-executor.js';
import type { RunStore } from '../orchestrator/run-store.js';
import type { RunContextStore } from '../orchestrator/run-context-store.js';
import type { CollectorSourceStatus } from '../collector/client.js';
import type { DebatePhaseResult } from './types.js';

export class DebateService {
  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly runStore: RunStore,
    private readonly contextStore: RunContextStore,
    private readonly policy: DebatePolicy,
  ) {}

  async run(params: {
    runId: string;
    plan?: string[];
    maxRounds?: number;
    providers?: string[];
    orchestratorQuestions?: string[];
    sourceStatus?: Record<string, CollectorSourceStatus>;
  }): Promise<DebatePhaseResult> {
    const run = this.runStore.getRun(params.runId);
    if (!run) {
      throw new Error(`Run not found: ${params.runId}`);
    }

    this.runStore.updateRun(params.runId, { status: 'running' });

    const plan = params.plan ?? this.policy.defaultPlan;
    const rounds = params.maxRounds ?? this.policy.maxRounds;
    const turns: AgentTurn[] = [];
    let roundsExecuted = 0;

    for (let round = 0; round < rounds; round += 1) {
      let hasNewMessages = false;

      for (const agentName of plan) {
        const agentTurns = await this.agentExecutor.executeAgent({
          runId: params.runId,
          runScope: params.runId,
          agentName,
          phase: 'debate',
          providers: params.providers,
          evidenceBundle: this.contextStore.getBundle(params.runId),
          otherAgentMessages: this.collectMessagesForAgent(params.runId, agentName),
          orchestratorQuestions: params.orchestratorQuestions,
          researchResults: this.contextStore.getResearchResults(params.runId),
          sourceStatus: params.sourceStatus,
        });
        turns.push(...agentTurns);

        if (agentTurns.some((turn) => turn.response.messages_for_other_agents.length > 0)) {
          hasNewMessages = true;
        }
      }

      roundsExecuted += 1;
      if (!hasNewMessages && round > 0 && this.policy.consensusRequiresQuietRound) {
        this.runStore.updateRun(params.runId, { status: 'completed' });
        return { turns, status: 'consensus', roundsExecuted };
      }
    }

    this.runStore.updateRun(params.runId, { status: 'completed' });
    return {
      turns,
      status: roundsExecuted >= rounds ? 'max_rounds_reached' : 'completed',
      roundsExecuted,
    };
  }

  private collectMessagesForAgent(runId: string, agentName: string): Array<{ from: string; content: string }> {
    const turns = this.runStore.getTurns(runId);
    const messages: Array<{ from: string; content: string }> = [];
    for (const turn of turns) {
      for (const message of turn.response.messages_for_other_agents) {
        if (message.target_agent === agentName) {
          messages.push({ from: turn.agent_name, content: message.content });
        }
      }
    }
    return messages;
  }
}
