import { env } from './config.js';
import { createApiServer } from './api/server.js';
import { BotApp } from './bot/botApp.js';
import { createAnalysisGateway } from './services/analysisGateway.js';
import { CollectorClient } from './services/collectorClient.js';
import { GuildConfigStore } from './services/guildConfigStore.js';
import { NotificationScheduler } from './services/notificationScheduler.js';
import { OrchestratorClient } from './services/orchestratorClient.js';
import { ProviderHealthMonitor } from './services/providerHealthMonitor.js';
import { ReportService } from './services/reportService.js';

async function bootstrap() {
  const store = new GuildConfigStore(env.CONFIG_STORE_PATH);

  const collector = new CollectorClient(env.COLLECTOR_BASE_URL);
  const mcpOrchestrator = new OrchestratorClient(env.ORCHESTRATOR_BASE_URL);

  const gateway = createAnalysisGateway(env.ANALYSIS_BACKEND, mcpOrchestrator, collector);
  const reports = new ReportService(store, gateway, env.REPORT_TIMEZONE);
  const scheduler = new NotificationScheduler(env.REPORT_TIMEZONE, env.REPORT_TIME_KST);
  const providerHealthMonitor = new ProviderHealthMonitor(mcpOrchestrator, {
    pollIntervalMs: env.PROVIDER_ALERT_POLL_INTERVAL_SEC * 1000,
  });
  const bot = new BotApp(scheduler, reports, collector, mcpOrchestrator, providerHealthMonitor);

  await bot.start();

  const app = createApiServer(bot);
  const server = app.listen(env.HEALTH_PORT, () => {
    console.log(`API listening on ${env.HEALTH_PORT}`);
    console.log(`Analysis backend: ${env.ANALYSIS_BACKEND}`);
  });

  const shutdown = async () => {
    server.close();
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void bootstrap();
