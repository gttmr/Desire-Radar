import { describe, expect, it } from 'vitest';
import { computeNextOccurrence } from '../src/services/reportSchedule.js';

describe('computeNextOccurrence', () => {
  it('returns same-day morning when current time is earlier', () => {
    const next = computeNextOccurrence({
      now: new Date('2026-03-16T21:30:00.000Z'),
      timeZone: 'Asia/Seoul',
      timeOfDay: '08:00'
    });

    expect(next.toISOString()).toBe('2026-03-16T23:00:00.000Z');
  });

  it('skips to next weekday when the target time has passed', () => {
    const next = computeNextOccurrence({
      now: new Date('2026-03-17T00:30:00.000Z'),
      timeZone: 'Asia/Seoul',
      timeOfDay: '08:00'
    });

    expect(next.toISOString()).toBe('2026-03-17T23:00:00.000Z');
  });

  it('skips weekends', () => {
    const next = computeNextOccurrence({
      now: new Date('2026-03-20T23:30:00.000Z'),
      timeZone: 'Asia/Seoul',
      timeOfDay: '08:00'
    });

    expect(next.toISOString()).toBe('2026-03-22T23:00:00.000Z');
  });
});
