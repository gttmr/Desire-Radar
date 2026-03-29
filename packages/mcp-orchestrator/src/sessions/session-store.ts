import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderSession, AgentTurn } from '@agentic/shared-types';
import type { ExecutionPhase, ModelProfile, ProviderTransportMode } from '../providers/base.js';

export type SessionScope = {
  phase: ExecutionPhase;
  modelProfile: ModelProfile;
  runScope: string;
  model?: string;
  transportMode?: ProviderTransportMode;
  transportTarget?: string | null;
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
  private readonly sessionRootDir: string;

  constructor(
    private readonly dataDir: string,
    sessionRootDir?: string,
  ) {
    this.filePath = join(dataDir, 'sessions.json');
    this.sessionRootDir = sessionRootDir ?? join(dataDir, 'provider-sessions');
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
        session.run_scope === scope.runScope &&
        (scope.transportMode ? (session.transport_mode ?? 'cli_exec') === scope.transportMode : true) &&
        (scope.transportTarget !== undefined
          ? (session.transport_target ?? null) === scope.transportTarget
          : true),
    );
  }

  createSession(
    agentName: string,
    provider: string,
    scope: SessionScope,
  ): ScopedProviderSession {
    const now = new Date().toISOString();
    const logicalSessionId = randomUUID();
    const sessionDir = join(
      this.sessionRootDir,
      sanitizePathSegment(provider),
      sanitizePathSegment(scope.phase),
      sanitizePathSegment(agentName),
      sanitizePathSegment(scope.runScope),
      logicalSessionId,
    );
    mkdirSync(sessionDir, { recursive: true });
    const session: ScopedProviderSession = {
      session_id: logicalSessionId,
      provider_session_id: null,
      session_dir: sessionDir,
      agent_name: agentName,
      provider,
      phase: scope.phase,
      model_profile: scope.modelProfile,
      run_scope: scope.runScope,
      model: scope.model,
      transport_mode: scope.transportMode,
      transport_target: scope.transportTarget,
      created_at: now,
      last_active_at: now,
      turn_count: 0,
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  updateSession(
    sessionId: string,
    _turn: AgentTurn,
    patch?: {
      providerSessionId?: string;
      transportMode?: ProviderTransportMode;
      transportTarget?: string | null;
    },
  ): void {
    const session = this.data.sessions.find((s) => s.session_id === sessionId);
    if (session) {
      this.updateSessionActivity(sessionId, patch);
    }
  }

  updateSessionActivity(
    sessionId: string,
    patch?: {
      providerSessionId?: string;
      transportMode?: ProviderTransportMode;
      transportTarget?: string | null;
    },
  ): void {
    const session = this.data.sessions.find((s) => s.session_id === sessionId);
    if (!session) {
      return;
    }
    session.last_active_at = new Date().toISOString();
    session.turn_count += 1;
    if (patch?.providerSessionId) {
      session.provider_session_id = patch.providerSessionId;
    }
    if (patch?.transportMode) {
      session.transport_mode = patch.transportMode;
    }
    if (patch?.transportTarget !== undefined) {
      session.transport_target = patch.transportTarget;
    }
    this.save();
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
    mkdirSync(this.sessionRootDir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }
}

function sanitizePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'default';
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}
