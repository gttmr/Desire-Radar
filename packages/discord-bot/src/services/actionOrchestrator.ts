import { randomUUID } from 'node:crypto';
import type { PendingAction, Transcript, JobRequest, JobResult } from '../types/domain.js';
import { JobEngine } from './jobEngine.js';

type ActionOutcome =
  | { status: 'executed'; result: JobResult }
  | { status: 'skipped'; actionId: string }
  | { status: 'expired' }
  | { status: 'not_found' };

export class ActionOrchestrator {
  private readonly pending = new Map<string, PendingAction>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly ttlMs: number,
    private readonly jobEngine: JobEngine
  ) {
    this.sweepTimer = setInterval(() => this.sweepExpired(), Math.max(5_000, Math.floor(ttlMs / 2)));
    this.sweepTimer.unref();
  }

  createPending(input: {
    transcript: Transcript;
    userId: string;
    guildId: string;
    channelId: string;
  }): PendingAction {
    const id = randomUUID();
    const now = Date.now();
    const action: PendingAction = {
      id,
      transcript: input.transcript,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      userId: input.userId,
      guildId: input.guildId,
      channelId: input.channelId
    };
    this.pending.set(id, action);
    return action;
  }

  getPending(actionId: string): PendingAction | undefined {
    return this.pending.get(actionId);
  }

  async execute(actionId: string): Promise<ActionOutcome> {
    const action = this.pending.get(actionId);
    if (!action) {
      return { status: 'not_found' };
    }
    if (Date.now() > action.expiresAt) {
      this.pending.delete(actionId);
      return { status: 'expired' };
    }

    const request: JobRequest = {
      actionId: action.id,
      userId: action.userId,
      guildId: action.guildId,
      channelId: action.channelId,
      transcript: action.transcript.text,
      createdAt: action.createdAt
    };
    const result = await this.jobEngine.run(request);
    this.pending.delete(actionId);
    return { status: 'executed', result };
  }

  skip(actionId: string): ActionOutcome {
    const action = this.pending.get(actionId);
    if (!action) {
      return { status: 'not_found' };
    }
    if (Date.now() > action.expiresAt) {
      this.pending.delete(actionId);
      return { status: 'expired' };
    }
    this.pending.delete(actionId);
    return { status: 'skipped', actionId };
  }

  stats(): { pendingCount: number } {
    return { pendingCount: this.pending.size };
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, action] of this.pending.entries()) {
      if (action.expiresAt <= now) {
        this.pending.delete(id);
      }
    }
  }
}
