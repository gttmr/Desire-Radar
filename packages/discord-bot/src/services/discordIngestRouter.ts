import type { Message } from 'discord.js';
import { env } from '../config.js';
import { CollectorClient } from './collectorClient.js';
import { buildHumanInputPayload, formatExpectedTemplate } from './discordIngestParser.js';

export type DiscordIngestResult =
  | { handled: false }
  | {
      handled: true;
      accepted: boolean;
      message: string;
      submissionId?: string;
    };

export class DiscordIngestRouter {
  constructor(private readonly collector: CollectorClient) {}

  isHumanInputChannel(channelId: string): boolean {
    return env.DISCORD_HUMAN_INPUT_CHANNEL_IDS.has(channelId);
  }

  async handleMessage(message: Message<boolean>): Promise<DiscordIngestResult> {
    if (!this.isHumanInputChannel(message.channelId)) {
      return { handled: false };
    }

    try {
      const submission = await this.collector.submitHumanInput(buildHumanInputPayload(message));
      const classification = (submission.metadata?.classification ?? {}) as Record<string, unknown>;
      const route = typeof classification.route === 'string' ? classification.route : 'unknown';
      const userMessage =
        typeof classification.user_message === 'string'
          ? classification.user_message
          : undefined;
      return {
        handled: true,
        accepted: submission.status !== 'rejected',
        submissionId: submission.submission_id,
        message:
          submission.status === 'rejected'
            ? `${userMessage ?? '입력을 분류하지 못했습니다.'}\n\n${formatExpectedTemplate()}`
            : `수집 등록됨: ${submission.submission_id} (${route})`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '알 수 없는 오류';
      return {
        handled: true,
        accepted: false,
        message: `${reason}\n\n${formatExpectedTemplate()}`,
      };
    }
  }
}
