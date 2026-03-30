import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config/index.js';
import { createRoutes } from './api/routes.js';
import { CandidateService } from './collector/candidate-service.js';
import { CollectorClient } from './collector/client.js';
import { ResearchService } from './collector/research-service.js';
import { SubmissionPoller } from './collector/submission-poller.js';
import { InvestmentContextProvider } from './investment/context-provider.js';
import { InvestmentDecisionStore } from './investment/decision-store.js';
import {
  ExternalArtifactDecisionRunner,
  ProviderExecDecisionRunner,
} from './investment/decision-runner.js';
import { EquityMapStore } from './investment/equity-map.js';
import { InvestmentEquityMapService } from './investment/equity-map-service.js';
import { EquityIdentityCacheStore } from './investment/identity-cache.js';
import { EquityIdentityResolver } from './investment/equity-identity.js';
import { InvestmentEquityIdentityService } from './investment/equity-identity-service.js';
import { KisInstrumentLookupClient } from './investment/kis-client.js';
import { InvestmentDecisionService } from './investment/decision-service.js';
import { AgentExecutor } from './orchestrator/agent-executor.js';
import { RunContextStore } from './orchestrator/run-context-store.js';
import { RunOrchestrator } from './orchestrator/run-orchestrator.js';
import { RunStore } from './orchestrator/run-store.js';
import { InvestmentDecisionPromptBuilder } from './investment/prompt-builder.js';
import { InvestmentReportFormatter } from './investment/report-formatter.js';
import { InvestmentSignalAssembler } from './investment/signal-assembler.js';
import { InvestableUniverseResolver } from './investment/universe-resolver.js';
import { DebateService } from './pipeline/debate.js';
import { ReportService } from './pipeline/report.js';
import { ResearchLoopService } from './pipeline/research-loop.js';
import { TriageService } from './pipeline/triage.js';
import { VerdictService } from './pipeline/verdict.js';
import { InvestmentIntakeService } from './investment/intake-service.js';
import { InvestmentMarkdownStore } from './investment/markdown-store.js';
import { PromptComposer } from './prompt/composer.js';
import { PromptLoader } from './prompt/loader.js';
import { ExecutionPolicyResolver } from './policy/execution.js';
import { ClaudeProvider } from './providers/claude.js';
import { CodexProvider } from './providers/codex.js';
import { GeminiProvider } from './providers/gemini.js';
import { OpenAIProvider } from './providers/openai.js';
import { ProviderHealthMonitor } from './providers/providerHealthMonitor.js';
import { ProviderRegistry } from './providers/registry.js';
import { SessionStore } from './sessions/session-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveAgentsDir(): string {
  const distAgentsDir = join(__dirname, 'agents');
  const srcAgentsDir = join(__dirname, '..', '..', 'src', 'agents');
  return existsSync(distAgentsDir) ? distAgentsDir : srcAgentsDir;
}

