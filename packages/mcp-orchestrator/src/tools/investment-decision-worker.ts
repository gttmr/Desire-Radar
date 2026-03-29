import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { ExecutionPolicyResolver } from '../policy/execution.js';
import { ClaudeProvider } from '../providers/claude.js';
import { CodexProvider } from '../providers/codex.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIProvider } from '../providers/openai.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SessionStore } from '../sessions/session-store.js';
import { ProviderExecDecisionRunner } from '../investment/decision-runner.js';
import { InvestmentDecisionStore } from '../investment/decision-store.js';
import { ExternalInvestmentDecisionWorker } from '../investment/external-worker.js';
import { InvestmentDecisionPromptBuilder } from '../investment/prompt-builder.js';
import { InvestmentReportFormatter } from '../investment/report-formatter.js';
import { PromptLoader } from '../prompt/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveAgentsDir(): string {
  const distAgentsDir = join(__dirname, '..', 'agents');
  const srcAgentsDir = join(__dirname, '..', '..', 'src', 'agents');
  return existsSync(distAgentsDir) ? distAgentsDir : srcAgentsDir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createProviderRegistry(config: ReturnType<typeof loadConfig>): Promise<ProviderRegistry> {
  const enabledProviders = new Set(config.providers.enabledProviders);
  const registry = new ProviderRegistry();
  if (enabledProviders.has('openai') && config.providers.OPENAI_API_KEY) {
    registry.register(
      new OpenAIProvider(
        config.providers.OPENAI_API_KEY,
        config.providers.PROVIDER_TIMEOUT_MS,
        config.providers.OPENAI_BASE_URL,
      ),
    );
  }
  if (enabledProviders.has('codex')) {
    registry.register(
      new CodexProvider(config.providers.CODEX_PATH, config.providers.PROVIDER_TIMEOUT_MS, {
        defaultTransportMode: config.providers.CODEX_TRANSPORT,
      }),
    );
  }
  if (enabledProviders.has('claude')) {
    registry.register(
      new ClaudeProvider(config.providers.CLAUDE_PATH, config.providers.PROVIDER_TIMEOUT_MS, {
        defaultTransportMode: config.providers.CLAUDE_TRANSPORT,
      }),
    );
  }
  if (enabledProviders.has('gemini')) {
    registry.register(
      new GeminiProvider(config.providers.GEMINI_PATH, config.providers.PROVIDER_TIMEOUT_MS, {
        defaultTransportMode: config.providers.GEMINI_TRANSPORT,
      }),
    );
  }
  return registry;
}

async function processOnce(worker: ExternalInvestmentDecisionWorker): Promise<void> {
  const summary = await worker.processPending();
  console.log(
    `[investment-decision-worker] processed=${summary.processed} completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped}`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const watchMode = process.argv.includes('--watch');
  const intervalMs = config.investmentDecision.INVESTMENT_DECISION_POLL_INTERVAL_MS;

  const registry = await createProviderRegistry(config);
  const sessionStore = new SessionStore(
    config.runtime.DATA_DIR,
    config.providers.providerSessionRootDir,
  );
  const policyResolver = new ExecutionPolicyResolver(
    config.policies.agentExecution,
    config.policies.modelProfiles,
    config.providers.defaultProviders,
  );
  const promptLoader = new PromptLoader(resolveAgentsDir());
  const promptBuilder = new InvestmentDecisionPromptBuilder(promptLoader);
  const providerRunner = new ProviderExecDecisionRunner(
    registry,
    sessionStore,
    policyResolver,
    promptBuilder,
    config.investmentDecision.INVESTMENT_DECISION_TIMEOUT_MS,
    {
      enabled: config.investmentDecision.preprocessEnabled,
      providers: config.investmentDecision.preprocessProviders,
      modelProfile: config.investmentDecision.INVESTMENT_DECISION_PREPROCESS_MODEL_PROFILE,
      toolPolicy: config.investmentDecision.INVESTMENT_DECISION_PREPROCESS_TOOL_POLICY,
      timeoutMs: config.investmentDecision.INVESTMENT_DECISION_PREPROCESS_TIMEOUT_MS,
    },
    {
      providers: config.investmentDecision.finalProviders,
      modelProfile: config.investmentDecision.INVESTMENT_DECISION_FINAL_MODEL_PROFILE,
      toolPolicy: config.investmentDecision.INVESTMENT_DECISION_FINAL_TOOL_POLICY,
      timeoutMs: config.investmentDecision.INVESTMENT_DECISION_FINAL_TIMEOUT_MS,
    },
  );
  const store = new InvestmentDecisionStore(config.investmentDecision.runRootDir);
  const formatter = new InvestmentReportFormatter();
  const worker = new ExternalInvestmentDecisionWorker(store, providerRunner, formatter);

  console.log(
    `[investment-decision-worker] run_root=${config.investmentDecision.runRootDir} watch=${watchMode} interval_ms=${intervalMs}`,
  );
  if (config.investmentDecision.INVESTMENT_DECISION_RUNNER !== 'external_artifact') {
    console.log(
      '[investment-decision-worker] warning: INVESTMENT_DECISION_RUNNER is not external_artifact; pending external runs will still be processed if they exist.',
    );
  }

  if (!watchMode) {
    await processOnce(worker);
    return;
  }

  for (;;) {
    await processOnce(worker);
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error('[investment-decision-worker] fatal:', error);
  process.exit(1);
});
