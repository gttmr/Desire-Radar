import type { IngestSubmission } from '@agentic/shared-types';
import type { CollectorClient } from './collectorClient.js';

export class QueueCommandService {
  constructor(private readonly collector: CollectorClient) {}

  async human(limit = 10): Promise<string> {
    const result = await this.collector.listSubmissions('pending_human', undefined, limit);
    if (result.count === 0) {
      return '대기 중인 사람 입력 요청이 없습니다.';
    }
    return result.submissions
      .map((submission, index) => this.formatSubmission(index, submission))
      .join('\n');
  }

  private formatSubmission(index: number, submission: IngestSubmission): string {
    const metadata = (submission.metadata ?? {}) as Record<string, unknown>;
    const entities = Array.isArray(metadata.entity_candidates)
      ? metadata.entity_candidates.map((value) => String(value)).join(', ')
      : '(none)';
    const question = typeof metadata.question === 'string' ? metadata.question : '(no question)';
    const kind =
      typeof metadata.requested_input_kind === 'string'
        ? metadata.requested_input_kind
        : 'study_result';
    const priority = typeof metadata.priority === 'string' ? metadata.priority : 'normal';
    const requestedBy =
      typeof metadata.requested_by_agent === 'string'
        ? metadata.requested_by_agent
        : 'unknown';
    return [
      `${index + 1}. ${submission.submission_id}`,
      `entity=${entities}`,
      `kind=${kind}`,
      `priority=${priority}`,
      `requested_by=${requestedBy}`,
      `question=${question}`,
    ].join(' | ');
  }
}
