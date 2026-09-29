import { createHash } from 'node:crypto';
import type { FamilyBundle, FamilyMedia } from './history';

/* Small helpers the family history modules share (docs/FAMILY_HISTORY.md).
 * THE REPOSITORY IS PUBLIC: no family data belongs here. */

/** Own properties only: a tree id of "constructor" must not find Object's. */
export function own<T>(map: Record<string, T> | undefined | null, key: string): T | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Who is looking: the tree id the viewer sees from, and whether they are the owner. */
export interface FamilyAudience {
  personId: string;
  owner: boolean;
}

/** May this viewer see this picture? Everything the export sends is the family's to see (the
 * owner's decision: the family sees the research as she does), except an item the export marked
 * `heldFor` a few people, which only they and the owner see; a restored copy follows its original. */
export function familyMediaVisible(
  bundle: FamilyBundle,
  item: FamilyMedia | undefined,
  audience: FamilyAudience,
): boolean {
  if (!item) return false;
  if (item.kind === 'restored') {
    const original = item.restoredFrom ? own(bundle.media, item.restoredFrom) : undefined;
    if (!original || original.kind === 'restored') return false;
    return familyMediaVisible(bundle, original, audience);
  }
  if (Array.isArray(item.heldFor))
    return audience.owner || item.heldFor.includes(audience.personId);
  return true;
}

export interface FamilyDate {
  year: number | null;
  /** 1 to 12, or null when the date names no month. */
  month: number | null;
  day: number | null;
  /** "abt", "about", "est", "circa", "bef", "aft", "between": the year is not exact. */
  approx: boolean;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export const FAMILY_MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const APPROX =
  /\b(?:abt|about|approx|approximately|est|estimated|circa|ca|c|bef|before|aft|after|bet|between|from|to|cal|calculated)\b\.?/i;

/**
 * A genealogy date string ("3 Mar 1960", "abt 1900", "12/25/1899", "March 1850", "1930") as its
 * parts. Anything unreadable is a date with no year.
 */
export function familyDate(text: string | null | undefined): FamilyDate {
  const raw = String(text || '').trim();
  const out: FamilyDate = { year: null, month: null, day: null, approx: false };
  if (!raw) return out;
  out.approx = APPROX.test(raw);
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(raw);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    out.year = Number(slash[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      out.month = month;
      out.day = day;
    }
    return out;
  }
  const years = raw.match(/\b(\d{4})\b/g);
  if (!years) return out;
  out.year = Number(years[0]);
  if (years.length > 1) out.approx = true;
  const beforeYear = raw.slice(0, raw.indexOf(years[0]));
  const month = /([A-Za-z]{3,9})\.?\s*$/.exec(beforeYear.trim());
  const monthNumber = month
    ? own(MONTHS, month[1].toLowerCase().slice(0, 4)) ||
      own(MONTHS, month[1].toLowerCase().slice(0, 3))
    : undefined;
  if (monthNumber) {
    out.month = monthNumber;
    const day = /\b(\d{1,2})\s+[A-Za-z]{3,9}\.?\s*$/.exec(beforeYear.trim());
    if (day && Number(day[1]) >= 1 && Number(day[1]) <= 31) out.day = Number(day[1]);
  }
  return out;
}

/** The first four-digit year in a date or lifespan string, or null. */
export function familyYear(text: string | null | undefined): number | null {
  return familyDate(text).year;
}

/** "Ada" from "Ada Example"; "Someone" when there is no name. */
export function familyFirstName(name: string | null | undefined): string {
  const first = String(name || '')
    .trim()
    .split(/\s+/)[0];
  return first || 'Someone';
}

/** Up to two capital letters: "AE" from "Ada Example", "Q" from "Quinn". */
export function familyInitials(name: string | null | undefined): string {
  const words = String(name || '')
    .replace(/[^A-Za-zÀ-ɏ\s'-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

/** Hex SHA-256, cut to `length` characters. */
export function familyHash(text: string | Buffer, length: number = 16): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

/** Whole number from a query string, defaulted and clamped ("" and "abc" are the default). */
export function familyInt(text: unknown, fallback: number, min: number, max: number): number {
  const value = typeof text === 'string' && text.trim() !== '' ? Number(text) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** A small seeded random source (mulberry32), so a game can be replayed from its seed. */
export function familyRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same items in a seeded random order. */
export function familyShuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}
