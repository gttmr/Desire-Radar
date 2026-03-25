import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderSession, AgentTurn } from '@agentic/shared-types';
import type { ExecutionPhase, ModelProfile } from '../providers/base.js';

export type SessionScope = {
  phase: ExecutionPhase;
  modelProfile: ModelProfile;
  runScope: string;
  model?: string;
};

type ScopedProviderSession = ProviderSession & {
  phase: ExecutionPhase;
  model_profile: ModelProfile;
  run_scope: string;
  model?: string;
};

type SessionData = {
  sessions: ScopedProviderSession[];
};

export class SessionStore {
  private data: SessionData = { sessions: [] };
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, 'sessions.json');
    this.load();
  }

  getSession(
    agentName: string,
    provider: string,
    scope: SessionScope,
  ): ScopedProviderSession | undefined {
    return this.data.sessions.find(
      (session) =>
        session.agent_name === agentName &&
        session.provider === provider &&
        session.phase === scope.phase &&
        session.model_profile === scope.modelProfile &&
        session.run_scope === scope.runScope,
    );
  }

  createSession(
    agentName: string,
    provider: string,
    scope: SessionScope,
  ): ScopedProviderSession {
    const now = new Date().toISOString();
    const session: ScopedProviderSession = {
      session_id: randomUUID(),
      agent_name: agentName,
      provider,
      phase: scope.phase,
      model_profile: scope.modelProfile,
      run_scope: scope.runScope,
      model: scope.model,
      created_at: now,
      last_active_at: now,
      turn_count: 0,
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  updateSession(sessionId: string, _turn: AgentTurn): void {
    const session = this.data.sessions.find((s) => s.session_id === sessionId);
    if (session) {
      session.last_active_at = new Date().toISOString();
      session.turn_count += 1;
      this.save();
    }
  }

  resetSession(agentName: string, provider: string): void {
    this.data.sessions = this.data.sessions.filter(
      (s) => !(s.agent_name === agentName && s.provider === provider),
    );
    this.save();
  }

  listSessions(agentName?: string, runScope?: string): ScopedProviderSession[] {
    if (agentName) {
      return this.data.sessions.filter(
        (session) =>
          session.agent_name === agentName &&
          (runScope ? session.run_scope === runScope : true),
      );
    }
    return runScope
      ? this.data.sessions.filter((session) => session.run_scope === runScope)
      : [...this.data.sessions];
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw) as SessionData;
      }
    } catch {
      this.data = { sessions: [] };
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }
}
