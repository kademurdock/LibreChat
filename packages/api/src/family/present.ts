import type { FamilyBundle, FamilyFaceBox, FamilyMedia } from './history';
import type { FamilyLens, FamilyModel } from './derive';
import type { FamilyImageCategory, FamilySide } from './words';
import type { FamilyAudience } from './util';
import {
  FAMILY_IMAGE_KIND_WORD,
  FAMILY_RESTORED_LABEL,
  familyCapital,
  familyChain,
  familyList,
  familySideText,
  familySpoken,
  familySpokenPerson,
  familyYearsText,
} from './words';
import { familyDate, familyFirstName, familyInitials, familyMediaVisible, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY PRESENTATION (docs/FAMILY_HISTORY.md, "Shared shapes")
 *
 * The one way every v2 route shows a person (familyPersonCard) and a picture
 * (familyImage). A picture is shown only when familyMediaVisible allows it; its
 * sizes come only from the export's own files (never from the query), and its
 * signed addresses are filled in one pass per answer (familySigner). A
 * restored copy is chosen for faces and heroes and always carries its label;
 * records and documents are never restored. Every picture may be saved or
 * shared (the owner's decision); a restored copy's file name says so.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilySize = 't' | 's' | 'l' | 'f' | 'o';

export interface FamilyFaceRef {
  id: string;
  face: string | null;
  thumb: string | null;
  alt: string;
  showing: 'original' | 'restored';
}

export interface FamilyPersonCard {
  id: string;
  name: string;
  first: string;
  years: string | null;
  yearsSpoken: string | null;
  living: boolean;
  gen: number | null;
  term: string | null;
  chain: string | null;
  side: FamilySide | null;
  sideText: string | null;
  research: { level: 'dna' | 'guess'; text: string } | null;
  face: FamilyFaceRef | null;
  initials: string;
  spoken: string;
}

export interface FamilyImage {
  id: string;
  category: FamilyImageCategory;
  w: number | null;
  h: number | null;
  year: number | null;
  /** Sizes this picture has ("t", "s", "l", "f"; "o" only for a scan's original). */
  sizes: string[];
  /** Signed addresses of the small sizes, when the export made them (null before). */
  thumb: string | null;
  face: string | null;
  /** The short label for a grid cell: "Portrait: your grandmother, Ada Example". */
  short: string;
  /** The full label: kind, people and date, then what the picture shows. */
  alt: string;
  description: string | null;
  text: string | null;
  date: string | null;
  place: string | null;
  described: 'auto' | null;
  hasText: boolean;
  textAuto: boolean;
  /** Faces as fractions of the picture, for a crop that keeps them in view. */
  faces: FamilyFaceBox[];
  shareable: boolean;
  /** A file name for Save and Share; a restored copy's says "restored with AI". */
  shareName: string;
  /** The restored copy's id when this is the original and one exists. */
  restored: string | null;
  restoredLabel: string | null;
  showing: 'original' | 'restored';
  /** The original's id when this is the restored copy. */
  original: string | null;
}

export interface FamilySigner {
  /** Asks for `target[field]` to be filled with a signed address for `key`. */
  later: (target: object, field: string, key: string, mime: string) => void;
  /** Signs everything asked for, in parallel, once per key. */
  fill: () => Promise<void>;
}

export interface FamilySignCacheEntry {
  url: string;
  at: number;
}

/** Signed addresses are reused for half an hour (they last an hour), so a phone scrolling a
 * gallery does not make the server sign the same picture again and again. */
export const FAMILY_SIGN_REUSE_MS: number = 30 * 60 * 1000;
const SIGN_CACHE_LIMIT = 5000;

export function familySigner(
  sign: (key: string, mime: string) => Promise<string>,
  cache: Map<string, FamilySignCacheEntry>,
  now: () => number,
): FamilySigner {
  const wanted: { target: object; field: string; key: string; mime: string }[] = [];
  return {
    later: (target, field, key, mime) => {
      wanted.push({ target, field, key, mime });
    },
    fill: async () => {
      const unique = new Map<string, string>();
      for (const want of wanted) unique.set(want.key, want.mime);
      const at = now();
      await Promise.all(
        [...unique].map(async ([key, mime]) => {
          const hit = cache.get(key);
          if (hit && at - hit.at < FAMILY_SIGN_REUSE_MS) return;
          cache.set(key, { url: await sign(key, mime), at });
          if (cache.size > SIGN_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
        }),
      );
      for (const want of wanted) {
        (want.target as Record<string, unknown>)[want.field] = cache.get(want.key)?.url || null;
      }
      wanted.length = 0;
    },
  };
}

export interface FamilyPresenter {
  lens: FamilyLens;
  model: FamilyModel;
  bundle: FamilyBundle;
  prefix: string;
  signer: FamilySigner;
  audience: FamilyAudience;
  cards: Map<string, FamilyPersonCard>;
}

export function familyPresenter(
  lens: FamilyLens,
  prefix: string,
  signer: FamilySigner,
  audience: FamilyAudience,
): FamilyPresenter {
  return {
    lens,
    model: lens.model,
    bundle: lens.model.bundle,
    prefix,
    signer,
    audience,
    cards: new Map(),
  };
}

const MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  htm: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** The type a stored file is served as (saved web pages as plain text, so no script runs). */
export function familyFileMime(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return own(MIME, ext) || 'application/octet-stream';
}

/** Asks the signer for one size of an item into `target[field]`; false when there is no such size. */
export function familySignSize(
  pc: FamilyPresenter,
  item: FamilyMedia,
  size: string,
  target: object,
  field: string,
): boolean {
  const file = pc.model.sizeFile(item, size);
  if (!file) return false;
  pc.signer.later(target, field, `${pc.prefix}/${file}`, familyFileMime(file));
  return true;
}

/** "your grandfather, Dan Example" (or just the name when there is no relationship). */
export function familyNamed(pc: FamilyPresenter, id: string): string {
  const person = own(pc.bundle.people, id);
  if (!person) return '';
  const term = pc.lens.term(id);
  return term && term !== pc.lens.voice.self ? `${term}, ${person.name}` : person.name;
}

function peopleWords(pc: FamilyPresenter, ids: string[]): string {
  const named = ids.filter((id) => own(pc.bundle.people, id)).map((id) => familyNamed(pc, id));
  if (named.length <= 3) return familyList(named);
  return `${named.slice(0, 2).join(', ')} and ${named.length - 2} others`;
}

/** A caption fit to show: no "(restored with AI)" (the label says it), and nothing when it is
 * only a file name. */
export function familyCaption(caption: string | null | undefined): string {
  const text = String(caption || '')
    .replace(/\s*\(restored with AI\)\s*$/i, '')
    .trim();
  if (!text || /^[\w-]+\.(?:jpe?g|png|gif|webp|pdf|html?|docx?|txt)$/i.test(text)) return '';
  return text;
}

function sentence(text: string): string {
  const t = text.trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/** A file name safe on every phone and computer: letters, numbers, spaces and a few marks. */
function fileName(words: string, restored: boolean): string {
  const base =
    words
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .split('')
      .map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90)
      .trim() || 'Family picture';
  return `${base}${restored ? ' (restored with AI)' : ''}.jpg`;
}

/**
 * A picture for this viewer, or null when they may not see it. With `prefer: 'restored'` a
 * restored copy is shown in its place (Home faces, the reel, tree boxes, person galleries);
 * records and documents are always the original.
 */
export function familyImage(
  pc: FamilyPresenter,
  mediaId: string,
  options: {
    prefer?: 'restored' | 'original';
    record?: { collection?: string; forId?: string };
  } = {},
): FamilyImage | null {
  const bundle = pc.bundle;
  const asked = own(bundle.media, mediaId);
  if (!asked || !familyMediaVisible(bundle, asked, pc.audience)) return null;
  const original =
    asked.kind === 'restored' && asked.restoredFrom
      ? (own(bundle.media, asked.restoredFrom) as FamilyMedia)
      : asked;
  const category = pc.model.category(original);
  const scan = category === 'record' || category === 'document' || category === 'story';
  const restoredId = scan ? null : pc.model.restoredOf(original.id);
  const restoredItem = restoredId ? own(bundle.media, restoredId) : undefined;
  const wantRestored =
    !!restoredItem &&
    (asked.kind === 'restored' ||
      (options.prefer === 'restored' && pc.model.sizes(restoredItem).length > 0));
  const shown = wantRestored ? (restoredItem as FamilyMedia) : original;
  if (!pc.model.servable(shown)) return null;
  const sizes = pc.model.sizes(shown);
  const date = familyDate(original.date);
  const people = (original.people || []).filter((id) => own(bundle.people, id));
  const kindWord = FAMILY_IMAGE_KIND_WORD[category];
  const who = peopleWords(pc, people);
  const caption = familyCaption(original.caption);
  const visual = String(original.alt || '').trim();
  let short: string;
  let alt: string;
  let share: string;
  if (category === 'record' && options.record) {
    const collection = options.record.collection || caption || 'a record';
    const forWho = options.record.forId ? familyNamed(pc, options.record.forId) : who;
    short = `${kindWord}: ${collection}`;
    alt = `${kindWord}: ${collection}${forWho ? ` for ${forWho}` : ''}.`;
    share = `${kindWord}, ${collection}`;
  } else {
    short = `${kindWord}: ${who || caption || 'no one named'}`;
    const lead = `${kindWord}: ${who || caption || 'no one named'}${original.date ? `, ${original.date}` : ''}.`;
    const extra = visual || (who && caption ? caption : '');
    alt = extra ? `${lead} ${sentence(extra)}` : lead;
    const names = people.map((id) => own(bundle.people, id)?.name || '').filter(Boolean);
    share = `${kindWord}${names.length ? ` of ${familyList(names.slice(0, 3))}` : caption ? `, ${caption}` : ''}${original.date ? `, ${original.date}` : ''}`;
  }
  if (wantRestored) alt = `${alt} Restored with AI.`;
  const automatic = original.describedBy === 'automatic';
  const description = String(original.description || '').trim() || null;
  const text = String(original.text || '').trim() || null;
  const faces =
    (Array.isArray(shown.faces) && shown.faces.length ? shown.faces : original.faces) || [];
  const image: FamilyImage = {
    id: shown.id,
    category,
    w: typeof shown.w === 'number' ? shown.w : typeof original.w === 'number' ? original.w : null,
    h: typeof shown.h === 'number' ? shown.h : typeof original.h === 'number' ? original.h : null,
    year: date.year,
    sizes,
    thumb: null,
    face: null,
    short,
    alt,
    description,
    text,
    date: original.date || null,
    place: original.place || null,
    described: automatic && (description || visual) ? 'auto' : null,
    hasText: !!text || !!original.hasText,
    textAuto: automatic && !!text && original.textAuto !== false,
    faces: faces.filter(
      (f) => f && [f.x, f.y, f.w, f.h].every((n) => typeof n === 'number' && n >= 0 && n <= 1),
    ),
    shareable: true,
    shareName: fileName(share, wantRestored),
    restored: wantRestored ? null : restoredId,
    restoredLabel: restoredId ? FAMILY_RESTORED_LABEL : null,
    showing: wantRestored ? 'restored' : 'original',
    original: wantRestored ? original.id : null,
  };
  familySignSize(pc, shown, 't', image, 'thumb');
  familySignSize(pc, shown, 'f', image, 'face');
  return image;
}

/** The small face picture a person card carries, from their best portrait (restored first). */
function faceRef(pc: FamilyPresenter, id: string): FamilyFaceRef | null {
  const mediaId = pc.model.portrait(id);
  if (!mediaId) return null;
  const image = familyImage(pc, mediaId, { prefer: 'restored' });
  if (!image || (!image.sizes.includes('f') && !image.sizes.includes('t'))) return null;
  const shown = own(pc.bundle.media, image.id) as FamilyMedia;
  const ref: FamilyFaceRef = {
    id: image.id,
    face: null,
    thumb: null,
    alt: image.short,
    showing: image.showing,
  };
  familySignSize(pc, shown, 'f', ref, 'face');
  familySignSize(pc, shown, 't', ref, 'thumb');
  return ref;
}

/** The one shape of a person in every v2 answer, said from the viewer's place. */
export function familyPersonCard(pc: FamilyPresenter, id: string): FamilyPersonCard | null {
  const known = pc.cards.get(id);
  if (known) return known;
  const person = own(pc.bundle.people, id);
  if (!person) return null;
  const lens = pc.lens;
  const relation = lens.relation(id);
  const living = !!person.living;
  const { years, spoken: yearsSpoken } = familyYearsText(
    pc.model.born(id),
    pc.model.died(id),
    living,
  );
  const term = lens.term(id);
  const steps =
    relation && (relation.group === 'ancestor' || relation.group === 'descendant')
      ? lens.steps(id)
      : null;
  const side = lens.side(id);
  const sideText =
    side === 'self' || side === 'descendant' ? null : familySideText(side, lens.voice);
  const proof = lens.research(id);
  const card: FamilyPersonCard = {
    id,
    name: person.name,
    first: familyFirstName(person.name),
    years,
    yearsSpoken,
    living,
    gen: typeof relation?.gen === 'number' ? relation.gen : null,
    term,
    chain: steps ? familyChain(steps, lens.voice) : null,
    side,
    sideText,
    research: proof && proof.level !== 'records' ? { level: proof.level, text: proof.text } : null,
    face: faceRef(pc, id),
    initials: familyInitials(person.name),
    spoken: familySpokenPerson({ name: person.name, term, yearsSpoken, sideText, proof }),
  };
  pc.cards.set(id, card);
  return card;
}

/** Person cards for ids in the bundle, in order, unknown ids left out. */
export function familyPersonCards(pc: FamilyPresenter, ids: string[]): FamilyPersonCard[] {
  const out: FamilyPersonCard[] = [];
  for (const id of ids) {
    const card = familyPersonCard(pc, id);
    if (card) out.push(card);
  }
  return out;
}

/** "your grandfather, Dan Example" for a sentence, capitalised when it leads. */
export function familySentencePerson(
  pc: FamilyPresenter,
  id: string,
  lead: boolean = false,
): string {
  const named = familyNamed(pc, id);
  return lead ? familyCapital(named) : named;
}

/** Makes a sentence speakable (re-exported so route builders have one import). */
export const familySay: (text: string) => string = familySpoken;
