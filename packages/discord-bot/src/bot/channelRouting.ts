export type ChannelRoutingConfig = {
  providerAlertChannelIds: Set<string>;
  statusChannelIds: Set<string>;
  defaultTextChannelId?: string;
  dailyReportChannelId?: string;
};

export function resolveProviderAlertChannelIds(config: ChannelRoutingConfig): string[] {
  if (config.providerAlertChannelIds.size > 0) {
    return [...config.providerAlertChannelIds];
  }
  if (config.statusChannelIds.size > 0) {
    return [...config.statusChannelIds];
  }
  if (config.defaultTextChannelId) {
    return [config.defaultTextChannelId];
  }
  return [];
}

export function detectChannelRoutingWarnings(config: ChannelRoutingConfig): string[] {
  const warnings: string[] = [];
  const dailyReportChannelId = config.dailyReportChannelId?.trim();
  if (!dailyReportChannelId) {
    return warnings;
  }

  if (config.providerAlertChannelIds.has(dailyReportChannelId)) {
    warnings.push(
      'DISCORD_PROVIDER_ALERT_CHANNEL_IDS includes DISCORD_DAILY_REPORT_CHANNEL_ID; provider alerts and daily reports will share a channel.',
    );
  }
  if (config.statusChannelIds.has(dailyReportChannelId)) {
    warnings.push(
      'DISCORD_STATUS_CHANNEL_IDS includes DISCORD_DAILY_REPORT_CHANNEL_ID; status alerts and daily reports will share a channel.',
    );
  }

  return warnings;
}
