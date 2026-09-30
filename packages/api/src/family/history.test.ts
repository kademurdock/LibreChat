/* Family history (Sep 29 2026, docs/FAMILY_HISTORY.md): the viewer rule, the pure helpers and
 * every route of familyHistoryRouter, on an invented family in __fixtures__/history.
 * THE REPOSITORY IS PUBLIC: every person, place, record and account here is made up.
 * Run from the repo root:
 * node --require <tsx cjs register> --test packages/api/src/family/history.test.ts */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { Router, RequestHandler } from 'express';
import type {
  FamilyBundle,
  FamilyFamily,
  FamilyFindingView,
  FamilyHistoryAccount,
  FamilyHistoryAccountRow,
  FamilyHistoryMode,
  FamilyHistoryUserFields,
  FamilyHistoryViewer,
  FamilyMedia,
  FamilyMemorialView,
  FamilyPeopleRow,
  FamilyPerson,
  FamilyRecordView,
  FamilyRelation,
  FamilyStoryListing,
  FamilyTreeLink,
  FamilyTreeNode,
  FamilyView,
} from './history';
import {
  FAMILY_HISTORY_ASKED,
  FAMILY_HISTORY_CACHE_MS,
  FAMILY_HISTORY_OWNER_ONLY,
  FAMILY_HISTORY_PRIVATE,
  FAMILY_HISTORY_REFUSAL_WORDS,
  FAMILY_HISTORY_ROW_HINT,
  FAMILY_HISTORY_UPDATING,
  FAMILY_HISTORY_VIEW_NOTE,
  familyFold,
  familyHistoryCandidate,
  familyHistoryMatch,
  familyHistoryOwnerAccount,
  familyHistoryRefusal,
  familyHistoryPrefix,
  familyHistoryRouter,
  familyHistoryViewer,
  familyMediaObject,
  familyNearness,
  familyPersonId,
  familyPersonPayload,
  familySearch,
  familySiblings,
  familyStoryMarkdown,
  familyTreeDepth,
} from './history';

process.env.KADE_APP_REVIEW_USER_IDS = 'aaaaaaaaaaaaaaaaaaaaaa05';
process.env.KADE_LIBRARY_HIDDEN_FROM = 'review-seat@example.com';
delete process.env.NOTIFY_TEST_USER_IDS;
delete process.env.KADE_FAMILY_HISTORY_PREFIX;
delete process.env.KADE_FH_OWNER_USER_ID;
delete process.env.KADE_FH_DNA_FINDINGS;

/** Runs `body` with KADE_FH_OWNER_USER_ID set, then unsets it again. */
async function withOwnerId<T>(id: string, body: () => Promise<T> | T): Promise<T> {
  process.env.KADE_FH_OWNER_USER_ID = id;
  try {
    return await body();
  } finally {
    delete process.env.KADE_FH_OWNER_USER_ID;
  }
}

const FIXTURES = join(__dirname, '__fixtures__', 'history');
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BUNDLE: FamilyBundle = JSON.parse(fixtureText('bundle.json'));
const OWNER_VIEW: FamilyView = JSON.parse(fixtureText('views/I100.json'));
const BEN_VIEW: FamilyView = JSON.parse(fixtureText('views/I200.json'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const STORY =
  '# The farm on Example Road\r\n\r\nThe <b>farm</b> was invented<script>alert(1)</script>.\r\n' +
  '<!-- a private note -->See <https://example.com/farm> and [records/ancestry/1/2.json].\u0007\r\n';
const STORY_CLEAN =
  '# The farm on Example Road\n\nThe farm was inventedalert(1).\n' +
  'See <https://example.com/farm> and [records/ancestry/1/2.json].\n';

const OWNER: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa01', name: 'Owner Account', username: 'owner', role: 'ADMIN' };
const BEN: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa02', name: 'Ben Account', username: 'ben', kadeFamilyTreePerson: '@I200@' };
const CORA: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa03', name: 'Cora Account', username: 'cora', kadeFamilyTreePerson: '@I201@' };
const GUEST: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa04', name: 'Guest Friend', username: 'friend', kadeFamilyHistory: 'guest' };
const REVIEW: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa05', name: 'Review Seat', role: 'ADMIN', kadeFamilyTreePerson: '@I200@' };
const TEST_SEAT: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa06', name: 'Seat', username: 'Test Guest' };
const STRANGER: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa07', name: 'Bob Stranger', username: 'bob' };
const TWIN: FamilyHistoryAccount = { _id: { toString: () => 'aaaaaaaaaaaaaaaaaaaaaa08' }, name: 'Ben Twin', kadeFamilyTreePerson: '@I900@' };
const STALE: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa09', name: 'Stale Match', kadeFamilyTreePerson: '@I999@' };
const ACCOUNTS: Record<string, FamilyHistoryAccount> = {
  owner: OWNER,
  ben: BEN,
  cora: CORA,
  guest: GUEST,
  review: REVIEW,
  test: TEST_SEAT,
  stranger: STRANGER,
  twin: TWIN,
  stale: STALE,
};

/* ── the harness: a bucket in a Map, accounts in a Map, a clock we move ── */

type Harness = {
  base: string;
  close: () => Promise<void>;
  objects: Map<string, Buffer>;
  reads: string[];
  failing: Set<string>;
  signed: [string, string, number][];
  sets: [string, FamilyHistoryUserFields][];
  users: Map<string, FamilyHistoryAccount>;
  tick: (ms: number) => void;
  signFails: { on: boolean };
};

function bucket(version = 'v1', bundle: FamilyBundle = BUNDLE): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ['family-history/current.json', Buffer.from(JSON.stringify({ version }))],
    [`family-history/${version}/bundle.json.gz`, gzipSync(Buffer.from(JSON.stringify(bundle)))],
    [`family-history/${version}/views/I100.json.gz`, Buffer.from(JSON.stringify(OWNER_VIEW))],
    [`family-history/${version}/views/I200.json.gz`, Buffer.from(JSON.stringify(BEN_VIEW))],
    [`family-history/${version}/stories/the-farm.md`, Buffer.from(STORY)],
  ]);
}

