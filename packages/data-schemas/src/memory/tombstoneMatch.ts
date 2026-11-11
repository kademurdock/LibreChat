/**
 * KADE Nov 11 2026 (card 8): the "do not relearn" match for a forgotten fact.
 *
 * When a person says "forget that", the card is deleted and a tombstone is written: the
 * forgotten words, each one hashed with the person's id (the words themselves are not kept).
 * A memory write that carries most of those words again is refused, so the keeper cannot
 * write the same fact back from the turns still in its window, and the night's passes cannot
 * bring it back from the old conversation.
 *
 * This file has no imports but node:crypto, so a plain `node --test` can load it. It must stay
 * identical in behaviour to api/server/services/kadeKnownTombstones.js (words, hashOf,
 * covers); kadeKnownTombstones.test.js runs both on the same inputs.
 */
import { createHash } from 'node:crypto';

const STOP = new Set(
  (
    'the and for are but not you your yours was were with that this they them their there then than ' +
    'have has had having she her hers him his its our ours who whom what when where why how which ' +
    'will would shall should can could may might must about into onto from over under again also just ' +
    'very too some any all each every both few more most other such only own same off out up down ' +
    'being been does did doing done get got gets user person said says told tell tells like really'
  ).split(' '),
);

/** The content words of a text, in order, each once. Numbers are kept whole. */
export function tombstoneWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const raw = String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/);
  for (const w of raw) {
    if (!w) continue;
    const digits = /^[0-9]+$/.test(w);
    if (!digits && (w.length < 3 || STOP.has(w))) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** One word, hashed with the person's id: the same word for two people never matches. */
export function tombstoneHash(userId: string, word: string): string {
  return createHash('sha256').update(`${String(userId)}|${word}`).digest('hex').slice(0, 16);
}

export function tombstoneHashes(userId: string, text: string): string[] {
  return tombstoneWords(text).map((w) => tombstoneHash(userId, w));
}

/**
 * True when the candidate carries the forgotten fact again: at least 80 percent of a
 * tombstone's words (all of them when it has only two). A tombstone of one word blocks nothing.
 */
export function tombstoneCovers(tomb: string[], candidate: string[]): boolean {
  const t = Array.isArray(tomb) ? tomb : [];
  if (t.length < 2) return false;
  const have = new Set(candidate || []);
  let hit = 0;
  for (const h of t) if (have.has(h)) hit += 1;
  if (t.length === 2) return hit === 2;
  return hit / t.length >= 0.8;
}
