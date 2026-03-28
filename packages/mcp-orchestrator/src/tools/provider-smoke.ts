import { loadConfig } from '../config/index.js';
import { ClaudeProvider } from '../providers/claude.js';
import { CodexProvider } from '../providers/codex.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIProvider } from '../providers/openai.js';
import { ProviderRegistry } from '../providers/registry.js';

type ProviderSmokeResult = {
  provider: string;
  healthAvailable: boolean;
  healthStatus?: string;
  authStatus?: string;
  executeReadinessStatus?: string;
  readyForExecution?: boolean;
  healthError?: string;
  healthRecoverable?: boolean;
  executeOk: boolean;
  executeStatus: 'completed' | 'degraded';
  degradedKind?: string;
  degradedMessage?: string;
  durationMs: number;
  preview: string;
};

export function isDegradedResult(status: 'completed' | 'degraded'): boolean {
  return status === 'degraded';
}

function previewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function createRegistry(): ProviderRegistry {
  const config = loadConfig();
  const registry = new ProviderRegistry();

  registry.register(
    new CodexProvider(config.providers.CODEX_PATH, config.providers.PROVIDER_TIMEOUT_MS),
  );
  registry.register(
    new ClaudeProvider(config.providers.CLAUDE_PATH, config.providers.PROVIDER_TIMEOUT_MS),
  );
  registry.register(
    new GeminiProvider(config.providers.GEMINI_PATH, config.providers.PROVIDER_TIMEOUT_MS),
  );
  if (config.providers.OPENAI_API_KEY) {
    registry.register(
      new OpenAIProvider(
        config.providers.OPENAI_API_KEY,
        config.providers.PROVIDER_TIMEOUT_MS,
        config.providers.OPENAI_BASE_URL,
      ),
    );
  }

  return registry;
}

async function smokeProvider(provider: string, registry: ProviderRegistry): Promise<ProviderSmokeResult> {
  const adapter = registry.get(provider);
  if (!adapter) {
    return {
      provider,
      healthAvailable: false,
      healthStatus: 'unknown',
      healthError: 'provider not registered',
      healthRecoverable: false,
      executeOk: false,
      executeStatus: 'degraded',
      durationMs: 0,
      preview: '',
    };
  }

  const health = adapter.probeHealth
    ? await adapter.probeHealth()
    : { available: await adapter.health() };

  if (!health.available) {
    return {
      provider,
      healthAvailable: false,
      healthStatus: health.status,
      authStatus: health.auth_status,
      executeReadinessStatus: health.execute_status,
      readyForExecution: health.ready_for_execution,
      healthError: health.error_summary ?? health.error,
      healthRecoverable: health.recoverable,
      executeOk: false,
      executeStatus: 'degraded',
      durationMs: 0,
      preview: previewText(health.error_summary ?? health.error ?? ''),
    };
  }

  const startedAt = Date.now();
  const result = await adapter.execute({
    prompt: 'Reply with exactly OK',
    phase: 'debate',
    agentName: 'provider_smoke',
    modelProfile: 'cheap',
    responseFormat: 'text',
    timeoutMs: 30_000,
  });
  const degraded = isDegradedResult(result.status);

  return {
    provider,
    healthAvailable: health.available,
    healthStatus: health.status,
    authStatus: health.auth_status,
    executeReadinessStatus: health.execute_status,
    readyForExecution: health.ready_for_execution,
    healthError: health.error_summary ?? health.error,
    healthRecoverable: health.recoverable,
    executeOk: !degraded,
    executeStatus: result.status,
    degradedKind: result.degraded_kind,
    degradedMessage: result.degraded_message,
    durationMs: Date.now() - startedAt,
    preview: previewText(result.text || result.degraded_message || ''),
  };
}

async function main(): Promise<void> {
  const registry = createRegistry();
  const results = await Promise.all(registry.list().map((provider) => smokeProvider(provider, registry)));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));

  if (results.some((result) => !result.healthAvailable || !result.executeOk)) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[provider-smoke] failed: ${message}`);
  process.exitCode = 1;
});