async function harness(objects: Map<string, Buffer> = bucket()): Promise<Harness> {
  const users = new Map(Object.entries(clone(ACCOUNTS)));
  users.set('twin', { ...TWIN });
  const reads: string[] = [];
  const failing = new Set<string>();
  const signed: [string, string, number][] = [];
  const sets: [string, FamilyHistoryUserFields][] = [];
  const signFails = { on: false };
  let clock = Date.parse('2026-09-29T12:00:00Z');
  const idOf = (user: FamilyHistoryAccount) => String(user.id || user._id?.toString());
  const auth: RequestHandler = (req, res, next) => {
    const user = users.get(req.get('x-user') || '');
    if (!user) {
      res.status(401).json({ error: 'Sign in first.' });
      return;
    }
    (req as { user?: FamilyHistoryAccount }).user = user;
    next();
  };
  const router: Router = familyHistoryRouter({
    auth,
    loadObject: async (key) => {
      reads.push(key);
      if (failing.has(key) || failing.has('*')) throw new Error('the bucket is unreachable');
      return objects.get(key) || null;
    },
    signGet: async (key, mime, seconds) => {
      if (signFails.on) throw new Error('signing is down');
      signed.push([key, mime, seconds]);
      return `https://bucket.example/${key}?signature=test`;
    },
    findUsers: async () => [...users.values()],
    setUserFields: async (id, fields) => {
      sets.push([id, fields]);
      const entry = [...users.entries()].find(([, user]) => idOf(user) === id);
      if (!entry) return null;
      const changed: FamilyHistoryAccount = { ...entry[1] };
      if (fields.kadeFamilyTreePerson === null) delete changed.kadeFamilyTreePerson;
      else if (fields.kadeFamilyTreePerson !== undefined) changed.kadeFamilyTreePerson = fields.kadeFamilyTreePerson;
      if (fields.kadeFamilyHistory === null) delete changed.kadeFamilyHistory;
      else if (fields.kadeFamilyHistory !== undefined) changed.kadeFamilyHistory = fields.kadeFamilyHistory;
      if (fields.kadeFamilyHistoryAskedAt === null) delete changed.kadeFamilyHistoryAskedAt;
      else if (fields.kadeFamilyHistoryAskedAt !== undefined) changed.kadeFamilyHistoryAskedAt = new Date(fields.kadeFamilyHistoryAskedAt);
      users.set(entry[0], changed);
      return changed;
    },
    now: () => clock,
    log: () => undefined,
  });
  const app = express();
  app.use('/api/kade/family-history', router);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kade/family-history`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    objects,
    reads,
    failing,
    signed,
    sets,
    users,
    tick: (ms) => {
      clock += ms;
    },
    signFails,
  };
}

/** Every field any single-object reply carries, so a test reads the one it checks by name. */
interface ReplyObject {
  error: string;
  access: boolean;
  reason: string;
  detail: string;
  hint: string;
  canAsk: boolean;
  askedAt: string | null;
  text: string;
  ok: boolean;
  url: string;
  row: { detail: string; hint: string };
  viewer: {
    personId: string;
    name: string;
    label: string;
    relationToOwner: FamilyRelation;
    first: string;
    inTree: boolean;
  };
  mode: FamilyHistoryMode;
  isOwner: boolean;
  version: string;
  counts: Record<string, number>;
  viewNote: string;
  person: FamilyPerson & { relation: FamilyRelation };
  family: FamilyFamily;
  records: FamilyRecordView[];
  memorials: FamilyMemorialView[];
  media: FamilyMedia[];
  findings: FamilyFindingView[];
  focus: string;
  up: number;
  down: number;
  nodes: FamilyTreeNode[];
  links: FamilyTreeLink[];
  couples: [string, string][];
  account: FamilyHistoryAccountRow;
  markdown: string;
}
/** A row of any list reply (people, search, findings, stories, accounts). */
type ReplyRow = FamilyPeopleRow & FamilyFindingView & FamilyStoryListing & FamilyHistoryAccountRow;
type Reply = {
  status: number;
  cache: string | null;
  location: string | null;
  body: ReplyObject & ReplyRow[];
};

async function call(h: Harness, path: string, who?: string, body?: object): Promise<Reply> {
  const headers: Record<string, string> = who ? { 'x-user': who } : {};
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${h.base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    redirect: 'manual',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  return {
    status: res.status,
    cache: res.headers.get('cache-control'),
    location: res.headers.get('location'),
    body: isJson && text ? JSON.parse(text) : text,
  };
}

const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id);
const pid = (id: string): string => encodeURIComponent(id);

let main: Harness;
before(async () => {
  main = await harness();
});
after(() => main.close());

/* ── the viewer rule ─────────────────────────────────────────────────── */

test('the viewer rule: matched family, admins as the owner, guests from the owner\'s place; never the review seat or a test seat', () => {
  const owner = (mode: FamilyHistoryViewer['mode']): FamilyHistoryViewer => ({ personId: '@I100@', mode });
  const table: [string, FamilyHistoryAccount | null, FamilyHistoryViewer | null][] = [
    ['the owner (an admin)', OWNER, owner('owner')],
    ['an admin matched to a person sees from that place', { ...OWNER, kadeFamilyTreePerson: '@I200@' }, { personId: '@I200@', mode: 'family' }],
    ['a matched family member', BEN, { personId: '@I200@', mode: 'family' }],
    ['a matched member whose place has no view file', CORA, { personId: '@I201@', mode: 'family' }],
    ['a match to a duplicate entry becomes the main person', TWIN, { personId: '@I200@', mode: 'family' }],
    ['a guest the owner let in', GUEST, owner('guest')],
    ['the review seat, even as a matched admin', REVIEW, null],
    ['the review seat by email', { id: 'aaaaaaaaaaaaaaaaaaaaaa10', email: 'Review-Seat@example.com', role: 'ADMIN' }, null],
    ['a test seat', TEST_SEAT, null],
    ['a test seat matched to a person', { ...TEST_SEAT, kadeFamilyTreePerson: '@I101@' }, null],
    ['a test seat marked as a guest', { ...TEST_SEAT, kadeFamilyHistory: 'guest' }, null],
    ['a test seat that is an admin', { ...TEST_SEAT, role: 'ADMIN' }, null],
    ['a test seat known by its id, as an admin', { id: '6a572e3be680dcdaadca0f04', name: 'tester', role: 'ADMIN' }, null],
    ['a stranger', STRANGER, null],
    ['a stranger the owner set to none', { ...STRANGER, kadeFamilyHistory: 'none' }, null],
    ['a Family feature pack member who is not matched', { ...STRANGER, kadeLibraryAccess: 'family' }, null],
    ['a match to someone no longer in the tree', STALE, null],
    ['an admin whose match left the tree', { ...STALE, role: 'ADMIN' }, owner('owner')],
    ['a match to a prototype key', { ...STRANGER, kadeFamilyTreePerson: 'constructor' }, null],
    ['nobody signed in', null, null],
  ];
  for (const [who, user, expected] of table) {
    assert.deepEqual(familyHistoryViewer(user, BUNDLE), expected, who);
    if (expected) assert.equal(familyHistoryCandidate(user), true, `${who} is worth loading the tree for`);
  }
  assert.equal(familyHistoryCandidate(STRANGER), false, 'a stranger never costs a bucket read');
  assert.equal(familyHistoryCandidate(REVIEW), false);
  assert.equal(familyHistoryCandidate({ ...TEST_SEAT, role: 'ADMIN', kadeFamilyTreePerson: '@I101@' }), false);
});

test('owner mode belongs to one account once KADE_FH_OWNER_USER_ID is set; before that, to an admin matched to nobody else', () => {
  const helper: FamilyHistoryAccount = { id: 'aaaaaaaaaaaaaaaaaaaaaa11', name: 'Helper Admin', role: 'ADMIN' };
  const ownerId = OWNER.id as string;
  assert.deepEqual(familyHistoryViewer(helper, BUNDLE, ''), { personId: '@I100@', mode: 'owner' }, 'unset: any admin, as in v1');
  assert.deepEqual(familyHistoryViewer({ ...OWNER, kadeFamilyTreePerson: '@I100@' }, BUNDLE, ''), { personId: '@I100@', mode: 'owner' }, 'unset: an admin matched to the owner is the owner');
  assert.deepEqual(familyHistoryViewer(OWNER, BUNDLE, ownerId), { personId: '@I100@', mode: 'owner' });
  assert.deepEqual(familyHistoryViewer({ ...OWNER, kadeFamilyTreePerson: '@I200@' }, BUNDLE, ownerId), { personId: '@I100@', mode: 'owner' }, 'the owner account is the owner, whatever it is matched to');
  assert.deepEqual(familyHistoryViewer(helper, BUNDLE, ownerId), { personId: '@I100@', mode: 'guest' }, 'set: another admin visits as a guest');
  assert.deepEqual(familyHistoryViewer({ ...helper, kadeFamilyTreePerson: '@I200@' }, BUNDLE, ownerId), { personId: '@I200@', mode: 'family' });
  assert.equal(familyHistoryViewer({ id: ownerId, email: 'review-seat@example.com', role: 'ADMIN' }, BUNDLE, ownerId), null, 'the review seat never, even with the owner id');
  assert.equal(familyHistoryViewer({ ...BEN, id: ownerId }, BUNDLE, ownerId)?.mode, 'family', 'the owner id is owner mode only on an administrator');

  assert.equal(familyHistoryOwnerAccount(OWNER, ''), true);
  assert.equal(familyHistoryOwnerAccount(helper, ''), true, 'unset: any admin keeps the owner pages, so the owner is never shut out');
  assert.equal(familyHistoryOwnerAccount(OWNER, ownerId), true);
  assert.equal(familyHistoryOwnerAccount(helper, ownerId), false);
  assert.equal(familyHistoryOwnerAccount(REVIEW, ''), false);
  assert.equal(familyHistoryOwnerAccount({ ...TEST_SEAT, role: 'ADMIN' }, ''), false);
  assert.equal(familyHistoryOwnerAccount(BEN, ''), false);
});

test('refusals carry the reason the greyed Library row shows, and whether the account may ask', () => {
  const at = Date.parse('2026-09-29T12:00:00Z');
  const refusal = (user: FamilyHistoryAccount) => familyHistoryRefusal(user, at);
  assert.deepEqual(refusal(STRANGER), {
    access: false,
    reason: 'unmatched',
    error: FAMILY_HISTORY_PRIVATE,
    detail: 'Not linked to the tree yet',
    hint: "Ask the tree's owner to match your account.",
    canAsk: true,
    askedAt: null,
  });
  assert.equal(refusal(REVIEW).reason, 'review');
  assert.equal(refusal(REVIEW).canAsk, false);
  assert.equal(refusal(REVIEW).detail, 'Private to one family');
  assert.equal(refusal(TEST_SEAT).reason, 'test');
  assert.equal(refusal({ ...STRANGER, kadeFamilyHistory: 'none' }).reason, 'declined');
  assert.equal(refusal({ ...STRANGER, kadeFamilyHistory: 'none' }).canAsk, false);
  const asked = refusal({ ...STRANGER, kadeFamilyHistoryAskedAt: new Date(at - 86400000) });
  assert.deepEqual([asked.canAsk, asked.detail, asked.askedAt], [false, 'Asked on 28 September 2026', '2026-09-28T12:00:00.000Z']);
  assert.equal(refusal({ ...STRANGER, kadeFamilyHistoryAskedAt: '2026-09-01T00:00:00Z' }).canAsk, true, 'a week later they may ask again');
  assert.equal(FAMILY_HISTORY_REFUSAL_WORDS.unmatched.detail, 'Not linked to the tree yet');
});

/* ── pure helpers ─────────────────────────────────────────────────────── */

test('ids, depths, folding, prefixes and story markdown', () => {
  assert.equal(familyPersonId(BUNDLE, '@I900@'), '@I200@', 'a duplicate points at its main person');
  assert.equal(familyPersonId(BUNDLE, '@I200@'), '@I200@');
  for (const missing of ['@I999@', 'constructor', '__proto__', 'toString', ''])
    assert.equal(familyPersonId(BUNDLE, missing), null, missing);

  assert.equal(familyTreeDepth('', 4, 8), 4);
  assert.equal(familyTreeDepth('abc', 4, 8), 4);
  assert.equal(familyTreeDepth('3', 4, 8), 3);
  assert.equal(familyTreeDepth('2.7', 4, 8), 2);
  assert.equal(familyTreeDepth('-3', 4, 8), 0);
  assert.equal(familyTreeDepth('99', 4, 8), 8);
  assert.equal(familyTreeDepth('Infinity', 2, 4), 2);

  assert.equal(familyFold("  Gail Ríos-O'Brien, Jr. "), 'gail rios obrien jr');
  assert.equal(familyFold('ZOË  “Zo” Mc‘Donald'), 'zoe zo mcdonald');

  assert.equal(familyHistoryPrefix({}), 'family-history');
  assert.equal(familyHistoryPrefix({ KADE_FAMILY_HISTORY_PREFIX: '/private/fh/' }), 'private/fh');

  assert.equal(familyStoryMarkdown(STORY), STORY_CLEAN);
  assert.equal(familyStoryMarkdown('a <br/> b <img src=x onerror=alert(1)> c 1 < 2 > 0'), 'a  b  c 1 < 2 > 0');
  assert.equal(familyStoryMarkdown('keep <!-- unclosed'), 'keep ');
});

test('siblings: full, half through one shared birth parent, step through a step-parent only, doubtful through a doubtful link only', () => {
  assert.deepEqual(familySiblings(BUNDLE, '@I100@'), [{ id: '@I101@' }, { id: '@I102@', kind: 'half' }]);
  assert.deepEqual(familySiblings(BUNDLE, '@I200@'), [{ id: '@I210@' }]);
  assert.deepEqual(familySiblings(BUNDLE, '@I999@'), []);
  const blended = clone(BUNDLE);
  blended.people['@I150@'] = { ...clone(BUNDLE.people['@I101@']), id: '@I150@', name: 'Pat Example', label: 'Pat Example (born 1980)', parents: [{ id: '@I200@', kind: 'step' }] };
  blended.people['@I151@'] = { ...clone(BUNDLE.people['@I101@']), id: '@I151@', name: 'Rue Example', label: 'Rue Example (born 1982)', parents: [{ id: '@I200@', kind: 'doubtful' }] };
  blended.people['@I200@'].children = [...(blended.people['@I200@'].children || []), '@I150@', '@I151@'];
  assert.deepEqual(familySiblings(blended, '@I100@'), [
    { id: '@I101@' },
    { id: '@I102@', kind: 'half' },
    { id: '@I150@', kind: 'step' },
    { id: '@I151@', kind: 'doubtful' },
  ]);
  const children = familyPersonPayload(blended, OWNER_VIEW, '@I200@')?.family.children || [];
  assert.deepEqual(children.map((child) => [child.id, child.kind || 'birth']), [
    ['@I100@', 'birth'],
    ['@I101@', 'birth'],
    ['@I102@', 'birth'],
    ['@I150@', 'step'],
    ['@I151@', 'doubtful'],
  ], "a child's own link to this parent comes along, so a stepchild is never shown as a child by birth");
});

test('record scans come with the person\'s pictures (so the page knows a PDF from a photo); a wrongly attached record\'s do not', () => {
  const scans = clone(BUNDLE);
  scans.people['@I300@'].media = ['m-tree1'];
  scans.records['c1:r2'].image = 'm-grave1';
  const payload = familyPersonPayload(scans, BEN_VIEW, '@I300@');
  assert.deepEqual(ids(payload?.media || []), ['m-tree1', 'm-rec1']);
  assert.equal(payload?.media[1].file, 'media/m-rec1.jpg');
  assert.deepEqual(ids(familyPersonPayload(BUNDLE, BEN_VIEW, '@I300@')?.media || []), ['m-tree1', 'm-rec1'], 'never twice');
});

test('media objects: only ids the bundle names, only files inside the media folder', () => {
  assert.deepEqual(familyMediaObject(BUNDLE, 'family-history', 'm-rec1'), { key: 'family-history/media/m-rec1.jpg', mime: 'image/jpeg' });
  assert.deepEqual(familyMediaObject(BUNDLE, 'fh', 'm-doc1'), { key: 'fh/media/m-doc1.pdf', mime: 'application/pdf' });
  for (const missing of ['m-bad', 'm-none', 'constructor', '__proto__', '../m-rec1'])
    assert.equal(familyMediaObject(BUNDLE, 'family-history', missing), null, missing);
  const pages = clone(BUNDLE);
  pages.media['m-page1'] = { id: 'm-page1', kind: 'tree', file: 'media/m-page1.htm', caption: 'An invented saved page' };
  pages.media['m-page2'] = { id: 'm-page2', kind: 'tree', file: 'media/m-page2.HTML', caption: 'Another' };
  assert.equal(familyMediaObject(pages, 'fh', 'm-page1')?.mime, 'text/plain; charset=utf-8', 'a saved web page opens as text, so its scripts never run');
  assert.equal(familyMediaObject(pages, 'fh', 'm-page2')?.mime, 'text/plain; charset=utf-8');
});

test('match bodies are checked against the tree before anything is saved', () => {
  const user = STRANGER.id as string;
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: '@I101@' }, BUNDLE), {
    userId: user,
    fields: { kadeFamilyTreePerson: '@I101@', kadeFamilyHistory: null, kadeFamilyHistoryAskedAt: null },
  }, 'a match also clears an ask to be added');
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: '@I900@', guest: true }, BUNDLE), {
    userId: user,
    fields: { kadeFamilyTreePerson: '@I200@', kadeFamilyHistory: null, kadeFamilyHistoryAskedAt: null },
  }, 'a duplicate entry is saved as its main person, and a person wins over guest');
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: null, guest: true }, BUNDLE), {
    userId: user,
    fields: { kadeFamilyTreePerson: null, kadeFamilyHistory: 'guest', kadeFamilyHistoryAskedAt: null },
  });
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: null }, BUNDLE), {
    userId: user,
    fields: { kadeFamilyTreePerson: null, kadeFamilyHistory: 'none', kadeFamilyHistoryAskedAt: null },
  });
  assert.deepEqual(familyHistoryMatch({ userId: 'nope', personId: '@I101@' }, BUNDLE), { error: 'Choose an account.' });
  assert.deepEqual(familyHistoryMatch(null, BUNDLE), { error: 'Choose an account.' });
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: '@I999@' }, BUNDLE), { error: 'That person is not in the family tree.' });
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: 42 }, BUNDLE), { error: 'That person is not in the family tree.' });
  assert.deepEqual(familyHistoryMatch({ userId: user, personId: 'constructor' }, BUNDLE), { error: 'That person is not in the family tree.' });
  assert.deepEqual(familyHistoryMatch({ userId: user, guest: 'yes' }, BUNDLE), { error: 'Guest must be yes or no.' });
});

test('nearness: married-in people sit one step past the relative they married', () => {
  assert.equal(familyNearness(BUNDLE, OWNER_VIEW, '@I100@'), 0);
  assert.equal(familyNearness(BUNDLE, OWNER_VIEW, '@I300@'), 2);
  assert.equal(familyNearness(BUNDLE, OWNER_VIEW, '@I110@'), 1, 'her husband, through her');
  assert.equal(familyNearness(BUNDLE, OWNER_VIEW, '@I211@'), 4, 'the uncle is 3 away');
  assert.ok(familyNearness(BUNDLE, OWNER_VIEW, '@I800@') < familyNearness(BUNDLE, OWNER_VIEW, '@I900@'), 'duplicates come last');
});

test('search keeps to 50 results, relatives nearest first', () => {
  const big = clone(BUNDLE);
  const view: FamilyView = { anchor: '@I100@', relations: {} };
  for (let i = 0; i < 70; i++) {
    const id = `@C${i}@`;
    big.people[id] = { id, name: `Cousin Example ${i}`, label: `Cousin Example ${i}`, lifespan: '' };
    if (i % 2 === 0) view.relations[id] = { term: 'cousin', group: 'blood', distance: 100 - i };
  }
  const found = familySearch(big, view, 'cousin example');
  assert.equal(found.length, 50);
  assert.deepEqual(ids(found.slice(0, 3)), ['@C68@', '@C66@', '@C64@']);
  assert.ok(found.slice(0, 35).every((row) => row.relation), 'all 35 relatives before anyone unrelated');
  assert.ok(found.slice(35).every((row) => !row.relation));
});

/* ── GET /me ──────────────────────────────────────────────────────────── */

test('GET /me: the owner, a matched member, one with no view file, a guest and a duplicate match', async () => {
  let r = await call(main, '/me', 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  assert.deepEqual(r.body, {
    access: true,
    viewer: {
      personId: '@I100@',
      name: 'Ada Example',
      label: 'Ada Example (born 1990)',
      relationToOwner: { term: 'you', group: 'self' },
      first: 'Owner',
      inTree: true,
    },
    mode: 'owner',
    isOwner: true,
    version: 'v1',
    counts: BUNDLE.counts,
    owner: { first: 'Ada' },
    row: { detail: 'Your tree', hint: FAMILY_HISTORY_ROW_HINT },
  });

  r = await call(main, '/me', 'ben');
  assert.equal(r.body.mode, 'family');
  assert.equal(r.body.isOwner, false);
  assert.equal(r.body.viewer.personId, '@I200@');
  assert.deepEqual(r.body.viewer.relationToOwner, OWNER_VIEW.relations['@I200@']);
  assert.equal('viewNote' in r.body, false, 'Ben has his own view file');
  assert.equal(r.body.row.detail, 'Ada’s father', "the row says who they are to the tree's owner");
  assert.equal(r.body.viewer.first, 'Ben', "the greeting uses the account's own name");

  r = await call(main, '/me', 'cora');
  assert.equal(r.body.viewer.personId, '@I201@');
  assert.equal(r.body.viewNote, FAMILY_HISTORY_VIEW_NOTE);
  assert.equal(r.body.viewer.relationToOwner.term, 'mother');
  assert.equal(r.body.row.detail, 'Ada’s mother');

  r = await call(main, '/me', 'guest');
  assert.equal(r.body.mode, 'guest');
  assert.equal(r.body.isOwner, false);
  assert.equal(r.body.viewer.personId, '@I100@', 'the web page centres a guest on the owner');
  assert.equal(r.body.viewer.name, 'Ada Example', "the web page says the owner's words for a guest");
  assert.equal(r.body.viewer.first, 'Guest', "a guest is greeted by their own name, never the owner's");
  assert.equal(r.body.viewer.inTree, false);
  assert.equal(r.body.row.detail, 'Guest');
  assert.equal('viewNote' in r.body, false);

  r = await call(main, '/me', 'twin');
  assert.equal(r.body.viewer.personId, '@I200@');
  assert.equal(r.body.viewer.label, 'Ben Example (1960-2020)');
});

test('refused accounts are told plainly, on every route, with nothing cached and no bucket read for strangers', async () => {
  const paths = ['/me', '/person/%40I100%40', '/tree', '/search?q=example', '/people?group=all', '/stories', '/story/the-farm', '/findings', '/media/m-rec1'];
  const reasons: Record<string, string> = { stranger: 'unmatched', test: 'test', review: 'review', stale: 'unmatched' };
  for (const who of ['stranger', 'test', 'review', 'stale']) {
    for (const path of paths) {
      const r = await call(main, path, who);
      assert.equal(r.status, 403, `${who} ${path}`);
      assert.equal(r.cache, 'no-store');
      assert.equal(r.body.access, false);
      assert.equal(r.body.error, FAMILY_HISTORY_PRIVATE);
      assert.equal(r.body.reason, reasons[who], `${who} ${path}`);
      assert.equal(r.body.canAsk, reasons[who] === 'unmatched', `${who} ${path}`);
    }
  }
  assert.equal(FAMILY_HISTORY_PRIVATE, 'The family history is private to the family.');
  const signedOut = await call(main, '/me');
  assert.equal(signedOut.status, 401, 'requireJwtAuth runs first');
  assert.equal(signedOut.cache, 'no-store');
  const strangerOnly = await harness();
  try {
    for (const path of paths) await call(strangerOnly, path, 'stranger');
    assert.deepEqual(strangerOnly.reads, [], 'a stranger never reaches the bucket');
  } finally {
    await strangerOnly.close();
  }
});

/* ── GET /person/:id ──────────────────────────────────────────────────── */

test('GET /person/:id: family, records with the wrongly attached one marked, graves, pictures, all said from the viewer\'s place', async () => {
  const r = await call(main, `/person/${pid('@I300@')}`, 'ben');
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  const body = r.body;
  assert.equal(body.person.id, '@I300@');
  assert.equal(body.person.name, 'Dan Example');
  assert.deepEqual(body.person.otherNames, ['Daniel Example']);
  assert.deepEqual(body.person.relation, BEN_VIEW.relations['@I300@'], "Ben's father, from Ben's view");
  assert.deepEqual(body.family.parents, [
    { id: '@I400@', label: 'Hugo Example (1900-1970)', lifespan: '1900-1970', relation: BEN_VIEW.relations['@I400@'], kind: 'birth' },
  ]);
  assert.deepEqual(ids(body.family.spouses), ['@I301@']);
  assert.equal(body.family.spouses[0].relation?.term, 'mother');
  assert.deepEqual(body.family.children.map((c) => [c.id, c.relation?.term, c.kind || 'birth']), [
    ['@I200@', 'you', 'birth'],
    ['@I210@', 'brother', 'birth'],
  ]);
  assert.deepEqual(body.family.siblings, []);
  assert.deepEqual(body.records.map((rec) => [rec.key, rec.wrong || null]), [
    ['c1:r1', null],
    ['c1:r2', 'This census lists a different Dan Example, twenty years older.'],
  ]);
  assert.deepEqual(body.records[0].tables, BUNDLE.records['c1:r1'].tables);
  assert.equal(body.memorials.length, 1);
  assert.equal(body.memorials[0].cemetery, 'Invented Cemetery');
  assert.deepEqual(body.memorials[0].photos, [{ id: 'm-grave1', caption: 'Headstone' }], 'a photo that was never downloaded is left out');
  assert.equal('wrong' in body.memorials[0], false);
  assert.deepEqual(ids(body.media), ['m-tree1', 'm-rec1']);
  assert.equal(body.media[0].kind, 'tree');
  assert.deepEqual(body.findings, []);
});

test('GET /person/:id: source records from facts, a wrongly attached grave, findings, siblings and a duplicate entry', async () => {
  let r = await call(main, `/person/${pid('@I200@')}`, 'owner');
  assert.deepEqual(r.body.records.map((rec) => rec.key), ['c2:r1'], 'the fact\'s source record comes along; a stripped one is skipped');
  assert.deepEqual(ids(r.body.media), ['m-doc1']);
  assert.equal(r.body.person.relation.term, 'father');
  assert.deepEqual(r.body.findings, [
    {
      summary: 'Ben and Ned Example share an invented DNA match.',
      people: [
        { id: '@I200@', label: 'Ben Example (1960-2020)', lifespan: '1960-2020', relation: OWNER_VIEW.relations['@I200@'] },
        { id: '@I210@', label: 'Ned Example (1958-2018)', lifespan: '1958-2018', relation: OWNER_VIEW.relations['@I210@'] },
      ],
    },
  ]);

  r = await call(main, `/person/${pid('@I100@')}`, 'owner');
  assert.deepEqual(r.body.family.siblings.map((s) => [s.id, s.kind || 'full']), [
    ['@I101@', 'full'],
    ['@I102@', 'half'],
  ]);
  assert.deepEqual(ids(r.body.family.children), ['@I120@']);
  assert.equal(r.body.family.children[0].relation?.term, 'son');

  r = await call(main, `/person/${pid('@I301@')}`, 'owner');
  assert.deepEqual(r.body.memorials.map((m) => [m.id, m.wrong]), [
    ['5003', 'A different Eve Example, buried in another state.'],
  ]);

  r = await call(main, `/person/${pid('@I302@')}`, 'owner');
  assert.deepEqual(r.body.family.parents.map((p) => [p.id, p.kind]), [['@I700@', 'probable']]);
  assert.equal(r.body.findings.length, 1);
  assert.match(r.body.findings[0].summary, /^Finn Sample's father/);

  r = await call(main, `/person/${pid('@I700@')}`, 'owner');
  assert.equal(r.body.person.virtual, true);
  assert.deepEqual(r.body.person.relation.notes, ['Research finding: probable father, not proven.']);
  assert.deepEqual(r.body.family.children.map((c) => [c.id, c.kind]), [['@I302@', 'probable']], "on the parent's page too, the child is marked as a research finding");

  r = await call(main, `/person/${pid('@I900@')}`, 'owner');
  assert.equal(r.status, 200, 'redirect-free');
  assert.equal(r.body.person.id, '@I900@');
  assert.equal(r.body.person.duplicateOf, '@I200@');
  assert.equal(r.body.person.relation, null);

  r = await call(main, `/person/${pid('@I300@')}`, 'cora');
  assert.equal(r.body.person.relation.term, 'grandfather', "Cora has no view file: the owner's view");

  for (const who of ['owner', 'ben', 'guest']) {
    r = await call(main, `/person/${pid('@I101@')}`, who);
    assert.equal(r.status, 200, who);
    assert.deepEqual(
      r.body.records.map((rec) => [rec.key, rec.wrong || null]),
      [['c2:r1', null], ['c1:r1', null], ['c1:r2', 'An invented mix-up.']],
      `${who}: a living relative's records are served like anyone's, as the export sends them`,
    );
    assert.deepEqual(r.body.memorials.map((m) => [m.id, m.wrong]), [['5003', 'An invented mix-up.']], who);
    assert.deepEqual(ids(r.body.media), ['m-rec1'], `${who}: with the record's scan`);
    assert.deepEqual(r.body.person.facts?.[0].records, ['c2:r1', 'c1:r1'], `${who}: the fact keeps its source records`);
  }

  for (const missing of ['@I999@', 'constructor', '__proto__', 'hasOwnProperty']) {
    r = await call(main, `/person/${pid(missing)}`, 'owner');
    assert.equal(r.status, 404, missing);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { error: 'That person is not in the family tree.' });
  }
});

