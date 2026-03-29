import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type {
  ExecutionPhase,
  InvestmentCoverageGap,
  InvestmentDecisionArtifact,
  InvestmentDecisionRecommendation,
  InvestmentDecisionRequest,
  InvestmentDecisionRunRecord,
  ModelProfile,
} from '@agentic/shared-types';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ExecutionPolicyResolver, ResolvedExecutionPolicy } from '../policy/execution.js';
import {
  InvestmentDecisionPromptBuilder,
  type PreparedInvestmentDecisionBriefing,
} from './prompt-builder.js';
import type { ProviderHealthProbe } from '../providers/base.js';
import type { ToolPolicy } from '../providers/base.js';
import {
  buildStructuredJsonRetryPrompt,
  parseStructuredJsonText,
  type StructuredJsonParseStrategy,
} from './structured-output.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeProviderAttemptArtifact(args: {
  runDir: string;
  provider: string;
  prefix: string;
  stage: 'initial' | 'repair';
  resultText: string;
  resultStatus: string;
  degradedMessage?: string | null;
  parseError?: string | null;
  parseStrategy?: StructuredJsonParseStrategy | null;
}): Promise<void> {
  const attemptsDir = join(args.runDir, 'provider-attempts');
  await mkdir(attemptsDir, { recursive: true });
  await writeFile(
    join(attemptsDir, `${args.prefix}-${args.provider}-${args.stage}.json`),
    JSON.stringify(
      {
        provider: args.provider,
        prefix: args.prefix,
        stage: args.stage,
        status: args.resultStatus,
        degraded_message: args.degradedMessage ?? null,
        parse_error: args.parseError ?? null,
        parse_strategy: args.parseStrategy ?? null,
        text: args.resultText,
      },
      null,
      2,
    ),
    'utf8',
  );
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

function normalizeCoverageGaps(
  value: unknown,
  fallback: InvestmentCoverageGap[],
): InvestmentCoverageGap[] {
  const rawGaps = Array.isArray(value) ? value : fallback;
  return rawGaps.map((gap) => {
    const raw = typeof gap === 'object' && gap != null ? (gap as Record<string, unknown>) : {};
    return {
      label: String(raw.label ?? '').trim(),
      reason: String(raw.reason ?? '').trim(),
      linked_cluster_id:
        raw.linked_cluster_id == null ? null : String(raw.linked_cluster_id),
      linked_note_ids: normalizeStringArray(raw.linked_note_ids),
    };
  });
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
    coverage_gaps: normalizeCoverageGaps(parsed.coverage_gaps, request.coverage_gaps),
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

type DecisionRunnerStageConfig = {
  enabled: boolean;
  providers: string[];
  modelProfile: ModelProfile;
  toolPolicy: ToolPolicy;
  timeoutMs: number;
};

type JsonAgentRunResult = {
  parsed: unknown;
  providerName: string;
  degraded: boolean;
  degradedReason?: string | null;
};

function mergeReasonParts(...parts: Array<string | null | undefined>): string | null {
  const normalized = parts.map((part) => part?.trim()).filter(Boolean) as string[];
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join(' | ');
}

function normalizePriority(value: unknown): 'high' | 'medium' | 'low' {
  switch (value) {
    case 'high':
    case 'medium':
    case 'low':
      return value;
    default:
      return 'medium';
  }
}

function normalizePreparedBriefing(
  value: unknown,
  request: InvestmentDecisionRequest,
  fallback: PreparedInvestmentDecisionBriefing,
): PreparedInvestmentDecisionBriefing {
  const parsed = typeof value === 'object' && value != null ? (value as Record<string, unknown>) : {};
  return {
    executive_summary:
      String(parsed.executive_summary ?? '').trim() || fallback.executive_summary,
    market_context: String(parsed.market_context ?? '').trim() || fallback.market_context,
    watchlist_focus: (() => {
      const normalized = normalizeStringArray(parsed.watchlist_focus);
      return normalized.length > 0 ? normalized : fallback.watchlist_focus;
    })(),
    resolved_equity_briefs: (() => {
      const source = Array.isArray(parsed.resolved_equity_briefs)
        ? parsed.resolved_equity_briefs
        : fallback.resolved_equity_briefs;
      return source.map((item, index) => {
        const raw = typeof item === 'object' && item != null ? (item as Record<string, unknown>) : {};
        const fallbackItem = fallback.resolved_equity_briefs[index];
        return {
          asset_key:
            String(raw.asset_key ?? '').trim() ||
            fallbackItem?.asset_key ||
            request.resolved_equities[index]?.asset_key ||
            `stock:${index}`,
          ticker:
            String(raw.ticker ?? '').trim() ||
            fallbackItem?.ticker ||
            request.resolved_equities[index]?.ticker ||
            'unknown',
          company_name:
            String(raw.company_name ?? '').trim() ||
            fallbackItem?.company_name ||
            request.resolved_equities[index]?.company_name ||
            'unknown',
          priority: normalizePriority(raw.priority ?? fallbackItem?.priority),
          why_in_scope:
            String(raw.why_in_scope ?? '').trim() ||
            fallbackItem?.why_in_scope ||
            request.resolved_equities[index]?.why_in_scope ||
            '',
          key_signals: normalizeStringArray(raw.key_signals),
          key_risks: normalizeStringArray(raw.key_risks),
          linked_clusters: normalizeStringArray(raw.linked_clusters),
          linked_notes: normalizeStringArray(raw.linked_notes),
          watchlist_member:
            typeof raw.watchlist_member === 'boolean'
              ? raw.watchlist_member
              : (fallbackItem?.watchlist_member ?? request.resolved_equities[index]?.watchlist_member ?? false),
        };
      });
    })(),
    cluster_briefs: (() => {
      const source = Array.isArray(parsed.cluster_briefs)
        ? parsed.cluster_briefs
        : fallback.cluster_briefs;
      return source.map((item, index) => {
        const raw = typeof item === 'object' && item != null ? (item as Record<string, unknown>) : {};
        const fallbackItem = fallback.cluster_briefs[index];
        return {
          cluster_id:
            raw.cluster_id == null
              ? (fallbackItem?.cluster_id ?? null)
              : String(raw.cluster_id),
          display_label:
            String(raw.display_label ?? '').trim() ||
            fallbackItem?.display_label ||
            `cluster-${index + 1}`,
          candidate_kind: 'entity_cluster' as const,
          why_it_matters:
            String(raw.why_it_matters ?? '').trim() ||
            fallbackItem?.why_it_matters ||
            '',
          supporting_sources: normalizeStringArray(raw.supporting_sources),
          theme_tags: normalizeStringArray(raw.theme_tags),
          event_summary:
            String(raw.event_summary ?? '').trim() || fallbackItem?.event_summary || '',
          graph_summary:
            String(raw.graph_summary ?? '').trim() || fallbackItem?.graph_summary || '',
          linked_equities: normalizeStringArray(raw.linked_equities),
          evidence_count: Math.max(0, Number(raw.evidence_count ?? fallbackItem?.evidence_count ?? 0)),
        };
      });
    })(),
    note_briefs: (() => {
      const source = Array.isArray(parsed.note_briefs)
        ? parsed.note_briefs
        : fallback.note_briefs;
      return source.map((item, index) => {
        const raw = typeof item === 'object' && item != null ? (item as Record<string, unknown>) : {};
        const fallbackItem = fallback.note_briefs[index];
        return {
          intake_id:
            String(raw.intake_id ?? '').trim() ||
            fallbackItem?.intake_id ||
            `note-${index + 1}`,
          asset_key:
            raw.asset_key == null
              ? (fallbackItem?.asset_key ?? null)
              : String(raw.asset_key),
          title: String(raw.title ?? '').trim() || fallbackItem?.title || '',
          summary: String(raw.summary ?? '').trim() || fallbackItem?.summary || '',
          why_it_might_matter:
            String(raw.why_it_might_matter ?? '').trim() ||
            fallbackItem?.why_it_might_matter ||
            '',
        };
      });
    })(),
    source_health_flags: (() => {
      const normalized = normalizeStringArray(parsed.source_health_flags);
      return normalized.length > 0 ? normalized : fallback.source_health_flags;
    })(),
    coverage_gaps: normalizeCoverageGaps(parsed.coverage_gaps, fallback.coverage_gaps),
  };
}

async function writePreparedArtifacts(args: {
  runDir: string;
  briefing: PreparedInvestmentDecisionBriefing;
  markdown: string;
  source: 'llm_preprocess' | 'fallback_disabled' | 'fallback_error';
  warning?: string | null;
}): Promise<void> {
  await writeFile(
    join(args.runDir, 'prepared_request.json'),
    JSON.stringify(args.briefing, null, 2),
    'utf8',
  );
  await writeFile(join(args.runDir, 'prepared_request.md'), args.markdown, 'utf8');
  await writeFile(
    join(args.runDir, 'prepared_request.meta.json'),
    JSON.stringify(
      {
        source: args.source,
        warning: args.warning ?? null,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
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
    private readonly overallTimeoutMs: number,
    private readonly preprocessConfig: DecisionRunnerStageConfig = {
      enabled: true,
      providers: [],
      modelProfile: 'cheap',
      toolPolicy: 'none',
      timeoutMs: 120_000,
    },
    private readonly finalConfig: Omit<DecisionRunnerStageConfig, 'enabled'> = {
      providers: [],
      modelProfile: 'premium',
      toolPolicy: 'default',
      timeoutMs: 420_000,
    },
  ) {}

  async run(args: {
    run: InvestmentDecisionRunRecord;
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
  }): Promise<InvestmentDecisionArtifact> {
    const runDir = dirname(args.run.request_path);
    const fallbackBriefing = this.promptBuilder.buildPreparedBriefingFallback(args.request);
    let preparedBriefing = fallbackBriefing;
    let preprocessWarning: string | null = null;
    let preparedSource: 'llm_preprocess' | 'fallback_disabled' | 'fallback_error' = 'llm_preprocess';

    if (this.preprocessConfig.enabled) {
    const preparedResult = await this.runStructuredJsonAgent({
      run: args.run,
      request: args.request,
      agentName: 'investment_decision_prepare',
      artifactPrefix: 'prepare',
      toolPolicy: this.preprocessConfig.toolPolicy,
      timeoutMs: this.preprocessConfig.timeoutMs,
        providersOverride: this.preprocessConfig.providers,
        modelProfileOverride: this.preprocessConfig.modelProfile,
        buildPrompt: async ({ provider, model, modelProfile }) =>
          this.promptBuilder.buildPreparation({
            request: args.request,
            requestMarkdown: args.requestMarkdown,
            provider,
            model,
            modelProfile,
            toolPolicy: this.preprocessConfig.toolPolicy,
          }),
      });

      if ('error' in preparedResult) {
        preparedSource = 'fallback_error';
        preprocessWarning =
          `Preprocessing failed; deterministic fallback briefing used. ${preparedResult.error}`;
      } else {
        preparedBriefing = normalizePreparedBriefing(
          preparedResult.parsed,
          args.request,
          fallbackBriefing,
        );
        if (preparedResult.degraded || preparedResult.degradedReason) {
          preprocessWarning =
            preparedResult.degradedReason ??
            `Preprocessing completed in degraded mode via ${preparedResult.providerName}.`;
        }
      }
    } else {
      preparedSource = 'fallback_disabled';
      preprocessWarning = null;
    }

    await writePreparedArtifacts({
      runDir,
      briefing: preparedBriefing,
      markdown: this.promptBuilder.renderPreparedBriefingMarkdown(preparedBriefing),
      source: preparedSource,
      warning: preprocessWarning,
    });

    const finalResult = await this.runStructuredJsonAgent({
      run: args.run,
      request: args.request,
      agentName: 'investment_decision',
      artifactPrefix: 'decision',
      toolPolicy: this.finalConfig.toolPolicy,
      timeoutMs: this.finalConfig.timeoutMs,
      providersOverride: this.finalConfig.providers,
      modelProfileOverride: this.finalConfig.modelProfile,
      buildPrompt: async ({ provider, model, modelProfile }) =>
        this.promptBuilder.buildDecision({
          request: args.request,
          preparedBriefing,
          provider,
          model,
          modelProfile,
          toolPolicy: this.finalConfig.toolPolicy,
        }),
    });

    if ('error' in finalResult) {
      const failureReason = mergeReasonParts(preprocessWarning, finalResult.error) ?? 'provider_exec failed';
      return buildFailureArtifact(
        args.request,
        'No provider completed the investment decision run.',
        failureReason,
      );
    }

    return normalizeArtifact(finalResult.parsed, args.request, {
      degraded: finalResult.degraded || Boolean(preprocessWarning),
      degradedReason: mergeReasonParts(preprocessWarning, finalResult.degradedReason),
    });
  }

  private resolvePolicy(
    agentName: string,
    fallbackPhase: ExecutionPhase,
    overrides: {
      providers?: string[];
      modelProfile?: ModelProfile;
    },
  ): ResolvedExecutionPolicy {
    const resolved = this.policyResolver.resolve(agentName, fallbackPhase);
    return {
      ...resolved,
      providers:
        overrides.providers && overrides.providers.length > 0
          ? [...new Set(overrides.providers)]
          : resolved.providers,
      modelProfile: overrides.modelProfile ?? resolved.modelProfile,
    };
  }

  private async runStructuredJsonAgent(args: {
    run: InvestmentDecisionRunRecord;
    request: InvestmentDecisionRequest;
    agentName: string;
    artifactPrefix: string;
    toolPolicy: ToolPolicy;
    timeoutMs: number;
    providersOverride?: string[];
    modelProfileOverride?: ModelProfile;
    buildPrompt: (args: {
      provider: string;
      model?: string;
      modelProfile: ModelProfile;
    }) => Promise<string>;
  }): Promise<JsonAgentRunResult | { error: string }> {
    const resolvedPolicy = this.resolvePolicy(args.agentName, 'investment_decision', {
      providers: args.providersOverride,
      modelProfile: args.modelProfileOverride,
    });
    const providerErrors: string[] = [];
    const runDir = dirname(args.run.request_path);

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
      let session = this.sessionStore.getSession(args.agentName, providerName, {
        phase: 'investment_decision',
        modelProfile,
        runScope: args.run.run_id,
        model,
        transportMode,
      });
      if (!session) {
        session = this.sessionStore.createSession(args.agentName, providerName, {
          phase: 'investment_decision',
          modelProfile,
          runScope: args.run.run_id,
          model,
          transportMode,
        });
      }

      try {
        const prompt = await args.buildPrompt({
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
          toolPolicy: args.toolPolicy,
          phase: 'investment_decision',
          agentName: args.agentName,
          responseFormat: 'json',
          timeoutMs: Math.min(args.timeoutMs, this.overallTimeoutMs),
        });
        this.sessionStore.updateSessionActivity(session.session_id, {
          providerSessionId: result.sessionId,
          transportMode,
          transportTarget: session.transport_target ?? null,
        });

        let parsed: unknown;
        try {
          const parsedResult = parseStructuredJsonText(result.text);
          parsed = parsedResult.parsed;
          await writeProviderAttemptArtifact({
            runDir,
            provider: providerName,
            prefix: args.artifactPrefix,
            stage: 'initial',
            resultText: result.text,
            resultStatus: result.status,
            degradedMessage: result.degraded_message ?? null,
            parseStrategy: parsedResult.strategy,
          });
        } catch (parseError) {
          const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
          await writeProviderAttemptArtifact({
            runDir,
            provider: providerName,
            prefix: args.artifactPrefix,
            stage: 'initial',
            resultText: result.text,
            resultStatus: result.status,
            degradedMessage: result.degraded_message ?? null,
            parseError: parseMessage,
          });

          const retryResult = await adapter.execute({
            prompt: buildStructuredJsonRetryPrompt(prompt),
            sessionId: result.sessionId ?? session.provider_session_id ?? undefined,
            logicalSessionId: session.session_id,
            workingDirectory: session.session_dir,
            turnCount: session.turn_count,
            transportMode,
            transportTarget: session.transport_target ?? null,
            model,
            modelProfile,
            toolPolicy: args.toolPolicy,
            phase: 'investment_decision',
            agentName: args.agentName,
            responseFormat: 'json',
            timeoutMs: Math.min(args.timeoutMs, this.overallTimeoutMs),
          });
          this.sessionStore.updateSessionActivity(session.session_id, {
            providerSessionId: retryResult.sessionId,
            transportMode,
            transportTarget: session.transport_target ?? null,
          });
          const parsedResult = parseStructuredJsonText(retryResult.text);
          parsed = parsedResult.parsed;
          await writeProviderAttemptArtifact({
            runDir,
            provider: providerName,
            prefix: args.artifactPrefix,
            stage: 'repair',
            resultText: retryResult.text,
            resultStatus: retryResult.status,
            degradedMessage: retryResult.degraded_message ?? null,
            parseStrategy: parsedResult.strategy,
          });
          return {
            parsed,
            providerName,
            degraded: true,
            degradedReason:
              result.degraded_message ??
              retryResult.degraded_message ??
              `${args.agentName} required JSON repair retry: ${parseMessage}`,
          };
        }

        return {
          parsed,
          providerName,
          degraded: result.status === 'degraded',
          degradedReason: result.degraded_message ?? null,
        };
      } catch (error) {
        providerErrors.push(
          `${providerName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      error: providerErrors.join(' | ') || `${args.agentName} failed`,
    };
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
