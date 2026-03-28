export function isQueueChannelAllowed(channelId: string, allowedChannelIds: Set<string>): boolean {
  return allowedChannelIds.size === 0 || allowedChannelIds.has(channelId);
}

export function isOpsChannelAllowed(
  channelId: string,
  statusChannelIds: Set<string>,
  providerAlertChannelIds: Set<string> = new Set(),
): boolean {
  const allowedChannelIds = new Set([
    ...statusChannelIds,
    ...providerAlertChannelIds,
  ]);
  return allowedChannelIds.size === 0 || allowedChannelIds.has(channelId);
}