/* ── GET /tree ────────────────────────────────────────────────────────── */

test('GET /tree: ancestors up, descendants down, siblings and spouses, with the default and capped depths', async () => {
  let r = await call(main, '/tree', 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.body.focus, '@I100@');
  assert.equal(r.body.up, 4);
  assert.equal(r.body.down, 2);
  assert.deepEqual(ids(r.body.nodes).sort(), [
    '@I100@', '@I101@', '@I102@', '@I110@', '@I120@', '@I200@', '@I201@', '@I300@', '@I301@', '@I302@', '@I303@', '@I400@', '@I500@', '@I700@',
  ]);
  assert.equal(r.body.nodes[0].id, '@I100@', 'the focus comes first');
  const node = (id: string): FamilyTreeNode => {
    const found = r.body.nodes.find((n) => n.id === id);
    assert.ok(found, id);
    return found;
  };
  assert.deepEqual(node('@I300@'), {
    id: '@I300@',
    label: 'Dan Example (1930-1999)',
    lifespan: '1930-1999',
    sex: 'M',
    relation: OWNER_VIEW.relations['@I300@'],
    living: false,
    virtual: false,
    photo: 'm-tree1',
  });
  assert.equal('photo' in node('@I200@'), false, 'a PDF is not a portrait');
  assert.equal(node('@I700@').virtual, true);
  assert.equal(node('@I101@').living, true);
  assert.ok(r.body.links.some((l) => l.parent === '@I700@' && l.child === '@I302@' && l.kind === 'probable'));
  assert.ok(r.body.links.some((l) => l.parent === '@I200@' && l.child === '@I102@'), 'the half brother hangs off his father');
  assert.deepEqual(
    r.body.couples.map((pair) => [...pair].sort().join('+')).sort(),
    ['@I100@+@I110@', '@I200@+@I201@', '@I300@+@I301@', '@I302@+@I303@'],
  );

  r = await call(main, '/tree?up=3&down=0', 'owner');
  assert.equal(ids(r.body.nodes).includes('@I500@'), false, 'four generations up is past up=3');
  assert.equal(ids(r.body.nodes).includes('@I400@'), true);
  assert.equal(ids(r.body.nodes).includes('@I120@'), false);

  r = await call(main, '/tree?up=99&down=99', 'owner');
  assert.equal(r.body.up, 8);
  assert.equal(r.body.down, 4);
  assert.equal(ids(r.body.nodes).includes('@I500@'), true);

  r = await call(main, '/tree?up=-2&down=nonsense', 'owner');
  assert.equal(r.body.up, 0);
  assert.equal(r.body.down, 2);
  assert.deepEqual(ids(r.body.nodes).sort(), ['@I100@', '@I101@', '@I102@', '@I110@', '@I120@']);
  assert.deepEqual(r.body.links, [
    { parent: '@I100@', child: '@I120@', kind: 'birth' },
    { parent: '@I110@', child: '@I120@', kind: 'birth' },
  ]);
});

