import type { Message } from 'discord.js';
import { env } from '../config.js';
import { CollectorClient } from './collectorClient.js';
import {
  formatExpectedTemplate,
  parseDiscordMessage,
  type DiscordHumanChannelRole,
} from './discordIngestParser.js';

export type DiscordIngestResult =
  | { handled: false }
  | {
      handled: true;
      accepted: boolean;
      role: DiscordHumanChannelRole;
      message: string;
      submissionId?: string;
    };

export class DiscordIngestRouter {
  constructor(private readonly collector: CollectorClient) {}

  resolveRole(channelId: string): DiscordHumanChannelRole | null {
    if (env.DISCORD_HUMAN_OBSERVATION_CHANNEL_IDS.has(channelId)) {
      return 'observation';
    }
    if (env.DISCORD_HUMAN_STUDY_CHANNEL_IDS.has(channelId)) {
      return 'study';
    }
    if (env.DISCORD_HUMAN_DATA_CHANNEL_IDS.has(channelId)) {
      return 'data';
    }
    return null;
  }

  async handleMessage(message: Message<boolean>): Promise<DiscordIngestResult> {
    const role = this.resolveRole(message.channelId);
    if (!role) {
      return { handled: false };
    }

    try {
      const parsed = parseDiscordMessage(role, message);
      const submission =
        parsed.role === 'observation'
          ? await this.collector.submitHumanObservation(parsed.payload)
          : parsed.role === 'study'
            ? await this.collector.submitHumanStudyResult(parsed.payload)
            : await this.collector.submitHumanDataSource(parsed.payload);

      return {
        handled: true,
        accepted: true,
        role,
        submissionId: submission.submission_id,
        message: `수집 등록됨: ${submission.submission_id}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '알 수 없는 오류';
      return {
        handled: true,
        accepted: false,
        role,
        message: `${reason}\n\n${formatExpectedTemplate(role)}`,
      };
    }
  }
}
