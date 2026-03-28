import { describe, expect, it } from 'vitest';
import { commandJson } from '../src/bot/commands.js';

describe('discord slash command surface', () => {
  it('registers the new top-level command namespaces', () => {
    const names = commandJson.map((command) => command.name);
    expect(names).toEqual(['report', 'radar', 'run', 'queue', 'ops']);
  });

  it('does not register removed flat commands', () => {
    const names = new Set(commandJson.map((command) => command.name));
    expect(names.has('ping')).toBe(false);
    expect(names.has('watchlist-add')).toBe(false);
    expect(names.has('report-summary')).toBe(false);
    expect(names.has('agent-status')).toBe(false);
    expect(names.has('voice-start')).toBe(false);
  });

  it('defines expected report and run subcommands', () => {
    const report = commandJson.find((command) => command.name === 'report');
    const run = commandJson.find((command) => command.name === 'run');
    expect(report?.options?.map((option) => option.name)).toEqual(['watchlist', 'run', 'status']);
    expect(run?.options?.map((option) => option.name)).toEqual(['start', 'status', 'verdict', 'research', 'requests']);
  });
});
