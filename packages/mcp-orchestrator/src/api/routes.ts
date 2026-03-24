import { Router } from 'express';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { submitEvidence } from '../tools/submit-evidence.js';
import { runAgentRound } from '../tools/run-agent-round.js';
import { runDebate } from '../tools/run-debate.js';
import { synthesizeReport } from '../tools/synthesize-report.js';
import { getRunState } from '../tools/get-run-state.js';
import { listSessions } from '../tools/list-sessions.js';
import { resetSession } from '../tools/reset-session.js';

export function createRoutes(
  orchestrator: RunOrchestrator,
  sessionStore: SessionStore,
  registry: ProviderRegistry,
): Router {
  const router = Router();

  // POST /runs/submit-evidence
  router.post('/runs/submit-evidence', async (req, res) => {
    try {
      const result = await submitEvidence(orchestrator)(req.body);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // POST /runs/agent-round
  router.post('/runs/agent-round', async (req, res) => {
    try {
      const result = await runAgentRound(orchestrator)(req.body);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // POST /runs/debate
  router.post('/runs/debate', async (req, res) => {
    try {
      const result = await runDebate(orchestrator)(req.body);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // POST /runs/synthesize
  router.post('/runs/synthesize', async (req, res) => {
    try {
      const result = await synthesizeReport(orchestrator)(req.body);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // GET /runs/:id/state
  router.get('/runs/:id/state', (req, res) => {
    try {
      const result = getRunState(orchestrator)(req.params.id!);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  // GET /sessions
  router.get('/sessions', (req, res) => {
    const agentName = req.query.agent_name as string | undefined;
    const result = listSessions(sessionStore)(agentName);
    res.json(result);
  });

  // POST /sessions/reset
  router.post('/sessions/reset', (req, res) => {
    try {
      const result = resetSession(sessionStore)(req.body);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // GET /health
  router.get('/health', async (_req, res) => {
    const providers = registry.list();
    const providerHealths = await Promise.all(
      providers.map(async (name) => {
        const adapter = registry.get(name);
        let available = false;
        try {
          available = adapter ? await adapter.health() : false;
        } catch {
          // unhealthy
        }
        return {
          provider: name,
          available,
          last_checked_at: new Date().toISOString(),
        };
      }),
    );

    res.json({
      ok: true,
      providers: providerHealths,
      active_runs: 0,
      total_sessions: sessionStore.listSessions().length,
    });
  });

  // GET /reports
  router.get('/reports', (_req, res) => {
    const reports = orchestrator.getReports();
    res.json({ reports, count: reports.length });
  });

  return router;
}
