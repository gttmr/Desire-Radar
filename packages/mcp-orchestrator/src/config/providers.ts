import { join } from 'node:path';
import { z } from 'zod';

export type ProviderTransportConfig = 'cli_exec' | 'external_injection';

export const providerEnvSchema = z.object({
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  CODEX_PATH: z.string().default('codex'),
  CLAUDE_PATH: z.string().default('claude'),
  GEMINI_PATH: z.string().default('gemini'),
  CODEX_TRANSPORT: z.string().default('cli_exec'),
  CLAUDE_TRANSPORT: z.string().default('cli_exec'),
  GEMINI_TRANSPORT: z.string().default('cli_exec'),
  ENABLED_PROVIDERS: z.string().default('codex,claude,gemini'),
  DEFAULT_PROVIDERS: z.string().default('codex,claude,gemini'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().default(60_000),
  PROVIDER_EXTERNAL_POLL_INTERVAL_MS: z.coerce.number().default(1_000),
  PROVIDER_SESSION_ROOT_DIR: z.string().default(''),
});

export type ProvidersConfig = z.infer<typeof providerEnvSchema> & {
  CODEX_TRANSPORT: ProviderTransportConfig;
  CLAUDE_TRANSPORT: ProviderTransportConfig;
  GEMINI_TRANSPORT: ProviderTransportConfig;
  enabledProviders: string[];
  defaultProviders: string[];
  providerSessionRootDir: string;
};

function splitProviderList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTransportMode(value: string): ProviderTransportConfig {
  const normalized = value.trim();
  if (normalized === 'external_inbox') {
    return 'external_injection';
  }
  if (normalized === 'external_injection') {
    return normalized;
  }
  return 'cli_exec';
}

export function loadProvidersConfig(
  env: NodeJS.ProcessEnv,
  defaultDataDir: string = 'data',
): ProvidersConfig {
  const parsed = providerEnvSchema.parse(env);
  const enabledProviders = splitProviderList(parsed.ENABLED_PROVIDERS);
  const enabledSet = new Set(enabledProviders);
  const requestedDefaults = splitProviderList(parsed.DEFAULT_PROVIDERS);
  const defaultProviders = requestedDefaults.filter((provider) => enabledSet.has(provider));
  return {
    ...parsed,
    OPENAI_BASE_URL: parsed.OPENAI_BASE_URL.trim() || 'https://api.openai.com/v1',
    CODEX_TRANSPORT: normalizeTransportMode(parsed.CODEX_TRANSPORT),
    CLAUDE_TRANSPORT: normalizeTransportMode(parsed.CLAUDE_TRANSPORT),
    GEMINI_TRANSPORT: normalizeTransportMode(parsed.GEMINI_TRANSPORT),
    enabledProviders,
    defaultProviders: defaultProviders.length > 0 ? defaultProviders : enabledProviders,
    providerSessionRootDir:
      parsed.PROVIDER_SESSION_ROOT_DIR.trim() || join(defaultDataDir, 'provider-sessions'),
  };
}
