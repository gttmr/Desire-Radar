import { env } from './config.js';
import { createApiServer } from './api/server.js';
import { BotApp } from './bot/botApp.js';
import { ActionOrchestrator } from './services/actionOrchestrator.js';
import { GuildConfigStore } from './services/guildConfigStore.js';
import { JobEngine } from './services/jobEngine.js';
import { NotificationScheduler } from './services/notificationScheduler.js';
import { PredictorClient } from './services/predictorClient.js';
import { ReportService } from './services/reportService.js';

async function bootstrap() {
  const jobEngine = new JobEngine();
  const orchestrator = new ActionOrchestrator(env.ACTION_TTL_SEC * 1000, jobEngine);
  const store = new GuildConfigStore(env.CONFIG_STORE_PATH);
  const predictor = new PredictorClient(env.PREDICTOR_BASE_URL);
  const reports = new ReportService(store, predictor, env.REPORT_TIMEZONE);
  const scheduler = new NotificationScheduler(env.REPORT_TIMEZONE, env.REPORT_TIME_KST);
  const bot = new BotApp(orchestrator, scheduler, reports);

  await bot.start();

  const app = createApiServer(bot);
  const server = app.listen(env.HEALTH_PORT, () => {
    console.log(`API listening on ${env.HEALTH_PORT}`);
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
