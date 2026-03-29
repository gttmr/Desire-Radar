import type {
  InvestmentDecisionRequest,
  ModelProfile,
} from '@agentic/shared-types';
import type { PromptLoader } from '../prompt/loader.js';

const RUNTIME_INSTRUCTIONS = `You are executing the investment_decision phase.

Rules:
1. Respond ONLY with valid JSON.
2. Do not invent tickers, companies, or evidence ids.
3. If coverage is incomplete, keep the gap in coverage_gaps instead of guessing.
4. Treat watchlist names as the default scope and be conservative with non-watchlist additions.
5. The downstream report formatter is deterministic. Your output must already be final structured content.
`;

export class InvestmentDecisionPromptBuilder {
  constructor(private readonly promptLoader: PromptLoader) {}

  async build(args: {
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
    provider: string;
    model?: string;
    modelProfile: ModelProfile;
  }): Promise<string> {
    const agentPrompt = await this.promptLoader.loadAgent('investment_decision');
    const providerOverride = await this.promptLoader.loadProviderOverride(
      'investment_decision',
      args.provider,
    );

    return [
      RUNTIME_INSTRUCTIONS,
      [
        '## Execution Context',
        '- phase: investment_decision',
        `- provider: ${args.provider}`,
        `- model_profile: ${args.modelProfile}`,
        `- model: ${args.model ?? '(provider default)'}`,
      ].join('\n'),
      agentPrompt,
      providerOverride ? `## Provider-Specific Instructions\n${providerOverride}` : null,
      '## Decision Request (Markdown)',
      args.requestMarkdown,
      '## Decision Request (JSON)',
      '```json',
      JSON.stringify(args.request, null, 2),
      '```',
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n---\n\n');
  }
}
