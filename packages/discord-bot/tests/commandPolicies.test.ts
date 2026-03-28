import { describe, expect, it } from 'vitest';
import { isOpsChannelAllowed, isQueueChannelAllowed } from '../src/bot/commandPolicies.js';

describe('commandPolicies', () => {
  it('allows commands everywhere when no allowlist is configured', () => {
    expect(isQueueChannelAllowed('channel-1', new Set())).toBe(true);
    expect(isOpsChannelAllowed('channel-1', new Set())).toBe(true);
  });

  it('restricts queue and ops commands to configured channels', () => {
    expect(isQueueChannelAllowed('queue-1', new Set(['queue-1']))).toBe(true);
    expect(isQueueChannelAllowed('other', new Set(['queue-1']))).toBe(false);
    expect(isOpsChannelAllowed('ops-1', new Set(['ops-1']))).toBe(true);
    expect(isOpsChannelAllowed('other', new Set(['ops-1']))).toBe(false);
  });

  it('allows ops commands in provider alert channels too', () => {
    expect(isOpsChannelAllowed('provider-1', new Set(['ops-1']), new Set(['provider-1']))).toBe(true);
    expect(isOpsChannelAllowed('other', new Set(['ops-1']), new Set(['provider-1']))).toBe(false);
  });
});
