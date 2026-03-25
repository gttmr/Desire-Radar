import type {
  HumanAnalystNoteRequest,
  HumanEvidenceBatchRequest,
  ManualObservationRequest,
} from '@agentic/shared-types';
import type { Message } from 'discord.js';

export type DiscordHumanChannelRole = 'observation' | 'study' | 'data';

type ParsedMetadata = {
  values: Record<string, string>;
  body: string;
};

const KNOWN_KEYS = new Set([
  'title',
  'entity',
  'entities',
  'entity_candidates',
  'signal_type',
  'geo',
  'url',
  'trust_score',
  'freshness_ttl',
  'metric_value',
  'metric_delta',
  'rank',
  'why_now',
  'confidence',
  'beneficiary_hints',
  'research_questions',
  'source_refs',
  'supporting_points',
  'study_type',
  'dataset_name',
  'notes',
  'request_submission_id',
]);

export type ParsedDiscordIngest =
  | { role: 'observation'; payload: ManualObservationRequest & { reporter?: string } }
  | { role: 'study'; payload: HumanAnalystNoteRequest }
  | { role: 'data'; payload: HumanEvidenceBatchRequest };

export function parseDiscordMessage(
  role: DiscordHumanChannelRole,
  message: Message<boolean>,
): ParsedDiscordIngest {
  const content = message.content.trim();
  const parsed = parseMetadata(content);
  const attachmentUrls = [...message.attachments.values()].map((attachment) => attachment.url);
  const messageRef = message.url;

  switch (role) {
    case 'observation':
      return {
        role,
        payload: {
          title: parsed.values.title ?? summarize(parsed.body || content, 140) ?? 'Discord observation',
          entities: parseList(parsed.values.entity_candidates ?? parsed.values.entities ?? parsed.values.entity),
          signal_type: parsed.values.signal_type ?? 'manual',
          metric_value: parseOptionalNumber(parsed.values.metric_value),
          metric_delta: parseOptionalNumber(parsed.values.metric_delta),
          rank: parseOptionalInteger(parsed.values.rank),
          geo: parsed.values.geo ?? 'global',
          url: parsed.values.url ?? attachmentUrls[0] ?? messageRef,
          trust_score: parseOptionalNumber(parsed.values.trust_score) ?? 0.9,
          freshness_ttl: parseOptionalInteger(parsed.values.freshness_ttl) ?? 86400,
          reporter: `${message.author.username}:${message.author.id}`,
        },
      };
    case 'study':
      return {
        role,
        payload: {
          title: parsed.values.title ?? summarize(parsed.body || content, 140) ?? 'Discord study result',
          observation: parsed.body || content,
          entity_candidates: parseList(
            parsed.values.entity_candidates ?? parsed.values.entities ?? parsed.values.entity,
          ),
          why_now: parsed.values.why_now ?? '',
          confidence: parseOptionalNumber(parsed.values.confidence) ?? 0.85,
          geo: parsed.values.geo ?? 'global',
          channel: 'discord-study',
          study_type: parsed.values.study_type ?? 'analysis_note',
          producer_ref: `discord:${message.author.id}`,
          beneficiary_hints: parseList(parsed.values.beneficiary_hints),
          research_questions: parseList(parsed.values.research_questions),
          source_refs: dedupeStrings([messageRef, ...attachmentUrls, ...parseList(parsed.values.source_refs)]),
          supporting_points: parseList(parsed.values.supporting_points),
          request_submission_id: parsed.values.request_submission_id,
        },
      };
    case 'data': {
      const jsonPayload = parseJsonCodeBlock(content);
      if (jsonPayload != null) {
        return {
          role,
          payload: normalizeBatchPayload(jsonPayload, {
            producer_ref: `discord:${message.author.id}`,
            dataset_name: parsed.values.dataset_name ?? 'discord_data_source',
            channel: 'discord-data',
            notes: parsed.values.notes ?? '',
            request_submission_id: parsed.values.request_submission_id,
          }),
        };
      }

      const entityCandidates = parseList(
        parsed.values.entity_candidates ?? parsed.values.entities ?? parsed.values.entity,
      );
      if (!parsed.body && attachmentUrls.length === 0) {
        throw new Error(
          '데이터 채널은 JSON 코드블록 또는 설명 본문이 필요합니다.',
        );
      }
      if (entityCandidates.length === 0) {
        throw new Error('데이터 채널은 `entities:` 또는 `entity_candidates:` 필드가 필요합니다.');
      }

      return {
        role,
        payload: {
          producer_ref: `discord:${message.author.id}`,
          dataset_name: parsed.values.dataset_name ?? 'discord_data_source',
          channel: 'discord-data',
          notes: parsed.values.notes ?? '',
          request_submission_id: parsed.values.request_submission_id,
          evidence_items: [
            {
              evidence_id: `discord-${message.id}`,
              entity_candidates: entityCandidates,
              signal_type: parsed.values.signal_type ?? 'human_data_source',
              title_or_label:
                parsed.values.title ?? summarize(parsed.body || content, 160) ?? 'Discord data source',
              metric_value: parseOptionalNumber(parsed.values.metric_value),
              metric_delta: parseOptionalNumber(parsed.values.metric_delta),
              rank: parseOptionalInteger(parsed.values.rank),
              geo: parsed.values.geo ?? 'global',
              url_or_ref: parsed.values.url ?? attachmentUrls[0] ?? messageRef,
              trust_score: parseOptionalNumber(parsed.values.trust_score) ?? 0.9,
              freshness_ttl: parseOptionalInteger(parsed.values.freshness_ttl) ?? 86400,
            },
          ],
        },
      };
    }
  }
}

