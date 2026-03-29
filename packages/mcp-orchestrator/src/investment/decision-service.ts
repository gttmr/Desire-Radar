import { randomUUID } from 'node:crypto';
import type {
  CreateInvestmentDecisionRunRequest,
  CreateInvestmentDecisionRunResponse,
  GetInvestmentDecisionRunResponse,
  GetLatestInvestmentDecisionResponse,
  InvestmentDecisionReportResponse,
} from '@agentic/shared-types';
import type { ReportDetailLevel } from '@agentic/shared-types';
import { InvestmentDecisionStore } from './decision-store.js';
import type { InvestmentDecisionRunner } from './decision-runner.js';
import { InvestmentReportFormatter } from './report-formatter.js';
import { InvestmentSignalAssembler } from './signal-assembler.js';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class InvestmentDecisionService {
  constructor(
    private readonly store: InvestmentDecisionStore,
    private readonly assembler: InvestmentSignalAssembler,
    private readonly runner: InvestmentDecisionRunner,
    private readonly formatter: InvestmentReportFormatter,
    private readonly runnerMode: 'provider_exec' | 'external_artifact',
    private readonly timeoutMs: number,
  ) {}

  private async reconcileStaleRuns(): Promise<void> {
    await this.store.reconcileTimedOutRuns({
      maxAgeMs: this.timeoutMs + 15_000,
      reason: `investment decision run exceeded timeout budget (${this.timeoutMs}ms)`,
    });
  }

  async run(
    request: CreateInvestmentDecisionRunRequest,
  ): Promise<CreateInvestmentDecisionRunResponse> {
    await this.reconcileStaleRuns();
    const runId = randomUUID();
    const assembled = await this.assembler.assemble({
      runId,
      mode: request.mode ?? 'manual',
      asOfDate: request.as_of_date ?? todayDate(),
      watchlist: request.watchlist,
      windowDays: request.window_days ?? 7,
    });
    const requestMarkdown = this.formatter.renderRequestMarkdown(assembled);
    const run = await this.store.createRun({
      runId,
      mode: assembled.mode,
      runner: this.runnerMode,
      request: assembled,
      requestMarkdown,
    });
    await this.store.markRunning(runId);
    const artifact = await this.runner.run({
      run,
      request: assembled,
      requestMarkdown,
    });
    const responseMarkdown = this.formatter.renderResponseMarkdown(assembled, artifact);
    const fullReport = this.formatter.formatReport(assembled, artifact, 'full');
    const completedRun = await this.store.complete(runId, artifact, responseMarkdown, fullReport);
    return {
      run: completedRun,
      request: assembled,
      artifact,
      report: {
        run_id: runId,
        detail: request.detail ?? 'summary',
        markdown: this.formatter.formatReport(
          assembled,
          artifact,
          request.detail ?? 'summary',
        ),
        generated_at: artifact.generated_at,
      },
    };
  }

  async getRun(
    runId: string,
    detail: ReportDetailLevel = 'full',
  ): Promise<GetInvestmentDecisionRunResponse | null> {
    await this.reconcileStaleRuns();
    const run = await this.store.getRun(runId);
    if (!run) {
      return null;
    }
    const request = await this.store.getRequest(runId);
    if (!request) {
      return null;
    }
    const artifact = await this.store.getArtifact(runId);
    return {
      run,
      request,
      artifact,
      report: artifact
        ? {
            run_id: runId,
            detail,
            markdown: this.formatter.formatReport(request, artifact, detail),
            generated_at: artifact.generated_at,
          }
        : null,
    };
  }

  async getLatest(
    detail: ReportDetailLevel = 'full',
  ): Promise<GetLatestInvestmentDecisionResponse> {
    await this.reconcileStaleRuns();
    const run = await this.store.getLatestRun();
    if (!run) {
      return { latest: null };
    }
    return {
      latest: await this.getRun(run.run_id, detail),
    };
  }

  async getReport(
    runId: string,
    detail: ReportDetailLevel = 'full',
  ): Promise<InvestmentDecisionReportResponse | null> {
    const run = await this.getRun(runId, detail);
    return run?.report ?? null;
  }
}
