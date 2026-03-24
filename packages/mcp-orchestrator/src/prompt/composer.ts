import type { EvidenceBundle } from '@agentic/shared-types';
import type { PromptLoader } from './loader.js';

export interface ComposeParams {
  agentName: string;
  provider: string;
  evidenceBundle?: EvidenceBundle;
  sessionSummary?: string;
  orchestratorQuestions?: string[];
  otherAgentMessages?: Array<{ from: string; content: string }>;
}

const RUNTIME_INSTRUCTIONS = `You are an analytical agent in a multi-agent debate system.

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

    // 5. Evidence bundle
    if (params.evidenceBundle) {
      sections.push(
        `## Evidence Bundle\n\`\`\`json\n${JSON.stringify(params.evidenceBundle, null, 2)}\n\`\`\``,
      );
    }

    // 6. Orchestrator questions / other agent messages
    if (params.orchestratorQuestions?.length) {
      sections.push(
        `## Orchestrator Questions\n${params.orchestratorQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
    }

    if (params.otherAgentMessages?.length) {
      const msgs = params.otherAgentMessages
        .map((m) => `**${m.from}**: ${m.content}`)
        .join('\n\n');
      sections.push(`## Messages From Other Agents\n${msgs}`);
    }

    return sections.join('\n\n---\n\n');
  }
}
