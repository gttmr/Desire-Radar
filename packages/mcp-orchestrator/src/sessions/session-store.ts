import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderSession, AgentTurn } from '@agentic/shared-types';

type SessionData = {
  sessions: ProviderSession[];
};

export class SessionStore {
  private data: SessionData = { sessions: [] };
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, 'sessions.json');
    this.load();
  }

  getSession(agentName: string, provider: string): ProviderSession | undefined {
    return this.data.sessions.find(
      (s) => s.agent_name === agentName && s.provider === provider,
    );
  }

  createSession(agentName: string, provider: string): ProviderSession {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      session_id: randomUUID(),
      agent_name: agentName,
      provider,
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

  listSessions(agentName?: string): ProviderSession[] {
    if (agentName) {
      return this.data.sessions.filter((s) => s.agent_name === agentName);
    }
    return [...this.data.sessions];
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
