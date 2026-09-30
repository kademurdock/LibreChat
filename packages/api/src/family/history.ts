import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Router, json } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { LibraryAccount } from '../library/access';
import { libraryReviewSeat, libraryTestSeat } from '../library/access';
import type { FamilyAudience } from './util';
import {
  FAMILY_MONTH_NAMES,
  familyFirstName,
  familyInt,
  familyMediaVisible,
  familyPortraitIdentity,
} from './util';
import {
  familyCapital,
  familyGenerationName,
  familyPageSpoken,
  familyTermText,
  familyVoice,
} from './words';
import type { FamilyLens } from './derive';
import { familyLens, familyModel } from './derive';
import type { FamilyDnaFindings, FamilyPageContext } from './pages';
import {
  familyFindingsV2,
  familyGallery,
  familyHomePayload,
  familyMediaInfo,
  familyMysteriesAllowed,
  familyPersonV2,
  familyStoriesV2,
  familyStoryV2,
  familyTreeExtras,
} from './pages';
import type { FamilySignCacheEntry } from './present';
import {
  familyFileMime,
  familyImage,
  familyPersonCards,
  familyPresenter,
  familySigner,
} from './present';
import { familyDnaForAllowed, familyDnaPayload, familyDnaSelf } from './dna';
import { familyPlacesPayload, familyTimelinePayload } from './timeline';
import { familyPlayPayload } from './play';
import type { FamilyNote } from './inbox';
import {
  FAMILY_NOTES_PER_DAY,
  FAMILY_NOTE_KIND_TEXT,
  familyNoteId,
  familyNoteIdValid,
  familyNoteKey,
  familyNoteRequest,
} from './inbox';
import type { FamilyListener } from './listen';
import { familyListener } from './listen';
import type { FamilyStoryPart } from './story';
import {
  familyCues,
  familySourceLookup,
  familyStoryBlocks,
  familyStoryHash,
  familyStoryParts,
} from './story';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY (Sep 29 2026, docs/FAMILY_HISTORY.md is the contract)
 *
 * The owner's family research, served only to accounts matched to a person in
 * the tree, to admins (the owner) and to guests the owner lets in one by one.
 * The App Review seat and test seats never get in, and cannot be matched.
 * Every relationship is said from the viewer's place, read from that person's
 * view file (the owner's view, with a note, when theirs was not built).
 * Owner mode belongs to one account: KADE_FH_OWNER_USER_ID, or while that is
 * unset any administrator not matched to someone else (the v1 rule). The
 * family sees the research as the owner does (her decision, Sep 29 2026):
 * living relatives in full, records as they are. Strangers, test seats and the
 * App Review seat see nothing at all.
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
export type FamilyMediaKind = 'record' | 'grave' | 'tree' | 'codex' | 'web' | 'restored';
export type FamilyHistoryRefusalReason = 'review' | 'test' | 'unmatched' | 'declined';

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
  /* Export v2. */
  /** The export's best portrait of this person (a media id). */
  portrait?: string | null;
  /** How many sources the export left out whole because they name a DNA match. */
  withheld?: number;
  /** A research-only person's proof level. */
  research?: 'dna' | 'guess' | null;
  presumedLiving?: boolean;
  mayBeLiving?: boolean;
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
  /** A reviewed association that still needs a human identity check. */
  evidenceWarning?: string | null;
  /** Saved words and their actual source; an excerpt need not be a complete original. */
  sourceExcerpt?: string | null;
  sourceExcerptCoverage?: string | null;
  sourceCitation?: string | null;
  sourceUrl?: string | null;
  newspaperSource?: FamilyNewspaperSource;
  /** The export took contact details out (the record concerns a living relative). */
  scrubbed?: boolean;
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
  /** Tree ids of the only people (with the owner) who may see an item the export held back. */
  heldFor?: string[];
  /* Export v2 (every field optional; the server works without them). */
  /** portrait | photo | record | grave | document | story, when the export decided it. */
  category?: string;
  w?: number;
  h?: number;
  /** Sizes the bucket holds: t (400 px), s (2,048), l (4,096, big scans), f (a 256 px face crop),
   * o (a scan's original). Their files are in `sizeFiles`. */
  sizes?: string[];
  sizeFiles?: Record<string, FamilySizeFile>;
  /** Short visual alt text and a longer description, written offline ("Described automatically"). */
  alt?: string;
  text?: string | null;
  textAuto?: boolean;
  /** A story document's words, extracted by the export ("media/<id>.text.<hash>.txt"). */
  textFile?: string;
  textChars?: number;
  hasText?: boolean;
  isPortrait?: boolean;
  isPhotograph?: boolean;
  /** Faces as fractions of the picture. */
  faces?: FamilyFaceBox[];
  portraitPersonId?: string;
  portraitIdentityBasis?: 'single-linked-person-single-face' | 'reviewed-face-identity';
  describedBy?: string;
  /** On an original: the id of its restored copy. */
  restored?: string;
  /** On a restored copy (kind "restored"): its original's id. */
  restoredFrom?: string;
  restoredNotes?: string | null;
  faithful?: boolean | 'high' | 'medium' | 'low' | null;
  source?: FamilyMediaSource;
  evidenceWarning?: string | null;
  newspaperSource?: FamilyNewspaperSource;
  /** Several indexed relatives can share one physical newspaper scan. */
  newspaperSources?: Record<string, FamilyNewspaperSource>;
  webSource?: string;
}

export interface FamilyMediaSource {
  kind: string;
  title: string;
  citation?: string | null;
  url?: string | null;
}

export interface FamilyNewspaperSource {
  coverage?: string | null;
  indexedPersonRole?: string | null;
  principalArticleSubject?: string | null;
  identityReview?: { status?: string; note?: string } | null;
  linkedTreeIdentityVerified?: boolean;
  requestedSourceUrl?: string | null;
  sourceUrl?: string | null;
  citation?: string | null;
  limitations?: string[];
}

export interface FamilySizeFile {
  /** "media/<id>.<size>.<hash>.jpg", relative to the prefix. */
  file: string;
  w?: number;
  h?: number;
  bytes?: number;
}

export interface FamilyFaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FamilyProofLevel = 'records' | 'dna' | 'guess';

export interface FamilyFinding {
  summary: string;
  people: string[];
  /* Export v2: the curated findings. */
  key?: string;
  title?: string;
  text?: string;
  proof?: FamilyProofLevel;
  /** How sure, in the research's words ("about 90 to 95% sure"). */
  band?: string | null;
  /** May be news to the family (who a father was): never featured, shown behind a heads-up. */
  sensitive?: boolean;
  dna?: boolean;
  evidence?: string | null;
  storySlug?: string | null;
}

export interface FamilyStory {
  slug: string;
  title: string;
  /** Markdown, relative to the version folder. */
  file: string;
  words?: number;
  /* Export v2. */
  short?: string[] | null;
  research?: boolean;
  sensitive?: boolean;
  /** Who's who: tree ids the story names. */
  people?: string[];
  findings?: string[];
  minutes?: number;
}

/** A dated moment for "On this day": people who have died, full dates only. */
export interface FamilyMilestone {
  people: string[];
  type: string;
  date: string;
  placeText?: string | null;
  /** "MM-DD" and the year, when the export sends them. */
  md?: string;
  year?: number;
}

/** What one export added since the one before it. */
export interface FamilyChange {
  version: string;
  date?: string;
  since?: string | null;
  people?: string[];
  updated?: string[];
  media?: string[];
}

