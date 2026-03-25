import type { HumanInputMessageRequest } from '@agentic/shared-types';
import type { Message } from 'discord.js';

function trimTo(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function extractRequestSubmissionId(
  content: string,
  threadName?: string | null,
): string | undefined {
  const contentMatch = content.match(/request_submission_id\s*:\s*([a-zA-Z0-9_-]+)/i);
  if (contentMatch?.[1]) {
    return contentMatch[1];
  }
  const threadMatch = threadName?.match(/([a-f0-9]{16})/i);
  return threadMatch?.[1];
}

export function buildHumanInputPayload(message: Message<boolean>): HumanInputMessageRequest {
  const attachmentUrls = [...message.attachments.values()].map((attachment) => attachment.url);
  const threadName = message.channel.isThread() ? message.channel.name : undefined;
  const channelName = 'name' in message.channel ? (message.channel.name ?? undefined) : undefined;

  return {
    content: message.content,
    message_url: message.url,
    attachment_urls: attachmentUrls,
    producer_ref: `discord:${message.author.id}`,
    author_id: message.author.id,
    author_name: message.author.username,
    guild_id: message.guildId ?? undefined,
    channel_id: message.channelId,
    channel_name: channelName,
    message_id: message.id,
    thread_id: message.channel.isThread() ? message.channel.id : undefined,
    thread_name: threadName,
    request_submission_id: extractRequestSubmissionId(message.content, threadName),
    posted_at: message.createdAt.toISOString(),
  };
}

export function formatExpectedTemplate(): string {
  return [
    '입력 채널 사용 예시:',
    '1. 빠른 관측',
    'title: Cursor adoption spike',
    'entities: Cursor, OpenAI',
    '',
    '짧은 관측 내용을 자유롭게 적으세요.',
    '',
    '2. 분석/스터디 결과',
    'title: Developer workflow study',
    'entities: Cursor',
    'why_now: weekly seat growth accelerated',
    'supporting_points: review workflow lock-in; repeat seat expansion',
    '',
    '분석 본문을 아래에 이어서 적으세요.',
    '',
    '3. 구조화된 데이터',
    '```json',
    '{',
    '  "evidence_items": [',
    '    {',
    '      "evidence_id": "local-1",',
    '      "entity_candidates": ["Cursor"],',
    '      "signal_type": "channel_check",',
    '      "title_or_label": "Three teams added seats",',
    '      "trust_score": 0.9',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    `내용 요약: ${trimTo('observation / study / dataset 중 하나로 collector가 자동 분류합니다.', 120)}`,
  ].join('\n');
}
