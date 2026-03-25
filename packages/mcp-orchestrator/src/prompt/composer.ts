import type { AgentTurn, EvidenceBundle } from '@agentic/shared-types';
import type { CollectorCandidate, CollectorSourceStatus } from '../collector/client.js';
import type { ResearchResult } from '../collector/research-service.js';
import type { ExecutionPhase, ModelProfile, ResponseFormat } from '../providers/base.js';
import type { PromptLoader } from './loader.js';
import { buildPhaseContext } from './context.js';

export interface ComposeParams {
  phase?: ExecutionPhase;
  agentName: string;
  provider: string;
  model?: string;
  modelProfile?: ModelProfile;
  responseFormat?: ResponseFormat;
  evidenceBundle?: EvidenceBundle;
  candidate?: CollectorCandidate;
  sessionSummary?: string;
  orchestratorQuestions?: string[];
  otherAgentMessages?: Array<{ from: string; content: string }>;
  debateTurns?: AgentTurn[];
  researchResults?: ResearchResult[];
  sourceStatus?: Record<string, CollectorSourceStatus>;
  verdictSummary?: string;
}

const RUNTIME_INSTRUCTIONS = `You are an analytical agent in a phase-aware investment decision system.

Rules:
1. Respond ONLY with valid JSON matching the Output Schema defined in your role description.
2. Be precise — cite evidence_id values from the evidence bundle.
3. Express confidence as a decimal between 0.0 and 1.0.
4. Use messages_for_other_agents to ask questions or challenge claims from other agents.
5. If you lack sufficient evidence, say so — do not fabricate data.
`;

export class PromptComposer {
  constructor(private readonly loader: PromptLoader) {}

  async compose(params: ComposeParams): Promise<string> {
    const sections: string[] = [];

    // 1. Common runtime instructions
    sections.push(RUNTIME_INSTRUCTIONS);
    sections.push(
      [
        '## Execution Context',
        `- phase: ${params.phase ?? 'debate'}`,
        `- provider: ${params.provider}`,
        `- model_profile: ${params.modelProfile ?? 'cheap'}`,
        `- model: ${params.model ?? '(provider default)'}`,
        `- response_format: ${params.responseFormat ?? 'json'}`,
      ].join('\n'),
    );

    // 2. Agent system prompt
    const agentPrompt = await this.loader.loadAgent(params.agentName);
    sections.push(agentPrompt);

    // 3. Provider override (if exists)
    const override = await this.loader.loadProviderOverride(
      params.agentName,
      params.provider,
    );
    if (override) {
      sections.push(`## Provider-Specific Instructions\n${override}`);
    }

    // 4. Session summary (if exists)
    if (params.sessionSummary) {
      sections.push(
        `## Previous Session Context\n${params.sessionSummary}`,
      );
    }

    sections.push(
      ...buildPhaseContext({
        phase: params.phase ?? 'debate',
        evidenceBundle: params.evidenceBundle,
        candidate: params.candidate,
        otherAgentMessages: params.otherAgentMessages,
        orchestratorQuestions: params.orchestratorQuestions,
        debateTurns: params.debateTurns,
        researchResults: params.researchResults,
        sourceStatus: params.sourceStatus,
        verdictSummary: params.verdictSummary,
      }),
    );

    return sections.join('\n\n---\n\n');
  }
}