export interface FamilyDnaCluster {
  key: string;
  title?: string;
  /** The couple whose descendants these DNA cousins are. */
  couple: string[];
  members?: number;
  band?: string;
  proof?: FamilyProofLevel;
  text?: string;
  /** The DNA matches in the cluster (name, shared cM and whatever the research recorded), when
   * the export sends them: the family sees the research as the owner does. */
  matches?: Record<string, unknown>[];
}

export interface FamilyDnaConclusion {
  key: string;
  title: string;
  text: string;
  proof?: FamilyProofLevel;
  band?: string;
  sensitive?: boolean;
  people: string[];
  clusters?: string[];
  finding?: string;
  storySlug?: string | null;
}

/** The owner's DNA test, curated by hand in the archive. */
export interface FamilyDnaBlock {
  tested?: string[];
  /** The side of the tester's family the clusters are on: "mother", "father" or "both". */
  testSide?: string;
  summary?: string;
  clusters?: FamilyDnaCluster[];
  conclusions?: FamilyDnaConclusion[];
  details?: { title?: string; rows?: string[]; caveats?: string[] };
}

export interface FamilyPlace {
  id: string;
  short: string;
  lat: number;
  lon: number;
  precision: string;
  state?: string | null;
  country?: string | null;
}

/** The offline map (export v2, tools/geocode.py). */
export interface FamilyPlaces {
  ready?: boolean;
  places: FamilyPlace[];
  /** A person (p) at a place (pl) in a year (y), from a fact of type t. */
  stays: { p: string; pl: string; y: number; t?: string }[];
  moves?: { p: string; from: string; to: string; y: number }[];
  ocean?: { p: string; from: string; to: string; born?: number; y: number; country?: string }[];
  unplaced?: string[];
  note?: string;
}

export interface FamilyBundle {
  version: string;
  generated?: string;
  owner: string;
  counts?: Record<string, unknown>;
  anchors: string[];
  people: Record<string, FamilyPerson>;
  records: Record<string, FamilyRecord>;
  memorials: Record<string, FamilyMemorial>;
  media: Record<string, FamilyMedia>;
  findings: FamilyFinding[];
  stories: FamilyStory[];
  sources?: Record<string, { title?: string }>;
  /* Export v2 (schema 2); each part is optional and the routes work without it. */
  schema?: number;
  sensitivePeople?: string[];
  milestones?: FamilyMilestone[];
  changes?: FamilyChange[];
  dna?: FamilyDnaBlock | null;
  places?: FamilyPlaces | null;
}

export interface FamilyRelation {
  term: string;
  group: FamilyRelationGroup;
  gen?: number | null;
  distance?: number;
  path?: string[];
  pathText?: string;
  notes?: string[];
  /* Export v2. */
  /** Coefficient of relationship on paper (1 for the anchor). */
  cor?: number;
  /** Ahnentafel numbers of an ancestor (more than one when the family married cousins). */
  ahnen?: number[];
  side?: string | null;
  kind?: string;
  research?: 'dna' | 'guess' | null;
}

export interface FamilyPaperRow {
  gen: number;
  slots: number;
  named: number;
  living?: number;
  research?: number;
  unknown?: number;
  share?: number;
}

export interface FamilyBirthplaceRow {
  gen: number;
  slots: number;
  named: number;
  known: number;
  unknown: number;
  rows: { place: string; kind?: string; count: number; people: string[] }[];
}

export interface FamilyView {
  anchor: string;
  relations: Record<string, FamilyRelation>;
  /* Export v2 (tools/inheritance.py). */
  follows?: 'father' | 'mother' | null;
  coverage?: Record<string, { named: number; deepest: number }>;
  paper?: FamilyPaperRow[];
  birthplaces?: FamilyBirthplaceRow[];
  abroad?: { id: string; country: string; year?: number | null; gen: number }[];
  faces?: { id: string; media: string; gen: number; mayBeLiving?: boolean }[];
}

export interface FamilyHistoryAccount extends LibraryAccount {
  /** A tree id like "@I123@" the owner matched this account to. */
  kadeFamilyTreePerson?: string | null;
  kadeFamilyHistory?: 'guest' | 'none' | null;
  /** When an account that is not matched last asked to be added (POST /ask). */
  kadeFamilyHistoryAskedAt?: Date | string | null;
}

/** The 403 every route answers to an account that may not see the family history. */
export interface FamilyHistoryRefusal {
  access: false;
  reason: FamilyHistoryRefusalReason;
  error: string;
  /** The Library row's greyed detail: "Not linked to the tree yet". */
  detail: string;
  hint: string;
  /** True when POST /ask would be taken now. */
  canAsk: boolean;
  askedAt: string | null;
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
  /** When this account asked to be added and has not been matched since, or null. */
  askedAt: string | null;
}

/** Fields the router may write on an account; a field left out is not touched, null removes it. */
export interface FamilyHistoryUserFields {
  kadeFamilyTreePerson?: string | null;
  kadeFamilyHistory?: 'guest' | 'none' | null;
  /** An ISO time. */
  kadeFamilyHistoryAskedAt?: string | null;
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
  /** A separate archive's verified owner; default reads the legacy setting on every request. */
  ownerUserId?: () => string;
  log?: (message: string) => void;
  /** Writes one object to the private bucket: notes to the owner, and Listen audio. */
  putObject?: (key: string, body: Buffer, mime: string) => Promise<void>;
  /** Every key under a prefix (the owner's notes). */
  listKeys?: (prefix: string) => Promise<string[]>;
  /** Voices a story part in the Library's voice (Listen); without it, Listen is off. */
  speak?: (
    text: string,
    options: { session: string; userId: string },
  ) => Promise<{ audio: Buffer; mime: string }>;
  /** Names the voice and its direction: the audio cache covers it, so a new voice means new audio. */
  voiceTag?: () => string;
}

export const FAMILY_HISTORY_PRIVATE: string = 'The family history is private to the family.';
export const FAMILY_HISTORY_UPDATING: string =
  'The family history is being updated. Try again in a minute.';
export const FAMILY_HISTORY_OWNER_ONLY: string =
  'Only the owner of the family tree can see and change who has access.';
export const FAMILY_HISTORY_VIEW_NOTE: string =
  "Your own place in the tree has not been mapped yet, so relationships are shown from the tree owner's place for now.";
export const FAMILY_HISTORY_ROW_HINT: string =
  'Your place in the family tree, with photos, records, a map and stories.';
/** The greyed Library row's words for each refusal (generic: no family data). */
export const FAMILY_HISTORY_REFUSAL_WORDS: Readonly<
  Record<FamilyHistoryRefusalReason, { detail: string; hint: string }>
> = {
  review: {
    detail: 'Private to one family',
    hint: "Photos, records, a family tree, maps and stories from one family's research. Open to accounts matched to a person in that family's tree.",
  },
  test: {
    detail: 'Private to one family',
    hint: "Photos, records, a family tree, maps and stories from one family's research. Open to accounts matched to a person in that family's tree.",
  },
  unmatched: {
    detail: 'Not linked to the tree yet',
    hint: "Ask the tree's owner to match your account.",
  },
  declined: {
    detail: 'Private to the family',
    hint: "The tree's owner keeps this to the family.",
  },
};
export const FAMILY_HISTORY_ASKED: string = "Asked. The tree's owner will see your request.";
/** An account may ask to be added again after a week. */
export const FAMILY_HISTORY_ASK_MS: number = 7 * 24 * 60 * 60 * 1000;
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

