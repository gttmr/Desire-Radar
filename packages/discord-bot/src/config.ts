import { config } from 'dotenv';
import { z } from 'zod';

config();

function parseIdSet(value?: string): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  DEFAULT_TEXT_CHANNEL_ID: z.string().optional(),
  DISCORD_DAILY_REPORT_CHANNEL_ID: z.string().optional(),
  DEFAULT_NOTIFY_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),
  HEALTH_PORT: z.coerce.number().int().positive().default(3000),
  CONFIG_STORE_PATH: z.string().default('data/guild-report-config.json'),
  COLLECTOR_BASE_URL: z.string().url().default('http://collector:5002'),
  ORCHESTRATOR_BASE_URL: z.string().url().default('http://mcp-orchestrator:5003'),
  DISCORD_HUMAN_INPUT_CHANNEL_IDS: z.string().optional().transform(parseIdSet),
  DISCORD_HUMAN_QUEUE_CHANNEL_IDS: z.string().optional().transform(parseIdSet),
  DISCORD_STATUS_CHANNEL_IDS: z.string().optional().transform(parseIdSet),
  DISCORD_PROVIDER_ALERT_CHANNEL_IDS: z.string().optional().transform(parseIdSet),
  ANALYSIS_BACKEND: z.enum(['orchestrator']).default('orchestrator'),
  PROVIDER_ALERT_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(300),
  REPORT_TIME_KST: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('08:00'),
  REPORT_TIMEZONE: z.string().default('Asia/Seoul')
});

export const env = envSchema.parse(process.env);
