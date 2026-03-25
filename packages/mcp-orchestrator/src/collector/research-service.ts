import type { CollectorSubmission } from './client.js';
import { CollectorClient } from './client.js';

export type ResearchRequestKind =
  | 'run_source'
  | 'submit_agent_evidence'
  | 'request_human_note';

export type ResearchPriority = 'low' | 'normal' | 'high';

export type ResearchRequest = {
  runId: string;
  entity: string;
  requestedByAgent: string;
  requestKind: ResearchRequestKind;
  targetSourceId?: string;
  question: string;
  whyNow: string;
  priority: ResearchPriority;
};

export type ResearchResult = {
  request: ResearchRequest;
  submissionId: string;
  status: CollectorSubmission['status'];
  evidenceIds: string[];
  errorMessage?: string;
};

export class ResearchService {
  constructor(private readonly client: CollectorClient) {}

  async submitRequest(request: ResearchRequest): Promise<ResearchResult> {
    if (request.requestKind === 'run_source') {
      const submission = await this.client.triggerSource(
        request.targetSourceId ?? 'manual_observation',
      );
      return this.toResult(request, submission);
    }

    const submission = await this.client.submitManualObservation({
      title: `${request.requestedByAgent}: ${request.question}`,
      entities: [request.entity],
      signal_type:
        request.requestKind === 'submit_agent_evidence'
          ? 'agent_research'
          : 'human_note_request',
      trust_score: request.requestKind === 'submit_agent_evidence' ? 0.85 : 0.75,
    });
    return this.toResult(request, submission);
  }

  private toResult(request: ResearchRequest, submission: CollectorSubmission): ResearchResult {
    return {
      request,
      submissionId: submission.submission_id,
      status: submission.status,
      evidenceIds: submission.evidence_ids,
      errorMessage: submission.error_message,
    };
  }
}
