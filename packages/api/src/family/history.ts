import { gunzipSync } from 'node:zlib';
import { Router, json } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { LibraryAccount } from '../library/access';
import { libraryReviewSeat, libraryTestSeat } from '../library/access';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY (Sep 29 2026, docs/FAMILY_HISTORY.md is the contract)
 *
 * The owner's family research, served only to accounts matched to a person in
 * the tree, to admins (the owner) and to guests the owner lets in one by one.
 * The App Review seat and test seats never get in, and cannot be matched.
 * Every relationship is said from the viewer's place, read from that person's
 * view file (the owner's view, with a note, when theirs was not built).
 *
 * All family data lives in the private bucket, built offline:
 *   <prefix>/current.json                 {"version": "..."}
 *   <prefix>/<version>/bundle.json.gz     people, records, memorials, media...
 *   <prefix>/<version>/views/<id>.json.gz relations from one anchor's place
 *   <prefix>/media/<id>.<ext>             pictures and scans, never versioned
 * THE REPOSITORY IS PUBLIC: no family data belongs in this file or its tests.
 * -------------------------------------------------------------------------- */

export type FamilyParentKind = 'birth' | 'step' | 'probable' | 'doubtful' | 'adopted';
export type FamilyRelationGroup = 'self' | 'ancestor' | 'descendant' | 'blood' | 'marriage';
export type FamilyPeopleGroup = FamilyRelationGroup | 'none';
export type FamilyHistoryMode = 'family' | 'owner' | 'guest';
export type FamilyHistoryAccess = FamilyHistoryMode | 'none';
export type FamilyMediaKind = 'record' | 'grave' | 'tree' | 'codex';

export interface FamilyEvent {
  date?: string | null;
  place?: string | null;
}

export interface FamilyFact {
  type: string;
  label?: string;
  date?: string | null;
  year?: number | null;
  place?: string | null;
  value?: string | null;
  note?: string | null;
  records?: string[];
}

export interface FamilyParentLink {
  id: string;
  kind: FamilyParentKind;
}

export interface FamilyConflict {
  sex?: string | null;
  parents?: string[];
  kept?: string[];
}

export interface FamilyPerson {
  id: string;
  name: string;
  label: string;
  sex?: string | null;
  birthSurname?: string | null;
  lifespan?: string;
  living?: boolean;
  virtual?: boolean;
  confidence?: string | null;
  birth?: FamilyEvent;
  death?: FamilyEvent;
  burial?: FamilyEvent;
  otherNames?: string[];
  facts?: FamilyFact[];
  parents?: FamilyParentLink[];
  spouses?: string[];
  children?: string[];
  records?: string[];
  wrongRecords?: Record<string, string>;
  memorials?: string[];
  wrongMemorials?: Record<string, string>;
  media?: string[];
  notes?: string[];
  history?: string[];
  duplicateOf?: string | null;
  duplicateWhy?: string | null;
  conflict?: FamilyConflict | null;
  ownerRelation?: string;
  ownerGroup?: string;
}

export interface FamilyRecord {
  key: string;
  collection?: string;
  name?: string;
  fields?: string[][];
  tables?: string[][][];
  citation?: string;
  url?: string;
  image?: string | null;
}

export interface FamilyMemorialRelative {
  memorial_id?: string;
  name?: string;
  dates?: string | null;
}

export interface FamilyMemorialPhoto {
  media?: string | null;
  caption?: string | null;
}

export interface FamilyMemorial {
  id: string;
  name?: string;
  birth_date?: string | null;
  birth_place?: string | null;
  death_date?: string | null;
  death_place?: string | null;
  cemetery?: string | null;
  cemetery_place?: string | null;
  plot?: string | null;
  inscription?: string | null;
  bio?: string | null;
  url?: string | null;
  family?: Record<string, FamilyMemorialRelative[]>;
  photos?: FamilyMemorialPhoto[];
  family_notes?: string[];
}

export interface FamilyMedia {
  id: string;
  kind: FamilyMediaKind;
  /** "media/<id>.<ext>", relative to the prefix. */
  file: string;
  caption?: string;
  people?: string[];
  bytes?: number;
  date?: string;
  place?: string;
  description?: string;
  media_kind?: string;
}

export interface FamilyFinding {
  summary: string;
  people: string[];
}

export interface FamilyStory {
  slug: string;
  title: string;
  /** Markdown, relative to the version folder. */
  file: string;
  words?: number;
}

export interface FamilyBundle {
  version: string;
  generated?: string;
  owner: string;
  counts?: Record<string, number>;
  anchors: string[];
  people: Record<string, FamilyPerson>;
  records: Record<string, FamilyRecord>;
  memorials: Record<string, FamilyMemorial>;
  media: Record<string, FamilyMedia>;
  findings: FamilyFinding[];
  stories: FamilyStory[];
  sources?: Record<string, { title?: string }>;
}

export interface FamilyRelation {
  term: string;
  group: FamilyRelationGroup;
  gen?: number | null;
  distance?: number;
  path?: string[];
  pathText?: string;
  notes?: string[];
}

export interface FamilyView {
  anchor: string;
  relations: Record<string, FamilyRelation>;
}

export interface FamilyHistoryAccount extends LibraryAccount {
  /** A tree id like "@I123@" the owner matched this account to. */
  kadeFamilyTreePerson?: string | null;
  kadeFamilyHistory?: 'guest' | 'none' | null;
}

export interface FamilyHistoryViewer {
  personId: string;
  mode: FamilyHistoryMode;
}

export interface FamilyPersonRef {
  id: string;
  label: string;
  lifespan: string;
  relation?: FamilyRelation;
}

export interface FamilyMember extends FamilyPersonRef {
  kind?: FamilyParentKind | 'half' | 'step';
}

export interface FamilyFamily {
  parents: FamilyMember[];
  spouses: FamilyMember[];
  children: FamilyMember[];
  siblings: FamilyMember[];
}

export interface FamilyRecordView extends FamilyRecord {
  /** Why this record is attached to the person in the tree but is about someone else. */
  wrong?: string;
}

export interface FamilyMemorialPhotoView {
  id: string;
  caption: string;
}

export interface FamilyMemorialView extends Omit<FamilyMemorial, 'photos'> {
  photos: FamilyMemorialPhotoView[];
  wrong?: string;
}

export interface FamilyFindingView {
  summary: string;
  people: FamilyPersonRef[];
}

export interface FamilyPersonPayload {
  person: FamilyPerson & { relation: FamilyRelation | null };
  family: FamilyFamily;
  records: FamilyRecordView[];
  memorials: FamilyMemorialView[];
  media: FamilyMedia[];
  findings: FamilyFindingView[];
}

export interface FamilyTreeNode {
  id: string;
  label: string;
  lifespan: string;
  sex: string | null;
  relation?: FamilyRelation;
  living: boolean;
  virtual: boolean;
  /** A tree photo's media id, for the chart box. */
  photo?: string;
}

export interface FamilyTreeLink {
  parent: string;
  child: string;
  kind: FamilyParentKind;
}

export interface FamilyTree {
  focus: string;
  up: number;
  down: number;
  nodes: FamilyTreeNode[];
  links: FamilyTreeLink[];
  couples: [string, string][];
}

export interface FamilyPeopleRow {
  id: string;
  label: string;
  lifespan: string;
  relation: FamilyRelation | null;
  group: FamilyPeopleGroup;
  gen?: number;
  distance?: number;
}

export interface FamilySearchEntry {
  id: string;
  /** Folded name, other names and birth surname, with a leading space for word starts. */
  words: string;
  /** The same words with no spaces, so "mc donald" finds "McDonald". */
  compact: string;
  duplicate: boolean;
}

export interface FamilyStoryListing {
  slug: string;
  title: string;
  words: number;
}

export interface FamilyStoryPayload {
  slug: string;
  title: string;
  markdown: string;
}

export interface FamilyHistoryAccountRow {
  userId: string;
  name: string;
  username: string;
  personId: string | null;
  personLabel: string | null;
  access: FamilyHistoryAccess;
  testSeat: boolean;
  /** False for accounts POST /match refuses: administrators and test seats. */
  changeable: boolean;
}

export interface FamilyHistoryUserFields {
  kadeFamilyTreePerson: string | null;
  kadeFamilyHistory: 'guest' | 'none' | null;
}

export interface FamilyHistoryMatch {
  userId: string;
  fields: FamilyHistoryUserFields;
}

export interface FamilyHistoryDependencies {
  auth: RequestHandler;
  /** The object's bytes (gunzipped for *.gz keys), or null when it does not exist. */
  loadObject: (key: string) => Promise<Buffer | null>;
  signGet: (key: string, mime: string, seconds: number) => Promise<string>;
  findUsers: () => Promise<FamilyHistoryAccount[]>;
  /** Null values are removed from the account. Answers the account after the change, or null. */
  setUserFields: (
    id: string,
    fields: FamilyHistoryUserFields,
  ) => Promise<FamilyHistoryAccount | null>;
  now?: () => number;
  /** Defaults to KADE_FAMILY_HISTORY_PREFIX or 'family-history'. */
  prefix?: string;
  log?: (message: string) => void;
}

export const FAMILY_HISTORY_PRIVATE: string = 'The family history is private to the family.';
export const FAMILY_HISTORY_UPDATING: string =
  'The family history is being updated. Try again in a minute.';
export const FAMILY_HISTORY_OWNER_ONLY: string =
  'Only the owner of the family tree can see and change who has access.';
export const FAMILY_HISTORY_VIEW_NOTE: string =
  "Your own place in the tree has not been mapped yet, so relationships are shown from the tree owner's place for now.";
export const FAMILY_HISTORY_CACHE_MS: number = 10 * 60 * 1000;
export const FAMILY_HISTORY_MEDIA_SECONDS: number = 3600;
export const FAMILY_SEARCH_LIMIT: number = 50;
export const FAMILY_TREE_LIMITS: {
  up: { fallback: number; max: number };
  down: { fallback: number; max: number };
} = { up: { fallback: 4, max: 8 }, down: { fallback: 2, max: 4 } };

const RETRY_MS = 60 * 1000;
const VIEW_CACHE_LIMIT = 48;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORY_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const STORY_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/;
const MEDIA_FILE = /^media\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const PORTRAIT = /\.(?:jpe?g|png|gif|webp)$/i;
const FIRM_PARENT: ReadonlySet<string> = new Set(['birth', 'probable', 'adopted']);
const PEOPLE_GROUPS: ReadonlySet<string> = new Set([
  'self',
  'ancestor',
  'descendant',
  'blood',
  'marriage',
  'none',
  'all',
]);
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  /** Saved Ancestry and Find a Grave pages open as their source text, so none of their scripts
   * or trackers run on the bucket's origin. */
  htm: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  doc: 'application/msword',
};
/** Sort ranks: a married-in person with no linked spouse, then nobody related, then duplicates. */
const FAR = 900;
const UNRELATED = 1000;
const DUPLICATE = 2000;

