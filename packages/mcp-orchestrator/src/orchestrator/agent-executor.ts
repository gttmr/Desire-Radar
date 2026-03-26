import type { AgentTurn, AgentResponse, EvidenceBundle } from '@agentic/shared-types';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { PromptComposer } from '../prompt/composer.js';
import type { RunStore } from './run-store.js';
import type { CollectorCandidate, CollectorSourceStatus } from '../collector/client.js';
import type { ResearchResult } from '../collector/research-service.js';
import type { ExecutionPhase, ModelProfile } from '../providers/base.js';
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
    // Try to extract JSON from the response (may be wrapped in markdown code fences)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : text.trim();
    const parsed = JSON.parse(jsonStr) as AgentResponse;
    // Validate required fields exist
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
    const existingTurns = this.runStore.getTurns(params.runId);
    const resolvedPolicy = this.policyResolver.resolve(params.agentName, params.phase);
    const providers =
      params.providers?.length && params.providers.length > 0
        ? params.providers
        : resolvedPolicy.providers;

    for (const providerName of providers) {
      const adapter = this.registry.get(providerName);
      if (!adapter) continue;
      const modelProfile = params.modelProfile ?? resolvedPolicy.modelProfile;
      const model = this.policyResolver.resolveModel(providerName, modelProfile);

      // 1. Get or create session
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

      // 2. Compose prompt
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

      // 3. Execute
      const result = await adapter.execute({
        prompt,
        sessionId: session.session_id,
        model,
        modelProfile,
        phase: params.phase,
        agentName: params.agentName,
        responseFormat: resolvedPolicy.responseFormat,
      });

      // 4. Parse response
      const response =
        result.status === 'degraded'
          ? buildDegradedResponse(
              providerName,
              result.degraded_kind,
              result.degraded_message,
            )
          : tryParseResponse(result.text);

      // 5. Create turn
      const turn: AgentTurn = {
        run_id: params.runId,
        agent_name: params.agentName,
        provider: providerName,
        session_id: result.sessionId,
        provider_execution_status: result.status,
        provider_degraded_kind: result.degraded_kind,
        provider_error: result.degraded_message,
        provider_recoverable: result.recoverable,
        turn_index: existingTurns.filter(
          (t) => t.agent_name === params.agentName && t.provider === providerName,
        ).length,
        prompt_summary: prompt.slice(0, 200),
        response,
        citations: response.evidence_used,
        evidence_refs: params.evidenceBundle
          ? params.evidenceBundle.evidence_items.map((e: { evidence_id: string }) => e.evidence_id)
          : [],
        created_at: new Date().toISOString(),
      };

      // 6. Save
      this.runStore.saveTurn(turn);
      this.sessionStore.updateSession(session.session_id, turn);
      turns.push(turn);
    }

    return turns;
  }
}
