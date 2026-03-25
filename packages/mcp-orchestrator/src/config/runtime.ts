import { z } from 'zod';

export const runtimeEnvSchema = z.object({
  ORCHESTRATOR_PORT: z.coerce.number().default(5003),
  ORCHESTRATOR_HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('data'),
});

export type RuntimeConfig = z.infer<typeof runtimeEnvSchema>;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return runtimeEnvSchema.parse(env);
}
