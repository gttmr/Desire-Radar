import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, AgentTurn } from '@agentic/shared-types';

type RunData = {
  runs: Run[];
  turns: AgentTurn[];
};

export class RunStore {
  private data: RunData = { runs: [], turns: [] };
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, 'runs.json');
    this.load();
  }

  createRun(topic: string, evidenceRefs: string[]): Run {
    const now = new Date().toISOString();
    const run: Run = {
      run_id: randomUUID(),
      date: now.slice(0, 10),
      topic_or_theme_set: [topic],
      evidence_refs: evidenceRefs,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    this.data.runs.push(run);
    this.save();
    return run;
  }

  getRun(runId: string): Run | undefined {
    return this.data.runs.find((r) => r.run_id === runId);
  }

  updateRun(runId: string, updates: Partial<Run>): void {
    const run = this.data.runs.find((r) => r.run_id === runId);
    if (run) {
      Object.assign(run, updates, { updated_at: new Date().toISOString() });
      this.save();
    }
  }

  listRuns(): Run[] {
    return [...this.data.runs];
  }

  saveTurn(turn: AgentTurn): void {
    this.data.turns.push(turn);
    this.save();
  }

  getTurns(runId: string): AgentTurn[] {
    return this.data.turns.filter((t) => t.run_id === runId);
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw) as RunData;
      }
    } catch {
      this.data = { runs: [], turns: [] };
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }
}
