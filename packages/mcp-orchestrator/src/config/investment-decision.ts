import { join } from 'node:path';
import { z } from 'zod';

const investmentDecisionEnvSchema = z.object({
  INVESTMENT_DECISION_RUNNER: z
    .enum(['provider_exec', 'external_artifact'])
    .default('provider_exec'),
  INVESTMENT_DECISION_RUN_ROOT: z.string().default(''),
  INVESTMENT_DECISION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  INVESTMENT_DECISION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  INVESTMENT_EQUITY_MAP_PATH: z.string().default(''),
});

export type InvestmentDecisionConfig = z.infer<typeof investmentDecisionEnvSchema> & {
  runRootDir: string;
  equityMapPath: string;
};

export function loadInvestmentDecisionConfig(
  env: NodeJS.ProcessEnv,
  defaultDataDir = 'data',
): InvestmentDecisionConfig {
  const parsed = investmentDecisionEnvSchema.parse(env);
  const investmentModuleDir = join(defaultDataDir, 'investment-module');
  return {
    ...parsed,
    runRootDir:
      parsed.INVESTMENT_DECISION_RUN_ROOT.trim() ||
      join(defaultDataDir, 'investment-decisions', 'runs'),
    equityMapPath:
      parsed.INVESTMENT_EQUITY_MAP_PATH.trim() ||
      join(investmentModuleDir, 'equity-map.json'),
  };
}
