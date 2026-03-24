import type { RunStateResponse } from '@agentic/shared-types';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';

export function getRunState(orchestrator: RunOrchestrator) {
  return (runId: string): RunStateResponse => {
    return orchestrator.getRunState(runId);
  };
}