async function main(): Promise<void> {
  const config = loadConfig();
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

  const sessionStore = new SessionStore(
    config.runtime.DATA_DIR,
    config.providers.providerSessionRootDir,
  );
  const runStore = new RunStore(config.runtime.DATA_DIR);
  const contextStore = new RunContextStore();
  const promptLoader = new PromptLoader(resolveAgentsDir());
  const promptComposer = new PromptComposer(promptLoader);
  const executionPolicy = new ExecutionPolicyResolver(
    config.policies.agentExecution,
    config.policies.modelProfiles,
    config.providers.defaultProviders,
  );
  const agentExecutor = new AgentExecutor(
    registry,
    sessionStore,
    promptComposer,
    runStore,
    executionPolicy,
    {
      externalInjectionPollIntervalMs: config.providers.PROVIDER_EXTERNAL_POLL_INTERVAL_MS,
    },
  );

  const collectorClient = new CollectorClient(
    config.collector.COLLECTOR_BASE_URL,
    config.collector.COLLECTOR_TIMEOUT_MS,
  );
  const providerHealthMonitor = new ProviderHealthMonitor(registry, {
    pollIntervalMs: config.providerHealth.pollIntervalMs,
    repairCooldownMs: config.providerHealth.repairCooldownMs,
    repairCommands: config.providerHealth.repairCommands,
  });
  void providerHealthMonitor.start();
  const candidateService = new CandidateService(collectorClient);
  const researchService = new ResearchService(collectorClient);
  const submissionPoller = new SubmissionPoller(
    collectorClient,
    config.collector.COLLECTOR_RESEARCH_POLL_INTERVAL_MS,
    config.collector.COLLECTOR_RESEARCH_TIMEOUT_MS,
  );

  const triageService = new TriageService(config.policies.debate);
  const debateService = new DebateService(
    agentExecutor,
    runStore,
    contextStore,
    config.policies.debate,
  );
  const researchLoopService = new ResearchLoopService(
    researchService,
    submissionPoller,
    candidateService,
    contextStore,
    debateService,
    config.policies.research,
    config.policies.debate,
  );
  const verdictService = new VerdictService(
    agentExecutor,
    contextStore,
    config.policies.debate,
    runStore,
  );
  const reportService = new ReportService(agentExecutor, contextStore, runStore);
  const investmentMarkdownStore = new InvestmentMarkdownStore(config.runtime.DATA_DIR);
  const investmentIntakeService = new InvestmentIntakeService(investmentMarkdownStore);
  const investmentContextProvider = new InvestmentContextProvider(investmentMarkdownStore);
  const equityMapStore = new EquityMapStore(config.investmentDecision.equityMapPath);
  await equityMapStore.ensureExists();
  const equityIdentityCacheStore = new EquityIdentityCacheStore(
    config.investmentDecision.identityCachePath,
  );
  const kisLookupClient = new KisInstrumentLookupClient({
    appKey: config.investmentDecision.KIS_APP_KEY,
    appSecret: config.investmentDecision.KIS_APP_SECRET,
    baseUrl: config.investmentDecision.KIS_BASE_URL,
  });
  const equityIdentityResolver = new EquityIdentityResolver(
    equityMapStore,
    equityIdentityCacheStore,
    kisLookupClient,
  );
  const investmentUniverseResolver = new InvestableUniverseResolver(
    equityIdentityResolver,
    investmentContextProvider,
  );
  const investmentEquityMapService = new InvestmentEquityMapService(equityMapStore);
  const investmentEquityIdentityService = new InvestmentEquityIdentityService(
    equityIdentityResolver,
  );
  const investmentSignalAssembler = new InvestmentSignalAssembler(
    candidateService,
    investmentContextProvider,
    investmentUniverseResolver,
  );
  const investmentDecisionStore = new InvestmentDecisionStore(
    config.investmentDecision.runRootDir,
  );
  const investmentReportFormatter = new InvestmentReportFormatter();
  const investmentPromptBuilder = new InvestmentDecisionPromptBuilder(promptLoader);
  const investmentDecisionRunner =
    config.investmentDecision.INVESTMENT_DECISION_RUNNER === 'external_artifact'
      ? new ExternalArtifactDecisionRunner(
          config.investmentDecision.INVESTMENT_DECISION_TIMEOUT_MS,
          config.investmentDecision.INVESTMENT_DECISION_POLL_INTERVAL_MS,
        )
      : new ProviderExecDecisionRunner(
          registry,
          sessionStore,
          executionPolicy,
          investmentPromptBuilder,
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
  const investmentDecisionService = new InvestmentDecisionService(
    investmentDecisionStore,
    investmentSignalAssembler,
    investmentDecisionRunner,
    investmentReportFormatter,
    config.investmentDecision.INVESTMENT_DECISION_RUNNER,
    config.investmentDecision.INVESTMENT_DECISION_TIMEOUT_MS,
  );

  const orchestrator = new RunOrchestrator(agentExecutor, runStore, config.providers.defaultProviders, {
    sessionStore,
    contextStore,
    candidateService,
    triageService,
    debateService,
    researchLoopService,
    verdictService,
    reportService,
  });

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    createRoutes(
      orchestrator,
      sessionStore,
      registry,
      providerHealthMonitor,
      investmentIntakeService,
      investmentDecisionService,
      investmentEquityMapService,
      investmentEquityIdentityService,
    ),
  );

  app.listen(config.runtime.ORCHESTRATOR_PORT, config.runtime.ORCHESTRATOR_HOST, () => {
    console.log(
      `MCP Orchestrator listening on ${config.runtime.ORCHESTRATOR_HOST}:${config.runtime.ORCHESTRATOR_PORT}`,
    );
    console.log(`Enabled providers: ${config.providers.enabledProviders.join(', ') || '(none)'}`);
    console.log(`Default providers: ${config.providers.defaultProviders.join(', ')}`);
    console.log(`Provider health monitoring enabled for: ${registry.list().join(', ') || '(none)'}`);
    console.log(`Data dir: ${config.runtime.DATA_DIR}`);
    console.log(`Collector base URL: ${config.collector.COLLECTOR_BASE_URL}`);
    console.log(`Policy dir: ${config.policies.policyDir}`);
    console.log(
      `Investment decision runner: ${config.investmentDecision.INVESTMENT_DECISION_RUNNER}`,
    );
  });
}

main().catch((error) => {
  console.error('Failed to start MCP Orchestrator:', error);
  process.exit(1);
});
