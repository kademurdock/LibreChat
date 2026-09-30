import type {
  FamilyBundle,
  FamilyFinding,
  FamilyMedia,
  FamilyMilestone,
  FamilyPerson,
  FamilyRelation,
  FamilyView,
} from './history';
import { familyChooseParents } from './layout';
import type {
  FamilyImageCategory,
  FamilyProof,
  FamilyProofLevel,
  FamilySide,
  FamilyStep,
  FamilyVoice,
} from './words';
import { familyProof, familyTermText } from './words';
import type { FamilyDate } from './util';
import { familyDate, familyPortraitIdentity, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY DERIVATIONS (docs/FAMILY_HISTORY.md, "What the server works out")
 *
 * Everything the v2 routes work out from the bundle, memoised per bundle (the
 * model) and per view (the lens): dates, pictures and their kinds, restored
 * copies, ancestors, sides of the family, research paths, milestones, findings
 * with their proof words, and places named by state or country. The export
 * may send any of these ready-made (schema 2); the server uses the export's
 * values when present and works them out otherwise, so the routes work on a
 * v1 bundle too. The family sees the research as the owner does, living
 * relatives in full (her decision); nothing here takes anything out.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

const PICTURE = /\.(?:jpe?g|png|gif|webp)$/i;
/** A file the bucket holds under the prefix's media folder (never anything outside it). */
const MEDIA_FILE = /^media\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;
export const FAMILY_SIZES: readonly string[] = ['t', 's', 'l', 'f', 'o'];
const CATEGORIES: ReadonlySet<string> = new Set([
  'portrait',
  'photo',
  'record',
  'grave',
  'document',
  'story',
]);
const SCANS: ReadonlySet<string> = new Set(['record', 'document', 'story']);
/** Parent links that carry blood (or adoption) for sides, papers and the chart. */
const LINE_KINDS: ReadonlySet<string> = new Set(['birth', 'adopted', 'probable', 'doubtful']);
const RESEARCH_KINDS: ReadonlySet<string> = new Set(['probable', 'doubtful']);
const PROOF_LEVELS: ReadonlySet<string> = new Set(['records', 'dna', 'guess']);

export interface FamilyFindingMeta {
  key: string;
  title: string;
  text: string;
  summary: string;
  proof: FamilyProofLevel;
  band: string | null;
  /** True for findings that may be news to the family (unknown fathers found by DNA). A finding
   * the export has not marked counts as sensitive, so nothing surprising is ever featured. */
  sensitive: boolean;
  people: string[];
  evidence: string | null;
  storySlug: string | null;
  dna: boolean;
}

export interface FamilyModel {
  bundle: FamilyBundle;
  born: (id: string) => FamilyDate;
  died: (id: string) => FamilyDate;
  deceased: (id: string) => boolean;
  category: (item: FamilyMedia) => FamilyImageCategory;
  isPicture: (item: FamilyMedia) => boolean;
  /** The sizes the bucket holds for an item: t, s, l, f from the export, and o (the stored original)
   * only for record and document scans, never for photos (a phone's original can carry GPS). */
  sizes: (item: FamilyMedia) => string[];
  /** The file ("media/...") of one size, or null when the item has no such size. */
  sizeFile: (item: FamilyMedia, size: string) => string | null;
  /** True when the bucket holds something of this item to show: a size, or its stored file. */
  servable: (item: FamilyMedia) => boolean;
  /** The restored copy's id for an original, when the bundle has one. */
  restoredOf: (id: string) => string | null;
  /** Pictures of a person: their own tree pictures, then photos from their graves. */
  pictures: (id: string) => string[];
  /** The best picture for a face circle, or null. */
  portrait: (id: string) => string | null;
  /** Everyone up a person's lines (birth, adoptive and research links), the person included. */
  line: (id: string) => ReadonlySet<string>;
  /** How many generations are known above a person. */
  depthAbove: (id: string) => number;
  /** The chart's father and mother of a person (blood links first). */
  parents: (id: string) => { father: string | null; mother: string | null };
  findings: FamilyFindingMeta[];
  /** People named by a sensitive finding: never featured. */
  sensitivePeople: ReadonlySet<string>;
  milestones: FamilyMilestone[];
  /** Nobody in the bundle is dated after this year (for "living" bars). */
  thisYear: number;
}

const models = new WeakMap<FamilyBundle, FamilyModel>();

function fileOf(item: FamilyMedia): string {
  return String(item.file || '');
}

/** A label's lifespan ("1930-1999", "born 1990", "about 1900", "died 1920") as birth and death. */
function lifespanParts(lifespan: string | null | undefined): {
  born: string | null;
  died: string | null;
} {
  const text = String(lifespan || '').trim();
  if (/^died\b/i.test(text)) return { born: null, died: text };
  const span = /^(.*?\d{4})\s*[-–]\s*(.*\d{4}.*)$/.exec(text);
  if (span) return { born: span[1], died: span[2] };
  return { born: /\d{4}/.test(text) ? text : null, died: null };
}

function findingMeta(finding: FamilyFinding, index: number): FamilyFindingMeta {
  const summary = String(finding.summary || finding.text || '').trim();
  const text = String(finding.text || summary).trim();
  const firstSentence = /^(.{12,120}?[.!?])(\s|$)/.exec(summary);
  const title = String(
    finding.title ||
      (firstSentence ? firstSentence[1] : summary.slice(0, 100)) ||
      'A research finding',
  ).trim();
  const dna =
    typeof finding.dna === 'boolean' ? finding.dna : /\bdna\b/i.test(`${summary} ${text}`);
  const proof: FamilyProofLevel =
    finding.proof && PROOF_LEVELS.has(finding.proof) ? finding.proof : dna ? 'dna' : 'guess';
  return {
    key: String(finding.key || `f${index + 1}`),
    title,
    text,
    summary,
    proof,
    band: finding.band ? String(finding.band) : null,
    sensitive: finding.sensitive !== false,
    people: Array.isArray(finding.people)
      ? finding.people.filter((id) => typeof id === 'string')
      : [],
    evidence: finding.evidence ? String(finding.evidence) : null,
    storySlug: finding.storySlug ? String(finding.storySlug) : null,
    dna,
  };
}

/** Milestones from facts when the export sent none: births, deaths and marriages with a full
 * date, for people who have died (a marriage only when both spouses have died). */
function deriveMilestones(
  bundle: FamilyBundle,
  deceased: (id: string) => boolean,
): FamilyMilestone[] {
  const out: FamilyMilestone[] = [];
  const marriages = new Map<string, FamilyMilestone>();
  for (const id of Object.keys(bundle.people)) {
    const person = bundle.people[id];
    if (person.duplicateOf || !deceased(id)) continue;
    for (const fact of person.facts || []) {
      const date = familyDate(fact.date);
      if (date.year == null || date.month == null || date.day == null || date.approx) continue;
      if (fact.type === 'BIRT' || fact.type === 'DEAT') {
        out.push({
          people: [id],
          type: fact.type === 'BIRT' ? 'birth' : 'death',
          date: String(fact.date),
          placeText: fact.place || null,
        });
      } else if (fact.type === 'MARR') {
        const spouses = (person.spouses || []).filter((s) => own(bundle.people, s));
        if (!spouses.every(deceased)) continue;
        const partner = spouses.find((s) =>
          (own(bundle.people, s)?.facts || []).some(
            (f) => f.type === 'MARR' && f.date === fact.date,
          ),
        );
        const key = partner ? [id, partner].sort().join('+') + fact.date : `${id}+${fact.date}`;
        if (marriages.has(key)) continue;
        const milestone: FamilyMilestone = {
          people: partner ? [id, partner] : [id],
          type: 'marriage',
          date: String(fact.date),
          placeText: fact.place || null,
        };
        marriages.set(key, milestone);
        out.push(milestone);
      }
    }
  }
  return out;
}

/** The bundle's derivations, worked out once per bundle. */
export function familyModel(bundle: FamilyBundle): FamilyModel {
  const known = models.get(bundle);
  if (known) return known;
  const dates = new Map<string, { born: FamilyDate; died: FamilyDate }>();
  const datesOf = (id: string): { born: FamilyDate; died: FamilyDate } => {
    let entry = dates.get(id);
    if (!entry) {
      const person = own(bundle.people, id);
      const fact = (type: string): string | null | undefined =>
        (person?.facts || []).find((f) => f.type === type && f.date)?.date;
      const span = lifespanParts(person?.lifespan);
      entry = {
        born: familyDate(person?.birth?.date || fact('BIRT') || span.born),
        died: familyDate(
          person?.death?.date || fact('DEAT') || (person?.living ? null : span.died),
        ),
      };
      dates.set(id, entry);
    }
    return entry;
  };
  const deceased = (id: string): boolean => {
    const person = own(bundle.people, id);
    return !!person && !person.living;
  };
  const isPicture = (item: FamilyMedia): boolean =>
    item.kind === 'restored' ||
    PICTURE.test(fileOf(item)) ||
    !!(item.sizeFiles && own(item.sizeFiles, 's'));
  const category = (item: FamilyMedia): FamilyImageCategory => {
    if (item.category && CATEGORIES.has(item.category)) return item.category as FamilyImageCategory;
    if (item.kind === 'restored') {
      const original = item.restoredFrom ? own(bundle.media, item.restoredFrom) : undefined;
      return original && original.kind !== 'restored' ? category(original) : 'photo';
    }
    if (item.kind === 'record') return 'record';
    if (item.kind === 'grave') return 'grave';
    const kind = String(item.media_kind || '').toLowerCase();
    if (kind === 'headstone') return 'grave';
    if (kind === 'story') return 'story';
    if (kind === 'document') return 'document';
    if (!isPicture(item)) return 'document';
    if (kind === 'portrait' || item.isPortrait) return 'portrait';
    return 'photo';
  };
  const sizeFile = (item: FamilyMedia, size: string): string | null => {
    const scan = SCANS.has(category(item));
    if (size === 'o' && !scan) return null;
    const entry = item.sizeFiles ? own(item.sizeFiles, size) : undefined;
    if (entry && typeof entry.file === 'string')
      return MEDIA_FILE.test(entry.file) && !entry.file.includes('..') ? entry.file : null;
    /* A bundle from before the export made sizes: a scan's stored file is its original. */
    if (
      size === 'o' &&
      item.kind !== 'restored' &&
      !item.sizeFiles &&
      MEDIA_FILE.test(fileOf(item))
    )
      return fileOf(item).includes('..') ? null : fileOf(item);
    return null;
  };
  const sizes = (item: FamilyMedia): string[] => FAMILY_SIZES.filter((s) => !!sizeFile(item, s));
  const servable = (item: FamilyMedia): boolean =>
    sizes(item).length > 0 ||
    (item.kind !== 'restored' && MEDIA_FILE.test(fileOf(item)) && !fileOf(item).includes('..'));
  const restoredOf = (id: string): string | null => {
    const item = own(bundle.media, id);
    const restored = item?.restored ? own(bundle.media, item.restored) : undefined;
    return restored && restored.kind === 'restored' && restored.restoredFrom === id
      ? restored.id
      : null;
  };
  const pictureCache = new Map<string, string[]>();
  const pictures = (id: string): string[] => {
    const cached = pictureCache.get(id);
    if (cached) return cached;
    const person = own(bundle.people, id);
    const out: string[] = [];
    const add = (mediaId: string | null | undefined): void => {
      const item = mediaId ? own(bundle.media, mediaId) : undefined;
      if (!item || item.kind === 'restored' || !isPicture(item) || out.includes(item.id)) return;
      const kind = category(item);
      if (kind === 'record' || kind === 'document' || kind === 'story') return;
      out.push(item.id);
    };
    for (const mediaId of person?.media || []) add(mediaId);
    const wrong = person?.wrongMemorials || {};
    for (const mid of person?.memorials || []) {
      if (own(wrong, mid)) continue;
      for (const photo of own(bundle.memorials, mid)?.photos || []) add(photo.media);
    }
    const rank = (mediaId: string): number => {
      const kind = category(own(bundle.media, mediaId) as FamilyMedia);
      return kind === 'portrait' ? 0 : kind === 'photo' ? 1 : 2;
    };
    out.sort((a, b) => rank(a) - rank(b));
    pictureCache.set(id, out);
    return out;
  };
  const portraitCache = new Map<string, string | null>();
  const portrait = (id: string): string | null => {
    if (portraitCache.has(id)) return portraitCache.get(id) as string | null;
    const chosen = own(bundle.people, id)?.portrait;
    const chosenItem = chosen ? own(bundle.media, chosen) : undefined;
    if (chosenItem && chosenItem.kind !== 'restored' && familyPortraitIdentity(chosenItem, id)) {
      portraitCache.set(id, chosenItem.id);
      return chosenItem.id;
    }
    let best: string | null = null;
    let bestScore = -1;
    for (const mediaId of pictures(id)) {
      const item = own(bundle.media, mediaId) as FamilyMedia;
      const kind = category(item);
      if (kind !== 'portrait' && kind !== 'photo') continue;
      if (!familyPortraitIdentity(item, id)) continue;
      const restored = restoredOf(mediaId);
      const shown = restored ? (own(bundle.media, restored) as FamilyMedia) : item;
      let score = 0;
      if (sizes(shown).includes('f') || sizes(item).includes('f')) score += 100;
      if (kind === 'portrait') score += 10;
      if ((item.people || []).length === 1) score += 5;
      if (Array.isArray(item.faces) && item.faces.length === 1) score += 3;
      if (restored) score += 2;
      if (score > bestScore) {
        best = mediaId;
        bestScore = score;
      }
    }
    portraitCache.set(id, best);
    return best;
  };
  const parentsCache = new Map<string, { father: string | null; mother: string | null }>();
  const parents = (id: string): { father: string | null; mother: string | null } => {
    const cached = parentsCache.get(id);
    if (cached) return cached;
    const person = own(bundle.people, id);
    const nodes = new Map<string, { id: string; sex?: string | null }>();
    const links = (person?.parents || []).filter(
      (link) => LINE_KINDS.has(link.kind) && own(bundle.people, link.id),
    );
    for (const link of links)
      nodes.set(link.id, { id: link.id, sex: own(bundle.people, link.id)?.sex });
    const pick = familyChooseParents(links, nodes);
    let father: string | null = null;
    let mother: string | null = null;
    for (const chosen of pick.chosen) {
      const sex = nodes.get(chosen.id)?.sex;
      if (sex === 'F' && !mother) mother = chosen.id;
      else if (sex === 'M' && !father) father = chosen.id;
      else if (!father) father = chosen.id;
      else if (!mother) mother = chosen.id;
    }
    const out = { father, mother };
    parentsCache.set(id, out);
    return out;
  };
  const lineCache = new Map<string, ReadonlySet<string>>();
  const line = (id: string): ReadonlySet<string> => {
    const cached = lineCache.get(id);
    if (cached) return cached;
    const out = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const at = stack.pop() as string;
      for (const link of own(bundle.people, at)?.parents || []) {
        if (!LINE_KINDS.has(link.kind) || out.has(link.id) || !own(bundle.people, link.id))
          continue;
        out.add(link.id);
        stack.push(link.id);
      }
    }
    lineCache.set(id, out);
    return out;
  };
  const depthCache = new Map<string, number>();
  const depthAbove = (id: string, guard: Set<string> = new Set()): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id) || guard.size > 60) return 0;
    guard.add(id);
    let depth = 0;
    for (const link of own(bundle.people, id)?.parents || []) {
      if (!LINE_KINDS.has(link.kind) || !own(bundle.people, link.id)) continue;
      depth = Math.max(depth, 1 + depthAbove(link.id, guard));
    }
    guard.delete(id);
    depthCache.set(id, depth);
    return depth;
  };
  const findings = (bundle.findings || []).map(findingMeta);
  const sensitivePeople = new Set<string>(
    Array.isArray(bundle.sensitivePeople) ? bundle.sensitivePeople : [],
  );
  for (const finding of findings)
    if (finding.sensitive) for (const id of finding.people) sensitivePeople.add(id);
  for (const conclusion of bundle.dna?.conclusions || [])
    if (conclusion.sensitive !== false)
      for (const id of conclusion.people || []) sensitivePeople.add(id);
  let thisYear = 0;
  for (const id of Object.keys(bundle.people)) {
    const { born, died } = datesOf(id);
    thisYear = Math.max(thisYear, born.year || 0, died.year || 0);
  }
  const generatedYear = familyDate(bundle.generated || bundle.version).year;
  const model: FamilyModel = {
    bundle,
    born: (id) => datesOf(id).born,
    died: (id) => datesOf(id).died,
    deceased,
    category,
    isPicture,
    sizes,
    sizeFile,
    servable,
    restoredOf,
    pictures,
    portrait,
    line,
    depthAbove: (id) => depthAbove(id),
    parents,
    findings,
    sensitivePeople,
    milestones: Array.isArray(bundle.milestones)
      ? bundle.milestones
      : deriveMilestones(bundle, deceased),
    thisYear: Math.max(thisYear, generatedYear || 0),
  };
  models.set(bundle, model);
  return model;
}

