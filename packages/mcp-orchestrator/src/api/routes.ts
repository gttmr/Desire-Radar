import { Router } from 'express';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderHealthMonitor } from '../providers/providerHealthMonitor.js';
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
  providerHealthMonitor?: ProviderHealthMonitor,
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

  // POST /runs/from-candidate
  router.post('/runs/from-candidate', async (req, res) => {
    try {
      const result = await orchestrator.runFromCandidate({
        entity: String(req.body.entity ?? ''),
        providers: Array.isArray(req.body.providers) ? req.body.providers : undefined,
        maxRounds:
          typeof req.body.max_rounds === 'number' ? req.body.max_rounds : undefined,
        plan: Array.isArray(req.body.plan) ? req.body.plan : undefined,
      });
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // POST /runs/:id/research
  router.post('/runs/:id/research', async (req, res) => {
    try {
      const result = await orchestrator.rerunResearch(req.params.id!);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // POST /runs/:id/verdict
  router.post('/runs/:id/verdict', async (req, res) => {
    try {
      const result = await orchestrator.rerunVerdict(req.params.id!);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // GET /runs/:id/research-requests
  router.get('/runs/:id/research-requests', (req, res) => {
    try {
      const result = orchestrator.listResearchRequests(req.params.id!);
      res.json({ run_id: req.params.id, requests: result, count: result.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
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
    const providerHealths = providerHealthMonitor
      ? providerHealthMonitor.snapshot()
      : await Promise.all(
          registry.list().map(async (name) => {
            const adapter = registry.get(name);
            let available = false;
            let probeStatus: string | undefined;
            let error: string | undefined;
            let recoverable: boolean | undefined;
            try {
              if (adapter?.probeHealth) {
                const result = await adapter.probeHealth();
                available = result.available;
                probeStatus = result.status;
                error = result.error;
                recoverable = result.recoverable;
              } else {
                available = adapter ? await adapter.health() : false;
                probeStatus = available ? 'healthy' : 'unknown';
              }
            } catch (err: unknown) {
              probeStatus = 'unknown';
              error = err instanceof Error ? err.message : 'Unknown health probe error';
            }
            return {
              provider: name,
              available,
              status: probeStatus,
              last_checked_at: new Date().toISOString(),
              ...(typeof recoverable === 'boolean' ? { recoverable } : {}),
              ...(error ? { error } : {}),
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

  // GET /runs
  router.get('/runs', (_req, res) => {
    try {
      res.json(orchestrator.listHighLevelRuns());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  });

  // GET /runs/:id
  router.get('/runs/:id', (req, res) => {
    try {
      res.json(orchestrator.getHighLevelRun(req.params.id!));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  // GET /runs/:id/research
  router.get('/runs/:id/research', (req, res) => {
    try {
      res.json(orchestrator.getRunResearch(req.params.id!));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  // GET /runs/:id/verdict
  router.get('/runs/:id/verdict', (req, res) => {
    try {
      res.json(orchestrator.getRunVerdict(req.params.id!));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  // GET /runs/:id/provider-executions
  router.get('/runs/:id/provider-executions', (req, res) => {
    try {
      res.json(orchestrator.getProviderExecutions(req.params.id!));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  });

  return router;
}
