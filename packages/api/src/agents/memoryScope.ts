export type MemoryBucket = { key: string; agentId?: string };

/** An update must not silently copy a private card into the shared bucket. */
export function existingMemoryScope(
  buckets: MemoryBucket[], key: string, requestedAgentId?: string,
): string | undefined {
  const matches = buckets.filter((row) => row.key === key);
  const scopes = new Set(matches.map((row) => row.agentId));
  return scopes.size === 1 ? matches[0].agentId : requestedAgentId;
}
