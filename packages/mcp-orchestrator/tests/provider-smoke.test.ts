import { describe, expect, it } from 'vitest';
import { isMockFallback } from '../src/tools/provider-smoke.js';

describe('provider smoke helpers', () => {
  it('detects provider mock fallback markers', () => {
    expect(isMockFallback('{"summary":"[claude-mock] failed"}', 'claude')).toBe(true);
    expect(isMockFallback('OK', 'claude')).toBe(false);
  });
});