/* ── the lens: one view, said in one voice ───────────────────────────── */

export interface FamilyLens {
  model: FamilyModel;
  view: FamilyView;
  /** The person whose place the view is from (the viewer, or the owner when borrowed). */
  anchor: string;
  voice: FamilyVoice;
  relation: (id: string) => FamilyRelation | undefined;
  term: (id: string) => string | null;
  side: (id: string) => FamilySide | null;
  research: (id: string) => FamilyProof | null;
  /** The path from the anchor as up and down steps, or null when it is not a line of parents. */
  steps: (id: string) => FamilyStep[] | null;
  /** How near: 0 for the anchor, then relation distance; married-in one past their spouse. */
  near: (id: string) => number;
  isAncestor: (id: string) => boolean;
  /** On a research path, or named by a sensitive finding: never featured, never in the game. */
  unsettled: (id: string) => boolean;
}

function linkKindBetween(bundle: FamilyBundle, a: string, b: string): string | null {
  const up = own(bundle.people, a)?.parents?.find((link) => link.id === b)?.kind;
  if (up) return up;
  return own(bundle.people, b)?.parents?.find((link) => link.id === a)?.kind || null;
}

const SIDES: ReadonlySet<string> = new Set([
  'self',
  'father',
  'mother',
  'both',
  'marriage',
  'descendant',
]);