/** Own properties only: a tree id of "constructor" must not find Object's. */
function own<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function accountIdOf(user: FamilyHistoryAccount): string {
  return String(user.id || user._id?.toString() || '');
}

function queryText(value: Request['query'][string]): string {
  return typeof value === 'string' ? value : '';
}

export function familyHistoryPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KADE_FAMILY_HISTORY_PREFIX || 'family-history').replace(/^\/+|\/+$/g, '');
}

/** The tree id to show for this id: a duplicate entry's main person, or the id itself. */
export function familyPersonId(bundle: FamilyBundle, id: string): string | null {
  const person = own(bundle.people, id);
  if (!person) return null;
  return person.duplicateOf && own(bundle.people, person.duplicateOf) ? person.duplicateOf : id;
}

/**
 * Who this account sees the tree as, or null when it may not see it:
 * the review seat and test seats never, whatever else they carry (the owner's decision); a matched
 * person (a duplicate entry's main person); an admin as the owner; a guest from the owner's place;
 * everyone else never.
 */
export function familyHistoryViewer(
  user: FamilyHistoryAccount | null | undefined,
  bundle: FamilyBundle,
): FamilyHistoryViewer | null {
  if (!user || libraryReviewSeat(user) || libraryTestSeat(user)) return null;
  const matched = user.kadeFamilyTreePerson
    ? familyPersonId(bundle, user.kadeFamilyTreePerson)
    : null;
  if (matched) return { personId: matched, mode: 'family' };
  if (user.role === 'ADMIN') return { personId: bundle.owner, mode: 'owner' };
  if (user.kadeFamilyHistory === 'guest') return { personId: bundle.owner, mode: 'guest' };
  return null;
}

