import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type {
  InvestmentDecisionArtifact,
  InvestmentDecisionRecommendation,
  InvestmentDecisionRequest,
  InvestmentDecisionRunRecord,
} from '@agentic/shared-types';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ExecutionPolicyResolver } from '../policy/execution.js';
import { InvestmentDecisionPromptBuilder } from './prompt-builder.js';
import type { ProviderHealthProbe } from '../providers/base.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

function asRecommendation(value: unknown): InvestmentDecisionRecommendation {
  switch (value) {
    case 'buy_now':
    case 'accumulate':
    case 'watch':
    case 'pass':
      return value;
    default:
      return 'watch';
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function normalizeArtifact(
  value: unknown,
  request: InvestmentDecisionRequest,
  options: {
    degraded: boolean;
    degradedReason?: string | null;
    fallbackStatus?: InvestmentDecisionArtifact['status'];
  } = {
    degraded: false,
  },
): InvestmentDecisionArtifact {
  const parsed = typeof value === 'object' && value != null ? (value as Record<string, unknown>) : {};
  const topPicks = Array.isArray(parsed.top_picks) ? parsed.top_picks : [];
  const watchCandidates = Array.isArray(parsed.watch_candidates) ? parsed.watch_candidates : [];
  const rejectedCandidates = Array.isArray(parsed.rejected_candidates) ? parsed.rejected_candidates : [];
  const coverageGaps = Array.isArray(parsed.coverage_gaps) ? parsed.coverage_gaps : request.coverage_gaps;

  const normalizeItem = (item: unknown) => {
    const raw = typeof item === 'object' && item != null ? (item as Record<string, unknown>) : {};
    const ticker = String(raw.ticker ?? '').trim();
    const companyName = String(raw.company_name ?? ticker).trim() || ticker || 'unknown';
    return {
      asset_key:
        String(raw.asset_key ?? '').trim() ||
        (ticker ? `stock:${ticker}` : `stock:${companyName}`),
      ticker: ticker || 'unknown',
      company_name: companyName,
      recommendation: asRecommendation(raw.recommendation),
      confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
      why_now: String(raw.why_now ?? '').trim(),
      thesis: String(raw.thesis ?? '').trim(),
      beneficiary_path: String(raw.beneficiary_path ?? '').trim(),
      linked_clusters: normalizeStringArray(raw.linked_clusters),
      linked_evidence_refs: normalizeStringArray(raw.linked_evidence_refs),
      risks: normalizeStringArray(raw.risks),
      missing_information: normalizeStringArray(raw.missing_information),
    };
  };

  const explicitStatus = parsed.status;
  const normalizedStatus: InvestmentDecisionArtifact['status'] =
    explicitStatus === 'completed' || explicitStatus === 'degraded' || explicitStatus === 'failed'
      ? explicitStatus
      : options.fallbackStatus ?? (options.degraded ? 'degraded' : 'completed');

  return {
    run_id: request.run_id,
    status: normalizedStatus,
    generated_at: new Date().toISOString(),
    summary: String(parsed.summary ?? '').trim() || 'No investment summary provided.',
    market_view: String(parsed.market_view ?? '').trim(),
    top_picks: topPicks.map(normalizeItem),
    watch_candidates: watchCandidates.map(normalizeItem),
    rejected_candidates: rejectedCandidates.map(normalizeItem),
    coverage_gaps: coverageGaps.map((gap) => {
      const raw = typeof gap === 'object' && gap != null ? (gap as Record<string, unknown>) : {};
      return {
        label: String(raw.label ?? '').trim(),
        reason: String(raw.reason ?? '').trim(),
        linked_cluster_id:
          raw.linked_cluster_id == null ? null : String(raw.linked_cluster_id),
        linked_note_ids: normalizeStringArray(raw.linked_note_ids),
      };
    }),
    risks: normalizeStringArray(parsed.risks),
    degraded: options.degraded || Boolean(parsed.degraded) || normalizedStatus !== 'completed',
    degraded_reason:
      options.degradedReason ??
      (parsed.degraded_reason == null ? null : String(parsed.degraded_reason)),
    schema_version: 1,
  };
}

function buildFailureArtifact(
  request: InvestmentDecisionRequest,
  summary: string,
  reason: string,
): InvestmentDecisionArtifact {
  return {
    run_id: request.run_id,
    status: 'failed',
    generated_at: new Date().toISOString(),
    summary,
    market_view: '',
    top_picks: [],
    watch_candidates: [],
    rejected_candidates: [],
    coverage_gaps: request.coverage_gaps,
    risks: [reason],
    degraded: true,
    degraded_reason: reason,
    schema_version: 1,
  };
}

async function probeReadiness(
  registry: ProviderRegistry,
  providerName: string,
): Promise<ProviderHealthProbe> {
  const adapter = registry.get(providerName);
  if (!adapter) {
    return {
      available: false,
      ready_for_execution: false,
      failure_kind: 'unknown',
      error_summary: 'provider not registered',
      recoverable: false,
    };
  }
  if (adapter.probeHealth) {
    return adapter.probeHealth();
  }
  try {
    const available = await adapter.health();
    return {
      available,
      ready_for_execution: available,
      status: available ? 'healthy' : 'unknown',
    };
  } catch (error) {
    return {
      available: false,
      ready_for_execution: false,
      failure_kind: 'unknown',
      error_summary: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export interface InvestmentDecisionRunner {
  run(args: {
    run: InvestmentDecisionRunRecord;
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
  }): Promise<InvestmentDecisionArtifact>;
}

export class ProviderExecDecisionRunner implements InvestmentDecisionRunner {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly sessionStore: SessionStore,
    private readonly policyResolver: ExecutionPolicyResolver,
    private readonly promptBuilder: InvestmentDecisionPromptBuilder,
    private readonly timeoutMs: number,
  ) {}

  async run(args: {
    run: InvestmentDecisionRunRecord;
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
  }): Promise<InvestmentDecisionArtifact> {
    const resolvedPolicy = this.policyResolver.resolve('investment_decision', 'investment_decision');
    const providerErrors: string[] = [];

    for (const providerName of resolvedPolicy.providers) {
      const adapter = this.registry.get(providerName);
      if (!adapter) {
        providerErrors.push(`${providerName}: provider not registered`);
        continue;
      }

      const readiness = await probeReadiness(this.registry, providerName);
      if (!(readiness.ready_for_execution ?? readiness.available)) {
        providerErrors.push(
          `${providerName}: ${readiness.error_summary ?? readiness.error ?? readiness.failure_kind ?? 'not ready'}`,
        );
        continue;
      }

      const modelProfile = resolvedPolicy.modelProfile;
      const model = this.policyResolver.resolveModel(providerName, modelProfile);
      const transportMode = adapter.defaultTransportMode ?? 'cli_exec';
      let session = this.sessionStore.getSession('investment_decision', providerName, {
        phase: 'investment_decision',
        modelProfile,
        runScope: args.run.run_id,
        model,
        transportMode,
      });
      if (!session) {
        session = this.sessionStore.createSession('investment_decision', providerName, {
          phase: 'investment_decision',
          modelProfile,
          runScope: args.run.run_id,
          model,
          transportMode,
        });
      }

      try {
        const prompt = await this.promptBuilder.build({
          request: args.request,
          requestMarkdown: args.requestMarkdown,
          provider: providerName,
          model,
          modelProfile,
        });
        const result = await adapter.execute({
          prompt,
          sessionId: session.provider_session_id ?? undefined,
          logicalSessionId: session.session_id,
          workingDirectory: session.session_dir,
          turnCount: session.turn_count,
          transportMode,
          transportTarget: session.transport_target ?? null,
          model,
          modelProfile,
          phase: 'investment_decision',
          agentName: 'investment_decision',
          responseFormat: 'json',
          timeoutMs: this.timeoutMs,
        });
        this.sessionStore.updateSessionActivity(session.session_id, {
          providerSessionId: result.sessionId,
          transportMode,
          transportTarget: session.transport_target ?? null,
        });

        const parsed = JSON.parse(stripMarkdownFences(result.text));
        return normalizeArtifact(parsed, args.request, {
          degraded: result.status === 'degraded',
          degradedReason: result.degraded_message ?? null,
        });
      } catch (error) {
        providerErrors.push(
          `${providerName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return buildFailureArtifact(
      args.request,
      'No provider completed the investment decision run.',
      providerErrors.join(' | ') || 'provider_exec failed',
    );
  }
}

export class ExternalArtifactDecisionRunner implements InvestmentDecisionRunner {
  constructor(
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
  ) {}

  async run(args: {
    run: InvestmentDecisionRunRecord;
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
  }): Promise<InvestmentDecisionArtifact> {
    const startedAt = Date.now();
    let lastError: string | null = null;

    while (Date.now() - startedAt <= this.timeoutMs) {
      if (args.run.response_path && existsSync(args.run.response_path)) {
        try {
          const parsed = JSON.parse(await readFile(args.run.response_path, 'utf8'));
          return normalizeArtifact(parsed, args.request);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      await sleep(this.pollIntervalMs);
    }

    return buildFailureArtifact(
      args.request,
      'External artifact response was not received in time.',
      lastError ?? `Timed out after ${this.timeoutMs}ms waiting for response.json`,
    );
  }
}
