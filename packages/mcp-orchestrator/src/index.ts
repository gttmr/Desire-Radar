import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { ProviderRegistry } from './providers/registry.js';
import { OpenAIProvider } from './providers/openai.js';
import { CodexProvider } from './providers/codex.js';
import { ClaudeProvider } from './providers/claude.js';
import { GeminiProvider } from './providers/gemini.js';
import { SessionStore } from './sessions/session-store.js';
import { RunStore } from './orchestrator/run-store.js';
import { PromptLoader } from './prompt/loader.js';
import { PromptComposer } from './prompt/composer.js';
import { AgentExecutor } from './orchestrator/agent-executor.js';
import { RunOrchestrator } from './orchestrator/run-orchestrator.js';
import { createRoutes } from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const config = loadConfig();

  // Provider registry — API providers first, CLI providers as optional fallback
  const registry = new ProviderRegistry();
  if (config.OPENAI_API_KEY) {
    registry.register(
      new OpenAIProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL, config.PROVIDER_TIMEOUT_MS, config.OPENAI_BASE_URL),
    );
  }
  registry.register(new CodexProvider(config.CODEX_PATH, config.PROVIDER_TIMEOUT_MS));
  registry.register(new ClaudeProvider(config.CLAUDE_PATH, config.PROVIDER_TIMEOUT_MS));
  registry.register(new GeminiProvider(config.GEMINI_PATH, config.PROVIDER_TIMEOUT_MS));

  // Stores
  const sessionStore = new SessionStore(config.DATA_DIR);
  const runStore = new RunStore(config.DATA_DIR);

  // Prompt system — agents are .md files copied to /app/src/agents in Docker
  // In dev they're relative to source; check both locations.
  const distAgentsDir = join(__dirname, 'agents');
  const srcAgentsDir = join(__dirname, '..', '..', 'src', 'agents');
  const { existsSync } = await import('node:fs');
  const agentsDir = existsSync(distAgentsDir) ? distAgentsDir : srcAgentsDir;
  const promptLoader = new PromptLoader(agentsDir);
  const promptComposer = new PromptComposer(promptLoader);

  // Orchestrator
  const defaultProviders = config.DEFAULT_PROVIDERS.split(',').map((p) => p.trim());
  const agentExecutor = new AgentExecutor(registry, sessionStore, promptComposer, runStore);
  const orchestrator = new RunOrchestrator(agentExecutor, runStore, defaultProviders);

  // Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createRoutes(orchestrator, sessionStore, registry));

  // Probe provider health on startup
  const available = await registry.getAvailable();
  const availableNames = available.map((p) => p.name);
  const allNames = registry.list();
  const unavailable = allNames.filter((n) => !availableNames.includes(n));

  app.listen(config.ORCHESTRATOR_PORT, config.ORCHESTRATOR_HOST, () => {
    console.log(
      `MCP Orchestrator listening on ${config.ORCHESTRATOR_HOST}:${config.ORCHESTRATOR_PORT}`,
    );
    console.log(`Default providers: ${defaultProviders.join(', ')}`);
    console.log(`Available providers: ${availableNames.join(', ') || '(none)'}`);
    if (unavailable.length > 0) {
      console.warn(`Unavailable providers: ${unavailable.join(', ')} — check host CLI login and volume mounts`);
    }
    console.log(`Data dir: ${config.DATA_DIR}`);
    console.log(`Agents dir: ${agentsDir}`);
    console.log(`HOME: ${process.env.HOME}`);
  });
}

main().catch((err) => {
  console.error('Failed to start MCP Orchestrator:', err);
  process.exit(1);
});
