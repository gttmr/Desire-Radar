import type { ResetSessionRequest, ResetSessionResponse } from '@agentic/shared-types';
import type { SessionStore } from '../sessions/session-store.js';

export function resetSession(sessionStore: SessionStore) {
  return (req: ResetSessionRequest): ResetSessionResponse => {
    sessionStore.resetSession(req.agent_name, req.provider);
    return { ok: true };
  };
}
