export interface Reflection {
  summary: string;
  take?: string;
  thread?: string;
  learned?: string;
  curious?: string;
  verdicts?: string;
}

type ReflectionField = keyof Reflection;

const LABELS: { [label: string]: ReflectionField } = {
  SUMMARY: 'summary',
  'MY TAKE': 'take',
  'CARRIED THREAD': 'thread',
  "WHAT I'VE LEARNED FROM THEM": 'learned',
  'WHAT IVE LEARNED FROM THEM': 'learned',
  'CURIOUS ABOUT': 'curious',
  VERDICTS: 'verdicts',
};

const SENTINELS: Partial<{ [field in ReflectionField]: RegExp }> = {
  take: /^no read yet\.?$/i,
  thread: /^nothing carried\.?$/i,
  learned: /^nothing yet\.?$/i,
  curious: /^nothing in particular\.?$/i,
  verdicts: /^no verdicts\.?$/i,
};

/** Missing SUMMARY must never turn a private take into shareable factual memory. */
export function parseReflection(text: string): Reflection | null {
  const sections: Partial<{ [field in ReflectionField]: string[] }> = {};
  let current: ReflectionField | undefined;
  for (const line of text.split('\n')) {
    const match = line.match(
      /^\s*(?:#{1,3}\s+)?(?:\*\*)?(SUMMARY|MY TAKE|CARRIED THREAD|WHAT I['’]?VE LEARNED FROM THEM|CURIOUS ABOUT|VERDICTS)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i,
    );
    if (match) {
      current = LABELS[match[1].toUpperCase().replace('’', "'")];
      sections[current] ??= [];
      if (match[2].trim()) sections[current]?.push(match[2]);
      continue;
    }
    if (current) sections[current]?.push(line);
  }
  const summary = sections.summary?.join('\n').trim();
  if (!summary) return null;
  const result: Reflection = { summary: summary.slice(0, 4000) };
  for (const field of ['take', 'thread', 'learned', 'curious', 'verdicts'] as const) {
    if (!sections[field]) continue;
    const value = sections[field].join('\n').trim();
    // A missing/empty section is a format error; only a sentinel intentionally clears it.
    if (value) result[field] = SENTINELS[field]?.test(value) ? '' : value;
  }
  return result;
}

export interface ReflectionTurn {
  messageId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface ReflectionCursor {
  at: string;
  messageId: string;
  pending: boolean;
}

function compare(
  a: Pick<ReflectionTurn, 'at' | 'messageId'>,
  b: Pick<ReflectionTurn, 'at' | 'messageId'>,
): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1;
  return 0;
}

/** Oldest unseen turns across conversations; the cursor advances only after the write succeeds. */
export function buildReflectionBatch({
  turns,
  cursor,
  since,
  until,
  maxMessages = 80,
  maxChars = 120000,
}: {
  turns: ReflectionTurn[];
  cursor?: ReflectionCursor | null;
  since: string;
  until: string;
  maxMessages?: number;
  maxChars?: number;
}): { text: string; cursor: ReflectionCursor; messages: number; conversations: number } | null {
  const seen = new Set<string>();
  const fresh = turns
    .filter((turn) => {
      if (!turn.messageId || seen.has(turn.messageId) || !turn.text.trim()) return false;
      const date = new Date(turn.at);
      if (!Number.isFinite(date.getTime())) return false;
      turn = { ...turn, at: date.toISOString() };
      if (turn.at > until || (cursor ? compare(turn, cursor) <= 0 : turn.at < since)) return false;
      seen.add(turn.messageId);
      return true;
    })
    .map((turn) => ({ ...turn, at: new Date(turn.at).toISOString() }))
    .sort(compare);
  if (!fresh.length) return null;
  const limit = Math.max(1, Math.floor(maxMessages));
  const charLimit = Math.max(1000, maxChars);
  const lines: string[] = [];
  const conversations = new Set<string>();
  let chars = 0;
  let count = 0;
  for (const turn of fresh) {
    const line = `[${turn.at}; conversation ${turn.conversationId}] ${turn.role === 'user' ? 'User' : 'Companion'}: ${turn.text.trim()}`;
    if (count && (count >= limit || chars + line.length > charLimit)) break;
    // Keep one oversized message intact: silently truncating a correction would lose its meaning.
    lines.push(line);
    chars += line.length;
    count++;
    conversations.add(turn.conversationId);
  }
  const last = fresh[count - 1];
  return {
    text: lines.join('\n\n'),
    cursor: { at: last.at, messageId: last.messageId, pending: count < fresh.length },
    messages: count,
    conversations: conversations.size,
  };
}
