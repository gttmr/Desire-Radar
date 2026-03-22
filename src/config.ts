import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  DEFAULT_TEXT_CHANNEL_ID: z.string().optional(),
  DEFAULT_NOTIFY_INTERVAL_SEC: z.coerce.number().int().positive().default(3600),
  ACTION_TTL_SEC: z.coerce.number().int().positive().default(600),
  HEALTH_PORT: z.coerce.number().int().positive().default(3000),
  STT_PROVIDER: z.enum(['mock']).default('mock'),
  CONFIG_STORE_PATH: z.string().default('data/guild-report-config.json'),
  PREDICTOR_BASE_URL: z.string().url().default('http://predictor:5001'),
  REPORT_TIME_KST: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('08:00'),
  REPORT_TIMEZONE: z.string().default('Asia/Seoul')
});

export const env = envSchema.parse(process.env);