/** False when no bundle could let this account in, so a stranger never costs a bucket read. */
export function familyHistoryCandidate(user: FamilyHistoryAccount | null | undefined): boolean {
  if (!user || libraryReviewSeat(user) || libraryTestSeat(user)) return false;
  return !!user.kadeFamilyTreePerson || user.role === 'ADMIN' || user.kadeFamilyHistory === 'guest';
}

function personRef(bundle: FamilyBundle, view: FamilyView, id: string): FamilyPersonRef | null {
  const person = own(bundle.people, id);
  if (!person) return null;
  const relation = own(view.relations, id);
  return {
    id,
    label: person.label,
    lifespan: person.lifespan || '',
    ...(relation ? { relation } : {}),
  };
}

function members(
  bundle: FamilyBundle,
  view: FamilyView,
  links: { id: string; kind?: FamilyMember['kind'] }[],
): FamilyMember[] {
  const out: FamilyMember[] = [];
  for (const link of links) {
    const ref = personRef(bundle, view, link.id);
    if (ref) out.push(link.kind ? { ...ref, kind: link.kind } : ref);
  }
  return out;
}

/** How the child's own entry links it to this parent, or undefined when it does not. */
function linkKind(
  bundle: FamilyBundle,
  childId: string,
  parentId: string,
): FamilyParentKind | undefined {
  return own(bundle.people, childId)?.parents?.find((link) => link.id === parentId)?.kind;
}

/**
 * Everyone sharing a parent; 'half' shares only some of the person's birth parents, 'step' none,
 * and 'doubtful' is reached only through a doubtful link (a research finding, not proven).
 */
export function familySiblings(
  bundle: FamilyBundle,
  id: string,
): { id: string; kind?: 'half' | 'step' | 'doubtful' }[] {
  const person = own(bundle.people, id);
  if (!person) return [];
  const shared = new Map<string, number>();
  const settled = new Set<string>();
  let firmParents = 0;
  for (const link of person.parents || []) {
    const parent = own(bundle.people, link.id);
    if (!parent) continue;
    const firm = FIRM_PARENT.has(link.kind);
    if (firm) firmParents++;
    for (const childId of parent.children || []) {
      if (childId === id || !own(bundle.people, childId)) continue;
      const theirs = linkKind(bundle, childId, link.id);
      const count = shared.get(childId) || 0;
      shared.set(childId, count + (firm && theirs && FIRM_PARENT.has(theirs) ? 1 : 0));
      if (link.kind !== 'doubtful' && theirs !== 'doubtful') settled.add(childId);
    }
  }
  const out: { id: string; kind?: 'half' | 'step' | 'doubtful' }[] = [];
  shared.forEach((count, siblingId) => {
    if (count === 0)
      out.push({ id: siblingId, kind: settled.has(siblingId) ? 'step' : 'doubtful' });
    else if (count < firmParents) out.push({ id: siblingId, kind: 'half' });
    else out.push({ id: siblingId });
  });
  return out;
}

function findingView(
  bundle: FamilyBundle,
  view: FamilyView,
  finding: FamilyFinding,
): FamilyFindingView {
  const people: FamilyPersonRef[] = [];
  for (const id of finding.people || []) {
    const ref = personRef(bundle, view, id);
    if (ref) people.push(ref);
  }
  return { summary: finding.summary, people };
}

