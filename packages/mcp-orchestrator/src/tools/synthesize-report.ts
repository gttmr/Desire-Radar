import type { SynthesizeReportRequest, SynthesizeReportResponse } from '@agentic/shared-types';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';

export function synthesizeReport(orchestrator: RunOrchestrator) {
  return async (req: SynthesizeReportRequest): Promise<SynthesizeReportResponse> => {
    return orchestrator.synthesizeReport(req.run_id, req.report_style);
  };
}
