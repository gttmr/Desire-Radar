import express from 'express';
import type { BotApp } from '../bot/botApp.js';
import { env } from '../config.js';

export function createApiServer(bot: BotApp) {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const health = await bot.health();
    res.json({ ok: true, ...health });
  });

  app.post('/api/reports/run', async (req, res) => {
    const guildId = typeof req.body?.guildId === 'string' ? req.body.guildId.trim() : '';
    if (!guildId) {
      res.status(400).json({ ok: false, error: 'guildId is required' });
      return;
    }

    const fallbackChannelId =
      typeof req.body?.channelId === 'string' && req.body.channelId.trim()
        ? req.body.channelId.trim()
        : env.DISCORD_DAILY_REPORT_CHANNEL_ID ?? env.DEFAULT_TEXT_CHANNEL_ID;
    if (!fallbackChannelId) {
      res.status(400).json({ ok: false, error: 'channelId or DISCORD_DAILY_REPORT_CHANNEL_ID or DEFAULT_TEXT_CHANNEL_ID is required' });
      return;
    }

    try {
      const detail = req.body?.detail === 'full' ? 'full' : 'summary';
      const dispatch = await bot.runReport(guildId, fallbackChannelId, 'api', detail);
      res.json({
        ok: true,
        channelId: dispatch.channelId,
        tickers: dispatch.config.tickers,
        generatedAt: dispatch.response.generatedAt,
        detail: dispatch.response.detail,
        summary: dispatch.response.summary
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'unknown error'
      });
    }
  });

  app.post('/api/jobs/run', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      res.status(400).json({ ok: false, error: 'text is required' });
      return;
    }

    const action = bot.orchestrator.createPending({
      transcript: { text, durationMs: 0 },
      userId: 'api-user',
      guildId: 'api-guild',
      channelId: env.DEFAULT_TEXT_CHANNEL_ID ?? 'unknown-channel'
    });

    const outcome = await bot.orchestrator.execute(action.id);
    if (outcome.status !== 'executed') {
      res.status(500).json({ ok: false, outcome: outcome.status });
      return;
    }

    res.json({ ok: true, result: outcome.result });
  });

  return app;
}