/** Every research finding, or only those naming one person. */
export function familyFindings(
  bundle: FamilyBundle,
  view: FamilyView,
  personId?: string,
): FamilyFindingView[] {
  const out: FamilyFindingView[] = [];
  for (const finding of bundle.findings) {
    if (personId && !(finding.people || []).includes(personId)) continue;
    out.push(findingView(bundle, view, finding));
  }
  return out;
}

function memorialView(
  bundle: FamilyBundle,
  memorial: FamilyMemorial,
  wrong: string | undefined,
): FamilyMemorialView {
  const photos: FamilyMemorialPhotoView[] = [];
  for (const photo of memorial.photos || []) {
    if (photo.media && own(bundle.media, photo.media))
      photos.push({ id: photo.media, caption: photo.caption || '' });
  }
  return { ...memorial, photos, ...(wrong ? { wrong } : {}) };
}

function withoutRecords({ records: _records, ...fact }: FamilyFact): FamilyFact {
  return fact;
}

/** How this child is linked to this parent, when it is anything but a birth link. */
function childLink(bundle: FamilyBundle, parentId: string, childId: string): FamilyMember['kind'] {
  const kind = linkKind(bundle, childId, parentId);
  return kind && kind !== 'birth' ? kind : undefined;
}

/**
 * One person, with their family, records, graves, pictures and findings, related to the viewer.
 * A living person gets only what the export left on them: their facts still name source records
 * (public-records indexes carry addresses), so those keys are neither followed nor sent.
 */
export function familyPersonPayload(
  bundle: FamilyBundle,
  view: FamilyView,
  id: string,
): FamilyPersonPayload | null {
  const person = own(bundle.people, id);
  if (!person) return null;
  const living = !!person.living;
  const wrongRecords = living ? {} : person.wrongRecords || {};
  const wrongMemorials = living ? {} : person.wrongMemorials || {};
  const recordKeys = new Set<string>(person.records || []);
  if (!living) {
    for (const fact of person.facts || [])
      for (const key of fact.records || []) recordKeys.add(key);
    for (const key of Object.keys(wrongRecords)) recordKeys.add(key);
  }
  const records: FamilyRecordView[] = [];
  recordKeys.forEach((key) => {
    const record = own(bundle.records, key);
    const wrong = own(wrongRecords, key);
    if (record) records.push(wrong ? { ...record, wrong } : record);
  });
  const memorialIds = new Set<string>([
    ...(person.memorials || []),
    ...Object.keys(wrongMemorials),
  ]);
  const memorials: FamilyMemorialView[] = [];
  memorialIds.forEach((mid) => {
    const memorial = own(bundle.memorials, mid);
    if (memorial) memorials.push(memorialView(bundle, memorial, own(wrongMemorials, mid)));
  });
  const media: FamilyMedia[] = [];
  const mediaIds = new Set<string>();
  const addMedia = (mediaId: string | null | undefined): void => {
    const item = mediaId && !mediaIds.has(mediaId) ? own(bundle.media, mediaId) : undefined;
    if (!item) return;
    mediaIds.add(item.id);
    media.push(item);
  };
  for (const mediaId of person.media || []) addMedia(mediaId);
  for (const record of records) if (!record.wrong) addMedia(record.image);
  return {
    person: {
      ...person,
      ...(living ? { facts: (person.facts || []).map(withoutRecords) } : {}),
      relation: own(view.relations, id) || null,
    },
    family: {
      parents: members(bundle, view, person.parents || []),
      spouses: members(
        bundle,
        view,
        (person.spouses || []).map((spouse) => ({ id: spouse })),
      ),
      children: members(
        bundle,
        view,
        (person.children || []).map((child) => ({ id: child, kind: childLink(bundle, id, child) })),
      ),
      siblings: members(bundle, view, familySiblings(bundle, id)),
    },
    records,
    memorials,
    media,
    findings: familyFindings(bundle, view, id),
  };
}

/** The query's generations, defaulted and capped ("", "abc" and -3 are not errors). */
export function familyTreeDepth(text: string, fallback: number, max: number): number {
  const n = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(n)));
}

function portrait(bundle: FamilyBundle, person: FamilyPerson): string | undefined {
  for (const mediaId of person.media || []) {
    const item = own(bundle.media, mediaId);
    if (item && item.kind === 'tree' && PORTRAIT.test(item.file)) return mediaId;
  }
  return undefined;
}

function walk(
  bundle: FamilyBundle,
  start: string,
  steps: number,
  next: (person: FamilyPerson) => string[],
  into: Set<string>,
): void {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let step = 0; step < steps && frontier.length; step++) {
    const found: string[] = [];
    for (const id of frontier) {
      const person = own(bundle.people, id);
      if (!person) continue;
      for (const nextId of next(person)) {
        if (seen.has(nextId) || !own(bundle.people, nextId)) continue;
        seen.add(nextId);
        into.add(nextId);
        found.push(nextId);
      }
    }
    frontier = found;
  }
}

