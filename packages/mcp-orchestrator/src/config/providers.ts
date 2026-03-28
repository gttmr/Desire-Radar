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
  DEFAULT_PROVIDERS: z.string().default('codex,claude,gemini'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().default(60_000),
  PROVIDER_EXTERNAL_POLL_INTERVAL_MS: z.coerce.number().default(1_000),
  PROVIDER_SESSION_ROOT_DIR: z.string().default(''),
});

export type ProvidersConfig = z.infer<typeof providerEnvSchema> & {
  CODEX_TRANSPORT: ProviderTransportConfig;
  CLAUDE_TRANSPORT: ProviderTransportConfig;
  GEMINI_TRANSPORT: ProviderTransportConfig;
  defaultProviders: string[];
  providerSessionRootDir: string;
};

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
  return {
    ...parsed,
    CODEX_TRANSPORT: normalizeTransportMode(parsed.CODEX_TRANSPORT),
    CLAUDE_TRANSPORT: normalizeTransportMode(parsed.CLAUDE_TRANSPORT),
    GEMINI_TRANSPORT: normalizeTransportMode(parsed.GEMINI_TRANSPORT),
    defaultProviders: parsed.DEFAULT_PROVIDERS
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    providerSessionRootDir:
      parsed.PROVIDER_SESSION_ROOT_DIR.trim() || join(defaultDataDir, 'provider-sessions'),
  };
}
