import type { InvestmentDecisionRunner } from './decision-runner.js';
import { InvestmentDecisionStore } from './decision-store.js';
import { InvestmentReportFormatter } from './report-formatter.js';

export type ExternalWorkerSummary = {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
};

export class ExternalInvestmentDecisionWorker {
  constructor(
    private readonly store: InvestmentDecisionStore,
    private readonly runner: InvestmentDecisionRunner,
    private readonly formatter: InvestmentReportFormatter,
  ) {}

  async processPending(limit = 10): Promise<ExternalWorkerSummary> {
    const runs = await this.store.listPendingExternalRuns(limit);
    const summary: ExternalWorkerSummary = {
      processed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };

    for (const run of runs) {
      summary.processed += 1;
      const request = await this.store.getRequest(run.run_id);
      if (!request) {
        await this.store.fail(run.run_id, 'investment decision request.json is missing');
        summary.failed += 1;
        continue;
      }
      const requestMarkdown =
        (await this.store.getRequestMarkdown(run.run_id)) ?? JSON.stringify(request, null, 2);
      try {
        const artifact = await this.runner.run({
          run,
          request,
          requestMarkdown,
        });
        const responseMarkdown = this.formatter.renderResponseMarkdown(request, artifact);
        const fullReport = this.formatter.formatReport(request, artifact, 'full');
        await this.store.complete(run.run_id, artifact, responseMarkdown, fullReport);
        if (artifact.status === 'failed') {
          summary.failed += 1;
          continue;
        }
        summary.completed += 1;
      } catch (error) {
        await this.store.fail(
          run.run_id,
          error instanceof Error ? error.message : String(error),
        );
        summary.failed += 1;
      }
    }

    return summary;
  }
}
