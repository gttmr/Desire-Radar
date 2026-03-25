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
import { AgentExecutor } from './orchestrator/agent-executor.js';
import { RunContextStore } from './orchestrator/run-context-store.js';
import { RunOrchestrator } from './orchestrator/run-orchestrator.js';
import { RunStore } from './orchestrator/run-store.js';
import { DebateService } from './pipeline/debate.js';
import { ReportService } from './pipeline/report.js';
import { ResearchLoopService } from './pipeline/research-loop.js';
import { TriageService } from './pipeline/triage.js';
import { VerdictService } from './pipeline/verdict.js';
import { PromptComposer } from './prompt/composer.js';
import { PromptLoader } from './prompt/loader.js';
import { ExecutionPolicyResolver } from './policy/execution.js';
import { ClaudeProvider } from './providers/claude.js';
import { CodexProvider } from './providers/codex.js';
import { GeminiProvider } from './providers/gemini.js';
import { OpenAIProvider } from './providers/openai.js';
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

  const registry = new ProviderRegistry();
  if (config.providers.OPENAI_API_KEY) {
    registry.register(
      new OpenAIProvider(
        config.providers.OPENAI_API_KEY,
        config.providers.PROVIDER_TIMEOUT_MS,
        config.providers.OPENAI_BASE_URL,
      ),
    );
  }
  registry.register(
    new CodexProvider(config.providers.CODEX_PATH, config.providers.PROVIDER_TIMEOUT_MS),
  );
  registry.register(
    new ClaudeProvider(config.providers.CLAUDE_PATH, config.providers.PROVIDER_TIMEOUT_MS),
  );
  registry.register(
    new GeminiProvider(config.providers.GEMINI_PATH, config.providers.PROVIDER_TIMEOUT_MS),
  );

  const sessionStore = new SessionStore(config.runtime.DATA_DIR);
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
  );

  const collectorClient = new CollectorClient(
    config.collector.COLLECTOR_BASE_URL,
    config.collector.COLLECTOR_TIMEOUT_MS,
  );
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
  const reportService = new ReportService(agentExecutor, contextStore);

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
  app.use(createRoutes(orchestrator, sessionStore, registry));

  const available = await registry.getAvailable();
  const availableNames = available.map((provider) => provider.name);
  const allNames = registry.list();
  const unavailable = allNames.filter((name) => !availableNames.includes(name));

  app.listen(config.runtime.ORCHESTRATOR_PORT, config.runtime.ORCHESTRATOR_HOST, () => {
    console.log(
      `MCP Orchestrator listening on ${config.runtime.ORCHESTRATOR_HOST}:${config.runtime.ORCHESTRATOR_PORT}`,
    );
    console.log(`Default providers: ${config.providers.defaultProviders.join(', ')}`);
    console.log(`Available providers: ${availableNames.join(', ') || '(none)'}`);
    if (unavailable.length > 0) {
      console.warn(`Unavailable providers: ${unavailable.join(', ')}`);
    }
    console.log(`Data dir: ${config.runtime.DATA_DIR}`);
    console.log(`Collector base URL: ${config.collector.COLLECTOR_BASE_URL}`);
    console.log(`Policy dir: ${config.policies.policyDir}`);
  });
}

main().catch((error) => {
  console.error('Failed to start MCP Orchestrator:', error);
  process.exit(1);
});
