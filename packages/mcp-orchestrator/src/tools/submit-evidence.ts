import type { SubmitEvidenceRequest, SubmitEvidenceResponse } from '@agentic/shared-types';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';

export function submitEvidence(orchestrator: RunOrchestrator) {
  return async (req: SubmitEvidenceRequest): Promise<SubmitEvidenceResponse> => {
    return orchestrator.submitEvidence(req.topic, req.evidence_bundle, req.run_id);
  };
}
