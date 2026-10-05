function starterHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

/** A seed belongs to one new-chat navigation; prior picks make a large pool feel fresh. */
export function selectConversationStarters(
  pool: readonly string[],
  seed: string,
  count = 4,
  previous: readonly string[] = [],
): string[] {
  const recent = new Set(previous);
  const unique = new Set<string>();
  const ranked: Array<{ text: string; recent: boolean; rank: number }> = [];
  for (const value of pool) {
    const text = value.trim();
    if (!text || unique.has(text)) {
      continue;
    }
    unique.add(text);
    ranked.push({ text, recent: recent.has(text), rank: starterHash(`${seed}:${text}`) });
  }
  return ranked
    .sort((a, b) => Number(a.recent) - Number(b.recent) || a.rank - b.rank)
    .slice(0, Math.max(0, count))
    .map(({ text }) => text);
}

export function readPreviousStarters(key: string): string[] {
  try {
    const parsed: string[] = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberStarters(key: string, starters: string[]): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(starters));
  } catch {
    return;
  }
}
