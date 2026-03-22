import type { JobRequest, JobResult } from '../types/domain.js';

export class JobEngine {
  async run(request: JobRequest): Promise<JobResult> {
    const summary = `작업 모의 실행 완료: "${request.transcript.slice(0, 120)}"`;
    return {
      actionId: request.actionId,
      executed: true,
      summary,
      finishedAt: Date.now()
    };
  }
}