/** One view said in one voice; the caches live as long as the view (one bundle version). */
export function familyLens(model: FamilyModel, view: FamilyView, voice: FamilyVoice): FamilyLens {
  const bundle = model.bundle;
  const anchor = own(bundle.people, view.anchor) ? view.anchor : bundle.owner;
  const relation = (id: string): FamilyRelation | undefined => own(view.relations, id);
  const anchorParents = model.parents(anchor);
  const fatherLine = anchorParents.father ? model.line(anchorParents.father) : new Set<string>();
  const motherLine = anchorParents.mother ? model.line(anchorParents.mother) : new Set<string>();
  const meets = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const id of small) if (big.has(id)) return true;
    return false;
  };
  const sideCache = new Map<string, FamilySide | null>();
  const side = (id: string): FamilySide | null => {
    if (sideCache.has(id)) return sideCache.get(id) as FamilySide | null;
    const r = relation(id);
    let out: FamilySide | null = null;
    if (r?.side && SIDES.has(r.side)) out = r.side as FamilySide;
    else if (!r) out = null;
    else if (r.group === 'self' || id === anchor) out = 'self';
    else if (r.group === 'marriage') out = 'marriage';
    else if (r.group === 'descendant') out = 'descendant';
    else {
      const onFather =
        r.group === 'ancestor' ? fatherLine.has(id) : meets(model.line(id), fatherLine);
      const onMother =
        r.group === 'ancestor' ? motherLine.has(id) : meets(model.line(id), motherLine);
      if (onFather && onMother) out = 'both';
      else if (onFather) out = 'father';
      else if (onMother) out = 'mother';
      else {
        const first = Array.isArray(r.path) ? r.path[1] : undefined;
        if (first && first === anchorParents.father) out = 'father';
        else if (first && first === anchorParents.mother) out = 'mother';
        else if (/^your father\b/i.test(r.pathText || '')) out = 'father';
        else if (/^your mother\b/i.test(r.pathText || '')) out = 'mother';
      }
    }
    sideCache.set(id, out);
    return out;
  };
  const findingText = new Map<string, string>();
  /** The strongest research level a curated finding gives a person it names. */
  const findingLevel = new Map<string, 'dna' | 'guess'>();
  for (const finding of model.findings)
    for (const id of finding.people) {
      findingText.set(id, `${findingText.get(id) || ''} ${finding.summary}`);
      if (finding.proof === 'dna') findingLevel.set(id, 'dna');
      else if (finding.proof === 'guess' && !findingLevel.has(id)) findingLevel.set(id, 'guess');
    }
  /* A view the export built with the inheritance pass (schema 2) says research on every relation
   * that rests on it, and nothing on the rest; an older view is read for the signs instead. */
  const v2 =
    Array.isArray(view.paper) ||
    Object.keys(view.relations).some((k) => typeof view.relations[k]?.cor === 'number');
  const researchCache = new Map<string, FamilyProof | null>();
  const research = (id: string): FamilyProof | null => {
    if (researchCache.has(id)) return researchCache.get(id) as FamilyProof | null;
    const r = relation(id);
    const person = own(bundle.people, id);
    let out: FamilyProof | null = null;
    if (r && (r.research === 'dna' || r.research === 'guess')) out = familyProof(r.research);
    else if (r && (r.research === null || v2)) out = null;
    else if (!r && (person?.research === 'dna' || person?.research === 'guess'))
      out = familyProof(person.research);
    else {
      const notes = (r?.notes || []).join(' ');
      const flagged =
        /(^|\s)research finding/i.test(notes) ||
        !!person?.virtual ||
        (Array.isArray(r?.path) &&
          r.path.some((at, i) => {
            const next = r.path?.[i + 1];
            if (!next) return false;
            const kind = linkKindBetween(bundle, at, next);
            return !!kind && RESEARCH_KINDS.has(kind);
          }));
      if (flagged) {
        const words = `${notes} ${person?.confidence || ''} ${findingText.get(id) || ''}`;
        const level =
          person?.research === 'dna' || person?.research === 'guess'
            ? person.research
            : findingLevel.get(id) || (/\bdna\b/i.test(words) ? 'dna' : 'guess');
        out = familyProof(level);
      }
    }
    researchCache.set(id, out);
    return out;
  };
  const steps = (id: string): FamilyStep[] | null => {
    const path = relation(id)?.path;
    if (!Array.isArray(path) || path.length < 2 || path[0] !== anchor) return null;
    const out: FamilyStep[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const sex = own(bundle.people, b)?.sex;
      if (own(bundle.people, a)?.parents?.some((link) => link.id === b))
        out.push({ up: true, sex });
      else if (own(bundle.people, b)?.parents?.some((link) => link.id === a))
        out.push({ up: false, sex });
      else return null;
    }
    return out;
  };
  const nearCache = new Map<string, number>();
  const near = (id: string): number => {
    const cached = nearCache.get(id);
    if (cached !== undefined) return cached;
    const direct = (r: FamilyRelation | undefined): number | null => {
      if (!r) return null;
      if (r.group === 'self') return 0;
      if (typeof r.distance === 'number') return r.distance;
      if (typeof r.gen === 'number') return Math.abs(r.gen);
      return null;
    };
    const person = own(bundle.people, id);
    let out = 2000;
    if (person && !person.duplicateOf) {
      const r = relation(id);
      const value = direct(r);
      if (!r) out = 1000;
      else if (value !== null) out = value;
      else {
        out = 900;
        for (const spouse of person.spouses || []) {
          const through = direct(relation(spouse));
          if (through !== null) out = Math.min(out, through + 1);
        }
      }
    }
    nearCache.set(id, out);
    return out;
  };
  return {
    model,
    view,
    anchor,
    voice,
    relation,
    term: (id) => {
      const r = relation(id);
      return r ? familyTermText(r.term, r.group, voice) : null;
    },
    side,
    research,
    steps,
    near,
    isAncestor: (id) => relation(id)?.group === 'ancestor',
    unsettled: (id) => !!research(id) || model.sensitivePeople.has(id),
  };
}

