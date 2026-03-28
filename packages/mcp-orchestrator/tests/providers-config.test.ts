import { describe, expect, it } from 'vitest';
import { loadProvidersConfig } from '../src/config/providers.js';

describe('loadProvidersConfig', () => {
  it('filters default providers to the enabled provider set', () => {
    const config = loadProvidersConfig(
      {
        ENABLED_PROVIDERS: 'claude,gemini',
        DEFAULT_PROVIDERS: 'codex,claude,gemini',
      },
      'data',
    );

    expect(config.enabledProviders).toEqual(['claude', 'gemini']);
    expect(config.defaultProviders).toEqual(['claude', 'gemini']);
  });

  it('falls back to enabled providers when every requested default is disabled', () => {
    const config = loadProvidersConfig(
      {
        ENABLED_PROVIDERS: 'claude',
        DEFAULT_PROVIDERS: 'codex,gemini',
      },
      'data',
    );

    expect(config.enabledProviders).toEqual(['claude']);
    expect(config.defaultProviders).toEqual(['claude']);
  });
});
