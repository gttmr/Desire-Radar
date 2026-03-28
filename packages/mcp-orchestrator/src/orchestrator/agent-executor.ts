import type { AgentTurn, AgentResponse, EvidenceBundle } from '@agentic/shared-types';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { PromptComposer } from '../prompt/composer.js';
import type { RunStore } from './run-store.js';
import type { CollectorCandidate, CollectorSourceStatus } from '../collector/client.js';
import type { ResearchResult } from '../collector/research-service.js';
import type {
  ExecutionPhase,
  ModelProfile,
  ProviderFailureKind,
  ProviderHealthProbe,
} from '../providers/base.js';
import { ExecutionPolicyResolver } from '../policy/execution.js';

export interface ExecuteAgentParams {
  runId: string;
  runScope?: string;
  agentName: string;
  phase: ExecutionPhase;
  providers?: string[];
  modelProfile?: ModelProfile;
  evidenceBundle?: EvidenceBundle;
  candidate?: CollectorCandidate;
  debateTurns?: AgentTurn[];
  researchResults?: ResearchResult[];
  sourceStatus?: Record<string, CollectorSourceStatus>;
  verdictSummary?: string;
  otherAgentMessages?: Array<{ from: string; content: string }>;
  orchestratorQuestions?: string[];
}

const DEFAULT_RESPONSE: AgentResponse = {
  summary: 'Unable to parse provider response',
  confidence: 0,
  claims: [],
  evidence_used: [],
  open_questions: ['Response parsing failed'],
  messages_for_other_agents: [],
  recommended_next_step: 'retry',
};

function buildDegradedResponse(
  provider: string,
  errorKind: string | undefined,
  errorMessage: string | undefined,
): AgentResponse {
  const label = errorKind ? `${provider}:${errorKind}` : provider;
  const summary = `[provider-degraded] ${label}${errorMessage ? ` ${errorMessage}` : ''}`.trim();
  const nextStep =
    errorKind === 'auth_failed' || errorKind === 'binary_missing'
      ? 'repair_provider'
      : 'retry_provider';
  return {
    summary,
    confidence: 0,
    claims: [],
    evidence_used: [],
    open_questions: [
      errorMessage
        ? `${provider} execution degraded: ${errorMessage}`
        : `${provider} execution degraded`,
    ],
    messages_for_other_agents: [],
    recommended_next_step: nextStep,
  };
}

function tryParseResponse(text: string): AgentResponse {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : text.trim();
    const parsed = JSON.parse(jsonStr) as AgentResponse;
    if (typeof parsed.summary === 'string' && typeof parsed.confidence === 'number') {
      return {
        summary: parsed.summary,
        confidence: parsed.confidence,
        claims: parsed.claims ?? [],
        evidence_used: parsed.evidence_used ?? [],
        open_questions: parsed.open_questions ?? [],
        messages_for_other_agents: parsed.messages_for_other_agents ?? [],
        recommended_next_step: parsed.recommended_next_step ?? '',
      };
    }
    return { ...DEFAULT_RESPONSE, summary: text.slice(0, 500) };
  } catch {
    return { ...DEFAULT_RESPONSE, summary: text.slice(0, 500) };
  }
}

