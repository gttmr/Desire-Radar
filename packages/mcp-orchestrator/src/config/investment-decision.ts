import { join } from 'node:path';
import { z } from 'zod';

function parseBooleanEnv(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function splitProviders(value: string): string[] {
  return value
    .split(',')
    .map((provider) => provider.trim())
    .filter(Boolean)
    .filter((provider, index, providers) => providers.indexOf(provider) === index);
}

const investmentDecisionEnvSchema = z.object({
  INVESTMENT_DECISION_RUNNER: z
    .enum(['provider_exec', 'external_artifact'])
    .default('provider_exec'),
  INVESTMENT_DECISION_RUN_ROOT: z.string().default(''),
  INVESTMENT_DECISION_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  INVESTMENT_DECISION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  INVESTMENT_EQUITY_MAP_PATH: z.string().default(''),
  INVESTMENT_DECISION_PREPROCESS_ENABLED: z.string().default('true'),
  INVESTMENT_DECISION_PREPROCESS_PROVIDERS: z.string().default(''),
  INVESTMENT_DECISION_PREPROCESS_MODEL_PROFILE: z
    .enum(['cheap', 'balanced', 'premium'])
    .default('cheap'),
  INVESTMENT_DECISION_PREPROCESS_TOOL_POLICY: z
    .enum(['default', 'none'])
    .default('none'),
  INVESTMENT_DECISION_PREPROCESS_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  INVESTMENT_DECISION_FINAL_PROVIDERS: z.string().default(''),
  INVESTMENT_DECISION_FINAL_MODEL_PROFILE: z
    .enum(['cheap', 'balanced', 'premium'])
    .default('premium'),
  INVESTMENT_DECISION_FINAL_TOOL_POLICY: z
    .enum(['default', 'none'])
    .default('default'),
  INVESTMENT_DECISION_FINAL_TIMEOUT_MS: z.coerce.number().int().positive().default(420_000),
});

export type InvestmentDecisionConfig = z.infer<typeof investmentDecisionEnvSchema> & {
  runRootDir: string;
  equityMapPath: string;
  preprocessEnabled: boolean;
  preprocessProviders: string[];
  finalProviders: string[];
};

export function loadInvestmentDecisionConfig(
  env: NodeJS.ProcessEnv,
  defaultDataDir = 'data',
): InvestmentDecisionConfig {
  const parsed = investmentDecisionEnvSchema.parse(env);
  const investmentModuleDir = join(defaultDataDir, 'investment-module');
  return {
    ...parsed,
    preprocessEnabled: parseBooleanEnv(parsed.INVESTMENT_DECISION_PREPROCESS_ENABLED, true),
    preprocessProviders: splitProviders(parsed.INVESTMENT_DECISION_PREPROCESS_PROVIDERS),
    finalProviders: splitProviders(parsed.INVESTMENT_DECISION_FINAL_PROVIDERS),
    runRootDir:
      parsed.INVESTMENT_DECISION_RUN_ROOT.trim() ||
      join(defaultDataDir, 'investment-decisions', 'runs'),
    equityMapPath:
      parsed.INVESTMENT_EQUITY_MAP_PATH.trim() ||
      join(investmentModuleDir, 'equity-map.json'),
  };
}
