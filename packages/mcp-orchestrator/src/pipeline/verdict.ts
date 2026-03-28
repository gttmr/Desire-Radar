import type { DebatePolicy } from '../config/index.js';
import type { AgentExecutor } from '../orchestrator/agent-executor.js';
import type { RunContextStore } from '../orchestrator/run-context-store.js';
import type { RunStore } from '../orchestrator/run-store.js';
import type { VerdictResult } from './types.js';
import {
  buildBeneficiaryMapping,
  isWeakBeneficiaryMapping,
  summarizeBeneficiaryMapping,
} from './beneficiary-mapping.js';
import type { AgentTurn } from '@agentic/shared-types';

function selectPreferredTurn(turns: AgentTurn[]): AgentTurn | undefined {
  return turns.find((turn) => turn.provider_execution_status !== 'degraded') ?? turns[0];
}

export class VerdictService {
  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly contextStore: RunContextStore,
    private readonly policy: DebatePolicy,
    private readonly runStore: RunStore,
  ) {}

  async run(runId: string, providers?: string[]): Promise<VerdictResult> {
    const bundle = this.contextStore.getBundle(runId);
    const entity = this.contextStore.getEntity(runId) ?? bundle?.entity ?? 'unknown';
    const debateTurns = this.runStore.getTurns(runId);
    const researchResults = this.contextStore.getResearchResults(runId);
    const beneficiaryMappingTurn = selectPreferredTurn(await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: 'beneficiary_mapping',
      phase: 'verdict',
      providers,
      modelProfile: 'balanced',
      evidenceBundle: bundle,
      debateTurns,
      researchResults,
      orchestratorQuestions: [
        'Map the direct winner, public beneficiary, and second-order beneficiary. Be explicit when monetization is missing or fragile.',
      ],
    }));
    const beneficiary_mapping = buildBeneficiaryMapping(beneficiaryMappingTurn);
    const beneficiarySummary = summarizeBeneficiaryMapping(beneficiary_mapping);

    const primaryTurn = selectPreferredTurn(await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: this.policy.verdict.primaryAgent,
      phase: 'verdict',
      providers,
      modelProfile: this.policy.verdict.primaryModelProfile,
      evidenceBundle: bundle,
      debateTurns,
      researchResults,
      otherAgentMessages: [
        {
          from: 'beneficiary_mapping',
          content: beneficiarySummary,
        },
      ],
      orchestratorQuestions: [
        'Produce the final investment judgement. Be explicit about what could make this thesis wrong.',
      ],
    }));

    const crossCheckTurn = selectPreferredTurn(await this.agentExecutor.executeAgent({
      runId,
      runScope: runId,
      agentName: this.policy.verdict.crossCheckAgent,
      phase: 'verdict',
      providers,
      modelProfile: this.policy.verdict.crossCheckModelProfile,
      evidenceBundle: bundle,
      debateTurns,
      researchResults,
      otherAgentMessages: [
        {
          from: 'beneficiary_mapping',
          content: beneficiarySummary,
        },
      ],
      orchestratorQuestions: ['Cross-check the final judgement and point out the largest risk.'],
    }));

    const weakMapping = isWeakBeneficiaryMapping(beneficiary_mapping);
    const degradedTurns = [beneficiaryMappingTurn, primaryTurn, crossCheckTurn].filter(
      (turn): turn is NonNullable<typeof turn> => turn?.provider_execution_status === 'degraded',
    );
    const hasPrimaryDegraded = primaryTurn?.provider_execution_status === 'degraded';
    const initialRecommendation =
      primaryTurn?.response.recommended_next_step ??
      crossCheckTurn?.response.recommended_next_step ??
      'hold';
    const downgradedRecommendation =
      hasPrimaryDegraded && initialRecommendation !== 'hold'
        ? 'hold'
        : degradedTurns.length > 0 && initialRecommendation === 'act_now'
          ? 'watch_closely'
          : weakMapping && initialRecommendation === 'act_now'
            ? 'watch_closely'
            : weakMapping &&
                initialRecommendation === 'watch_closely' &&
                beneficiary_mapping?.missing_monetization_link
              ? 'hold'
              : initialRecommendation;
    const baselineConfidence = weakMapping
      ? Math.min(
          Math.max(
            primaryTurn?.response.confidence ?? 0,
            crossCheckTurn?.response.confidence ?? 0,
          ),
          beneficiary_mapping?.missing_monetization_link ? 0.58 : 0.68,
        )
      : Math.max(
          primaryTurn?.response.confidence ?? 0,
          crossCheckTurn?.response.confidence ?? 0,
        );
    const degradedConfidenceCap = hasPrimaryDegraded
      ? 0.32
      : degradedTurns.length >= 2
        ? 0.45
        : degradedTurns.length === 1
          ? 0.58
          : 1.0;
    const adjustedConfidence = Math.min(baselineConfidence, degradedConfidenceCap);

    const verdict: VerdictResult = {
      runId,
      entity,
      summary:
        primaryTurn?.response.summary ??
        crossCheckTurn?.response.summary ??
        'No verdict produced.',
      confidence: adjustedConfidence,
      recommendation: downgradedRecommendation,
      beneficiary_mapping,
      supportingAgents: [
        beneficiaryMappingTurn?.agent_name,
        primaryTurn?.agent_name,
        crossCheckTurn?.agent_name,
      ].filter((value): value is string => Boolean(value)),
      openQuestions: [
        ...(beneficiary_mapping?.missing_monetization_link
          ? [beneficiary_mapping.missing_monetization_link]
          : []),
        ...(beneficiary_mapping?.invalidation_point ? [beneficiary_mapping.invalidation_point] : []),
        ...degradedTurns
          .map((turn) => turn.provider_error || turn.provider_degraded_kind)
          .filter((value): value is string => Boolean(value)),
        ...(primaryTurn?.response.open_questions ?? []),
        ...(crossCheckTurn?.response.open_questions ?? []),
      ].filter((value, index, items) => items.indexOf(value) === index),
      primaryTurn,
      crossCheckTurn,
      beneficiaryMappingTurn,
      createdAt: new Date().toISOString(),
    };

    this.contextStore.setVerdict(runId, verdict);
    return verdict;
  }
}