test('GET /tree: another focus, the viewer\'s own place by default, a duplicate focus and an unknown one', async () => {
  let r = await call(main, `/tree?focus=${pid('@I300@')}&up=1&down=1`, 'owner');
  assert.equal(r.body.focus, '@I300@');
  assert.deepEqual(ids(r.body.nodes).sort(), ['@I200@', '@I210@', '@I300@', '@I301@', '@I400@']);
  assert.deepEqual(
    r.body.links.map((l) => `${l.parent}>${l.child}`).sort(),
    ['@I300@>@I200@', '@I300@>@I210@', '@I301@>@I200@', '@I301@>@I210@', '@I400@>@I300@'],
  );
  assert.deepEqual(r.body.couples, [['@I300@', '@I301@']]);

  r = await call(main, '/tree?up=1&down=1', 'ben');
  assert.equal(r.body.focus, '@I200@');
  const self = r.body.nodes.find((n) => n.id === '@I200@');
  assert.equal(self?.relation?.term, 'you');

  r = await call(main, `/tree?focus=${pid('@I900@')}`, 'owner');
  assert.equal(r.body.focus, '@I200@', 'a duplicate entry centres on its main person');

  r = await call(main, `/tree?focus=${pid('@I999@')}`, 'owner');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'That person is not in the family tree.' });
});

