import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type InvestmentDecisionArtifact,
  type InvestmentDecisionRequest,
  type InvestmentDecisionRunRecord,
  type InvestmentDecisionRunStatus,
} from '@agentic/shared-types';

type RunIndex = {
  version: 1;
  runs: Record<string, InvestmentDecisionRunRecord>;
  latest_run_id?: string | null;
};

const EMPTY_INDEX: RunIndex = {
  version: 1,
  runs: {},
  latest_run_id: null,
};

export class InvestmentDecisionStore {
  private readonly indexPath: string;

  constructor(private readonly runRootDir: string) {
    this.indexPath = join(this.runRootDir, '..', 'index.json');
  }

  async createRun(args: {
    runId: string;
    mode: InvestmentDecisionRequest['mode'];
    runner: InvestmentDecisionRunRecord['runner'];
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
  }): Promise<InvestmentDecisionRunRecord> {
    const dateDir = join(this.runRootDir, args.request.created_at.slice(0, 10), args.runId);
    await mkdir(dateDir, { recursive: true });
    const record: InvestmentDecisionRunRecord = {
      run_id: args.runId,
      status: 'queued',
      mode: args.mode,
      runner: args.runner,
      created_at: args.request.created_at,
      updated_at: args.request.created_at,
      request_path: join(dateDir, 'request.json'),
      request_markdown_path: join(dateDir, 'request.md'),
      status_path: join(dateDir, 'status.json'),
      response_path: join(dateDir, 'response.json'),
      response_markdown_path: join(dateDir, 'response.md'),
      report_path: join(dateDir, 'report.md'),
      degraded_reason: null,
      error: null,
    };

    await writeFile(record.request_path, JSON.stringify(args.request, null, 2), 'utf8');
    await writeFile(record.request_markdown_path, args.requestMarkdown, 'utf8');
    await this.persistRecord(record);
    return record;
  }

  async markRunning(runId: string): Promise<InvestmentDecisionRunRecord> {
    return this.updateRecord(runId, { status: 'running', error: null });
  }

  async complete(
    runId: string,
    artifact: InvestmentDecisionArtifact,
    responseMarkdown: string,
    reportMarkdown: string,
  ): Promise<InvestmentDecisionRunRecord> {
    const record = await this.getRun(runId);
    if (!record) {
      throw new Error(`investment decision run not found: ${runId}`);
    }
    await writeFile(record.response_path ?? join(dirname(record.request_path), 'response.json'), JSON.stringify(artifact, null, 2), 'utf8');
    await writeFile(record.response_markdown_path ?? join(dirname(record.request_path), 'response.md'), responseMarkdown, 'utf8');
    await writeFile(record.report_path ?? join(dirname(record.request_path), 'report.md'), reportMarkdown, 'utf8');
    return this.updateRecord(runId, {
      status: artifact.status,
      degraded_reason: artifact.degraded_reason ?? null,
      error: artifact.status === 'failed' ? artifact.summary : null,
    });
  }

  async fail(runId: string, message: string): Promise<InvestmentDecisionRunRecord> {
    return this.updateRecord(runId, {
      status: 'failed',
      degraded_reason: message,
      error: message,
    });
  }

  async getRun(runId: string): Promise<InvestmentDecisionRunRecord | null> {
    const index = await this.readIndex();
    return index.runs[runId] ?? null;
  }

  async getRequest(runId: string): Promise<InvestmentDecisionRequest | null> {
    const record = await this.getRun(runId);
    if (!record || !existsSync(record.request_path)) {
      return null;
    }
    return JSON.parse(await readFile(record.request_path, 'utf8')) as InvestmentDecisionRequest;
  }

  async getArtifact(runId: string): Promise<InvestmentDecisionArtifact | null> {
    const record = await this.getRun(runId);
    if (!record?.response_path || !existsSync(record.response_path)) {
      return null;
    }
    return JSON.parse(await readFile(record.response_path, 'utf8')) as InvestmentDecisionArtifact;
  }

  async getReportMarkdown(runId: string): Promise<string | null> {
    const record = await this.getRun(runId);
    if (!record?.report_path || !existsSync(record.report_path)) {
      return null;
    }
    return readFile(record.report_path, 'utf8');
  }

  async getLatestRun(): Promise<InvestmentDecisionRunRecord | null> {
    const index = await this.readIndex();
    if (!index.latest_run_id) {
      return null;
    }
    return index.runs[index.latest_run_id] ?? null;
  }

  private async updateRecord(
    runId: string,
    patch: Partial<InvestmentDecisionRunRecord> & { status?: InvestmentDecisionRunStatus },
  ): Promise<InvestmentDecisionRunRecord> {
    const index = await this.readIndex();
    const current = index.runs[runId];
    if (!current) {
      throw new Error(`investment decision run not found: ${runId}`);
    }
    const updated: InvestmentDecisionRunRecord = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    index.runs[runId] = updated;
    index.latest_run_id = runId;
    await this.writeIndex(index);
    await writeFile(updated.status_path, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  private async persistRecord(record: InvestmentDecisionRunRecord): Promise<void> {
    const index = await this.readIndex();
    index.runs[record.run_id] = record;
    index.latest_run_id = record.run_id;
    await this.writeIndex(index);
    await writeFile(record.status_path, JSON.stringify(record, null, 2), 'utf8');
  }

  private async readIndex(): Promise<RunIndex> {
    if (!existsSync(this.indexPath)) {
      return structuredClone(EMPTY_INDEX);
    }
    const raw = await readFile(this.indexPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RunIndex>;
    return {
      version: 1,
      runs: parsed.runs ?? {},
      latest_run_id: parsed.latest_run_id ?? null,
    };
  }

  private async writeIndex(index: RunIndex): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }
}
