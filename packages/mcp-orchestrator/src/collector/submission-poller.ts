import { CollectorClient } from './client.js';
import type { ResearchResult } from './research-service.js';

export class SubmissionPoller {
  constructor(
    private readonly client: CollectorClient,
    private readonly pollIntervalMs: number,
    private readonly timeoutMs: number,
  ) {}

  async awaitCompletion(result: ResearchResult): Promise<ResearchResult> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.timeoutMs) {
      const submission = await this.client.getSubmission(result.submissionId);
      if (
        submission.status === 'completed' ||
        submission.status === 'failed' ||
        submission.status === 'rejected' ||
        submission.status === 'pending_human'
      ) {
        return {
          ...result,
          status: submission.status,
          evidenceIds: submission.evidence_ids,
          errorMessage: submission.error_message,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    return {
      ...result,
      status: 'failed',
      errorMessage: `Timed out waiting for submission ${result.submissionId}`,
    };
  }
}
