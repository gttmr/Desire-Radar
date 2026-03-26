import { z } from 'zod';

export const providerHealthEnvSchema = z.object({
  PROVIDER_HEALTH_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(300),
  PROVIDER_REPAIR_COOLDOWN_SEC: z.coerce.number().int().positive().default(1800),
  PROVIDER_REPAIR_CODEX_COMMAND: z.string().optional(),
  PROVIDER_REPAIR_CLAUDE_COMMAND: z.string().optional(),
  PROVIDER_REPAIR_GEMINI_COMMAND: z.string().optional(),
});

export type ProviderHealthConfig = z.infer<typeof providerHealthEnvSchema> & {
  pollIntervalMs: number;
  repairCooldownMs: number;
  repairCommands: Partial<Record<string, string>>;
};

export function loadProviderHealthConfig(env: NodeJS.ProcessEnv): ProviderHealthConfig {
  const parsed = providerHealthEnvSchema.parse(env);
  return {
    ...parsed,
    pollIntervalMs: parsed.PROVIDER_HEALTH_POLL_INTERVAL_SEC * 1000,
    repairCooldownMs: parsed.PROVIDER_REPAIR_COOLDOWN_SEC * 1000,
    repairCommands: {
      ...(parsed.PROVIDER_REPAIR_CODEX_COMMAND
        ? { codex: parsed.PROVIDER_REPAIR_CODEX_COMMAND }
        : {}),
      ...(parsed.PROVIDER_REPAIR_CLAUDE_COMMAND
        ? { claude: parsed.PROVIDER_REPAIR_CLAUDE_COMMAND }
        : {}),
      ...(parsed.PROVIDER_REPAIR_GEMINI_COMMAND
        ? { gemini: parsed.PROVIDER_REPAIR_GEMINI_COMMAND }
        : {}),
    },
  };
}
