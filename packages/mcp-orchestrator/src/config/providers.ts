import { z } from 'zod';

export const providerEnvSchema = z.object({
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  CODEX_PATH: z.string().default('codex'),
  CLAUDE_PATH: z.string().default('claude'),
  GEMINI_PATH: z.string().default('gemini'),
  DEFAULT_PROVIDERS: z.string().default('codex,claude,gemini'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().default(60_000),
});

export type ProvidersConfig = z.infer<typeof providerEnvSchema> & {
  defaultProviders: string[];
};

export function loadProvidersConfig(env: NodeJS.ProcessEnv): ProvidersConfig {
  const parsed = providerEnvSchema.parse(env);
  return {
    ...parsed,
    defaultProviders: parsed.DEFAULT_PROVIDERS
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
}
