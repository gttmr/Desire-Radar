import type { CollectorSourceStatus } from '../collector/client.js';
import type { ResearchRequestKind } from '../collector/research-service.js';

export type ResearchIntent =
  | 'demand'
  | 'ranking'
  | 'pricing'
  | 'supply'
  | 'monetization'
  | 'beneficiary'
  | 'validation';

export type ResearchInputKind =
  | 'study_result'
  | 'data_source'
  | 'channel_check'
  | 'beneficiary_mapping'
  | 'validation_note';

export type ResearchPlan = {
  intent: ResearchIntent;
  requestKind: ResearchRequestKind;
  requestedInputKind: ResearchInputKind;
  requiredFields: string[];
  preferredCapabilities: string[];
  question: string;
};

const INTENT_CAPABILITIES: Record<ResearchIntent, string[]> = {
  demand: ['demand', 'trend', 'adoption', 'usage'],
  ranking: ['ranking', 'trend', 'velocity'],
  pricing: ['pricing', 'channel_check', 'inventory'],
  supply: ['supply', 'inventory', 'channel_check'],
  monetization: ['monetization', 'beneficiary', 'channel_check'],
  beneficiary: ['beneficiary', 'monetization', 'theme_mapping'],
  validation: ['validation', 'channel_check', 'trend'],
};

const INTENT_REQUIRED_FIELDS: Record<ResearchIntent, string[]> = {
  demand: ['entity', 'observed_behavior', 'timeframe'],
  ranking: ['entity', 'ranking_surface', 'timeframe'],
  pricing: ['entity', 'price_or_premium', 'timeframe'],
  supply: ['entity', 'availability_or_inventory', 'timeframe'],
  monetization: ['entity', 'value_capture_path', 'candidate_beneficiary'],
  beneficiary: ['entity', 'public_beneficiary', 'value_capture_reason'],
  validation: ['entity', 'confirming_signal', 'disconfirming_signal'],
};

const HUMAN_INPUT_KIND_BY_INTENT: Record<ResearchIntent, ResearchInputKind> = {
  demand: 'study_result',
  ranking: 'data_source',
  pricing: 'channel_check',
  supply: 'channel_check',
  monetization: 'study_result',
  beneficiary: 'beneficiary_mapping',
  validation: 'validation_note',
};

function normalize(text: string): string {
  return text.toLowerCase();
}

export function inferResearchIntent(question: string): ResearchIntent {
  const lowered = normalize(question);
  if (
    /(who benefits|beneficiary|public company|listed|ticker|supplier|infrastructure|platform winner)/i.test(
      lowered,
    )
  ) {
    return 'beneficiary';
  }
  if (/(monetization|value capture|revenue|how does this make money|business model)/i.test(lowered)) {
    return 'monetization';
  }
  if (/(price|pricing|premium|markup|resale|discount|sell out|sell-out)/i.test(lowered)) {
    return 'pricing';
  }
  if (/(supply|inventory|waitlist|stockout|availability|channel check)/i.test(lowered)) {
    return 'supply';
  }
  if (/(rank|ranking|chart|top seller|top-seller|position)/i.test(lowered)) {
    return 'ranking';
  }
  if (/(confirm|validate|false positive|disconfirm|is this real|is this durable)/i.test(lowered)) {
    return 'validation';
  }
  return 'demand';
}

export function inferSourceCapabilities(
  sourceId: string,
  source: CollectorSourceStatus,
): string[] {
  if (Array.isArray(source.capabilities) && source.capabilities.length > 0) {
    return [...new Set(source.capabilities.map((value) => value.toLowerCase()))];
  }

  const inferred = new Set<string>();
  const normalizedId = normalize(sourceId);
  const kind = source.kind ?? 'pull';

  if (kind === 'human') {
    return ['demand', 'ranking', 'pricing', 'supply', 'monetization', 'beneficiary', 'validation'];
  }
  if (kind === 'agent') {
    return ['beneficiary', 'monetization', 'validation', 'demand'];
  }
  if (normalizedId.includes('google_trends') || normalizedId.includes('naver_datalab')) {
    inferred.add('demand');
    inferred.add('ranking');
  }
  if (
    normalizedId.includes('app_store') ||
    normalizedId.includes('steamdb') ||
    normalizedId.includes('similarweb') ||
    normalizedId.includes('top_charts')
  ) {
    inferred.add('ranking');
    inferred.add('demand');
  }
  if (normalizedId.includes('supply_tightness')) {
    inferred.add('supply');
    inferred.add('pricing');
  }
  if (normalizedId.includes('co_mention') || normalizedId.includes('persistence') || normalizedId.includes('divergence')) {
    inferred.add('validation');
    inferred.add('demand');
    inferred.add('ranking');
  }
  if (normalizedId.includes('reddit') || normalizedId.includes('tiktok')) {
    inferred.add('demand');
    inferred.add('validation');
  }
  if (inferred.size === 0) {
    inferred.add('demand');
  }
  return [...inferred];
}

export function supportsRequestKind(
  sourceId: string,
  source: CollectorSourceStatus,
  requestKind: ResearchRequestKind,
): boolean {
  if (Array.isArray(source.request_kinds_supported) && source.request_kinds_supported.length > 0) {
    if (!source.request_kinds_supported.includes(requestKind)) {
      return false;
    }
    if (requestKind === 'run_source') {
      return source.runnable === true && source.kind !== 'human';
    }
    return true;
  }
  if (requestKind === 'run_source') {
    return source.runnable === true && source.kind !== 'human';
  }
  if (requestKind === 'request_human_note') {
    return source.kind === 'human';
  }
  return source.kind === 'agent';
}

export function planResearchQuestion(
  question: string,
  defaultRequestKind: ResearchRequestKind,
): ResearchPlan {
  const intent = inferResearchIntent(question);
  return {
    intent,
    requestKind: defaultRequestKind,
    requestedInputKind: HUMAN_INPUT_KIND_BY_INTENT[intent],
    requiredFields: INTENT_REQUIRED_FIELDS[intent],
    preferredCapabilities: INTENT_CAPABILITIES[intent],
    question,
  };
}
