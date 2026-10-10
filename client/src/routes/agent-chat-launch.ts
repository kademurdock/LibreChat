export type AgentChatLaunch = { agentId: string; routeKey: string; locationKey: string };

export function unambiguousAgentId(params: URLSearchParams): string | null {
  const values = params.getAll('agent_id');
  return values.length === 1 && /^agent_[A-Za-z0-9_-]{1,100}$/.test(values[0]) ? values[0] : null;
}

export function agentChatLaunch(
  conversationId: string,
  search: string,
  locationKey: string,
): AgentChatLaunch | null {
  const params = new URLSearchParams(search);
  const agentId = unambiguousAgentId(params);
  if (conversationId !== 'new' || !agentId) return null;
  return { agentId, routeKey: params.toString(), locationKey };
}

export function needsAgentChatLaunch(
  request: AgentChatLaunch | null,
  consumed: AgentChatLaunch | null,
  navigationType: 'POP' | 'PUSH' | 'REPLACE',
): boolean {
  if (!request) return false;
  if (!consumed || request.routeKey !== consumed.routeKey) return true;
  return navigationType !== 'REPLACE' && request.locationKey !== consumed.locationKey;
}