export class AgentExecutor {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly sessionStore: SessionStore,
    private readonly promptComposer: PromptComposer,
    private readonly runStore: RunStore,
    private readonly policyResolver: ExecutionPolicyResolver,
  ) {}

  async executeAgent(params: ExecuteAgentParams): Promise<AgentTurn[]> {
    const turns: AgentTurn[] = [];
    const resolvedPolicy = this.policyResolver.resolve(params.agentName, params.phase);
    const providers =
      params.providers?.length && params.providers.length > 0
        ? params.providers
        : resolvedPolicy.providers;

    for (const providerName of providers) {
      const adapter = this.registry.get(providerName);
      const modelProfile = params.modelProfile ?? resolvedPolicy.modelProfile;
      const model = this.policyResolver.resolveModel(providerName, modelProfile);

      if (!adapter) {
        turns.push(
          this.createDegradedTurn({
            params,
            providerName,
            message: 'Provider not registered',
            kind: 'unknown',
            recoverable: false,
            model,
            modelProfile,
          }),
        );
        continue;
      }

      const readiness = await this.probeProviderReadiness(adapter);
      if (!(readiness.ready_for_execution ?? readiness.available)) {
        turns.push(
          this.createDegradedTurn({
            params,
            providerName,
            message:
              readiness.error_summary ??
              readiness.error ??
              `${providerName} is not ready for execution`,
            kind:
              readiness.failure_kind ??
              (readiness.execute_status !== 'healthy' && readiness.execute_status !== 'unprobed'
                ? readiness.execute_status
                : readiness.auth_status !== 'healthy' && readiness.auth_status !== 'unprobed'
                  ? readiness.auth_status
                  : 'unknown'),
            recoverable: readiness.recoverable,
            model,
            modelProfile,
          }),
        );
        continue;
      }

      let session = this.sessionStore.getSession(params.agentName, providerName, {
        phase: params.phase,
        modelProfile,
        runScope: params.runScope ?? params.runId,
        model,
      });
      if (!session) {
        session = this.sessionStore.createSession(params.agentName, providerName, {
          phase: params.phase,
          modelProfile,
          runScope: params.runScope ?? params.runId,
          model,
        });
      }

      const prompt = await this.promptComposer.compose({
        phase: params.phase,
        agentName: params.agentName,
        provider: providerName,
        model,
        modelProfile,
        responseFormat: resolvedPolicy.responseFormat,
        evidenceBundle: params.evidenceBundle,
        candidate: params.candidate,
        otherAgentMessages: params.otherAgentMessages,
        debateTurns: params.debateTurns,
        researchResults: params.researchResults,
        sourceStatus: params.sourceStatus,
        orchestratorQuestions: params.orchestratorQuestions,
        verdictSummary: params.verdictSummary,
      });

      const result = await adapter.execute({
        prompt,
        sessionId: session.session_id,
        model,
        modelProfile,
        phase: params.phase,
        agentName: params.agentName,
        responseFormat: resolvedPolicy.responseFormat,
      });

      const response =
        result.status === 'degraded'
          ? buildDegradedResponse(
              providerName,
              result.degraded_kind,
              result.degraded_message,
            )
          : tryParseResponse(result.text);

      const turn = this.buildTurn({
        params,
        providerName,
        sessionId: result.sessionId,
        status: result.status,
        kind: result.degraded_kind,
        message: result.degraded_message,
        recoverable: result.recoverable,
        promptSummary: prompt.slice(0, 200),
        response,
      });

      this.runStore.saveTurn(turn);
      this.sessionStore.updateSession(session.session_id, turn);
      turns.push(turn);
    }

    return turns;
  }

  private async probeProviderReadiness(adapter: {
    health(): Promise<boolean>;
    probeHealth?(): Promise<ProviderHealthProbe>;
  }): Promise<ProviderHealthProbe> {
    if (adapter.probeHealth) {
      return adapter.probeHealth();
    }

    const available = await adapter.health();
    return {
      available,
      status: available ? 'healthy' : 'unknown',
      auth_status: available ? 'healthy' : 'unknown',
      execute_status: available ? 'healthy' : 'unknown',
      ready_for_execution: available,
      recoverable: false,
    };
  }

  private createDegradedTurn(params: {
    params: ExecuteAgentParams;
    providerName: string;
    message: string;
    kind?: ProviderFailureKind | string;
    recoverable?: boolean;
    model?: string;
    modelProfile?: ModelProfile;
  }): AgentTurn {
    const response = buildDegradedResponse(
      params.providerName,
      params.kind,
      params.message,
    );
    const turn = this.buildTurn({
      params: params.params,
      providerName: params.providerName,
      sessionId: `degraded-${params.providerName}-${Date.now()}`,
      status: 'degraded',
      kind: params.kind as ProviderFailureKind | undefined,
      message: params.message,
      recoverable: params.recoverable,
      promptSummary:
        params.model || params.modelProfile
          ? `provider probe blocked execution (model=${params.model ?? 'default'}, profile=${params.modelProfile ?? 'default'})`
          : 'provider probe blocked execution',
      response,
    });
    this.runStore.saveTurn(turn);
    return turn;
  }

  private buildTurn(args: {
    params: ExecuteAgentParams;
    providerName: string;
    sessionId: string;
    status: 'completed' | 'degraded';
    kind?: ProviderFailureKind;
    message?: string;
    recoverable?: boolean;
    promptSummary: string;
    response: AgentResponse;
  }): AgentTurn {
    return {
      run_id: args.params.runId,
      agent_name: args.params.agentName,
      provider: args.providerName,
      session_id: args.sessionId,
      provider_execution_status: args.status,
      provider_degraded_kind: args.kind,
      provider_error: args.message,
      provider_recoverable: args.recoverable,
      turn_index: this.runStore
        .getTurns(args.params.runId)
        .filter(
          (turn) =>
            turn.agent_name === args.params.agentName &&
            turn.provider === args.providerName,
        ).length,
      prompt_summary: args.promptSummary,
      response: args.response,
      citations: args.response.evidence_used,
      evidence_refs: args.params.evidenceBundle
        ? args.params.evidenceBundle.evidence_items.map((e: { evidence_id: string }) => e.evidence_id)
        : [],
      created_at: new Date().toISOString(),
    };
  }
}