/* ── GET /search ──────────────────────────────────────────────────────── */

test('GET /search: name, other names and birth surname, any case and punctuation, relatives first', async () => {
  let r = await call(main, '/search?q=sample', 'owner');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.body), ['@I201@', '@I302@', '@I303@', '@I700@'], 'born a Sample, then the grandparents, then the research finding');
  assert.deepEqual(r.body[0], { id: '@I201@', label: 'Cora Example (born 1962)', lifespan: 'born 1962', relation: OWNER_VIEW.relations['@I201@'] });

  r = await call(main, '/search?q=example', 'ben');
  assert.deepEqual(ids(r.body), [
    '@I200@',
    '@I100@', '@I201@', '@I300@', '@I301@', '@I101@', '@I102@',
    '@I400@', '@I120@', '@I210@',
    '@I500@', '@I211@',
    '@I900@',
  ], "Ben's own family nearest first by his relationships, the duplicate entry last");
  assert.equal('relation' in r.body[12], false);

  r = await call(main, '/search?q=' + encodeURIComponent('Sample'), 'ben');
  assert.deepEqual(ids(r.body), ['@I201@', '@I302@', '@I303@', '@I700@'], 'his wife is related to him; her family is not');
  assert.equal(r.body[1].relation, undefined);

  for (const q of ["o'brien", 'OBRIEN', 'O.Brien', 'obrien-stranger', 'OBrienStranger', 'quinn  STRANGER']) {
    r = await call(main, `/search?q=${encodeURIComponent(q)}`, 'owner');
    assert.deepEqual(ids(r.body), ['@I800@'], q);
  }
  for (const q of ['rios', 'Ríos', 'RIOS']) {
    r = await call(main, `/search?q=${encodeURIComponent(q)}`, 'owner');
    assert.deepEqual(ids(r.body), ['@I303@'], q);
  }
  r = await call(main, '/search?q=oakley', 'owner');
  assert.deepEqual(ids(r.body), ['@I301@'], 'born an Oakley');
  for (const q of ['', '   ', '!!!', 'zzzz']) {
    r = await call(main, `/search?q=${encodeURIComponent(q)}`, 'owner');
    assert.deepEqual(r.body, [], JSON.stringify(q));
  }
  r = await call(main, '/search', 'owner');
  assert.deepEqual(r.body, []);
});

