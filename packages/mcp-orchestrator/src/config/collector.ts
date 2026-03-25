import { z } from 'zod';

export const collectorEnvSchema = z.object({
  COLLECTOR_BASE_URL: z.string().default('http://collector:5002'),
  COLLECTOR_TIMEOUT_MS: z.coerce.number().default(20_000),
  COLLECTOR_RESEARCH_POLL_INTERVAL_MS: z.coerce.number().default(2_000),
  COLLECTOR_RESEARCH_TIMEOUT_MS: z.coerce.number().default(20_000),
});

export type CollectorConfig = z.infer<typeof collectorEnvSchema>;

export function loadCollectorConfig(env: NodeJS.ProcessEnv): CollectorConfig {
  return collectorEnvSchema.parse(env);
}
