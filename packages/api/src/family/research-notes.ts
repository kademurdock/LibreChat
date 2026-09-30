import type { FamilyHistoryAccount } from './history';

export interface FamilyResearchNote {
  id: string;
  at: string;
  kind: 'unverified-recollection';
  status: 'needs-source-review';
  author: { userId: string; name: string; personId: string | null };
  personId: string | null;
  text: string;
  notice: string;
}
export const FAMILY_RESEARCH_NOTE_NOTICE: string =
  'Attributed personal recollection, not a verified record or proven relationship. It has not changed the sourced tree.';

export function familyResearchNoteRequest(body: unknown):
  { text: string; personId: string | null } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Write the recollection as text.' };
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['text', 'personId', 'userRequestedSave'].includes(key)))
    return { error: 'Only text and an optional subject may be supplied; attribution and review status are set by the server.' };
  if (data.userRequestedSave !== true) return { error: 'Only an explicitly requested new research note may be saved.' };
  const text = typeof data.text === 'string' ? data.text.replace(/\r\n?/g, '\n').trim() : '';
  if (!text || text.length > 4000) return { error: 'Write a recollection between 1 and 4,000 characters.' };
  if (data.personId !== undefined && (typeof data.personId !== 'string' || !data.personId.trim() || data.personId.length > 120))
    return { error: 'Use a person ID from the selected archive, or leave the subject unset.' };
  return { text, personId: typeof data.personId === 'string' ? data.personId : null };
}

/** Attribution takes only trusted context, never note-body/model author fields. */
export function familyResearchNoteAuthor(user: FamilyHistoryAccount, personId: string | null): FamilyResearchNote['author'] {
  return {
    userId: String(user.id || user._id?.toString() || ''),
    name: String(user.name || user.username || 'Someone').trim(),
    personId,
  };
}