/* ── GET /people ──────────────────────────────────────────────────────── */

test('GET /people: groups nearest first, ancestors by generation, duplicates left out', async () => {
  let r = await call(main, '/people?group=ancestor', 'owner');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.body), ['@I200@', '@I201@', '@I300@', '@I301@', '@I302@', '@I303@', '@I400@', '@I700@', '@I500@']);
  assert.deepEqual(r.body[0], {
    id: '@I200@',
    label: 'Ben Example (1960-2020)',
    lifespan: '1960-2020',
    relation: OWNER_VIEW.relations['@I200@'],
    group: 'ancestor',
    gen: 1,
    distance: 1,
  });

  r = await call(main, '/people?group=blood', 'owner');
  assert.deepEqual(ids(r.body), ['@I101@', '@I102@', '@I210@']);
  assert.equal('gen' in r.body[0], false, 'a sibling has no generation');

  r = await call(main, '/people?group=marriage', 'owner');
  assert.deepEqual(ids(r.body), ['@I110@', '@I211@']);
  assert.deepEqual(r.body[0], { id: '@I110@', label: 'Lee Spouse (born 1989)', lifespan: 'born 1989', relation: { term: 'husband', group: 'marriage' }, group: 'marriage' });

  r = await call(main, '/people?group=all', 'owner');
  assert.equal(r.body.length, 17);
  assert.equal(r.body[0].id, '@I100@');
  assert.equal(r.body[0].group, 'self');
  assert.deepEqual(r.body[16], { id: '@I800@', label: 'Quinn Stranger (1850-1900)', lifespan: '1850-1900', relation: null, group: 'none' });
  assert.equal(ids(r.body).includes('@I900@'), false);

  r = await call(main, '/people', 'owner');
  assert.equal(r.body.length, 17, 'no group means all');

  r = await call(main, '/people?group=descendant', 'owner');
  assert.deepEqual(ids(r.body), ['@I120@']);

  r = await call(main, '/people?group=ancestor', 'ben');
  assert.deepEqual(ids(r.body), ['@I300@', '@I301@', '@I400@', '@I500@']);

  r = await call(main, '/people?group=cousins', 'owner');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Choose ancestor, blood, marriage or all.' });
});

/* ── stories and findings ─────────────────────────────────────────────── */

test('GET /stories and /story/:slug: markdown with no raw HTML, and no file outside the version folder', async () => {
  let r = await call(main, '/stories', 'guest');
  assert.deepEqual(r.body, [
    { slug: 'the-farm', title: 'The farm on Example Road', words: 14 },
    { slug: 'escape', title: 'A path that leaves the version folder', words: 1 },
  ]);
  r = await call(main, '/story/the-farm', 'guest');
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  assert.deepEqual(r.body, { slug: 'the-farm', title: 'The farm on Example Road', markdown: STORY_CLEAN });
  assert.ok(main.reads.includes('family-history/v1/stories/the-farm.md'));
  for (const slug of ['escape', 'nope', '..%2F..%2Fbundle', 'constructor']) {
    r = await call(main, `/story/${slug}`, 'guest');
    assert.equal(r.status, 404, slug);
    assert.deepEqual(r.body, { error: 'That story was not found.' });
  }
  assert.equal(main.reads.some((key) => key.includes('outside')), false, 'the escaping path was never read');
});

test('GET /findings: every finding with the people it names, related to the viewer', async () => {
  let r = await call(main, '/findings', 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.deepEqual(r.body[0], {
    summary: "Finn Sample's father is probably the unnamed farmhand in an invented census.",
    people: [
      { id: '@I302@', label: 'Finn Sample (1935-2001)', lifespan: '1935-2001', relation: OWNER_VIEW.relations['@I302@'] },
      { id: '@I700@', label: 'Unknown Sample (about 1900)', lifespan: 'about 1900', relation: OWNER_VIEW.relations['@I700@'] },
    ],
  });
  r = await call(main, '/findings', 'ben');
  assert.deepEqual(r.body[0].people, [
    { id: '@I302@', label: 'Finn Sample (1935-2001)', lifespan: '1935-2001' },
    { id: '@I700@', label: 'Unknown Sample (about 1900)', lifespan: 'about 1900' },
  ], 'no known link to Ben');
  assert.equal(r.body[1].people[0].relation?.term, 'you');
});

/* ── GET /media/:id ───────────────────────────────────────────────────── */

test('GET /media/:id: a signed hour for ids in the bundle, a redirect for <img>, 404 for anything else', async () => {
  main.signed.length = 0;
  let r = await call(main, '/media/m-rec1', 'ben');
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  assert.deepEqual(r.body, { url: 'https://bucket.example/family-history/media/m-rec1.jpg?signature=test' });
  assert.deepEqual(main.signed, [['family-history/media/m-rec1.jpg', 'image/jpeg', 3600]]);

  r = await call(main, '/media/m-doc1?redirect=1', 'guest');
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://bucket.example/family-history/media/m-doc1.pdf?signature=test');
  assert.deepEqual(main.signed[1], ['family-history/media/m-doc1.pdf', 'application/pdf', 3600]);

  for (const id of ['m-bad', 'm-none', 'constructor', '..%2Fbundle', 'media%2Fm-rec1.jpg']) {
    r = await call(main, `/media/${id}`, 'owner');
    assert.equal(r.status, 404, id);
    assert.deepEqual(r.body, { error: 'That picture is not in the family history.' });
  }
  assert.equal(main.signed.length, 2, 'nothing else was signed');

  main.signFails.on = true;
  try {
    r = await call(main, '/media/m-rec1', 'owner');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: FAMILY_HISTORY_UPDATING });
  } finally {
    main.signFails.on = false;
  }
});

/* ── owner only: /accounts and /match ─────────────────────────────────── */

