import type { ProviderFailureKind, ProviderHealthProbe, ProviderResult } from './base.js';

function includesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function classifyProviderFailure(message: string): ProviderFailureKind {
  if (
    includesAny(message, [
      /ENOENT/i,
      /not found/i,
      /is not recognized/i,
      /No such file or directory/i,
      /spawn .* ENOENT/i,
    ])
  ) {
    return 'binary_missing';
  }
  if (includesAny(message, [/timed out/i, /timeout/i, /aborted/i])) {
    return 'timeout';
  }
  if (
    includesAny(message, [
      /MODEL_CAPACITY_EXHAUSTED/i,
      /RESOURCE_EXHAUSTED/i,
      /resource exhausted/i,
      /temporarily unavailable/i,
      /capacity/i,
    ])
  ) {
    return 'capacity_limited';
  }
  if (
    includesAny(message, [
      /429\b/i,
      /rate limit/i,
      /too many requests/i,
      /you've hit your limit/i,
      /quota exceeded/i,
    ])
  ) {
    return 'rate_limited';
  }
  if (
    includesAny(message, [
      /unauthorized/i,
      /forbidden/i,
      /auth/i,
      /credential/i,
      /login/i,
      /token/i,
      /session/i,
      /expired/i,
      /loggedIn=false/i,
      /api key/i,
    ])
  ) {
    return 'auth_failed';
  }
  if (
    includesAny(message, [
      /parse/i,
      /invalid json/i,
      /missing agent_message/i,
      /returned no assistant message/i,
      /returned empty output/i,
    ])
  ) {
    return 'parse_failed';
  }
  return 'unknown';
}

export function isRecoverableFailure(kind: ProviderFailureKind): boolean {
  switch (kind) {
    case 'auth_failed':
    case 'capacity_limited':
    case 'rate_limited':
    case 'timeout':
    case 'parse_failed':
      return true;
    case 'binary_missing':
    case 'unknown':
    default:
      return false;
  }
}

export function buildDegradedProviderResult(params: {
  sessionId: string;
  durationMs: number;
  model?: string;
  message: string;
}): ProviderResult {
  const kind = classifyProviderFailure(params.message);
  return {
    text: '',
    sessionId: params.sessionId,
    durationMs: params.durationMs,
    model: params.model,
    status: 'degraded',
    degraded_kind: kind,
    degraded_message: params.message,
    recoverable: isRecoverableFailure(kind),
  };
}

export function buildFailedHealthProbe(message: string): ProviderHealthProbe {
  const kind = classifyProviderFailure(message);
  return {
    available: false,
    status: kind,
    error: message,
    recoverable: isRecoverableFailure(kind),
  };
}