/* ── places named by state or country (no geocoding) ─────────────────── */

const STATES: ReadonlyArray<[string, string]> = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
  ['', 'Indian Territory'],
  ['', 'Dakota Territory'],
];
const STATE_NAMES = new Map<string, string>();
for (const [abbr, name] of STATES) {
  STATE_NAMES.set(name.toLowerCase(), name);
  if (abbr) STATE_NAMES.set(abbr.toLowerCase(), name);
}
const US_NAMES: ReadonlySet<string> = new Set([
  'usa',
  'us',
  'u s a',
  'united states',
  'united states of america',
  'america',
]);
const COUNTRIES: ReadonlyArray<string> = [
  'England',
  'Scotland',
  'Ireland',
  'Wales',
  'Northern Ireland',
  'United Kingdom',
  'Great Britain',
  'Germany',
  'Prussia',
  'Bavaria',
  'France',
  'Netherlands',
  'Holland',
  'Belgium',
  'Switzerland',
  'Austria',
  'Bohemia',
  'Hungary',
  'Poland',
  'Russia',
  'Ukraine',
  'Norway',
  'Sweden',
  'Denmark',
  'Finland',
  'Italy',
  'Spain',
  'Portugal',
  'Greece',
  'Czech Republic',
  'Luxembourg',
  'Canada',
  'Mexico',
  'Cuba',
  'Jamaica',
  'Australia',
  'New Zealand',
  'South Africa',
  'China',
  'Japan',
  'India',
  'Philippines',
  'Lebanon',
  'Syria',
  'Turkey',
];
const COUNTRY_NAMES = new Map<string, string>(COUNTRIES.map((name) => [name.toLowerCase(), name]));