test('GET /accounts: the owner sees every account but the review seat; nobody else sees it', async () => {
  for (const who of ['ben', 'guest', 'cora', 'stranger', 'review', 'test']) {
    const r = await call(main, '/accounts', who);
    assert.equal(r.status, 403, who);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { error: FAMILY_HISTORY_OWNER_ONLY });
  }
  const r = await call(main, '/accounts', 'owner');
  assert.equal(r.status, 200);
  const rows: FamilyHistoryAccountRow[] = r.body;
  assert.equal(rows.some((row) => row.userId === REVIEW.id), false, 'the review seat is not listed');
  assert.deepEqual(rows.map((row) => row.name), ['Ben Account', 'Ben Twin', 'Bob Stranger', 'Cora Account', 'Guest Friend', 'Owner Account', 'Seat', 'Stale Match']);
  const row = (name: string) => rows.find((entry) => entry.name === name);
  assert.deepEqual(row('Ben Account'), {
    userId: BEN.id,
    name: 'Ben Account',
    username: 'ben',
    personId: '@I200@',
    personLabel: 'Ben Example (1960-2020)',
    access: 'family',
    testSeat: false,
    changeable: true,
    askedAt: null,
  });
  assert.equal(row('Ben Twin')?.userId, 'aaaaaaaaaaaaaaaaaaaaaa08', 'a lean row with _id');
  assert.equal(row('Ben Twin')?.personLabel, 'Ben Example (1960-2020)');
  assert.equal(row('Owner Account')?.access, 'owner');
  assert.equal(row('Owner Account')?.changeable, false, 'an administrator is never matched');
  assert.equal(row('Guest Friend')?.access, 'guest');
  assert.equal(row('Guest Friend')?.changeable, true);
  assert.equal(row('Bob Stranger')?.access, 'none');
  assert.equal(row('Seat')?.testSeat, true);
  assert.equal(row('Seat')?.access, 'none');
  assert.equal(row('Seat')?.changeable, false, 'a test seat is never let in');
  assert.deepEqual([row('Stale Match')?.personId, row('Stale Match')?.personLabel, row('Stale Match')?.access], ['@I999@', null, 'none']);
});

test('POST /match: validated against the tree, never on the review seat, an admin or a test seat, and only by the owner', async () => {
  const h = await harness();
  h.users.set('helper', { id: 'aaaaaaaaaaaaaaaaaaaaaa11', name: 'Helper Admin', username: 'helper', role: 'ADMIN' });
  try {
    let r = await call(h, '/match', 'ben', { userId: STRANGER.id, personId: '@I101@' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: FAMILY_HISTORY_OWNER_ONLY });
    r = await call(h, '/match', 'review', { userId: STRANGER.id, personId: '@I101@' });
    assert.equal(r.status, 403, 'the review seat is an admin, and still not the owner');
    assert.deepEqual(h.sets, []);

    r = await call(h, '/match', 'owner', { userId: 'bob', personId: '@I101@' });
    assert.deepEqual([r.status, r.body], [400, { error: 'Choose an account.' }]);
    r = await call(h, '/match', 'owner', { userId: STRANGER.id, personId: '@I999@' });
    assert.deepEqual([r.status, r.body], [400, { error: 'That person is not in the family tree.' }]);
    r = await call(h, '/match', 'owner', { userId: STRANGER.id, guest: 'yes' });
    assert.deepEqual([r.status, r.body], [400, { error: 'Guest must be yes or no.' }]);
    r = await call(h, '/match', 'owner', { userId: 'aaaaaaaaaaaaaaaaaaaaaaff', personId: '@I101@' });
    assert.deepEqual([r.status, r.body], [404, { error: 'That account was not found.' }]);
    r = await call(h, '/match', 'owner', { userId: REVIEW.id, personId: '@I101@' });
    assert.equal(r.status, 409);
    const adminRefusal = { error: 'An administrator always sees the family history as its owner.' };
    r = await call(h, '/match', 'owner', { userId: OWNER.id, personId: '@I300@' });
    assert.deepEqual([r.status, r.body], [409, adminRefusal], "the owner cannot re-anchor her own view on a relative");
    r = await call(h, '/match', 'owner', { userId: 'aaaaaaaaaaaaaaaaaaaaaa11', personId: '@I200@' });
    assert.deepEqual([r.status, r.body], [409, adminRefusal]);
    r = await call(h, '/match', 'owner', { userId: 'aaaaaaaaaaaaaaaaaaaaaa11', personId: null, guest: false });
    assert.deepEqual([r.status, r.body], [409, adminRefusal]);
    const testRefusal = { error: 'Test accounts are always kept out of the family history.' };
    r = await call(h, '/match', 'owner', { userId: TEST_SEAT.id, personId: null, guest: true });
    assert.deepEqual([r.status, r.body], [409, testRefusal]);
    r = await call(h, '/match', 'owner', { userId: TEST_SEAT.id, personId: '@I101@' });
    assert.deepEqual([r.status, r.body], [409, testRefusal]);
    assert.deepEqual(h.sets, [], 'nothing saved for any refusal');
    assert.equal((await call(h, '/me', 'owner')).body.mode, 'owner', 'the owner still sees the tree as its owner');
    assert.equal((await call(h, '/me', 'test')).status, 403);

    let me = await call(h, '/me', 'stranger');
    assert.equal(me.status, 403);
    r = await call(h, '/match', 'owner', { userId: STRANGER.id, personId: '@I900@' });
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(h.sets.pop(), [STRANGER.id, { kadeFamilyTreePerson: '@I200@', kadeFamilyHistory: null, kadeFamilyHistoryAskedAt: null }]);
    assert.deepEqual(r.body, {
      ok: true,
      account: { userId: STRANGER.id, name: 'Bob Stranger', username: 'bob', personId: '@I200@', personLabel: 'Ben Example (1960-2020)', access: 'family', testSeat: false, changeable: true, askedAt: null },
    });
    me = await call(h, '/me', 'stranger');
    assert.equal(me.body.viewer.personId, '@I200@', 'the match takes effect at once');

    r = await call(h, '/match', 'owner', { userId: STRANGER.id, personId: null, guest: true });
    assert.deepEqual(h.sets.pop(), [STRANGER.id, { kadeFamilyTreePerson: null, kadeFamilyHistory: 'guest', kadeFamilyHistoryAskedAt: null }]);
    assert.equal(r.body.account.access, 'guest');
    assert.equal(r.body.account.personId, null);
    me = await call(h, '/me', 'stranger');
    assert.equal(me.body.mode, 'guest');

    r = await call(h, '/match', 'owner', { userId: STRANGER.id, personId: null, guest: false });
    assert.deepEqual(h.sets.pop(), [STRANGER.id, { kadeFamilyTreePerson: null, kadeFamilyHistory: 'none', kadeFamilyHistoryAskedAt: null }]);
    assert.equal(r.body.account.access, 'none');
    me = await call(h, '/me', 'stranger');
    assert.equal(me.status, 403, 'access removed');
  } finally {
    await h.close();
  }
});

test('POST /ask: an account that is not matched asks once a week; the owner sees askers first; a match clears the ask', async () => {
  const h = await harness();
  h.users.set('declined', { id: 'aaaaaaaaaaaaaaaaaaaaaa12', name: 'Said No', username: 'no', kadeFamilyHistory: 'none' });
  try {
    let r = await call(h, '/ask', 'stranger', {});
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual([r.body.ok, r.body.askedAt, r.body.text], [true, '2026-09-29T12:00:00.000Z', FAMILY_HISTORY_ASKED]);
    assert.deepEqual(h.sets.pop(), [STRANGER.id, { kadeFamilyHistoryAskedAt: '2026-09-29T12:00:00.000Z' }]);
    assert.deepEqual(h.reads, [], 'asking never reads the tree for an account that could not be in it');

    r = await call(h, '/me', 'stranger');
    assert.equal(r.status, 403);
    assert.deepEqual([r.body.reason, r.body.canAsk, r.body.detail, r.body.askedAt], ['unmatched', false, 'Asked on 29 September 2026', '2026-09-29T12:00:00.000Z']);

    r = await call(h, '/ask', 'stranger', {});
    assert.equal(r.status, 429, 'once a week');
    assert.equal(r.body.canAsk, false);
    assert.deepEqual(h.sets, []);

    h.tick(8 * 24 * 60 * 60 * 1000);
    r = await call(h, '/ask', 'stranger', {});
    assert.equal(r.status, 200, 'a week later they may ask again');
    h.sets.length = 0;

    for (const [who, reason] of [['review', 'review'], ['test', 'test'], ['declined', 'declined']]) {
      r = await call(h, '/ask', who, {});
      assert.equal(r.status, 403, who);
      assert.equal(r.body.reason, reason, who);
    }
    for (const who of ['ben', 'guest', 'owner']) {
      r = await call(h, '/ask', who, {});
      assert.equal(r.status, 403, who);
      assert.equal(r.body.error, 'This account can already open the family history.');
    }
    r = await call(h, '/ask', 'stale', {});
    assert.equal(r.status, 200, 'a match that left the tree may ask again');
    assert.deepEqual(h.sets.map((s) => s[0]), [STALE.id], 'nobody else was written');

    r = await call(h, '/accounts', 'owner');
    const rows: FamilyHistoryAccountRow[] = r.body;
    assert.deepEqual(rows.slice(0, 2).map((row) => row.name), ['Bob Stranger', 'Stale Match'], 'askers first');
    assert.equal(rows[0].askedAt, '2026-10-07T12:00:00.000Z');

    r = await call(h, '/match', 'owner', { userId: STRANGER.id, personId: '@I101@' });
    assert.equal(r.status, 200);
    assert.equal(r.body.account.askedAt, null, 'the match clears the ask');
    assert.equal((await call(h, '/me', 'stranger')).body.viewer.personId, '@I101@');
  } finally {
    await h.close();
  }
});