/** Ancestors `up` generations, descendants `down`, and the focus person's siblings and spouses. */
export function familyTreeSlice(
  bundle: FamilyBundle,
  view: FamilyView,
  focus: string,
  up: number,
  down: number,
): FamilyTree | null {
  const center = own(bundle.people, focus);
  if (!center) return null;
  const ids = new Set<string>([focus]);
  walk(bundle, focus, up, (person) => (person.parents || []).map((link) => link.id), ids);
  walk(bundle, focus, down, (person) => person.children || [], ids);
  for (const sibling of familySiblings(bundle, focus)) ids.add(sibling.id);
  for (const spouse of center.spouses || []) if (own(bundle.people, spouse)) ids.add(spouse);
  const nodes: FamilyTreeNode[] = [];
  const links: FamilyTreeLink[] = [];
  const couples: [string, string][] = [];
  const paired = new Set<string>();
  ids.forEach((id) => {
    const person = own(bundle.people, id) as FamilyPerson;
    const relation = own(view.relations, id);
    const photo = portrait(bundle, person);
    nodes.push({
      id,
      label: person.label,
      lifespan: person.lifespan || '',
      sex: person.sex || null,
      ...(relation ? { relation } : {}),
      living: !!person.living,
      virtual: !!person.virtual,
      ...(photo ? { photo } : {}),
    });
    for (const link of person.parents || [])
      if (ids.has(link.id)) links.push({ parent: link.id, child: id, kind: link.kind });
    for (const spouse of person.spouses || []) {
      const pair = id < spouse ? `${id} ${spouse}` : `${spouse} ${id}`;
      if (!ids.has(spouse) || paired.has(pair)) continue;
      paired.add(pair);
      couples.push([id, spouse]);
    }
  });
  return { focus, up, down, nodes, links, couples };
}

/** Lower-case, no accents, no apostrophes, every other mark a space. */
export function familyFold(text: string): string {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Built once per bundle so a search is one pass over folded strings. */
export function familySearchIndex(bundle: FamilyBundle): FamilySearchEntry[] {
  return Object.keys(bundle.people).map((id) => {
    const person = bundle.people[id];
    const words = familyFold(
      [person.name, ...(person.otherNames || []), person.birthSurname || ''].join(' '),
    );
    return {
      id,
      words: ` ${words}`,
      compact: words.replace(/ /g, ''),
      duplicate: !!person.duplicateOf,
    };
  });
}

/** How near a person is to the viewer: self 0, then relation distance; married-in people by the
 * nearest spouse they married plus one. */
export function familyNearness(bundle: FamilyBundle, view: FamilyView, id: string): number {
  const person = own(bundle.people, id);
  if (!person || person.duplicateOf) return DUPLICATE;
  const direct = (relation: FamilyRelation | undefined): number | null => {
    if (!relation) return null;
    if (relation.group === 'self') return 0;
    if (typeof relation.distance === 'number') return relation.distance;
    if (typeof relation.gen === 'number') return Math.abs(relation.gen);
    return null;
  };
  const relation = own(view.relations, id);
  if (!relation) return UNRELATED;
  const near = direct(relation);
  if (near !== null) return near;
  let best = FAR;
  for (const spouse of person.spouses || []) {
    const through = direct(own(view.relations, spouse));
    if (through !== null) best = Math.min(best, through + 1);
  }
  return best;
}

function byLabel(bundle: FamilyBundle, a: string, b: string): number {
  return (own(bundle.people, a)?.label || '').localeCompare(own(bundle.people, b)?.label || '');
}

/** Up to 50 people whose names match every word; relatives first, nearest first, then the rest. */
export function familySearch(
  bundle: FamilyBundle,
  view: FamilyView,
  query: string,
  index: FamilySearchEntry[] = familySearchIndex(bundle),
  limit: number = FAMILY_SEARCH_LIMIT,
): FamilyPersonRef[] {
  const folded = familyFold(query.slice(0, 120));
  if (!folded) return [];
  const tokens = folded.split(' ');
  const compact = tokens.join('');
  const hits: { id: string; near: number; quality: number }[] = [];
  for (const entry of index) {
    const spaced = tokens.every((token) => entry.words.includes(token));
    if (!spaced && !entry.compact.includes(compact)) continue;
    const quality = tokens.every((token) => entry.words.includes(` ${token}`)) ? 0 : 1;
    hits.push({ id: entry.id, near: familyNearness(bundle, view, entry.id), quality });
  }
  hits.sort((a, b) => a.near - b.near || a.quality - b.quality || byLabel(bundle, a.id, b.id));
  const out: FamilyPersonRef[] = [];
  for (const hit of hits.slice(0, limit)) {
    const ref = personRef(bundle, view, hit.id);
    if (ref) out.push(ref);
  }
  return out;
}

export function familyPeopleGroup(text: string): FamilyPeopleGroup | 'all' | null {
  const group = text || 'all';
  return PEOPLE_GROUPS.has(group) ? (group as FamilyPeopleGroup | 'all') : null;
}

/** Everyone in a group (duplicate entries left out), nearest first; ancestors by generation. */
export function familyPeople(
  bundle: FamilyBundle,
  view: FamilyView,
  group: FamilyPeopleGroup | 'all',
): FamilyPeopleRow[] {
  const rows: { row: FamilyPeopleRow; near: number }[] = [];
  for (const id of Object.keys(bundle.people)) {
    const person = bundle.people[id];
    if (person.duplicateOf) continue;
    const relation = own(view.relations, id) || null;
    const rowGroup: FamilyPeopleGroup = relation ? relation.group : 'none';
    if (group !== 'all' && group !== rowGroup) continue;
    const row: FamilyPeopleRow = {
      id,
      label: person.label,
      lifespan: person.lifespan || '',
      relation,
      group: rowGroup,
      ...(typeof relation?.gen === 'number' ? { gen: relation.gen } : {}),
      ...(typeof relation?.distance === 'number' ? { distance: relation.distance } : {}),
    };
    rows.push({ row, near: familyNearness(bundle, view, id) });
  }
  rows.sort((a, b) => a.near - b.near || byLabel(bundle, a.row.id, b.row.id));
  return rows.map((entry) => entry.row);
}

export function familyStories(bundle: FamilyBundle): FamilyStoryListing[] {
  return bundle.stories.map((story) => ({
    slug: story.slug,
    title: story.title || story.slug,
    words: Number(story.words) || 0,
  }));
}

/** The story and its file, or null for an unknown slug or a file path that leaves its folder. */
export function familyStory(bundle: FamilyBundle, slug: string): FamilyStory | null {
  if (!STORY_SLUG.test(slug)) return null;
  const story = bundle.stories.find((entry) => entry.slug === slug);
  if (!story || !STORY_FILE.test(story.file || '') || story.file.split('/').includes('..'))
    return null;
  return story;
}

function printable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 9 || code === 10 || (code >= 32 && code !== 127);
}