export interface FamilyRegion {
  /** A state's name, or a country's. */
  name: string;
  abroad: boolean;
}

/** The state or country a place string names ("Town, County, Vermont, USA" is Vermont; "Oslo,
 * Norway" is Norway, abroad), or null when it names neither. */
export function familyRegion(place: string | null | undefined): FamilyRegion | null {
  const parts = String(place || '')
    .split(',')
    .map((part) => part.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (US_NAMES.has(part)) continue;
    const state =
      STATE_NAMES.get(part) || STATE_NAMES.get(part.replace(/\s+(state|territory)$/, ''));
    if (state) return { name: state, abroad: false };
    const country = COUNTRY_NAMES.get(part);
    if (country) return { name: country, abroad: true };
    return null;
  }
  return parts.length && US_NAMES.has(parts[parts.length - 1])
    ? { name: 'the United States', abroad: false }
    : null;
}

/** The first place a person was born or christened, from the birth event or its fact. */
export function familyBirthPlace(person: FamilyPerson | undefined): string | null {
  if (!person) return null;
  if (person.birth?.place) return person.birth.place;
  const fact = (person.facts || []).find(
    (f) => (f.type === 'BIRT' || f.type === 'CHR' || f.type === 'BAPM') && f.place,
  );
  return fact?.place || null;
}

/** ISO week "2026-W40", for the ancestor of the week. */
export function familyIsoWeek(ms: number): string {
  const date = new Date(ms);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3),
  );
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * 86400000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Days from one month-day to another, the short way round the year (0 to 183). */
export function familyDayGap(
  a: { month: number; day: number },
  b: { month: number; day: number },
): number {
  const dayOfYear = (m: number, d: number): number =>
    Date.UTC(2001, m - 1, d) / 86400000 - Date.UTC(2001, 0, 1) / 86400000;
  const gap = Math.abs(dayOfYear(a.month, a.day) - dayOfYear(b.month, b.day));
  return Math.min(gap, 365 - gap);
}
