import type { FamilyBundle } from './history';
import type { FamilyModel } from './derive';
import type { FamilyAudience } from './util';
import { familyMediaVisible, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY NOTES (docs/FAMILY_HISTORY.md, "Notes to the owner")
 *
 * "Add a memory", "Do you know who this is?" and "Ask for this photo to be
 * restored" send the tree's owner a note. Only she reads them. Each note is
 * one small JSON object in the private bucket, <prefix>/inbox/<id>.json,
 * never in a bundle; marking one done rewrites that object.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyNoteKind = 'memory' | 'who' | 'restore-request';

export interface FamilyNote {
  id: string;
  at: string;
  from: { userId: string; name: string; personId: string | null; mode: string };
  kind: FamilyNoteKind;
  about: { personId?: string; mediaId?: string } | null;
  text: string;
  done: boolean;
  doneAt?: string | null;
}

export const FAMILY_NOTE_MAX: number = 2000;
export const FAMILY_NOTES_PER_DAY: number = 20;
export const FAMILY_NOTE_KIND_TEXT: Readonly<Record<FamilyNoteKind, string>> = {
  memory: 'A memory',
  who: 'Who is in this picture',
  'restore-request': 'Please restore this photo',
};
const NOTE_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** "20260305T120000Z-1a2b3c4d": sorts by time, safe in a key and a path. */
export function familyNoteId(at: number, random: string): string {
  return `${new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}-${random}`;
}

export function familyNoteIdValid(id: string): boolean {
  return NOTE_ID.test(id);
}

export function familyNoteKey(prefix: string, id: string): string {
  return `${prefix}/inbox/${id}.json`;
}

/** The note a POST /note body asks to send, checked against the tree and what this viewer may
 * see, or why it cannot be sent. */
export function familyNoteRequest(
  body: { kind?: unknown; about?: unknown; text?: unknown } | null | undefined,
  bundle: FamilyBundle,
  model: FamilyModel,
  audience: FamilyAudience,
  mainPersonId: (id: string) => string | null,
): { kind: FamilyNoteKind; about: FamilyNote['about']; text: string } | { error: string } {
  const kind = body?.kind === undefined ? 'memory' : body.kind;
  if (kind !== 'memory' && kind !== 'who' && kind !== 'restore-request')
    return { error: 'Choose a memory, who is in a picture, or a photo to restore.' };
  const text = typeof body?.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
  if (body?.text !== undefined && typeof body.text !== 'string')
    return { error: 'Write the note as text.' };
  if (text.length > FAMILY_NOTE_MAX)
    return { error: `Keep the note to ${FAMILY_NOTE_MAX.toLocaleString('en-US')} characters.` };
  const about = (body?.about && typeof body.about === 'object' ? body.about : null) as {
    personId?: unknown;
    mediaId?: unknown;
  } | null;
  let target: FamilyNote['about'] = null;
  if (about && about.personId !== undefined) {
    const main = typeof about.personId === 'string' ? mainPersonId(about.personId) : null;
    if (!main) return { error: 'That person is not in the family tree.' };
    target = { personId: main };
  } else if (about && about.mediaId !== undefined) {
    const id = typeof about.mediaId === 'string' ? about.mediaId : '';
    if (!familyMediaVisible(bundle, own(bundle.media, id), audience))
      return { error: 'That picture is not in the family history.' };
    target = { mediaId: id };
  }
  if (kind === 'restore-request') {
    const item = target?.mediaId ? own(bundle.media, target.mediaId) : undefined;
    if (!item) return { error: 'Choose the photo to restore.' };
    const category = model.category(item);
    if (category === 'record' || category === 'document' || category === 'story')
      return { error: 'Records and documents are kept as they are, never restored.' };
    if (item.kind === 'restored' || model.restoredOf(item.id))
      return { error: 'This photo has been restored already.' };
    return { kind, about: target, text: text || FAMILY_NOTE_KIND_TEXT[kind] };
  }
  if (kind === 'who' && !target?.mediaId) return { error: 'Choose the picture this is about.' };
  if (!text) return { error: 'Write the note first.' };
  return { kind, about: target, text };
}
