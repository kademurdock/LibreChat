export interface EvidenceTurn {
  role: 'user' | 'assistant';
  text: string;
  conversationId?: string;
  at?: string | Date;
}

export function hasPeoplePrivacyControl(text: string): boolean {
  return /\b(?:off[ -]the[ -]record|back on the record)\b/i.test(text);
}

/** Conservative textual controls supplement explicit conversation memory policy. */
export function peopleOffRecord(userMessages: string[], initial = false): boolean {
  let offRecord = initial;
  for (const text of userMessages) {
    const controls = [...text.matchAll(/\b(?:off[ -]the[ -]record|back on the record)\b/gi)];
    for (const control of controls) offRecord = !/^back on/i.test(control[0]);
  }
  return offRecord;
}

/** Read controls before the cutoff, but never admit their historical or off-record payload. */
export function permittedMemoryTurns<T extends EvidenceTurn>(turns: T[], cutoff: Date | null): T[] {
  if (cutoff && !Number.isFinite(cutoff.getTime())) return [];
  const offRecordConversations = new Set<string>();
  const allowed: T[] = [];
  for (const turn of turns) {
    const key = turn.conversationId || '';
    const wasOffRecord = offRecordConversations.has(key);
    if (turn.role === 'user') {
      if (peopleOffRecord([turn.text], wasOffRecord)) offRecordConversations.add(key);
      else offRecordConversations.delete(key);
    }
    if (
      wasOffRecord ||
      offRecordConversations.has(key) ||
      (turn.role === 'user' && hasPeoplePrivacyControl(turn.text))
    )
      continue;
    const at = turn.at ? new Date(turn.at).getTime() : NaN;
    if (cutoff && (!Number.isFinite(at) || at <= cutoff.getTime())) continue;
    allowed.push(turn);
  }
  return allowed;
}

export function permittedUserEvidence(
  turns: EvidenceTurn[],
  initialOffRecord = false,
  initialOffRecordConversations: string[] = [],
): {
  userEvidence: string;
  offRecord: boolean;
  offRecordConversations: string[];
  evidenceTurns: { text: string; at?: string | Date }[];
} {
  const evidence: string[] = [];
  const evidenceTurns: { text: string; at?: string | Date }[] = [];
  const offRecordConversations = new Set(initialOffRecordConversations);
  if (initialOffRecord) offRecordConversations.add('');
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const key = turn.conversationId || '';
    const wasOffRecord = offRecordConversations.has(key);
    const offRecord = peopleOffRecord([turn.text], wasOffRecord);
    if (offRecord) offRecordConversations.add(key);
    else offRecordConversations.delete(key);
    if (!wasOffRecord && !offRecord && !hasPeoplePrivacyControl(turn.text)) {
      evidence.push(turn.text);
      evidenceTurns.push({ text: turn.text, ...(turn.at ? { at: turn.at } : {}) });
    }
  }
  return {
    userEvidence: evidence.join('\n\n'),
    offRecord: offRecordConversations.size > 0,
    offRecordConversations: [...offRecordConversations],
    evidenceTurns,
  };
}
