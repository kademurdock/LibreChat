interface MemoryAudience {
  user?: { id?: string };
  kadeOnBehalfOf?: { id?: string };
  kadeOnBehalfOfUnresolved?: boolean;
}

export function ownsPrivateMemory(request: MemoryAudience): boolean {
  if (!request.user?.id || request.kadeOnBehalfOfUnresolved === true) return false;
  const actingFor = request.kadeOnBehalfOf?.id;
  return !actingFor || String(actingFor) === String(request.user.id);
}