/** The tree owner's account id (KADE_FH_OWNER_USER_ID), read on every request so changing it on
 * the server needs no build; "" while it is unset. */
export function familyOwnerUserId(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KADE_FH_OWNER_USER_ID || '').trim();
}

/**
 * Who this account sees the tree as, or null when it may not see it:
 * the review seat and test seats never, whatever else they carry (the owner's decision); the
 * owner's account as the owner; a matched person (a duplicate entry's main person); any other
 * administrator, and a guest, from the owner's place in the owner's words; everyone else never.
 * While KADE_FH_OWNER_USER_ID is unset, an administrator who is not matched to someone else is
 * the owner, as in v1, so the owner is never shut out before the setting is made.
 */
export function familyHistoryViewer(
  user: FamilyHistoryAccount | null | undefined,
  bundle: FamilyBundle,
  ownerUserId: string = familyOwnerUserId(),
): FamilyHistoryViewer | null {
  if (!user || libraryReviewSeat(user) || libraryTestSeat(user)) return null;
  const admin = user.role === 'ADMIN';
  const matched = user.kadeFamilyTreePerson
    ? familyPersonId(bundle, user.kadeFamilyTreePerson)
    : null;
  if (ownerUserId) {
    if (admin && accountIdOf(user) === ownerUserId)
      return { personId: bundle.owner, mode: 'owner' };
  } else if (admin && (!matched || matched === bundle.owner)) {
    return { personId: bundle.owner, mode: 'owner' };
  }
  if (matched) return { personId: matched, mode: 'family' };
  if (admin || user.kadeFamilyHistory === 'guest') return { personId: bundle.owner, mode: 'guest' };
  return null;
}

/** May this account use the owner's pages (/accounts, /match, /notes)? The owner's account, or,
 * while KADE_FH_OWNER_USER_ID is unset, any administrator; never the review seat or a test seat. */
export function familyHistoryOwnerAccount(
  user: FamilyHistoryAccount | null | undefined,
  ownerUserId: string = familyOwnerUserId(),
): boolean {
  if (!user || user.role !== 'ADMIN' || libraryReviewSeat(user) || libraryTestSeat(user))
    return false;
  return ownerUserId ? accountIdOf(user) === ownerUserId : true;
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** "29 September 2026", for "Asked on ...". */
export function familyDayText(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${FAMILY_MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Why an account may not see the family history, in the words its greyed row shows. No bundle
 * is needed, so a stranger never costs a bucket read. */
export function familyHistoryRefusal(
  user: FamilyHistoryAccount | null | undefined,
  now: number,
): FamilyHistoryRefusal {
  let reason: FamilyHistoryRefusalReason = 'unmatched';
  if (user && libraryReviewSeat(user)) reason = 'review';
  else if (user && libraryTestSeat(user)) reason = 'test';
  else if (user?.kadeFamilyHistory === 'none') reason = 'declined';
  const words = FAMILY_HISTORY_REFUSAL_WORDS[reason];
  const askedAt = reason === 'unmatched' ? isoOf(user?.kadeFamilyHistoryAskedAt) : null;
  const waiting = !!askedAt && now - Date.parse(askedAt) < FAMILY_HISTORY_ASK_MS;
  return {
    access: false,
    reason,
    error: FAMILY_HISTORY_PRIVATE,
    detail: waiting && askedAt ? `Asked on ${familyDayText(askedAt)}` : words.detail,
    hint: waiting ? "The tree's owner will see your request." : words.hint,
    canAsk: reason === 'unmatched' && !!user && !waiting,
    askedAt,
  };
}

/** The Library row's detail for an account that may open the family history: "Ada's sister",
 * "Your tree", "Guest". */
export function familyRowDetail(
  mode: FamilyHistoryMode,
  bundle: FamilyBundle,
  relationToOwner: FamilyRelation | null | undefined,
): string {
  if (mode === 'owner') return 'Your tree';
  if (mode === 'guest') return 'Guest';
  const owner = own(bundle.people, bundle.owner);
  const voice = familyVoice(familyFirstName(owner?.name), owner?.sex, true);
  const term = relationToOwner
    ? familyTermText(relationToOwner.term, relationToOwner.group, voice)
    : null;
  if (!term || term === voice.self) return 'In the family tree';
  return familyCapital(term);
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
  sensitiveAllowed: boolean = true,
): FamilyFindingView[] {
  const out: FamilyFindingView[] = [];
  for (const finding of bundle.findings) {
    if (personId && !(finding.people || []).includes(personId)) continue;
    /* only a finding the export marked sensitive follows KADE_FH_DNA_FINDINGS here, so the web
     * page reads an older, unmarked bundle as before */
    if (finding.sensitive === true && !sensitiveAllowed) continue;
    out.push(findingView(bundle, view, finding));
  }
  return out;
}

function memorialView(
  bundle: FamilyBundle,
  memorial: FamilyMemorial,
  wrong: string | undefined,
  audience: FamilyAudience,
): FamilyMemorialView {
  const photos: FamilyMemorialPhotoView[] = [];
  for (const photo of memorial.photos || []) {
    if (photo.media && familyMediaVisible(bundle, own(bundle.media, photo.media), audience))
      photos.push({ id: photo.media, caption: photo.caption || '' });
  }
  return { ...memorial, photos, ...(wrong ? { wrong } : {}) };
}

/** How this child is linked to this parent, when it is anything but a birth link. */
function childLink(bundle: FamilyBundle, parentId: string, childId: string): FamilyMember['kind'] {
  const kind = linkKind(bundle, childId, parentId);
  return kind && kind !== 'birth' ? kind : undefined;
}

/** Everyone may see everything but items the export held back (the owner sees those too). */
const EVERYONE: FamilyAudience = { personId: '', owner: false };

/**
 * One person, with their family, records, graves, pictures and findings, related to the viewer.
 * Living relatives get the same page as anyone, records and all, as the export sends them (the
 * owner's decision, Sep 29 2026: the family sees the research as she does).
 */
export function familyPersonPayload(
  bundle: FamilyBundle,
  view: FamilyView,
  id: string,
  audience: FamilyAudience = EVERYONE,
  sensitiveAllowed: boolean = true,
): FamilyPersonPayload | null {
  const person = own(bundle.people, id);
  if (!person) return null;
  const wrongRecords = person.wrongRecords || {};
  const wrongMemorials = person.wrongMemorials || {};
  const recordKeys = new Set<string>(person.records || []);
  for (const fact of person.facts || []) for (const key of fact.records || []) recordKeys.add(key);
  for (const key of Object.keys(wrongRecords)) recordKeys.add(key);
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
    if (memorial)
      memorials.push(memorialView(bundle, memorial, own(wrongMemorials, mid), audience));
  });
  const media: FamilyMedia[] = [];
  const mediaIds = new Set<string>();
  const addMedia = (mediaId: string | null | undefined): void => {
    const item = mediaId && !mediaIds.has(mediaId) ? own(bundle.media, mediaId) : undefined;
    if (!item || item.kind === 'restored' || !familyMediaVisible(bundle, item, audience)) return;
    mediaIds.add(item.id);
    media.push(item);
  };
  for (const mediaId of person.media || []) addMedia(mediaId);
  for (const record of records) if (!record.wrong) addMedia(record.image);
  return {
    person: {
      ...person,
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
    findings: familyFindings(bundle, view, id, sensitiveAllowed),
  };
}

/** The query's generations, defaulted and capped ("", "abc" and -3 are not errors). */
export function familyTreeDepth(text: string, fallback: number, max: number): number {
  const n = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(n)));
}