/** Markdown with no raw HTML, no control characters and plain line ends; autolinks survive. */
export function familyStoryMarkdown(text: string): string {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, '')
    .split('')
    .filter(printable)
    .join('');
}

export function familyStoryPayload(story: FamilyStory, text: string): FamilyStoryPayload {
  return {
    slug: story.slug,
    title: story.title || story.slug,
    markdown: familyStoryMarkdown(text),
  };
}

/** The bucket key and type for a media id the bundle names, or null. */
export function familyMediaObject(
  bundle: FamilyBundle,
  prefix: string,
  id: string,
): { key: string; mime: string } | null {
  const item = own(bundle.media, id);
  if (!item || !MEDIA_FILE.test(item.file || '') || item.file.includes('..')) return null;
  const ext = item.file.slice(item.file.lastIndexOf('.') + 1).toLowerCase();
  return {
    key: `${prefix}/${item.file}`,
    mime: own(MEDIA_TYPES, ext) || 'application/octet-stream',
  };
}

/** Why the owner may not match this account, or null when she may. */
export function familyHistoryLocked(user: FamilyHistoryAccount): string | null {
  if (libraryReviewSeat(user))
    return 'The App Review account is always kept out of the family history.';
  if (libraryTestSeat(user)) return 'Test accounts are always kept out of the family history.';
  if (user.role === 'ADMIN') return 'An administrator always sees the family history as its owner.';
  return null;
}

export function familyHistoryAccountRow(
  user: FamilyHistoryAccount,
  bundle: FamilyBundle,
): FamilyHistoryAccountRow {
  const personId = user.kadeFamilyTreePerson || null;
  return {
    userId: accountIdOf(user),
    name: String(user.name || '').trim(),
    username: String(user.username || '').trim(),
    personId,
    personLabel: personId ? own(bundle.people, personId)?.label || null : null,
    access: familyHistoryViewer(user, bundle)?.mode || 'none',
    testSeat: libraryTestSeat(user),
    changeable: !familyHistoryLocked(user),
  };
}

/**
 * The owner's POST /match body, checked against the bundle: a person (a duplicate entry becomes
 * its main person), or no person and guest true/false.
 */
export function familyHistoryMatch(
  body: { userId?: unknown; personId?: unknown; guest?: unknown } | null | undefined,
  bundle: FamilyBundle,
): FamilyHistoryMatch | { error: string } {
  const { userId, personId, guest } = body || {};
  if (typeof userId !== 'string' || !OBJECT_ID.test(userId)) return { error: 'Choose an account.' };
  if (guest !== undefined && typeof guest !== 'boolean')
    return { error: 'Guest must be yes or no.' };
  if (personId === undefined || personId === null || personId === '') {
    return {
      userId,
      fields: { kadeFamilyTreePerson: null, kadeFamilyHistory: guest ? 'guest' : 'none' },
    };
  }
  const main = typeof personId === 'string' ? familyPersonId(bundle, personId) : null;
  if (!main) return { error: 'That person is not in the family tree.' };
  return { userId, fields: { kadeFamilyTreePerson: main, kadeFamilyHistory: null } };
}

/* ── loading ─────────────────────────────────────────────────────────── */

interface LoadedBundle {
  version: string;
  bundle: FamilyBundle;
  anchors: Set<string>;
  index: FamilySearchEntry[];
  views: Map<string, Promise<FamilyView | null>>;
  checkedAt: number;
}

/** The wrapper gunzips *.gz objects; bytes that still start with gzip's magic are unpacked here. */
function unpacked(buffer: Buffer): Buffer {
  return buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b
    ? gunzipSync(buffer)
    : buffer;
}

function parseJson<T>(buffer: Buffer | null): T | null {
  return buffer ? (JSON.parse(unpacked(buffer).toString('utf8')) as T) : null;
}

function completeBundle(raw: FamilyBundle | null, version: string): FamilyBundle {
  if (!raw || typeof raw.owner !== 'string' || !raw.people || !own(raw.people, raw.owner))
    throw new Error(`bundle ${version} has no owner in its people`);
  return {
    ...raw,
    version: raw.version || version,
    anchors: Array.isArray(raw.anchors) ? raw.anchors : [],
    records: raw.records || {},
    memorials: raw.memorials || {},
    media: raw.media || {},
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    stories: Array.isArray(raw.stories) ? raw.stories : [],
  };
}

function bundleCounts(bundle: FamilyBundle): Record<string, number> {
  return (
    bundle.counts || {
      people: Object.keys(bundle.people).length,
      records: Object.keys(bundle.records).length,
      memorials: Object.keys(bundle.memorials).length,
      media: Object.keys(bundle.media).length,
      stories: bundle.stories.length,
      anchors: bundle.anchors.length,
    }
  );
}