export function formatExpectedTemplate(role: DiscordHumanChannelRole): string {
  switch (role) {
    case 'observation':
      return [
        '관측 채널 형식 예시:',
        'title: Cursor adoption spike',
        'entities: Cursor, OpenAI',
        'signal_type: manual',
        'geo: US',
        '',
        '짧은 관측 내용을 자유롭게 적으세요.',
      ].join('\n');
    case 'study':
      return [
        '스터디 채널 형식 예시:',
        'title: Developer workflow study',
        'entities: Cursor',
        'why_now: weekly seat growth accelerated',
        'beneficiary_hints: Microsoft, GitHub',
        'supporting_points: teams standardize code review; retention is high',
        '',
        '분석/스터디 결과 본문을 아래에 적으세요.',
      ].join('\n');
    case 'data':
      return [
        '데이터 채널 형식 예시:',
        'entities: Cursor',
        'dataset_name: channel checks',
        '',
        '```json',
        '{',
        '  "evidence_items": [',
        '    {',
        '      "evidence_id": "local-1",',
        '      "entity_candidates": ["Cursor"],',
        '      "signal_type": "channel_check",',
        '      "title_or_label": "Seat counts expanded in 3 teams",',
        '      "trust_score": 0.9',
        '    }',
        '  ]',
        '}',
        '```',
      ].join('\n');
  }
}

function parseMetadata(content: string): ParsedMetadata {
  const lines = content.split('\n');
  const values: Record<string, string> = {};
  const bodyLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    if (match) {
      const key = match[1]!.toLowerCase();
      const value = match[2]!.trim();
      if (KNOWN_KEYS.has(key)) {
        values[key] = value;
        continue;
      }
    }
    bodyLines.push(rawLine);
  }

  return {
    values,
    body: bodyLines.join('\n').replace(/```json[\s\S]*?```/gi, '').trim(),
  };
}

function parseList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return dedupeStrings(
    value
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function dedupeStrings(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function summarize(value: string, maxLength: number): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return null;
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function parseOptionalNumber(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalInteger(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonCodeBlock(content: string): unknown | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }
  return JSON.parse(match[1]!.trim());
}

function normalizeBatchPayload(
  payload: unknown,
  defaults: Pick<
    HumanEvidenceBatchRequest,
    'producer_ref' | 'dataset_name' | 'channel' | 'notes' | 'request_submission_id'
  >,
): HumanEvidenceBatchRequest {
  if (Array.isArray(payload)) {
    return { ...defaults, evidence_items: payload as Record<string, unknown>[] };
  }
  if (payload && typeof payload === 'object') {
    const objectPayload = payload as Record<string, unknown>;
    if (Array.isArray(objectPayload.evidence_items)) {
      return {
        ...defaults,
        ...objectPayload,
        evidence_items: objectPayload.evidence_items as Record<string, unknown>[],
      };
    }
    if (typeof objectPayload.evidence_id === 'string') {
      return {
        ...defaults,
        evidence_items: [objectPayload],
      };
    }
  }
  throw new Error('JSON 코드블록은 evidence_items 배열 또는 단일 evidence 객체여야 합니다.');
}