function portrait(
  bundle: FamilyBundle,
  person: FamilyPerson,
  audience: FamilyAudience,
): string | undefined {
  for (const mediaId of person.media || []) {
    const item = own(bundle.media, mediaId);
    if (
      item &&
      item.kind === 'tree' &&
      PORTRAIT.test(item.file) &&
      familyPortraitIdentity(item, person.id) &&
      familyMediaVisible(bundle, item, audience)
    )
      return mediaId;
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
  audience: FamilyAudience = EVERYONE,
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
    const photo = portrait(bundle, person, audience);
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
export function familyHistoryLocked(
  user: FamilyHistoryAccount,
  ownerUserId: string = familyOwnerUserId(),
): string | null {
  if (libraryReviewSeat(user))
    return 'The App Review account is always kept out of the family history.';
  if (libraryTestSeat(user)) return 'Test accounts are always kept out of the family history.';
  if (user.role === 'ADMIN') {
    return ownerUserId && accountIdOf(user) !== ownerUserId
      ? 'An administrator is not matched here: an administrator who is not the owner visits as a guest.'
      : 'An administrator always sees the family history as its owner.';
  }
  return null;
}

export function familyHistoryAccountRow(
  user: FamilyHistoryAccount,
  bundle: FamilyBundle,
): FamilyHistoryAccountRow {
  const personId = user.kadeFamilyTreePerson || null;
  const access = familyHistoryViewer(user, bundle)?.mode || 'none';
  return {
    userId: accountIdOf(user),
    name: String(user.name || '').trim(),
    username: String(user.username || '').trim(),
    personId,
    personLabel: personId ? own(bundle.people, personId)?.label || null : null,
    access,
    testSeat: libraryTestSeat(user),
    changeable: !familyHistoryLocked(user),
    askedAt: access === 'none' ? isoOf(user.kadeFamilyHistoryAskedAt) : null,
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
      fields: {
        kadeFamilyTreePerson: null,
        kadeFamilyHistory: guest ? 'guest' : 'none',
        kadeFamilyHistoryAskedAt: null,
      },
    };
  }
  const main = typeof personId === 'string' ? familyPersonId(bundle, personId) : null;
  if (!main) return { error: 'That person is not in the family tree.' };
  return {
    userId,
    fields: { kadeFamilyTreePerson: main, kadeFamilyHistory: null, kadeFamilyHistoryAskedAt: null },
  };
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

/** A Content-Disposition that saves a file under `name`: a plain-letter copy for old browsers,
 * and the exact name (curly apostrophes and accents too) for the rest. */
export function familyAttachment(name: string): string {
  const exact = String(name || '').trim() || 'Family picture.jpg';
  const plain = exact.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(exact).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
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

function bundleCounts(bundle: FamilyBundle): Record<string, unknown> {
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
        ? { ...raw, anchor: raw.anchor || anchor, relations: raw.relations }
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
  /** True when `view` is the owner's, standing in for a viewer who has none (or a guest). */
  borrowed: boolean;
  audience: FamilyAudience;
  viewNote?: string;
  ownerView: () => Promise<FamilyView | null>;
}

type FamilyHandler = (req: Request, res: Response, ctx: FamilyContext) => Promise<void> | void;
type OwnerHandler = (req: Request, res: Response, state: LoadedBundle) => Promise<void> | void;

const signedIn = (req: Request): FamilyHistoryAccount | undefined =>
  (req as Request & { user?: FamilyHistoryAccount }).user;

/** KADE_FH_DNA_FINDINGS, read on every request: `family` (the default) shows family mysteries to
 * everyone matched, `owner` to the owner alone, `off` to nobody. */
export function familyDnaFindingsSetting(env: NodeJS.ProcessEnv = process.env): FamilyDnaFindings {
  const value = String(env.KADE_FH_DNA_FINDINGS || '')
    .trim()
    .toLowerCase();
  return value === 'owner' || value === 'off' ? value : 'family';
}

/** Pages of everyone in the tree, sixty at a time. */
export const FAMILY_PEOPLE_PAGE: number = 60;
/** At most this many pictures are signed by one POST /media/sign. */
export const FAMILY_SIGN_LIMIT: number = 100;
const TEXT_LIMIT = 400 * 1024;

const PEOPLE_V2: Readonly<Record<string, { title: string; groups: string[] }>> = {
  ancestor: { title: 'Ancestors', groups: ['ancestor'] },
  blood: { title: 'Blood relatives', groups: ['blood', 'descendant'] },
  marriage: { title: 'By marriage', groups: ['marriage'] },
  all: { title: 'Everyone in the tree', groups: [] },
};

/**
 * v1 (the web page):  GET /me /person/:id /tree /search /people /stories /story/:slug /findings
 *                     /media/:id
 * v2 (the iPhone app, which sends ?v=2 on every call; v1 routes answer exactly as before
 * without it):        the same routes with server-written words, plus GET /home /gallery /dna
 *                     /timeline /places /play /media/:id/info and POST /media/sign
 * GET /media/:id/file one picture's bytes under its share name (Save and Share on the web page)
 * POST /ask           an account that is not matched asks to be added
 * GET  /accounts, POST /match   the owner only
 * Every answer is JSON with Cache-Control: no-store (a media redirect is a 302, a saved picture
 * its bytes). A refused
 * account gets the same 403 on every route, with the reason its greyed Library row shows.
 */
export function familyHistoryRouter(deps: FamilyHistoryDependencies): Router {
  const router = Router();
  const ownerUserId = deps.ownerUserId || familyOwnerUserId;
  const prefix = deps.prefix || familyHistoryPrefix();
  const store = createFamilyStore(deps, prefix);
  const now = deps.now || Date.now;
  const signCache = new Map<string, FamilySignCacheEntry>();
  const lenses = new WeakMap<FamilyView, Map<string, FamilyLens>>();
  const putObject = deps.putObject;
  const listener: FamilyListener | null =
    deps.speak && putObject
      ? familyListener({
          speak: deps.speak,
          voiceTag: deps.voiceTag || (() => 'default'),
          putObject,
          loadObject: deps.loadObject,
          now,
        })
      : null;
  /** A story's Listen parts, worked out once per version. */
  const storyParts = new Map<string, { hash: string; parts: FamilyStoryPart[] }>();
  /** Notes read from the bucket, by key (a note changes only through this router). */
  const notesCache = new Map<string, FamilyNote>();
  /** Notes sent per account per day, "<account> <YYYY-MM-DD>". */
  const sentToday = new Map<string, number>();
  const fail = (res: Response, error: Error): void => {
    deps.log?.(error.message);
    if (!res.headersSent) res.status(503).json({ error: FAMILY_HISTORY_UPDATING });
  };
  const deny = (res: Response, user: FamilyHistoryAccount | undefined): void => {
    res.status(403).json(familyHistoryRefusal(user, now()));
  };
  const v2 = (req: Request): boolean => queryText(req.query.v) === '2';
  /** May this viewer see sensitive findings and stories (KADE_FH_DNA_FINDINGS, read now)? */
  const mysteries = (ctx: FamilyContext): boolean =>
    familyMysteriesAllowed(ctx.viewer.mode, familyDnaFindingsSetting());
  const expires = (): string => new Date(now() + FAMILY_HISTORY_MEDIA_SECONDS * 1000).toISOString();

  /** The viewer and their view, null when refused; throws when the bundle or views cannot load. */
  const contextFor = async (user: FamilyHistoryAccount): Promise<FamilyContext | null> => {
    const state = await store.loaded();
    const viewer = familyHistoryViewer(user, state.bundle, ownerUserId());
    if (!viewer) return null;
    const ownerView = (): Promise<FamilyView | null> => store.view(state, state.bundle.owner);
    const mine = viewer.mode === 'guest' ? null : await store.view(state, viewer.personId);
    const view = mine || (await ownerView());
    if (!view) throw new Error(`no view for ${viewer.personId} and none for the owner`);
    return {
      state,
      bundle: state.bundle,
      user,
      viewer,
      view,
      borrowed: !mine || viewer.mode === 'guest',
      audience: { personId: viewer.personId, owner: viewer.mode === 'owner' },
      ...(mine || viewer.mode === 'guest' ? {} : { viewNote: FAMILY_HISTORY_VIEW_NOTE }),
      ownerView,
    };
  };

  /** Everything a v2 page builder needs: the view said in the right voice, and a signer. */
  const pageOf = async (ctx: FamilyContext): Promise<FamilyPageContext> => {
    const model = familyModel(ctx.bundle);
    const ownerPerson = own(ctx.bundle.people, ctx.bundle.owner);
    const ownerFirst = familyFirstName(ownerPerson?.name);
    const key = `${ctx.borrowed ? 'borrowed' : 'own'} ${ownerFirst}`;
    let byVoice = lenses.get(ctx.view);
    if (!byVoice) {
      byVoice = new Map();
      lenses.set(ctx.view, byVoice);
    }
    let lens = byVoice.get(key);
    if (!lens) {
      lens = familyLens(model, ctx.view, familyVoice(ownerFirst, ownerPerson?.sex, ctx.borrowed));
      byVoice.set(key, lens);
    }
    const signer = familySigner(
      (objectKey, mime) => deps.signGet(objectKey, mime, FAMILY_HISTORY_MEDIA_SECONDS),
      signCache,
      now,
    );
    const person = own(ctx.bundle.people, ctx.viewer.personId);
    const accountFirst = String(ctx.user.name || '').trim()
      ? familyFirstName(ctx.user.name)
      : ctx.viewer.mode === 'guest'
        ? 'there'
        : familyFirstName(person?.name);
    return {
      pc: familyPresenter(lens, prefix, signer, ctx.audience),
      lens,
      model,
      bundle: ctx.bundle,
      viewer: ctx.viewer,
      accountFirst,
      ownerFirst,
      ownerView: await ctx.ownerView(),
      now: now(),
      version: ctx.state.version,
      dnaFindings: familyDnaFindingsSetting(),
      placesReady: !!ctx.bundle.places?.places?.length,
      listenReady: !!listener,
      readable: (story) => !!familyStory(ctx.bundle, story.slug),
    };
  };

  /** Signs every picture the answer asked for, then sends it. */
  const send = async (res: Response, page: FamilyPageContext, body: unknown): Promise<void> => {
    await page.pc.signer.fill();
    res.json(body);
  };

  /** Every note in the owner's inbox, newest first. */
  const loadNotes = async (): Promise<FamilyNote[]> => {
    if (!deps.listKeys) return [];
    const keys = (await deps.listKeys(`${prefix}/inbox/`)).filter((key) => {
      const name = key.slice(key.lastIndexOf('/') + 1);
      return name.endsWith('.json') && familyNoteIdValid(name.slice(0, -5));
    });
    const notes = await Promise.all(
      keys.map(async (key) => {
        const cached = notesCache.get(key);
        if (cached) return cached;
        const raw = await deps.loadObject(key);
        if (!raw) return null;
        try {
          const note = JSON.parse(unpacked(raw).toString('utf8')) as FamilyNote;
          if (!note || typeof note.id !== 'string' || typeof note.at !== 'string') return null;
          notesCache.set(key, note);
          return note;
        } catch {
          return null;
        }
      }),
    );
    return notes
      .filter((note): note is FamilyNote => !!note)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  };

  /** A story this viewer may read, with its Listen parts (worked out once per version). */
  const storyFor = async (
    ctx: FamilyContext,
    slug: string,
  ): Promise<{ story: FamilyStory; hash: string; parts: FamilyStoryPart[] } | null> => {
    const found = familyStory(ctx.bundle, slug);
    const story = found && (found.sensitive !== true || mysteries(ctx)) ? found : null;
    if (!story) return null;
    const key = `${ctx.state.version} ${story.slug}`;
    let known = storyParts.get(key);
    if (!known) {
      const text = await deps.loadObject(`${prefix}/${ctx.state.version}/${story.file}`);
      if (!text) return null;
      const markdown = familyStoryMarkdown(unpacked(text).toString('utf8'));
      const { blocks } = familyStoryBlocks(
        markdown,
        familySourceLookup(ctx.bundle.records, ctx.bundle.memorials),
      );
      known = { hash: familyStoryHash(markdown), parts: familyStoryParts(blocks) };
      storyParts.set(key, known);
      if (storyParts.size > 64) {
        const oldest = storyParts.keys().next().value;
        if (oldest !== undefined) storyParts.delete(oldest);
      }
    }
    return { story, ...known };
  };

  const family =
    (handler: FamilyHandler): RequestHandler =>
    async (req, res) => {
      const user = signedIn(req);
      if (!user || !familyHistoryCandidate(user)) return deny(res, user);
      let ctx: FamilyContext | null = null;
      try {
        ctx = await contextFor(user);
      } catch (error) {
        return fail(res, error as Error);
      }
      if (!ctx) return deny(res, user);
      try {
        await handler(req, res, ctx);
      } catch (error) {
        fail(res, error as Error);
      }
    };

  const owner =
    (handler: OwnerHandler): RequestHandler =>
    async (req, res) => {
      if (!familyHistoryOwnerAccount(signedIn(req), ownerUserId())) {
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
      const ownerPerson = own(ctx.bundle.people, ctx.bundle.owner);
      const ownerView = await ctx.ownerView();
      const relationToOwner = (ownerView && own(ownerView.relations, ctx.viewer.personId)) || null;
      const accountFirst = String(ctx.user.name || '').trim()
        ? familyFirstName(ctx.user.name)
        : ctx.viewer.mode === 'guest'
          ? 'there'
          : familyFirstName(person.name);
      res.json({
        access: true,
        viewer: {
          personId: ctx.viewer.personId,
          name: person.name,
          label: person.label,
          relationToOwner,
          /** The greeting's name: the account's own, never the owner's for a guest. */
          first: accountFirst,
          /** False for a guest, who sees the tree from the owner's place. */
          inTree: ctx.viewer.mode !== 'guest',
        },
        mode: ctx.viewer.mode,
        isOwner: ctx.viewer.mode === 'owner',
        version: ctx.state.version,
        counts: bundleCounts(ctx.bundle),
        owner: { first: familyFirstName(ownerPerson?.name) },
        row: {
          detail: familyRowDetail(ctx.viewer.mode, ctx.bundle, relationToOwner),
          hint: FAMILY_HISTORY_ROW_HINT,
        },
        ...(ctx.viewNote ? { viewNote: ctx.viewNote } : {}),
      });
    }),
  );

  router.post('/ask', async (req, res) => {
    const user = signedIn(req);
    let refusal = familyHistoryRefusal(user, now());
    try {
      if (user && familyHistoryCandidate(user) && (await contextFor(user))) {
        res.status(403).json({ error: 'This account can already open the family history.' });
        return;
      }
    } catch (error) {
      return fail(res, error as Error);
    }
    if (!user || refusal.reason !== 'unmatched') {
      res.status(403).json(refusal);
      return;
    }
    if (!refusal.canAsk) {
      res.status(429).json({ ...refusal, error: `${refusal.detail}. ${refusal.hint}` });
      return;
    }
    const askedAt = new Date(now()).toISOString();
    try {
      const after = await deps.setUserFields(accountIdOf(user), {
        kadeFamilyHistoryAskedAt: askedAt,
      });
      if (!after) {
        res.status(404).json({ error: 'That account was not found.' });
        return;
      }
      refusal = familyHistoryRefusal(after, now());
    } catch (error) {
      return fail(res, error as Error);
    }
    deps.log?.(`ask ${accountIdOf(user)}`);
    res.json({ ok: true, askedAt, text: FAMILY_HISTORY_ASKED, refusal });
  });

  router.get(
    '/home',
    family(async (req, res, ctx) => {
      const page = await pageOf(ctx);
      let ownerExtra: { notes: number; asks: number } | null = null;
      if (ctx.viewer.mode === 'owner') {
        const asks = (await deps.findUsers()).filter(
          (user) =>
            !libraryReviewSeat(user) &&
            !libraryTestSeat(user) &&
            !!user.kadeFamilyHistoryAskedAt &&
            !familyHistoryViewer(user, ctx.bundle),
        ).length;
        const notes = (await loadNotes()).filter((note) => !note.done).length;
        ownerExtra = { notes, asks };
      }
      const since = queryText(req.query.since).slice(0, 64) || null;
      await send(res, page, familyHomePayload(page, since, ownerExtra));
    }),
  );

  router.get(
    '/person/:id',
    family(async (req, res, ctx) => {
      const id = String(req.params.id || '');
      const payload = familyPersonPayload(ctx.bundle, ctx.view, id, ctx.audience, mysteries(ctx));
      if (!payload) {
        res.status(404).json({ error: 'That person is not in the family tree.' });
        return;
      }
      if (!v2(req)) {
        res.json(payload);
        return;
      }
      const page = await pageOf(ctx);
      await send(res, page, familyPersonV2(page, id, payload));
    }),
  );

  router.get(
    '/tree',
    family(async (req, res, ctx) => {
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
            ctx.audience,
          )
        : null;
      if (!tree) {
        res.status(404).json({ error: 'That person is not in the family tree.' });
        return;
      }
      if (!v2(req)) {
        res.json(tree);
        return;
      }
      const page = await pageOf(ctx);
      await send(res, page, { ...tree, ...familyTreeExtras(page, tree) });
    }),
  );

  router.get(
    '/search',
    family(async (req, res, ctx) => {
      const found = familySearch(ctx.bundle, ctx.view, queryText(req.query.q), ctx.state.index);
      if (!v2(req)) {
        res.json(found);
        return;
      }
      const page = await pageOf(ctx);
      const n = found.length;
      const text = n ? `${n} ${n === 1 ? 'person' : 'people'} found` : 'No one found';
      await send(res, page, {
        query: queryText(req.query.q).slice(0, 120),
        total: n,
        text,
        spoken: text,
        people: familyPersonCards(
          page.pc,
          found.map((row) => row.id),
        ),
      });
    }),
  );

  router.get(
    '/people',
    family(async (req, res, ctx) => {
      if (!v2(req)) {
        const group = familyPeopleGroup(queryText(req.query.group));
        if (!group) {
          res.status(400).json({ error: 'Choose ancestor, blood, marriage or all.' });
          return;
        }
        res.json(familyPeople(ctx.bundle, ctx.view, group));
        return;
      }
      const key = queryText(req.query.group) || 'ancestor';
      const segment = own(PEOPLE_V2, key);
      if (!segment) {
        res.status(400).json({ error: 'Choose ancestor, blood, marriage or all.' });
        return;
      }
      const page = await pageOf(ctx);
      const rows = familyPeople(ctx.bundle, ctx.view, 'all').filter(
        (row) => !segment.groups.length || segment.groups.includes(row.group),
      );
      const total = rows.length;
      const from = Math.min(familyInt(req.query.from, 0, 0, 1e6), Math.max(0, total - 1));
      const cards = familyPersonCards(
        page.pc,
        rows.slice(from, from + FAMILY_PEOPLE_PAGE).map((row) => row.id),
      );
      /* Ancestors come under generation headings (a heading repeats at the top of a page); the
       * other groups are one section with no heading. */
      const genOf = new Map(rows.map((row) => [row.id, row.gen]));
      const sections: {
        heading: string | null;
        level: number;
        rows: { id: string; spoken: string; person: (typeof cards)[number] }[];
      }[] = [];
      for (const card of cards) {
        const gen = genOf.get(card.id);
        const heading =
          key === 'ancestor' && typeof gen === 'number' ? familyGenerationName(gen) : null;
        const row = { id: card.id, spoken: card.spoken, person: card };
        const last = sections[sections.length - 1];
        if (last && last.heading === heading) last.rows.push(row);
        else sections.push({ heading, level: 2, rows: [row] });
      }
      await send(res, page, {
        group: key,
        title: segment.title,
        total,
        from: total ? from : 0,
        count: cards.length,
        prev: from > 0 ? Math.max(0, from - FAMILY_PEOPLE_PAGE) : null,
        next: from + FAMILY_PEOPLE_PAGE < total ? from + FAMILY_PEOPLE_PAGE : null,
        pageSpoken: familyPageSpoken(total ? from : 0, cards.length, total),
        people: cards,
        sections,
      });
    }),
  );

  router.get(
    '/stories',
    family(async (req, res, ctx) => {
      if (!v2(req)) {
        const allowed = mysteries(ctx);
        res.json(
          familyStories({
            ...ctx.bundle,
            stories: ctx.bundle.stories.filter((story) => allowed || story.sensitive !== true),
          }),
        );
        return;
      }
      const page = await pageOf(ctx);
      await send(res, page, familyStoriesV2(page));
    }),
  );

  router.get(
    '/story/:slug',
    family(async (req, res, ctx) => {
      const found = familyStory(ctx.bundle, String(req.params.slug || ''));
      const story = found && (found.sensitive !== true || mysteries(ctx)) ? found : null;
      const text = story
        ? await deps.loadObject(`${prefix}/${ctx.state.version}/${story.file}`)
        : null;
      if (!story || !text) {
        res.status(404).json({ error: 'That story was not found.' });
        return;
      }
      const payload = familyStoryPayload(story, unpacked(text).toString('utf8'));
      if (!v2(req)) {
        res.json(payload);
        return;
      }
      const page = await pageOf(ctx);
      await send(res, page, { ...payload, ...familyStoryV2(page, story, payload.markdown) });
    }),
  );

  /* Listen: the caption track for the whole story, then one part's audio at a time. */
  router.get(
    '/story/:slug/listen',
    family(async (req, res, ctx) => {
      const found = await storyFor(ctx, String(req.params.slug || ''));
      if (!found) {
        res.status(404).json({ error: 'That story was not found.' });
        return;
      }
      const { story, hash, parts } = found;
      res.json({
        slug: story.slug,
        title: story.title || story.slug,
        listen: !!listener,
        count: parts.length,
        parts: parts.map((part) => ({
          i: part.i,
          text: part.text,
          cues: part.cues,
          audio: `/story/${encodeURIComponent(story.slug)}/audio/${part.i}`,
          ready: !!listener && listener.known(prefix, hash, part.text),
        })),
      });
    }),
  );

  router.get(
    '/story/:slug/audio/:i',
    family(async (req, res, ctx) => {
      if (!listener) {
        res.status(503).json({ error: 'Listening is not set up yet.' });
        return;
      }
      const found = await storyFor(ctx, String(req.params.slug || ''));
      if (!found) {
        res.status(404).json({ error: 'That story was not found.' });
        return;
      }
      const { story, hash, parts } = found;
      const i = familyInt(req.params.i, -1, -1, 1e6);
      const part = parts[i];
      if (!part) {
        res.status(404).json({ error: 'Past the end of the story.' });
        return;
      }
      const userId = accountIdOf(ctx.user);
      let note: Awaited<ReturnType<FamilyListener['ensure']>>;
      try {
        note = await listener.ensure(prefix, hash, part.text, userId);
      } catch (error) {
        deps.log?.(`listen ${story.slug} part ${i}: ${(error as Error).message}`);
        res.status(502).json({ error: 'The voice did not answer. Try that part again.' });
        return;
      }
      const url = await deps.signGet(note.key, note.mime, FAMILY_HISTORY_MEDIA_SECONDS);
      if (queryText(req.query.redirect) === '1') res.redirect(302, url);
      else
        res.json({
          slug: story.slug,
          i,
          count: parts.length,
          text: part.text,
          mime: note.mime,
          duration: note.duration,
          url,
          expires: expires(),
          cues: familyCues(part.text, note.duration),
          next: i + 1 < parts.length ? i + 1 : null,
        });
      /* one part ahead, so the next one is ready when this one ends */
      const ahead = parts[i + 1];
      if (ahead && !listener.known(prefix, hash, ahead.text))
        listener.ensure(prefix, hash, ahead.text, userId).catch((error: Error) => {
          deps.log?.(`listen ${story.slug} part ${i + 1} ahead: ${error.message}`);
        });
    }),
  );

  /* Notes to the owner: a memory, who is in a picture, or a photo to restore. */
  router.post(
    '/note',
    json({ limit: '16kb' }),
    family(async (req, res, ctx) => {
      if (!putObject) {
        res.status(503).json({ error: 'Notes cannot be sent yet.' });
        return;
      }
      const asked = familyNoteRequest(
        req.body,
        ctx.bundle,
        familyModel(ctx.bundle),
        ctx.audience,
        (id) => familyPersonId(ctx.bundle, id),
      );
      if ('error' in asked) {
        res.status(400).json({ error: asked.error });
        return;
      }
      const userId = accountIdOf(ctx.user);
      const at = now();
      const day = new Date(at).toISOString().slice(0, 10);
      const counted = `${userId} ${day}`;
      const sent = sentToday.get(counted) || 0;
      if (sent >= FAMILY_NOTES_PER_DAY) {
        res.status(429).json({
          error: `That is ${FAMILY_NOTES_PER_DAY} notes today. Send more tomorrow.`,
        });
        return;
      }
      const id = familyNoteId(at, randomBytes(4).toString('hex'));
      const note: FamilyNote = {
        id,
        at: new Date(at).toISOString(),
        from: {
          userId,
          name:
            String(ctx.user.name || '').trim() ||
            String(ctx.user.username || '').trim() ||
            'Someone',
          personId: ctx.viewer.mode === 'guest' ? null : ctx.viewer.personId,
          mode: ctx.viewer.mode,
        },
        kind: asked.kind,
        about: asked.about,
        text: asked.text,
        done: false,
        doneAt: null,
      };
      const key = familyNoteKey(prefix, id);
      await putObject(key, Buffer.from(JSON.stringify(note)), 'application/json');
      notesCache.set(key, note);
      for (const old of sentToday.keys()) if (!old.endsWith(day)) sentToday.delete(old);
      sentToday.set(counted, sent + 1);
      deps.log?.(`note ${asked.kind} from ${userId}`);
      const ownerFirst = familyFirstName(own(ctx.bundle.people, ctx.bundle.owner)?.name);
      res.json({
        ok: true,
        id,
        text:
          asked.kind === 'restore-request'
            ? `Asked. ${ownerFirst} will see your request.`
            : `Sent to ${ownerFirst}. Thank you.`,
      });
    }),
  );

  router.get(
    '/notes',
    family(async (_req, res, ctx) => {
      if (!familyHistoryOwnerAccount(ctx.user, ownerUserId())) {
        res.status(403).json({ error: FAMILY_HISTORY_OWNER_ONLY });
        return;
      }
      const page = await pageOf(ctx);
      const rows = (await loadNotes()).slice(0, 200).map((note) => {
        const about = note.about || null;
        const person = about?.personId
          ? familyPersonCards(page.pc, [about.personId])[0] || null
          : null;
        const image = about?.mediaId ? familyImage(page.pc, about.mediaId) : null;
        return {
          id: note.id,
          at: note.at,
          from: { userId: note.from?.userId || '', name: note.from?.name || 'Someone' },
          kind: note.kind,
          kindText: own(FAMILY_NOTE_KIND_TEXT, note.kind) || 'A note',
          about: person ? { person } : image ? { image } : null,
          text: note.text,
          done: !!note.done,
          doneAt: note.doneAt || null,
        };
      });
      await send(res, page, rows);
    }),
  );

  router.post(
    '/notes/:id/done',
    json({ limit: '1kb' }),
    family(async (req, res, ctx) => {
      if (!familyHistoryOwnerAccount(ctx.user, ownerUserId())) {
        res.status(403).json({ error: FAMILY_HISTORY_OWNER_ONLY });
        return;
      }
      const id = String(req.params.id || '');
      if (!familyNoteIdValid(id) || !putObject) {
        res.status(404).json({ error: 'That note was not found.' });
        return;
      }
      const key = familyNoteKey(prefix, id);
      let note = notesCache.get(key) || null;
      if (!note) {
        const raw = await deps.loadObject(key);
        note = raw ? (JSON.parse(unpacked(raw).toString('utf8')) as FamilyNote) : null;
      }
      if (!note) {
        res.status(404).json({ error: 'That note was not found.' });
        return;
      }
      const done = (req.body || {}).done !== false;
      const changed: FamilyNote = {
        ...note,
        done,
        doneAt: done ? new Date(now()).toISOString() : null,
      };
      await putObject(key, Buffer.from(JSON.stringify(changed)), 'application/json');
      notesCache.set(key, changed);
      res.json({ ok: true, id, done });
    }),
  );

  router.get(
    '/findings',
    family(async (req, res, ctx) => {
      const group = queryText(req.query.group);
      if (!v2(req) && !group) {
        res.json(familyFindings(ctx.bundle, ctx.view, undefined, mysteries(ctx)));
        return;
      }
      const page = await pageOf(ctx);
      await send(res, page, familyFindingsV2(page, group));
    }),
  );

  router.get(
    '/gallery',
    family(async (req, res, ctx) => {
      const page = await pageOf(ctx);
      const person = queryText(req.query.person);
      const body = familyGallery(page, {
        kind: queryText(req.query.kind) || 'photos',
        person: person ? familyPersonId(ctx.bundle, person) || person : '',
        since: queryText(req.query.since).slice(0, 64),
        sort: queryText(req.query.sort) === 'year' ? 'year' : 'near',
        from: familyInt(req.query.from, 0, 0, 1e6),
      });
      if (!body) {
        res.status(400).json({
          error:
            'Choose photos, portraits, records, graves, documents, stories or all, for someone in the tree.',
        });
        return;
      }
      await send(res, page, body);
    }),
  );

  router.post(
    '/media/sign',
    json({ limit: '16kb' }),
    family(async (req, res, ctx) => {
      const body = (req.body || {}) as { ids?: unknown; size?: unknown };
      const size = typeof body.size === 'string' ? body.size : 't';
      if (
        !Array.isArray(body.ids) ||
        body.ids.length > FAMILY_SIGN_LIMIT ||
        !['t', 's', 'l', 'f', 'o'].includes(size)
      ) {
        res.status(400).json({
          error: `Send up to ${FAMILY_SIGN_LIMIT} picture ids and a size (t, s, l, f or o).`,
        });
        return;
      }
      const page = await pageOf(ctx);
      const urls: Record<string, string | null> = {};
      for (const raw of body.ids) {
        const id = typeof raw === 'string' ? raw : '';
        const item = own(ctx.bundle.media, id);
        if (!item || !familyMediaVisible(ctx.bundle, item, ctx.audience)) continue;
        const file = page.model.sizeFile(item, size);
        if (!file) continue;
        page.pc.signer.later(urls, id, `${prefix}/${file}`, familyFileMime(file));
      }
      await page.pc.signer.fill();
      res.json({ urls, size, expires: expires() });
    }),
  );

  /* Save and Share on the web page: one picture's bytes from this site under its share name, so a
   * browser can keep it or hand it to the share sheet without the bucket answering other sites.
   * Only the export's JPEG copies ("s", or "l" for a big scan); never a photo's original. */
  router.get(
    '/media/:id/file',
    family(async (req, res, ctx) => {
      const id = String(req.params.id || '');
      const item = own(ctx.bundle.media, id);
      const size = queryText(req.query.size) || 's';
      if (size !== 's' && size !== 'l') {
        res.status(400).json({ error: 'Choose the s or l size.' });
        return;
      }
      const page = await pageOf(ctx);
      const visible = !!item && familyMediaVisible(ctx.bundle, item, ctx.audience);
      const file = visible && item ? page.model.sizeFile(item, size) : null;
      const image = file ? familyImage(page.pc, id) : null;
      const bytes =
        file && image && /^image\//.test(familyFileMime(file))
          ? await deps.loadObject(`${prefix}/${file}`)
          : null;
      if (!file || !image || !bytes) {
        res.status(404).json({ error: 'That picture cannot be saved from the family history.' });
        return;
      }
      res.setHeader('Content-Type', familyFileMime(file));
      res.setHeader('Content-Disposition', familyAttachment(image.shareName));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(bytes);
    }),
  );

  router.get(
    '/media/:id/info',
    family(async (req, res, ctx) => {
      const id = String(req.params.id || '');
      const item = own(ctx.bundle.media, id);
      if (!item || !familyMediaVisible(ctx.bundle, item, ctx.audience)) {
        res.status(404).json({ error: 'That picture is not in the family history.' });
        return;
      }
      const page = await pageOf(ctx);
      let text: string | null = null;
      const textFile = String(item.textFile || '');
      if (
        /^media\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/.test(textFile) &&
        !textFile.includes('..')
      ) {
        const buffer = await deps.loadObject(`${prefix}/${textFile}`);
        if (buffer) text = unpacked(buffer).subarray(0, TEXT_LIMIT).toString('utf8');
      }
      const body = familyMediaInfo(page, id, text);
      if (!body) {
        res.status(404).json({ error: 'That picture is not in the family history.' });
        return;
      }
      await send(res, page, body);
    }),
  );

  router.get(
    '/media/:id',
    family(async (req, res, ctx) => {
      const id = String(req.params.id || '');
      const item = own(ctx.bundle.media, id);
      const visible = familyMediaVisible(ctx.bundle, item, ctx.audience);
      const size = queryText(req.query.size);
      let key: string | null = null;
      let mime = '';
      let w: number | null = null;
      let h: number | null = null;
      if (visible && item && size) {
        const file = familyModel(ctx.bundle).sizeFile(item, size);
        if (file) {
          key = `${prefix}/${file}`;
          mime = familyFileMime(file);
          const entry = item.sizeFiles ? own(item.sizeFiles, size) : undefined;
          w = typeof entry?.w === 'number' ? entry.w : typeof item.w === 'number' ? item.w : null;
          h = typeof entry?.h === 'number' ? entry.h : typeof item.h === 'number' ? item.h : null;
        }
      } else if (visible) {
        const object = familyMediaObject(ctx.bundle, prefix, id);
        if (object) {
          key = object.key;
          mime = object.mime;
        }
      }
      if (!key) {
        res.status(404).json({
          error: size
            ? 'That size of the picture is not in the family history.'
            : 'That picture is not in the family history.',
        });
        return;
      }
      const url = await deps.signGet(key, mime, FAMILY_HISTORY_MEDIA_SECONDS);
      if (queryText(req.query.redirect) === '1') {
        res.redirect(302, url);
        return;
      }
      res.json(size ? { url, w, h, expires: expires() } : { url });
    }),
  );

  router.get(
    '/dna',
    family(async (req, res, ctx) => {
      const page = await pageOf(ctx);
      const asked = queryText(req.query.for);
      const forId = asked ? familyPersonId(ctx.bundle, asked) : familyDnaSelf(page);
      if (!forId || !familyDnaForAllowed(page, forId)) {
        res
          .status(400)
          .json({ error: 'Choose yourself, your husband or wife, or one of your children.' });
        return;
      }
      await send(res, page, familyDnaPayload(page, forId));
    }),
  );

  router.get(
    '/timeline',
    family(async (req, res, ctx) => {
      const page = await pageOf(ctx);
      const scope = queryText(req.query.scope) === 'all' ? 'all' : 'ancestors';
      await send(res, page, familyTimelinePayload(page, scope));
    }),
  );

  router.get(
    '/places',
    family(async (req, res, ctx) => {
      const page = await pageOf(ctx);
      const scope = queryText(req.query.scope) === 'all' ? 'all' : 'ancestors';
      const body = familyPlacesPayload(page, scope);
      if (!body) {
        res.status(404).json({ error: 'The map is coming soon.', missing: 'places' });
        return;
      }
      await send(res, page, body);
    }),
  );

  router.get(
    '/play',
    family(async (req, res, ctx) => {
      if (ctx.viewer.mode === 'guest') {
        res
          .status(403)
          .json({ error: 'The game is for family members in the tree.', reason: 'guest' });
        return;
      }
      const page = await pageOf(ctx);
      const count = familyInt(req.query.count, 5, 1, 10);
      const seed = familyInt(req.query.seed, now() % 2147483647, 0, 2147483647);
      await send(res, page, familyPlayPayload(page, count, seed));
    }),
  );

  router.get(
    '/accounts',
    owner(async (_req, res, state) => {
      const rows = (await deps.findUsers())
        .filter((user) => !libraryReviewSeat(user))
        .map((user) => familyHistoryAccountRow(user, state.bundle));
      /* Accounts asking to be added come first, the newest ask first; then everyone by name. */
      rows.sort(
        (a, b) =>
          (b.askedAt || '').localeCompare(a.askedAt || '') ||
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
