import type { HumanInputInterpretation, InvestmentIntakeResponse } from '@agentic/shared-types';
import type { OrchestratorClient } from './orchestratorClient.js';
import type { ReportCommandService } from './reportCommandService.js';

const AUTO_ACTION_THRESHOLD = 0.8;

export type HumanInputFollowUpContext = {
  guildId?: string | null;
  channelRef?: string;
  rawInput: string;
  sourceSubmissionId: string;
  interpretation: HumanInputInterpretation;
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export class HumanInputFollowUpService {
  constructor(
    private readonly reportCommands: ReportCommandService,
    private readonly orchestrator: OrchestratorClient,
  ) {}

  async handle(context: HumanInputFollowUpContext): Promise<string[]> {
    const messages: string[] = [];
    const autoActions = await this.applyAutoActions(context);
    messages.push(...autoActions);

    const handoff = await this.forwardInvestmentNote(context);
    if (handoff) {
      messages.push(handoff);
    }

    if (
      messages.length === 0 &&
      context.interpretation.user_message &&
      context.interpretation.input_kind === 'command'
    ) {
      const kind = context.interpretation.input_kind;
      if (kind === 'command') {
        messages.push(context.interpretation.user_message);
      }
    }

    return unique(messages).slice(0, 4);
  }

  private async applyAutoActions(context: HumanInputFollowUpContext): Promise<string[]> {
    if (!context.guildId) {
      return [];
    }

    const messages: string[] = [];
    const seen = new Set<string>();
    for (const request of context.interpretation.action_requests ?? []) {
      if (
        request.asset_type !== 'stock' ||
        !request.ticker ||
        request.confidence < AUTO_ACTION_THRESHOLD
      ) {
        continue;
      }
      const key = `${request.action}:${request.ticker}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const result = await this.reportCommands.applyWatchlistAction(
        context.guildId,
        request.action,
        request.ticker,
        request.display_name,
      );
      messages.push(result);
    }
    return messages;
  }

  private async forwardInvestmentNote(
    context: HumanInputFollowUpContext,
  ): Promise<string | null> {
    if (
      !context.interpretation.handoff_targets?.includes('investment_module') ||
      !context.interpretation.investment_note
    ) {
      return null;
    }

    const response: InvestmentIntakeResponse = await this.orchestrator.submitInvestmentIntake({
      source_submission_id: context.sourceSubmissionId,
      input_kind: context.interpretation.input_kind,
      raw_input: context.rawInput,
      channel_ref: context.channelRef,
      asset_candidates: context.interpretation.asset_candidates ?? [],
      auto_actions: context.interpretation.action_requests ?? [],
      investment_note: context.interpretation.investment_note,
    });

    const resolvedAssets = response.dossiers.map((dossier) => dossier.display_name);
    return resolvedAssets.length > 0
      ? `투자 메모 저장: ${response.intake.intake_id} | dossier=${resolvedAssets.join(', ')}`
      : `투자 메모 저장: ${response.intake.intake_id} | unresolved asset`;
  }
}
