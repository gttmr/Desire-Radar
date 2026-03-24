import type { RunAgentRoundRequest, RunAgentRoundResponse } from '@agentic/shared-types';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';

export function runAgentRound(orchestrator: RunOrchestrator) {
  return async (req: RunAgentRoundRequest): Promise<RunAgentRoundResponse> => {
    const turns = await orchestrator.runAgentRound(
      req.run_id,
      req.agent_name,
      req.providers,
    );
    return { turns, status: 'completed' };
  };
}
