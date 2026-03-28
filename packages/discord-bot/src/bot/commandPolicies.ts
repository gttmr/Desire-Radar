export function isQueueChannelAllowed(channelId: string, allowedChannelIds: Set<string>): boolean {
  return allowedChannelIds.size === 0 || allowedChannelIds.has(channelId);
}

export function isOpsChannelAllowed(channelId: string, allowedChannelIds: Set<string>): boolean {
  return allowedChannelIds.size === 0 || allowedChannelIds.has(channelId);
}
