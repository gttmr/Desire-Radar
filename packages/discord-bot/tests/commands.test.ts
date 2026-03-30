import { describe, expect, it } from 'vitest';
import { commandSchema } from '../src/bot/commandSchema.js';

describe('discord slash command surface', () => {
  it('registers the new top-level command namespaces', () => {
    const names = commandSchema.map((command) => command.name);
    expect(names).toEqual(['report', 'radar', 'run', 'queue', 'ops']);
  });

  it('does not register removed flat commands', () => {
    const names = new Set(commandSchema.map((command) => command.name));
    expect(names.has('ping')).toBe(false);
    expect(names.has('watchlist-add')).toBe(false);
    expect(names.has('report-summary')).toBe(false);
    expect(names.has('agent-status')).toBe(false);
    expect(names.has('voice-start')).toBe(false);
  });

  it('defines expected report and run subcommands', () => {
    const report = commandSchema.find((command) => command.name === 'report');
    const run = commandSchema.find((command) => command.name === 'run');
    expect(report?.options?.map((option) => option.name)).toEqual(['watchlist', 'run', 'detail', 'status']);
    expect(run?.options?.map((option) => option.name)).toEqual(['start', 'status', 'verdict', 'research', 'requests']);
  });
});
