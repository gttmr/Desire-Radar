import type { RunDebateRequest, RunDebateResponse } from '@agentic/shared-types';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';

export function runDebate(orchestrator: RunOrchestrator) {
  return async (req: RunDebateRequest): Promise<RunDebateResponse> => {
    return orchestrator.runDebate(
      req.run_id,
      req.plan,
      req.max_rounds,
      req.providers,
    );
  };
}
