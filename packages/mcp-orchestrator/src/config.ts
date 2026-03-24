import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  ORCHESTRATOR_PORT: z.coerce.number().default(5003),
  ORCHESTRATOR_HOST: z.string().default('0.0.0.0'),
  COLLECTOR_BASE_URL: z.string().default('http://collector:5002'),
  DATA_DIR: z.string().default('data'),
  // OpenAI API provider
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  // CLI providers (optional, used when available)
  CODEX_PATH: z.string().default('codex'),
  CLAUDE_PATH: z.string().default('claude'),
  GEMINI_PATH: z.string().default('gemini'),
  // Default provider list — openai first, CLI providers as fallback
  DEFAULT_PROVIDERS: z.string().default('openai'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().default(60_000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  return envSchema.parse(process.env);
}
