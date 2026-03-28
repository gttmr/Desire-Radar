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
    '자유 형식 입력이 기본입니다. 아래 예시는 선택사항입니다.',
    '',
    '예시 1. 자연어 명령',
    '삼성전자 와치리스트에 추가해',
    '',
    '예시 2. 자유 형식 스터디 메모',
    '삼성전자 쪽을 다시 보고 있다. HBM 고객사 수요가 빨라지고 있고,',
    '메모리 업사이클보다 AI 서버 믹스 변화가 더 중요해 보인다.',
    '',
    '예시 3. 구조화된 데이터(JSON도 계속 지원)',
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
    trimTo('collector가 observation / study note / dataset / command로 자동 해석하고, 저위험 watchlist 액션과 투자 메모 handoff를 처리합니다.', 140),
  ].join('\n');
}
