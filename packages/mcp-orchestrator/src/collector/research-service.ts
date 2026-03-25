import type { CollectorSubmission } from './client.js';
import { CollectorClient } from './client.js';
import { randomUUID } from 'node:crypto';

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
      if (!request.targetSourceId) {
        throw new Error(`run_source request requires targetSourceId (${request.entity})`);
      }
      const submission = await this.client.triggerSource(request.targetSourceId);
      return this.toResult(request, submission);
    }

    const submission =
      request.requestKind === 'submit_agent_evidence'
        ? await this.client.submitAgentEvidence({
            producer_ref: request.requestedByAgent,
            evidence_items: [
              {
                evidence_id: randomUUID().replace(/-/g, '').slice(0, 16),
                entity_candidates: [request.entity],
                signal_type: 'agent_research_note',
                title_or_label: `${request.requestedByAgent}: ${request.question}`,
                geo: 'global',
                trust_score: 0.8,
                freshness_ttl: 3600,
              },
            ],
          })
        : await this.client.requestHumanAnalystNote({
            entity_candidates: [request.entity],
            question: request.question,
            why_now: request.whyNow,
            priority: request.priority,
            producer_ref: 'orchestrator',
            requested_by_agent: request.requestedByAgent,
            run_id: request.runId,
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