test('KADE_FH_OWNER_USER_ID: the owner account keeps owner mode and the owner pages; another admin visits as a guest', async () => {
  const h = await harness();
  h.users.set('helper', { id: 'aaaaaaaaaaaaaaaaaaaaaa11', name: 'Helper Admin', username: 'helper', role: 'ADMIN' });
  try {
    await withOwnerId(OWNER.id as string, async () => {
      let r = await call(h, '/me', 'owner');
      assert.deepEqual([r.body.mode, r.body.isOwner], ['owner', true]);
      r = await call(h, '/me', 'helper');
      assert.deepEqual([r.body.mode, r.body.isOwner, r.body.viewer.first, r.body.row.detail], ['guest', false, 'Helper', 'Guest']);
      assert.equal((await call(h, '/accounts', 'helper')).status, 403);
      assert.equal((await call(h, '/accounts', 'owner')).status, 200);
      r = await call(h, '/match', 'owner', { userId: 'aaaaaaaaaaaaaaaaaaaaaa11', personId: '@I200@' });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /visits as a guest/);
    });
    const r = await call(h, '/accounts', 'helper');
    assert.equal(r.status, 200, 'unset again: any admin, so the owner is never shut out');
  } finally {
    await h.close();
  }
});

test('pictures the export held back reach only the owner and the people it names, on every v1 route', async () => {
  const held = clone(BUNDLE);
  held.media['m-held'] = {
    id: 'm-held',
    kind: 'tree',
    file: 'media/m-held.jpg',
    caption: 'An invented held picture',
    people: ['@I300@'],
    heldFor: ['@I200@'],
    faces: [{ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }],
    portraitPersonId: '@I300@',
    portraitIdentityBasis: 'reviewed-face-identity',
  };
  held.people['@I300@'].media = ['m-held', 'm-tree1', 'm-rec1'];
  held.memorials['5001'].photos = [
    { media: 'm-held', caption: 'Held' },
    { media: 'm-grave1', caption: 'Headstone' },
  ];
  const h = await harness(bucket('v1', held));
  try {
    for (const [who, sees] of [
      ['owner', true],
      ['ben', true],
      ['guest', false],
      ['cora', false],
    ] as const) {
      const media = await call(h, '/media/m-held', who);
      assert.equal(media.status, sees ? 200 : 404, who);
      const person = await call(h, `/person/${pid('@I300@')}`, who);
      assert.equal(ids(person.body.media).includes('m-held'), sees, who);
      assert.equal(
        person.body.memorials[0].photos.some((p) => p.id === 'm-held'),
        sees,
        who,
      );
      const tree = await call(h, `/tree?focus=${pid('@I300@')}&up=0&down=0`, who);
      assert.equal(tree.body.nodes[0].photo, sees ? 'm-held' : 'm-tree1', who);
    }
  } finally {
    await h.close();
  }
});

/* ── loading, caching and failures ────────────────────────────────────── */

test('the bundle and views load once, stay ten minutes, and reload only when current.json names a new version', async () => {
  const h = await harness();
  try {
    await call(h, '/me', 'owner');
    assert.deepEqual(h.reads, ['family-history/current.json', 'family-history/v1/bundle.json.gz', 'family-history/v1/views/I100.json.gz']);
    await call(h, '/person/%40I300%40', 'ben');
    await call(h, '/me', 'ben');
    await call(h, '/me', 'cora');
    assert.deepEqual(h.reads.slice(3), ['family-history/v1/views/I200.json.gz'], "Cora has no view file, so none is fetched for her");

    h.tick(FAMILY_HISTORY_CACHE_MS - 1000);
    await call(h, '/me', 'owner');
    assert.equal(h.reads.length, 4, 'still inside ten minutes');

    h.tick(2000);
    await call(h, '/me', 'owner');
    assert.deepEqual(h.reads.slice(4), ['family-history/current.json'], 'same version: the bundle is kept');

    const next = clone(BUNDLE);
    next.version = 'v2';
    next.counts = { ...next.counts, people: 99 };
    for (const [key, value] of bucket('v2', next)) h.objects.set(key, value);
    h.objects.set('family-history/current.json', Buffer.from(JSON.stringify({ version: 'v2' })));
    let r = await call(h, '/me', 'owner');
    assert.equal(r.body.version, 'v1', 'a new version waits for the ten minutes');
    h.tick(FAMILY_HISTORY_CACHE_MS + 1);
    r = await call(h, '/me', 'owner');
    assert.equal(r.body.version, 'v2');
    assert.equal(r.body.counts.people, 99);
    assert.deepEqual(h.reads.slice(-3), ['family-history/current.json', 'family-history/v2/bundle.json.gz', 'family-history/v2/views/I100.json.gz']);
  } finally {
    await h.close();
  }
});

test('a failed load answers 503 in plain words; once loaded, a failed check keeps the tree it has', async () => {
  const h = await harness();
  try {
    h.failing.add('*');
    let r = await call(h, '/me', 'owner');
    assert.equal(r.status, 503);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { error: 'The family history is being updated. Try again in a minute.' });
    r = await call(h, '/tree', 'ben');
    assert.equal(r.status, 503);
    r = await call(h, '/accounts', 'owner');
    assert.equal(r.status, 503, 'the owner\'s list needs the tree for labels');

    h.failing.clear();
    r = await call(h, '/me', 'owner');
    assert.equal(r.status, 200);
    h.tick(FAMILY_HISTORY_CACHE_MS + 1);
    h.failing.add('family-history/current.json');
    const reads = h.reads.length;
    r = await call(h, '/me', 'owner');
    assert.equal(r.status, 200, 'the bucket hiccuped; the family keeps reading');
    assert.equal(r.body.version, 'v1');
    r = await call(h, '/me', 'owner');
    assert.equal(h.reads.length, reads + 1, 'and it waits a minute before asking again');
  } finally {
    await h.close();
  }

  const empty = await harness(new Map());
  try {
    const r = await call(empty, '/me', 'owner');
    assert.equal(r.status, 503, 'no current.json yet');
  } finally {
    await empty.close();
  }

  const noViews = bucket();
  noViews.delete('family-history/v1/views/I200.json.gz');
  const partial = await harness(noViews);
  try {
    const r = await call(partial, '/me', 'ben');
    assert.equal(r.status, 200);
    assert.equal(r.body.viewNote, FAMILY_HISTORY_VIEW_NOTE, "an anchor whose file is missing reads the owner's view");
    const person = await call(partial, `/person/${pid('@I300@')}`, 'ben');
    assert.equal(person.body.person.relation.term, 'grandfather');
  } finally {
    await partial.close();
  }

  const broken = bucket();
  broken.set('family-history/v1/bundle.json.gz', Buffer.from('{"owner": "@I1@", "people": {}}'));
  const bad = await harness(broken);
  try {
    const r = await call(bad, '/me', 'owner');
    assert.equal(r.status, 503, 'a bundle without its owner is not served');
  } finally {
    await bad.close();
  }
});

test('unknown paths under the API answer 404 here instead of falling through to other /api/kade routes', async () => {
  const r = await call(main, '/nothing-here', 'owner');
  assert.equal(r.status, 404);
  assert.equal(r.cache, 'no-store');
});