function createFamilyStore(deps: FamilyHistoryDependencies, prefix: string) {
  const now = deps.now || Date.now;
  let current: LoadedBundle | null = null;
  let pending: Promise<LoadedBundle> | null = null;
  let retryAt = 0;

  const read = async <T>(path: string): Promise<T | null> =>
    parseJson<T>(await deps.loadObject(`${prefix}/${path}`));

  const refresh = async (): Promise<LoadedBundle> => {
    const pointer = await read<{ version?: string }>('current.json');
    const version = String(pointer?.version || '');
    if (!VERSION.test(version)) throw new Error('current.json names no version');
    if (current && current.version === version) {
      current.checkedAt = now();
      return current;
    }
    const bundle = completeBundle(await read<FamilyBundle>(`${version}/bundle.json.gz`), version);
    current = {
      version,
      bundle,
      anchors: new Set(bundle.anchors),
      index: familySearchIndex(bundle),
      views: new Map(),
      checkedAt: now(),
    };
    return current;
  };

  const loaded = (): Promise<LoadedBundle> => {
    const at = now();
    if (current && (at - current.checkedAt < FAMILY_HISTORY_CACHE_MS || at < retryAt))
      return Promise.resolve(current);
    if (pending) return pending;
    pending = refresh()
      .catch((error: Error) => {
        if (!current) throw error;
        retryAt = now() + RETRY_MS;
        deps.log?.(`kept version ${current.version}: ${error.message}`);
        return current;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  /** An anchor's view, or null when it has none; loads once per version. */
  const view = (state: LoadedBundle, anchor: string): Promise<FamilyView | null> => {
    if (!state.anchors.has(anchor)) return Promise.resolve(null);
    const cached = state.views.get(anchor);
    if (cached) return cached;
    const file = `${state.version}/views/${anchor.replace(/@/g, '')}.json.gz`;
    const loading = read<FamilyView>(file).then((raw) =>
      raw && raw.relations && typeof raw.relations === 'object'
        ? { anchor: raw.anchor || anchor, relations: raw.relations }
        : null,
    );
    loading.catch(() => state.views.delete(anchor));
    state.views.set(anchor, loading);
    if (state.views.size > VIEW_CACHE_LIMIT) {
      const oldest = state.views.keys().next().value;
      if (oldest !== undefined && oldest !== anchor) state.views.delete(oldest);
    }
    return loading;
  };

  return { loaded, view };
}

/* ── the routes ──────────────────────────────────────────────────────── */

interface FamilyContext {
  state: LoadedBundle;
  bundle: FamilyBundle;
  user: FamilyHistoryAccount;
  viewer: FamilyHistoryViewer;
  view: FamilyView;
  viewNote?: string;
  ownerView: () => Promise<FamilyView | null>;
}

type FamilyHandler = (req: Request, res: Response, ctx: FamilyContext) => Promise<void> | void;
type OwnerHandler = (req: Request, res: Response, state: LoadedBundle) => Promise<void> | void;

const signedIn = (req: Request): FamilyHistoryAccount | undefined =>
  (req as Request & { user?: FamilyHistoryAccount }).user;

/**
 * GET  /me /person/:id /tree /search /people /stories /story/:slug /findings /media/:id
 * GET  /accounts, POST /match   the owner only
 * Every answer is JSON with Cache-Control: no-store (a media redirect is a 302).
 */
export function familyHistoryRouter(deps: FamilyHistoryDependencies): Router {
  const router = Router();
  const prefix = deps.prefix || familyHistoryPrefix();
  const store = createFamilyStore(deps, prefix);
  const fail = (res: Response, error: Error): void => {
    deps.log?.(error.message);
    if (!res.headersSent) res.status(503).json({ error: FAMILY_HISTORY_UPDATING });
  };
  const deny = (res: Response): void => {
    res.status(403).json({ access: false, error: FAMILY_HISTORY_PRIVATE });
  };

  /** The viewer and their view, null when refused; throws when the bundle or views cannot load. */
  const contextFor = async (user: FamilyHistoryAccount): Promise<FamilyContext | null> => {
    const state = await store.loaded();
    const viewer = familyHistoryViewer(user, state.bundle);
    if (!viewer) return null;
    const ownerView = (): Promise<FamilyView | null> => store.view(state, state.bundle.owner);
    const mine = await store.view(state, viewer.personId);
    const view = mine || (await ownerView());
    if (!view) throw new Error(`no view for ${viewer.personId} and none for the owner`);
    return {
      state,
      bundle: state.bundle,
      user,
      viewer,
      view,
      ...(mine ? {} : { viewNote: FAMILY_HISTORY_VIEW_NOTE }),
      ownerView,
    };
  };

  const family =
    (handler: FamilyHandler): RequestHandler =>
    async (req, res) => {
      const user = signedIn(req);
      if (!user || !familyHistoryCandidate(user)) return deny(res);
      let ctx: FamilyContext | null = null;
      try {
        ctx = await contextFor(user);
      } catch (error) {
        return fail(res, error as Error);
      }
      if (!ctx) return deny(res);
      try {
        await handler(req, res, ctx);
      } catch (error) {
        fail(res, error as Error);
      }
    };

  const owner =
    (handler: OwnerHandler): RequestHandler =>
    async (req, res) => {
      const user = signedIn(req);
      if (!user || user.role !== 'ADMIN' || libraryReviewSeat(user)) {
        res.status(403).json({ error: FAMILY_HISTORY_OWNER_ONLY });
        return;
      }
      try {
        await handler(req, res, await store.loaded());
      } catch (error) {
        fail(res, error as Error);
      }
    };

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(deps.auth);

  router.get(
    '/me',
    family(async (_req, res, ctx) => {
      const person = own(ctx.bundle.people, ctx.viewer.personId) as FamilyPerson;
      const ownerView = await ctx.ownerView();
      res.json({
        access: true,
        viewer: {
          personId: ctx.viewer.personId,
          name: person.name,
          label: person.label,
          relationToOwner: (ownerView && own(ownerView.relations, ctx.viewer.personId)) || null,
        },
        mode: ctx.viewer.mode,
        isOwner: ctx.user.role === 'ADMIN',
        version: ctx.state.version,
        counts: bundleCounts(ctx.bundle),
        ...(ctx.viewNote ? { viewNote: ctx.viewNote } : {}),
      });
    }),
  );

  router.get(
    '/person/:id',
    family((req, res, ctx) => {
      const payload = familyPersonPayload(ctx.bundle, ctx.view, String(req.params.id || ''));
      if (!payload) {
        res.status(404).json({ error: 'That person is not in the family tree.' });
        return;
      }
      res.json(payload);
    }),
  );

  router.get(
    '/tree',
    family((req, res, ctx) => {
      const asked = queryText(req.query.focus);
      const focus = asked ? familyPersonId(ctx.bundle, asked) : ctx.viewer.personId;
      const { up, down } = FAMILY_TREE_LIMITS;
      const tree = focus
        ? familyTreeSlice(
            ctx.bundle,
            ctx.view,
            focus,
            familyTreeDepth(queryText(req.query.up), up.fallback, up.max),
            familyTreeDepth(queryText(req.query.down), down.fallback, down.max),
          )
        : null;
      if (!tree) {
        res.status(404).json({ error: 'That person is not in the family tree.' });
        return;
      }
      res.json(tree);
    }),
  );

  router.get(
    '/search',
    family((req, res, ctx) => {
      res.json(familySearch(ctx.bundle, ctx.view, queryText(req.query.q), ctx.state.index));
    }),
  );

  router.get(
    '/people',
    family((req, res, ctx) => {
      const group = familyPeopleGroup(queryText(req.query.group));
      if (!group) {
        res.status(400).json({ error: 'Choose ancestor, blood, marriage or all.' });
        return;
      }
      res.json(familyPeople(ctx.bundle, ctx.view, group));
    }),
  );

  router.get(
    '/stories',
    family((_req, res, ctx) => {
      res.json(familyStories(ctx.bundle));
    }),
  );

  router.get(
    '/story/:slug',
    family(async (req, res, ctx) => {
      const story = familyStory(ctx.bundle, String(req.params.slug || ''));
      const text = story
        ? await deps.loadObject(`${prefix}/${ctx.state.version}/${story.file}`)
        : null;
      if (!story || !text) {
        res.status(404).json({ error: 'That story was not found.' });
        return;
      }
      res.json(familyStoryPayload(story, unpacked(text).toString('utf8')));
    }),
  );

  router.get(
    '/findings',
    family((_req, res, ctx) => {
      res.json(familyFindings(ctx.bundle, ctx.view));
    }),
  );

  router.get(
    '/media/:id',
    family(async (req, res, ctx) => {
      const object = familyMediaObject(ctx.bundle, prefix, String(req.params.id || ''));
      if (!object) {
        res.status(404).json({ error: 'That picture is not in the family history.' });
        return;
      }
      const url = await deps.signGet(object.key, object.mime, FAMILY_HISTORY_MEDIA_SECONDS);
      if (queryText(req.query.redirect) === '1') {
        res.redirect(302, url);
        return;
      }
      res.json({ url });
    }),
  );

  router.get(
    '/accounts',
    owner(async (_req, res, state) => {
      const rows = (await deps.findUsers())
        .filter((user) => !libraryReviewSeat(user))
        .map((user) => familyHistoryAccountRow(user, state.bundle));
      rows.sort(
        (a, b) =>
          (a.name || a.username).localeCompare(b.name || b.username) ||
          a.userId.localeCompare(b.userId),
      );
      res.json(rows);
    }),
  );

  router.post(
    '/match',
    json({ limit: '4kb' }),
    owner(async (req, res, state) => {
      const match = familyHistoryMatch(req.body, state.bundle);
      if ('error' in match) {
        res.status(400).json({ error: match.error });
        return;
      }
      const target = (await deps.findUsers()).find((user) => accountIdOf(user) === match.userId);
      if (!target) {
        res.status(404).json({ error: 'That account was not found.' });
        return;
      }
      const locked = familyHistoryLocked(target);
      if (locked) {
        res.status(409).json({ error: locked });
        return;
      }
      const after = await deps.setUserFields(match.userId, match.fields);
      if (!after) {
        res.status(404).json({ error: 'That account was not found.' });
        return;
      }
      deps.log?.(
        `match ${match.userId} -> ${match.fields.kadeFamilyTreePerson || match.fields.kadeFamilyHistory} by ${accountIdOf(signedIn(req) as FamilyHistoryAccount)}`,
      );
      res.json({ ok: true, account: familyHistoryAccountRow(after, state.bundle) });
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  return router;
}
