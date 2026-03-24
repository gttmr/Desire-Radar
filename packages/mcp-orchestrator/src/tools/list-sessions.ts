import type { ListSessionsResponse } from '@agentic/shared-types';
import type { SessionStore } from '../sessions/session-store.js';

export function listSessions(sessionStore: SessionStore) {
  return (agentName?: string): ListSessionsResponse => {
    return { sessions: sessionStore.listSessions(agentName) };
  };
}
