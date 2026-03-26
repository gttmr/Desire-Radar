import { describe, expect, it } from 'vitest';
import { isDegradedResult } from '../src/tools/provider-smoke.js';

describe('provider smoke helpers', () => {
  it('detects degraded provider executions', () => {
    expect(isDegradedResult('degraded')).toBe(true);
    expect(isDegradedResult('completed')).toBe(false);
  });
});
