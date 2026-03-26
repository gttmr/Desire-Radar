import { describe, expect, it } from 'vitest';
import {
  inferResearchIntent,
  inferSourceCapabilities,
  planResearchQuestion,
  supportsRequestKind,
} from '../src/pipeline/research-planner.js';

describe('research planner', () => {
  it('infers beneficiary intent for monetization questions', () => {
    expect(inferResearchIntent('Which public company benefits if Cursor keeps spreading?')).toBe(
      'beneficiary',
    );
  });

  it('maps pricing-like questions to channel-check style requests', () => {
    const plan = planResearchQuestion('Are there resale premiums or pricing changes in channel checks?', 'run_source');
    expect(plan.intent).toBe('pricing');
    expect(plan.requestedInputKind).toBe('channel_check');
    expect(plan.requiredFields).toContain('price_or_premium');
  });

  it('infers source capabilities from known pull sources when explicit metadata is missing', () => {
    const capabilities = inferSourceCapabilities('google_trends', {
      scheduled: true,
      last_run: null,
      cadence_seconds: 300,
      source_tier: 2,
      kind: 'pull',
      ingestion_mode: 'raw',
      runnable: true,
    });
    expect(capabilities).toContain('demand');
    expect(capabilities).toContain('ranking');
  });

  it('respects declared request kind support when present', () => {
    expect(
      supportsRequestKind(
        'custom_source',
        {
          scheduled: false,
          last_run: null,
          cadence_seconds: 0,
          source_tier: 2,
          kind: 'pull',
          ingestion_mode: 'raw',
          runnable: true,
          request_kinds_supported: ['run_source'],
        },
        'request_human_note',
      ),
    ).toBe(false);
  });
});
