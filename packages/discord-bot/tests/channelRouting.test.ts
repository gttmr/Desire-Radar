import { describe, expect, it } from 'vitest';
import {
  detectChannelRoutingWarnings,
  resolveProviderAlertChannelIds,
} from '../src/bot/channelRouting.js';

describe('channel routing', () => {
  it('prefers dedicated provider alert channels over status channels', () => {
    expect(
      resolveProviderAlertChannelIds({
        providerAlertChannelIds: new Set(['provider-alerts']),
        statusChannelIds: new Set(['ops-status']),
        defaultTextChannelId: 'default-text',
        dailyReportChannelId: 'daily-report',
      }),
    ).toEqual(['provider-alerts']);
  });

  it('falls back to status channels and then default text channel', () => {
    expect(
      resolveProviderAlertChannelIds({
        providerAlertChannelIds: new Set(),
        statusChannelIds: new Set(['ops-status']),
        defaultTextChannelId: 'default-text',
      }),
    ).toEqual(['ops-status']);

    expect(
      resolveProviderAlertChannelIds({
        providerAlertChannelIds: new Set(),
        statusChannelIds: new Set(),
        defaultTextChannelId: 'default-text',
      }),
    ).toEqual(['default-text']);
  });

  it('warns when daily report and alert/status channels overlap', () => {
    expect(
      detectChannelRoutingWarnings({
        providerAlertChannelIds: new Set(['daily-report']),
        statusChannelIds: new Set(['ops-status', 'daily-report']),
        defaultTextChannelId: 'default-text',
        dailyReportChannelId: 'daily-report',
      }),
    ).toEqual([
      'DISCORD_PROVIDER_ALERT_CHANNEL_IDS includes DISCORD_DAILY_REPORT_CHANNEL_ID; provider alerts and daily reports will share a channel.',
      'DISCORD_STATUS_CHANNEL_IDS includes DISCORD_DAILY_REPORT_CHANNEL_ID; status alerts and daily reports will share a channel.',
    ]);
  });
});
