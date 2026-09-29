/* Family history v2 (Sep 29 2026, docs/FAMILY_HISTORY.md): the iPhone app's routes, with every
 * word written on the server, on the invented family in __fixtures__/history.
 * THE REPOSITORY IS PUBLIC: every person, place, record and account here is made up.
 * Run from the repo root:
 * node --require <tsx cjs register> --test packages/api/src/family/history.v2.test.ts */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { FamilyBundle, FamilyHistoryAccount, FamilyHistoryUserFields, FamilyView } from './history';
import { FAMILY_SIGN_LIMIT, familyHistoryRouter } from './history';
import { familySpokenProblems } from './words';

process.env.KADE_APP_REVIEW_USER_IDS = 'aaaaaaaaaaaaaaaaaaaaaa05';
process.env.KADE_LIBRARY_HIDDEN_FROM = 'review-seat@example.com';
delete process.env.NOTIFY_TEST_USER_IDS;
delete process.env.KADE_FAMILY_HISTORY_PREFIX;
delete process.env.KADE_FH_OWNER_USER_ID;
delete process.env.KADE_FH_DNA_FINDINGS;

const FIXTURES = join(__dirname, '__fixtures__', 'history');
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BUNDLE: FamilyBundle = JSON.parse(fixtureText('bundle.json'));
const OWNER_VIEW: FamilyView = JSON.parse(fixtureText('views/I100.json'));
const BEN_VIEW: FamilyView = JSON.parse(fixtureText('views/I200.json'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const STORY =
  '# The farm on Example Road\n\nWe lived on an invented farm [records/ancestry/c1/r1.json]. Mr. Example kept bees.\n\n' +
  '## Later\n\nThen the family moved to an invented town. It rained.\n';
const CLIPPING = 'An invented clipping: the farm won a prize for its bees.';

const ACCOUNTS: Record<string, FamilyHistoryAccount> = {
  owner: { id: 'aaaaaaaaaaaaaaaaaaaaaa01', name: 'Owner Account', username: 'owner', role: 'ADMIN' },
  ben: { id: 'aaaaaaaaaaaaaaaaaaaaaa02', name: 'Ben Account', kadeFamilyTreePerson: '@I200@' },
  cora: { id: 'aaaaaaaaaaaaaaaaaaaaaa03', name: 'Cora Account', kadeFamilyTreePerson: '@I201@' },
  guest: { id: 'aaaaaaaaaaaaaaaaaaaaaa04', name: 'Guest Friend', kadeFamilyHistory: 'guest' },
  review: { id: 'aaaaaaaaaaaaaaaaaaaaaa05', name: 'Review Seat', role: 'ADMIN', kadeFamilyTreePerson: '@I200@' },
  test: { id: 'aaaaaaaaaaaaaaaaaaaaaa06', name: 'Seat', username: 'Test Guest' },
  stranger: { id: 'aaaaaaaaaaaaaaaaaaaaaa07', name: 'Bob Stranger', username: 'bob' },
  jack: { id: 'aaaaaaaaaaaaaaaaaaaaaa21', name: 'Jack Account', kadeFamilyTreePerson: '@I101@' },
  kit: { id: 'aaaaaaaaaaaaaaaaaaaaaa22', name: 'Kit Account', kadeFamilyTreePerson: '@I102@' },
  max: { id: 'aaaaaaaaaaaaaaaaaaaaaa23', name: 'Max Account', kadeFamilyTreePerson: '@I120@' },
  lee: { id: 'aaaaaaaaaaaaaaaaaaaaaa24', name: 'Lee Account', kadeFamilyTreePerson: '@I110@' },
  opal: { id: 'aaaaaaaaaaaaaaaaaaaaaa25', name: 'Opal Account', kadeFamilyTreePerson: '@I211@' },
  helper: { id: 'aaaaaaaaaaaaaaaaaaaaaa26', name: 'Helper Admin', role: 'ADMIN' },
  asker: { id: 'aaaaaaaaaaaaaaaaaaaaaa27', name: 'Asking Friend', kadeFamilyHistoryAskedAt: '2026-03-01T00:00:00Z' },
};
/** Everyone the tree lets in. */
const INSIDE = ['owner', 'ben', 'cora', 'guest', 'jack', 'kit', 'max', 'lee', 'opal'];

type Harness = {
  base: string;
  close: () => Promise<void>;
  signed: string[];
  users: Map<string, FamilyHistoryAccount>;
};

function bucket(bundle: FamilyBundle = BUNDLE): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ['family-history/current.json', Buffer.from(JSON.stringify({ version: 'v1' }))],
    ['family-history/v1/bundle.json.gz', gzipSync(Buffer.from(JSON.stringify(bundle)))],
    ['family-history/v1/views/I100.json.gz', Buffer.from(JSON.stringify(OWNER_VIEW))],
    ['family-history/v1/views/I200.json.gz', Buffer.from(JSON.stringify(BEN_VIEW))],
    ['family-history/v1/stories/the-farm.md', Buffer.from(STORY)],
    ['family-history/media/m-story1.text.eeee0001.txt', Buffer.from(CLIPPING)],
  ]);
}

async function harness(objects: Map<string, Buffer> = bucket()): Promise<Harness> {
  const users = new Map(Object.entries(clone(ACCOUNTS)));
  const signed: string[] = [];
  const auth: RequestHandler = (req, res, next) => {
    const user = users.get(req.get('x-user') || '');
    if (!user) {
      res.status(401).json({ error: 'Sign in first.' });
      return;
    }
    (req as { user?: FamilyHistoryAccount }).user = user;
    next();
  };
  const router = familyHistoryRouter({
    auth,
    loadObject: async (key) => objects.get(key) || null,
    signGet: async (key) => {
      signed.push(key);
      return `https://bucket.example/${key}?signature=test`;
    },
    findUsers: async () => [...users.values()],
    setUserFields: async (_id: string, _fields: FamilyHistoryUserFields) => null,
    /* 5 March 2026: three days after an invented birthday on 3 March */
    now: () => Date.parse('2026-03-05T12:00:00Z'),
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
    signed,
    users,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(h: Harness, path: string, who: string, body?: object): Promise<{ status: number; cache: string | null; body: Json }> {
  const headers: Record<string, string> = { 'x-user': who };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${h.base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    redirect: 'manual',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    cache: res.headers.get('cache-control'),
    body: (res.headers.get('content-type') || '').includes('application/json') && text ? JSON.parse(text) : text,
  };
}

const pid = (id: string): string => encodeURIComponent(id);
const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

/** Every person card id anywhere in an answer. */
function cardIds(value: Json, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) cardIds(item, out);
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && 'initials' in value && 'spoken' in value) out.add(value.id);
    for (const key of Object.keys(value)) cardIds(value[key], out);
  }
  return out;
}

/** Every spoken string in an answer, with where it was found. */
function spokenStrings(value: Json, path = '', out: [string, string][] = []): [string, string][] {
  if (Array.isArray(value)) value.forEach((item, i) => spokenStrings(item, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const here = `${path}.${key}`;
      if (/^spoken|Spoken$/.test(key) && typeof value[key] === 'string') out.push([here, value[key]]);
      else spokenStrings(value[key], here, out);
    }
  }
  return out;
}

let main: Harness;
before(async () => {
  main = await harness();
});
after(() => main.close());

const V2_PATHS = [
  '/home',
  '/home?since=v0',
  '/tree?v=2',
  '/tree?v=2&focus=%40I300%40&up=8&down=4',
  `/person/${pid('@I300@')}?v=2`,
  `/person/${pid('@I101@')}?v=2`,
  `/person/${pid('@I700@')}?v=2`,
  '/gallery',
  '/gallery?kind=all&sort=year',
  '/media/m-tree1/info',
  '/media/m-story1/info',
  '/dna',
  '/timeline',
  '/timeline?scope=all',
  '/places',
  '/play?seed=11',
  '/search?v=2&q=example',
  '/people?v=2&group=ancestor',
  '/people?v=2&group=blood',
  '/stories?v=2',
  '/story/the-farm?v=2',
  '/findings?v=2',
  '/findings?group=mysteries',
];

/* ── contracts that hold on every route ───────────────────────────────── */

test('every v2 route answers every viewer let in, with no-store and no dash, dot, arrow or shouted word in anything spoken', async () => {
  let checked = 0;
  for (const who of INSIDE) {
    for (const path of V2_PATHS) {
      const r = await call(main, path, who);
      if (path.startsWith('/play') && who === 'guest') {
        assert.equal(r.status, 403, `${who} ${path}`);
        continue;
      }
      assert.equal(r.status, 200, `${who} ${path}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.cache, 'no-store');
      for (const [where, text] of spokenStrings(r.body)) {
        assert.deepEqual(familySpokenProblems(text), [], `${who} ${path} ${where}: ${text}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `${checked} spoken strings checked`);
});

test('refused accounts get the same 403, with its reason, on every v2 route', async () => {
  for (const [who, reason] of [['stranger', 'unmatched'], ['test', 'test'], ['review', 'review'], ['asker', 'unmatched']]) {
    for (const path of [...V2_PATHS, '/media/m-tree1?size=t']) {
      const r = await call(main, path, who);
      assert.equal(r.status, 403, `${who} ${path}`);
      assert.equal(r.body.reason, reason, `${who} ${path}`);
    }
    const sign = await call(main, '/media/sign', who, { ids: ['m-tree1'], size: 't' });
    assert.equal(sign.status, 403);
  }
  const asked = await call(main, '/me', 'asker');
  assert.deepEqual([asked.body.canAsk, asked.body.detail], [false, 'Asked on 1 March 2026']);
});

test('without ?v=2 the old routes answer exactly as v1 did, for the live web page', async () => {
  let r = await call(main, `/person/${pid('@I300@')}`, 'owner');
  assert.equal('nutshell' in r.body, false);
  assert.equal('pictures' in r.body, false);
  r = await call(main, '/tree', 'owner');
  assert.deepEqual(Object.keys(r.body).sort(), ['couples', 'down', 'focus', 'links', 'nodes', 'up']);
  r = await call(main, '/stories', 'owner');
  assert.ok(Array.isArray(r.body));
  r = await call(main, '/findings', 'owner');
  assert.ok(Array.isArray(r.body));
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['people', 'summary']);
  r = await call(main, '/search?q=sample', 'owner');
  assert.ok(Array.isArray(r.body));
  r = await call(main, '/story/the-farm', 'owner');
  assert.deepEqual(Object.keys(r.body).sort(), ['markdown', 'slug', 'title']);
  r = await call(main, '/media/m-tree1', 'owner');
  assert.deepEqual(r.body, { url: 'https://bucket.example/family-history/media/m-tree1.jpg?signature=test' });
});

/* ── Home ─────────────────────────────────────────────────────────────── */

test('GET /home: the hero, faces, reel, featured, news, four tiles and more, all in words', async () => {
  const r = await call(main, '/home?since=v0', 'owner');
  const home = r.body;
  assert.deepEqual(home.hero, {
    hello: 'Hi Owner.',
    headline: 'Your family goes back to 1870.',
    youAre: 'This is your tree.',
    stats: '17 people in the tree, 9 of them your direct ancestors.',
    follows: null,
    spoken: 'Hi Owner. Your family goes back to 1870. This is your tree. 17 people in the tree, 9 of them your direct ancestors.',
    open: { to: 'tree' },
  });
  assert.equal(home.faces.layout, 'portrait', 'fewer than four photographed ancestors: one large portrait');
  assert.equal(home.faces.portrait.image.id, 'm-tree1r', 'the restored copy is chosen for the hero');
  assert.equal(home.faces.portrait.image.showing, 'restored');
  assert.match(home.faces.portrait.image.alt, /Restored with AI\.$/);
  assert.equal(home.faces.portrait.caption, 'Your grandfather Dan, about 1950');
  assert.deepEqual(home.tiles.map((t: Json) => t.key), ['tree', 'photos', 'whereWhen', 'dna']);
  assert.deepEqual(home.tiles.map((t: Json) => t.detail), [
    'You and 4 generations up',
    '3 photos, plus records and graves',
    'Through the years, and on a map',
    'What it found, in plain words',
  ]);
  assert.deepEqual(home.more.map((t: Json) => t.key), ['stories', 'discoveries', 'mysteries', 'people', 'play', 'note']);
  assert.equal(home.more[0].detail, '1 story', 'a story whose file leaves its folder is still counted by v1, not here');
  assert.equal(home.comingSoon, null);
  assert.deepEqual(home.owner, { notes: 0, asks: 1 });
  assert.deepEqual(home.featured.map((f: Json) => f.kind), ['onThisDay', 'ancestorOfWeek', 'story']);
  assert.equal(home.featured[0].text, '3 March 1960: Your father, Ben Example, was born in Invented County. 66 years ago this week.');
  assert.equal(home.news.text, '2 new photos and 1 new person since your last visit');
  assert.deepEqual(home.news.open, { to: 'gallery', since: 'v0', filter: 'all' });
  assert.deepEqual(home.reel.cards.map((c: Json) => c.key), ['you', 'grandparents', 'oldest', 'ocean', 'mystery', 'end'], 'no places card: only one ancestor has a birthplace');
  assert.equal(home.reel.cards[0].text, 'It starts with you, Owner.');
  assert.equal(home.reel.cards[2].text, 'Your 2nd great-grandfather, Ivo Example, was born in 1870.');
  assert.equal(home.reel.cards[3].text, 'Your great-grandfather, Hugo Example, was born in Finland in 1900, across the ocean.');
  assert.equal(home.reel.cards[4].text, 'A mystery that was solved: Two brothers, one invented match.');
  assert.equal(home.reel.detail, '6 cards, about a minute');
  assert.equal((await call(main, '/home', 'owner')).body.news, null, 'no last visit, no news');
});

test('Home never features anyone on a research path or in a sensitive finding, nor anyone living in its history cards', async () => {
  for (const who of INSIDE) {
    const home = (await call(main, '/home?since=v0', who)).body;
    for (const part of [home.faces, home.featured, home.news, home.reel.cards.filter((c: Json) => c.key !== 'you' && c.key !== 'grandparents')]) {
      const found = cardIds(part);
      for (const unsettled of ['@I302@', '@I700@']) assert.equal(found.has(unsettled), false, `${who}: ${unsettled}`);
    }
    for (const card of home.reel.cards.filter((c: Json) => ['oldest', 'ocean', 'mystery'].includes(c.key)))
      for (const person of card.people) assert.equal(person.living, false, `${who} ${card.key}`);
    for (const item of home.featured) {
      const person = BUNDLE.people[item.open.id];
      if (person) assert.equal(person.living, false, `${who} ${item.kind}`);
    }
  }
});

test('a matched child sees the same Home and DNA screens as an adult sibling; a guest is greeted by name and sees the family in the owner\'s words', async () => {
  const child = (await call(main, '/home', 'max')).body;
  const adult = (await call(main, '/home', 'jack')).body;
  assert.deepEqual(Object.keys(child).sort(), Object.keys(adult).sort());
  assert.deepEqual(child.tiles.map((t: Json) => [t.key, t.enabled]), adult.tiles.map((t: Json) => [t.key, t.enabled]));
  assert.deepEqual(child.more.map((t: Json) => [t.key, t.enabled]), adult.more.map((t: Json) => [t.key, t.enabled]));
  assert.deepEqual(child.featured.map((f: Json) => f.kind), adult.featured.map((f: Json) => f.kind));
  assert.ok((await call(main, '/dna', 'max')).body.test.mysteries, 'the family mysteries too');
  const guest = (await call(main, '/home', 'guest')).body;
  assert.equal(guest.hero.hello, 'Hi Guest.');
  assert.equal(guest.hero.youAre, 'You’re visiting as Ada’s guest.');
  assert.equal(guest.hero.headline, 'Ada’s family goes back to 1870.');
  assert.deepEqual(guest.tiles[3], {
    key: 'dna',
    title: 'Your DNA',
    detail: 'For family members in the tree',
    spoken: 'Your DNA, For family members in the tree',
    hint: 'Where your DNA comes from, on paper, and what the family DNA test found.',
    enabled: false,
    reason: 'guest',
    open: null,
  });
  assert.equal(guest.more.find((t: Json) => t.key === 'play').enabled, false);
  assert.equal(guest.more.some((t: Json) => t.key === 'mysteries'), false, 'a guest never sees the family mysteries');
  const ben = (await call(main, '/home', 'ben')).body;
  assert.equal(ben.hero.youAre, 'You’re Ada’s father.');
  assert.equal(ben.hero.follows, 'This tree follows your father’s family.');
  const lee = (await call(main, '/home', 'lee')).body;
  assert.deepEqual([lee.tiles[3].title, lee.tiles[3].enabled, lee.tiles[3].open], ['Your children’s inheritance', true, { to: 'dna', id: '@I120@' }]);
  const opal = (await call(main, '/home', 'opal')).body;
  assert.deepEqual([opal.tiles[3].detail, opal.tiles[3].enabled], ['Your own family isn’t in this tree yet', false]);
});

/* ── the tree ─────────────────────────────────────────────────────────── */

test('GET /tree?v=2: boxes in box units with cards and spoken sentences, the list version, legend and order', async () => {
  const r = await call(main, '/tree?v=2&up=4&down=2', 'owner');
  const { layout, summary, list, legend } = r.body;
  assert.equal(summary.text, 'Centred on you. 14 people shown.');
  assert.equal(layout.order[0], layout.boxes.find((b: Json) => b.role === 'focus').key, 'the focus first');
  assert.equal(layout.boxes.length, layout.order.length);
  const dan = layout.boxes.find((b: Json) => b.id === '@I300@');
  assert.deepEqual([dan.person.term, dan.moreAbove, dan.you], ['your grandfather', null, false]);
  const ivo = layout.boxes.find((b: Json) => b.id === '@I500@');
  assert.equal(ivo.moreAbove, null, 'nothing is known above the oldest');
  const me = layout.boxes.find((b: Json) => b.id === '@I100@');
  assert.equal(me.you, true);
  assert.equal(dan.person.face.id, 'm-tree1r', 'tree boxes use the restored portrait');
  assert.match(dan.person.face.face, /m-tree1r\.f\.bbbb0003\.jpg/);
  const finn = layout.boxes.find((b: Json) => b.id === '@I302@');
  assert.equal(finn.moreAbove, null);
  const unknown = layout.boxes.find((b: Json) => b.id === '@I700@');
  assert.deepEqual(unknown.person.research, { level: 'dna', text: 'Strong DNA evidence' });
  assert.match(unknown.spoken, /Research finding, strong DNA evidence, not proven by records\.$/);
  assert.deepEqual(list.map((s: Json) => s.heading), ['Parents', 'Grandparents', 'Great-grandparents', '2nd great-grandparents', 'Brothers and sisters', 'Spouses', 'Children']);
  assert.ok(legend.some((l: Json) => l.key === 'step'));
  const shallow = await call(main, '/tree?v=2&up=1&down=0', 'owner');
  const father = shallow.body.layout.boxes.find((b: Json) => b.id === '@I200@');
  assert.equal(father.moreAbove, 3, 'a top-row box says how many generations wait above');
  assert.match(father.spoken, /3 more generations above\.$/);
});

/* ── a person ─────────────────────────────────────────────────────────── */

test('GET /person/:id?v=2: nutshell, lived-through, relation, restored pictures first, records, grave, sources and withheld', async () => {
  const r = await call(main, `/person/${pid('@I300@')}?v=2`, 'owner');
  const p = r.body;
  assert.equal(p.person.spoken, 'Your grandfather, Dan Example, 1930 to 1999, Dad’s side.');
  assert.equal(p.nutshell.text, 'Born in 1930 in Invented County. Raised 2 children. Died in 1999 in Invented County, at 69.');
  assert.equal(p.livedThrough, 'Born 1930; lived through the Great Depression, the Dust Bowl and World War II.');
  assert.deepEqual(p.relation.ladder, ['You', 'Dad', 'Grandpa']);
  assert.equal(p.relation.chain, 'your dad’s dad');
  assert.equal(p.relation.dnaLine, 'On average about 1 in 4 of your DNA comes from him. From the records, not a DNA test.');
  assert.equal(p.headerKind, 'portrait');
  assert.deepEqual(p.pictures.items.map((i: Json) => [i.id, i.showing]), [['m-tree1r', 'restored'], ['m-grave1', 'original']], 'the held picture is not in the family pictures');
  assert.equal(p.pictures.items[0].original, 'm-tree1', 'the switch back to the original');
  assert.equal(p.pictures.items[0].restoredLabel, 'Restored with AI: colours and repairs may be guessed');
  assert.equal(p.pictures.items[0].shareName, 'Photo of Dan Example, about 1950 (restored with AI).jpg');
  assert.equal(p.records[0].spoken, 'Invented Census 1940, scan available, 2 fields.');
  assert.equal(p.records[0].scan.alt, 'Record scan: Invented Census 1940 for your grandfather, Dan Example.');
  assert.equal(p.records[1].spoken, 'Invented Census 1940, 2 fields. Attached to this person by mistake: This census lists a different Dan Example, twenty years older.');
  assert.equal(p.grave.cemetery, 'Invented Cemetery');
  assert.deepEqual(p.withheld, { count: 1, text: '1 source withheld: it names living relatives' });
  assert.deepEqual(p.share, { allowed: true, text: 'From our family history' });
  assert.equal(p.person.name, 'Dan Example', 'the v1 fields are still there');
  assert.ok(Array.isArray(p.memorials));

  const jack = (await call(main, `/person/${pid('@I101@')}?v=2`, 'jack')).body;
  assert.equal(jack.person.living, true);
  assert.deepEqual(jack.records.map((rec: Json) => rec.key), ['c2:r1', 'c1:r1', 'c1:r2'], 'a living relative\'s records are shown');
  assert.deepEqual(
    jack.records[0].fields,
    [['Name', 'Ben Example'], ['Birth', '1960'], ['Street address', '1 Invented Lane']],
    'records as the export sends them: the family sees the research as the owner does',
  );
  assert.equal(JSON.stringify((await call(main, `/person/${pid('@I101@')}`, 'cora')).body).includes('Invented Lane'), true, 'v1 too');

  const unknown = (await call(main, `/person/${pid('@I700@')}?v=2`, 'owner')).body;
  assert.equal(unknown.findings[0].proofText, 'Strong DNA evidence (about 90 to 95% sure)');
  const guest = (await call(main, `/person/${pid('@I700@')}?v=2`, 'guest')).body;
  assert.deepEqual(guest.findings, [], 'a guest never sees a family mystery');
  assert.deepEqual((await call(main, `/person/${pid('@I700@')}`, 'guest')).body.findings, [], 'nor on v1');
});

/* ── pictures ─────────────────────────────────────────────────────────── */

test('GET /gallery: photos first, pages of 48, signed thumbnails from the export\'s own files, held pictures only for who may see them', async () => {
  main.signed.length = 0;
  let r = await call(main, '/gallery', 'owner');
  assert.equal(r.body.kind, 'photos');
  assert.deepEqual(r.body.items.map((i: Json) => i.id), ['m-tree1', 'm-living', 'm-held'], 'nearest relatives first, then oldest');
  assert.equal(r.body.items[0].thumb, 'https://bucket.example/family-history/media/m-tree1.t.aaaa0001.jpg?signature=test');
  assert.equal(r.body.items[0].restored, 'm-tree1r', 'the gallery shows the original and offers the restored copy');
  assert.equal(r.body.items[0].index, 1);
  assert.equal(r.body.pageSpoken, 'Showing 1 to 3 of 3');
  assert.deepEqual(r.body.kinds.map((k: Json) => [k.key, k.count]), [['photos', 3], ['portraits', 0], ['records', 1], ['graves', 1], ['documents', 1], ['stories', 1], ['all', 7]]);
  assert.ok(main.signed.every((key) => !key.endsWith('m-tree1.jpg')), 'never a photo\'s original');
  for (const [who, sees] of [['ben', true], ['guest', false], ['cora', false]] as const) {
    r = await call(main, '/gallery?kind=all', who);
    assert.equal(r.body.items.some((i: Json) => i.id === 'm-held'), sees, who);
    assert.equal(r.body.items.some((i: Json) => i.id === 'm-bad'), false, 'a file outside the media folder is never listed');
  }
  r = await call(main, `/gallery?kind=all&person=${pid('@I300@')}&sort=year`, 'owner');
  assert.deepEqual(r.body.items.map((i: Json) => i.id), ['m-tree1', 'm-grave1', 'm-held', 'm-rec1'], 'dated first, oldest first');
  r = await call(main, '/gallery?kind=all&since=v0', 'owner');
  assert.deepEqual(r.body.items.map((i: Json) => i.id).sort(), ['m-living', 'm-tree1']);
  r = await call(main, '/gallery?kind=all&from=5', 'owner');
  assert.deepEqual([r.body.from, r.body.count, r.body.prev, r.body.next], [5, 2, 0, null]);
  assert.equal((await call(main, '/gallery?kind=selfies', 'owner')).status, 400);
  assert.equal((await call(main, `/gallery?person=${pid('@I999@')}`, 'owner')).status, 400);
});

test('captions reach the family as the research recorded them; only "(restored with AI)" and bare file names are left off', async () => {
  const calls = clone(BUNDLE);
  calls.media['m-grave1'].caption = 'Headstone. Invented carver, call (555) 010-1234';
  calls.media['m-living'].caption = 'IMG_0001.jpg';
  const h = await harness(bucket(calls));
  try {
    const info = await call(h, '/media/m-grave1/info', 'cora');
    assert.equal(info.body.caption, 'Headstone. Invented carver, call (555) 010-1234');
    const living = await call(h, '/media/m-living/info', 'cora');
    assert.equal(living.body.caption, 'Photo: Ada’s brother, Jack Example', 'a bare file name gives way to the label');
    const restored = await call(h, '/media/m-tree1r/info', 'owner');
    assert.equal(restored.body.caption, 'Dan Example on an invented porch');
  } finally {
    await h.close();
  }
});

test('media sizes come only from the export\'s files; a photo\'s original is never signed; /media/sign and /media/:id/info', async () => {
  let r = await call(main, '/media/m-tree1?size=f', 'ben');
  assert.deepEqual(r.body, {
    url: 'https://bucket.example/family-history/media/m-tree1.f.aaaa0003.jpg?signature=test',
    w: 256,
    h: 256,
    expires: '2026-03-05T13:00:00.000Z',
  });
  assert.equal((await call(main, '/media/m-tree1?size=o', 'owner')).status, 404, 'a phone original can carry GPS');
  assert.equal((await call(main, '/media/m-tree1?size=x', 'owner')).status, 404);
  r = await call(main, '/media/m-rec1?size=o', 'owner');
  assert.equal(r.body.url, 'https://bucket.example/family-history/media/m-rec1.jpg?signature=test', 'a record scan\'s original is allowed');
  assert.equal((await call(main, '/media/m-doc1?size=o', 'owner')).status, 200, 'an older bundle\'s document is its own original');
  assert.equal((await call(main, '/media/m-held?size=t', 'guest')).status, 404);
  assert.equal((await call(main, '/media/m-tree1r?size=s', 'guest')).status, 200, 'a restored copy has its own sizes');

  r = await call(main, '/media/sign', 'guest', { ids: ['m-tree1', 'm-held', 'm-none', 'm-rec1', 42, 'm-tree1r'], size: 't' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.urls).sort(), ['m-rec1', 'm-tree1', 'm-tree1r'], 'unknown and held ids are left out');
  assert.equal(r.body.expires, '2026-03-05T13:00:00.000Z');
  const many = Array.from({ length: FAMILY_SIGN_LIMIT + 1 }, (_, i) => `m-${i}`);
  assert.equal((await call(main, '/media/sign', 'owner', { ids: many, size: 't' })).status, 400);
  assert.equal((await call(main, '/media/sign', 'owner', { ids: ['m-tree1'], size: 'huge' })).status, 400);

  r = await call(main, '/media/m-story1/info', 'owner');
  assert.equal(r.body.text, CLIPPING, 'a clipping\'s words come from the export\'s text file');
  assert.equal(r.body.canAskRestore, false, 'documents are never restored');
  r = await call(main, '/media/m-tree1/info', 'owner');
  assert.deepEqual([r.body.described, r.body.describedNote, r.body.canAskRestore], ['auto', 'Described automatically', false]);
  assert.equal(r.body.description, 'An invented description: a man sits on a wooden porch step in bright sun.');
  r = await call(main, '/media/m-tree1r/info', 'owner');
  assert.deepEqual([r.body.image.showing, r.body.restoredNotes], ['restored', 'Invented repairs: a crease removed.']);
  r = await call(main, '/media/m-grave1/info', 'owner');
  assert.equal(r.body.canAskRestore, true);
  assert.equal((await call(main, '/media/m-held/info', 'guest')).status, 404);
});

/* ── DNA ──────────────────────────────────────────────────────────────── */

test('GET /dna: the test counts in full for the owner and her full brother, only the shared families for others, never for guests or people married in', async () => {
  const dna = async (who: string, query = ''): Promise<Json> => (await call(main, `/dna${query}`, who)).body;
  let d = await dna('owner');
  assert.deepEqual([d.test.applies, d.test.cards.map((c: Json) => c.key), d.test.mysteries.cards.map((c: Json) => c.key)], ['self', ['c1', 'c2'], ['k1']]);
  assert.equal(d.test.cards[0].title, 'The family of your grandparents Finn Sample and Gail Sample');
  assert.equal(d.test.cards[0].text, '12 of your DNA cousins descend from this family.');
  assert.equal(d.test.mysteries.cards[0].proofText, 'Strong DNA evidence (about 90 to 95% sure)');
  assert.ok(d.test.details.rows.includes('The family of your grandparents Finn Sample and Gail Sample: about 90 to 400 cM.'));
  assert.deepEqual(d.test.cards[0].matches, [
    { name: 'Invented Match One', cM: 120, segments: 6 },
    { name: 'Invented Match Two', cM: 95, segments: 4 },
  ], 'the family sees the matches as the owner does');
  assert.deepEqual(d.test.details.clusters.map((c: Json) => [c.key, c.members, c.matches.length]), [['c1', 12, 2], ['c2', 5, 0]]);
  d = await dna('jack');
  assert.deepEqual([d.title, d.test.applies, d.test.cards.length], ['Ada’s DNA test counts for you too', 'fullSibling', 2]);
  assert.match(d.test.intro, /^You and Ada have the same mother and father/);
  assert.equal(d.test.footnote, 'Full siblings share about half their DNA, but not the same half. A test would show your own pieces. It would not change who your ancestors are.');
  d = await dna('kit');
  assert.deepEqual([d.test.applies, d.test.cards.map((c: Json) => c.key), d.test.mysteries], ['sharedLine', ['c2'], null], 'a half brother on the untested side: only the family he descends from');
  d = await dna('max');
  assert.deepEqual([d.test.applies, d.test.cards.length, !!d.test.mysteries], ['sharedLine', 2, true]);
  for (const who of ['lee', 'opal', 'guest']) assert.equal((await dna(who)).test, null, who);
  assert.equal((await dna('lee')).title, 'Your children’s inheritance');

  d = await dna('max');
  assert.deepEqual(d.paper.generations.slice(0, 3).map((g: Json) => g.text), [
    'Your mother has a name.',
    'All 2 of your grandparents on the mother’s side have a name.',
    'All 4 of your great-grandparents on the mother’s side have a name.',
  ], 'a half tree: only the side the tree follows');
  assert.equal(d.paper.half, true);
  assert.equal(d.follows, 'This tree follows Ada’s mother’s family.');
  d = await dna('owner');
  assert.deepEqual(d.paper.generations[1].wedges.map((w: Json) => [w.ahnen, w.state, w.side, w.person?.id || null, w.share]), [
    [4, 'known', 'father', '@I300@', '1 in 4'],
    [5, 'known', 'father', '@I301@', '1 in 4'],
    [6, 'known', 'mother', '@I302@', '1 in 4'],
    [7, 'known', 'mother', '@I303@', '1 in 4'],
  ]);
  assert.deepEqual(d.paper.generations[2].wedges.map((w: Json) => [w.ahnen, w.state, w.person?.id || null]), [
    [8, 'known', '@I400@'],
    [9, 'unknown', null],
    [10, 'unknown', null],
    [11, 'unknown', null],
    [12, 'research', '@I700@'],
    [13, 'unknown', null],
    [14, 'unknown', null],
    [15, 'unknown', null],
  ], 'a research slot is marked, an unknown one is empty');
  assert.equal(d.paper.generations[2].text, '2 of your 8 great-grandparents have a name.');
  assert.equal(d.paper.generations[1].spoken, 'Generation 2, grandparents: 4 of 4 known');
  assert.equal(d.abroad.text, '1 of your ancestors was born outside the United States.');
  assert.equal(d.abroad.rows[0].text, 'Born in Finland in 1900.');
  assert.equal(d.birthplaces.note, 'From birthplaces in records. This is not a DNA ethnicity estimate.');
  assert.deepEqual(d.compare.averages[0], { key: 'parent', class: 'a parent or child', percent: 'about 50%', text: 'With a parent or child: about 50% on average.', details: null });
});

test('GET /dna?for=: only the viewer, a spouse or a child, and it never unlocks the test', async () => {
  let r = await call(main, `/dna?for=${pid('@I120@')}`, 'lee');
  assert.equal(r.status, 200);
  assert.equal(r.body.test, null, 'for changes only the paper, never the test');
  assert.equal(r.body.forName, 'Max Example');
  assert.equal(r.body.paper.generations[0].text, 'Max’s mother has a name.');
  r = await call(main, `/dna?for=${pid('@I100@')}`, 'lee');
  assert.equal(r.status, 200, 'his wife');
  for (const [who, other] of [['lee', '@I300@'], ['kit', '@I100@'], ['jack', '@I999@'], ['guest', '@I200@']]) {
    r = await call(main, `/dna?for=${pid(other)}`, who);
    assert.equal(r.status, 400, `${who} for ${other}`);
  }
});

test('KADE_FH_DNA_FINDINGS: family (the default), owner, or off, read on every request', async () => {
  const mysteriesOf = async (who: string): Promise<Json> => (await call(main, '/dna', who)).body.test.mysteries;
  try {
    process.env.KADE_FH_DNA_FINDINGS = 'owner';
    assert.ok(await mysteriesOf('owner'));
    assert.equal(await mysteriesOf('jack'), null);
    assert.equal((await call(main, '/findings?group=mysteries', 'jack')).body.available, false);
    assert.deepEqual((await call(main, '/findings', 'jack')).body.map((f: Json) => f.summary), ['Ben and Ned Example share an invented DNA match.'], 'v1 too');
    assert.equal((await call(main, '/home', 'jack')).body.more.some((t: Json) => t.key === 'mysteries'), false);
    process.env.KADE_FH_DNA_FINDINGS = 'off';
    assert.equal(await mysteriesOf('owner'), null);
    assert.deepEqual((await call(main, '/findings?group=mysteries', 'owner')).body.findings, []);
    process.env.KADE_FH_DNA_FINDINGS = 'something else';
    assert.ok(await mysteriesOf('jack'), 'anything else is the default');
  } finally {
    delete process.env.KADE_FH_DNA_FINDINGS;
  }
  assert.ok(await mysteriesOf('jack'));
});

/* ── where and when ───────────────────────────────────────────────────── */

test('GET /timeline: decades newest first, how many were alive, national history, lanes and events', async () => {
  const r = await call(main, '/timeline', 'owner');
  const t = r.body;
  assert.equal(t.top, 'You, today');
  assert.equal(t.mapReady, true);
  const titles = t.decades.map((d: Json) => d.title);
  assert.equal(titles[0], '2020s');
  assert.deepEqual([...titles].sort().reverse(), titles, 'newest first');
  const forties = t.decades.find((d: Json) => d.decade === 1940);
  assert.equal(forties.summary, '6 of your ancestors were alive.');
  assert.deepEqual(forties.context.map((c: Json) => c.text), ['1 of your ancestors was an adult during World War II.']);
  const decadeOf = (decade: number): Json => t.decades.find((d: Json) => d.decade === decade);
  assert.deepEqual(decadeOf(1920).context.map((c: Json) => c.text), ['2 of your ancestors were adults during the Great Depression.'], 'a moment sits in the decade it began');
  assert.deepEqual(decadeOf(1930).context.map((c: Json) => c.text), ['2 of your ancestors were adults during the Dust Bowl years.']);
  assert.deepEqual(forties.events.map((e: Json) => e.text), ['1940: Your great-grandfather, Hugo Example, was counted in the census in Invented County.']);
  const twenties = t.decades.find((d: Json) => d.decade === 1920);
  assert.ok(twenties.events.some((e: Json) => e.text === '1925: Your great-grandfather, Hugo Example, arrived as an immigrant in Invented County.'));
  for (const decade of t.decades)
    for (const a of decade.bars)
      for (const b of decade.bars)
        if (a.id < b.id && a.lane === b.lane) assert.ok(a.to < b.from || b.to < a.from, `${a.id} and ${b.id} overlap in lane ${a.lane}`);
  assert.ok(t.people['@I300@'].term);
  const all = (await call(main, '/timeline?scope=all', 'owner')).body;
  assert.equal(all.title, 'All relatives');
  assert.ok(all.decades.some((d: Json) => d.bars.some((b: Json) => b.id === '@I110@' && b.from === 1989 && b.to === 2026)), 'living relatives have lifelines to today');
  assert.ok(t.decades.some((d: Json) => d.bars.some((b: Json) => b.id === '@I201@' && b.to === 2026)), 'a living parent too');
  assert.match(all.decades.find((d: Json) => d.decade === 1940).summary, /relatives were alive\.$/);
});

test('GET /places: the export\'s map by decade, with the text list, journeys and ocean crossings; 404 until there is a map', async () => {
  let r = await call(main, '/places', 'owner');
  const p = r.body;
  assert.equal(p.start, 1900, 'the richest decade (the earliest of equals)');
  const twenties = p.decades.find((d: Json) => d.decade === 1920);
  assert.deepEqual([twenties.summary, twenties.counts, twenties.labels], ['1 ancestor in 1 place', { p1: 1 }, ['p1']]);
  assert.deepEqual(twenties.moves, [{ personId: '@I400@', from: 'p3', to: 'p1', year: 1925 }]);
  assert.deepEqual(twenties.list, [{ heading: 'Invented State', rows: [{ placeId: 'p1', text: 'Invented County, IS: 1 ancestor', people: ['@I400@'] }] }]);
  assert.deepEqual(p.ocean.map((o: Json) => o.text), ['Your great-grandfather, Hugo Example, came from Finland about 1925.']);
  assert.ok(p.journeys.some((j: Json) => j.text === 'Your great-grandfather, Hugo Example: born in somewhere in Finland in 1900, in Invented County, IS by 1925.'));
  assert.equal(p.unplaced, '6 ancestors have no place in the records yet.');
  const noMap = clone(BUNDLE);
  delete noMap.places;
  const h = await harness(bucket(noMap));
  try {
    r = await call(h, '/places', 'owner');
    assert.deepEqual([r.status, r.body], [404, { error: 'The map is coming soon.', missing: 'places' }]);
    assert.equal((await call(h, '/home', 'owner')).body.comingSoon, 'The map is coming soon.');
    assert.equal((await call(h, '/timeline', 'owner')).body.mapReady, false);
  } finally {
    await h.close();
  }
});

/* ── the game ─────────────────────────────────────────────────────────── */

test('GET /play: mixed rounds with their answers and explanations, never about research people, replayable from a seed; not for guests', async () => {
  const r = await call(main, '/play?seed=11&count=5', 'owner');
  assert.equal(r.status, 200);
  const { rounds, seed, score } = r.body;
  assert.equal(seed, 11);
  assert.equal(rounds.length, 5);
  assert.equal(score, '0 of 5');
  assert.ok(new Set(rounds.map((round: Json) => round.kind)).size >= 3, 'mixed kinds');
  for (const round of rounds) {
    assert.ok(round.answer >= 0 && round.answer < round.choices.length, round.kind);
    assert.equal(new Set(round.choices.map((c: Json) => c.text)).size, round.choices.length, 'no choice twice');
    assert.ok(round.wrong.startsWith('Not quite. '));
    for (const unsettled of ['@I302@', '@I700@']) assert.equal(cardIds(round).has(unsettled), false, `${round.kind} ${unsettled}`);
    if (round.kind === 'year') assert.doesNotMatch(round.image.alt, /\d{4}/, 'the picture\'s label never gives the year away');
  }
  const again = await call(main, '/play?seed=11&count=5', 'owner');
  assert.deepEqual(again.body.rounds.map((round: Json) => round.prompt), rounds.map((round: Json) => round.prompt), 'the same seed, the same game');
  assert.equal((await call(main, '/play?seed=11&count=99', 'owner')).body.rounds.length <= 10, true);
  const guest = await call(main, '/play', 'guest');
  assert.deepEqual([guest.status, guest.body], [403, { error: 'The game is for family members in the tree.', reason: 'guest' }]);
});

/* ── lists, stories and findings ──────────────────────────────────────── */

test('GET /search?v=2 and /people?v=2: person cards, counts in words, pages of 60 with generation headings', async () => {
  let r = await call(main, '/search?v=2&q=sample', 'owner');
  assert.deepEqual([r.body.total, r.body.text], [4, '4 people found']);
  assert.deepEqual(ids(r.body.results), ['@I201@', '@I302@', '@I303@', '@I700@']);
  r = await call(main, '/search?v=2&q=zzzz', 'owner');
  assert.deepEqual([r.body.total, r.body.text, r.body.results], [0, 'No one found', []]);
  r = await call(main, '/people?v=2&group=ancestor', 'owner');
  assert.deepEqual(r.body.rows.map((row: Json) => row.heading), ['Parents', null, 'Grandparents', null, null, null, 'Great-grandparents', null, '2nd great-grandparents']);
  assert.equal(r.body.pageSpoken, 'Showing 1 to 9 of 9');
  r = await call(main, '/people?v=2&group=blood', 'owner');
  assert.deepEqual(ids(r.body.rows), ['@I120@', '@I101@', '@I102@', '@I210@'], 'blood relatives, children included, nearest first');
  r = await call(main, '/people?v=2&group=all&from=10', 'owner');
  assert.deepEqual([r.body.from, r.body.count, r.body.prev, r.body.next], [10, 7, 0, null]);
  assert.equal((await call(main, '/people?v=2&group=cousins', 'owner')).status, 400);
});

test('GET /stories?v=2 and /story/:slug?v=2: blocks, sources, parts with sentence cues, the research banner and Who\'s who', async () => {
  let r = await call(main, '/stories?v=2', 'owner');
  assert.deepEqual(r.body.stories, [{ slug: 'the-farm', title: 'The farm on Example Road', words: 14, detail: 'About 1 minute', research: true }], 'a story whose file leaves its folder is not listed');
  assert.deepEqual(r.body.clippings.map((c: Json) => c.id), ['m-story1']);
  r = await call(main, '/story/the-farm?v=2', 'owner');
  const s = r.body;
  assert.equal(s.markdown.startsWith('# The farm'), true, 'the v1 markdown is still there');
  assert.deepEqual(s.research, { banner: 'This story rests on research findings. They are not proven by records.' });
  assert.deepEqual(s.short, ['An invented farm.', 'An invented road.', 'An invented family.']);
  assert.deepEqual(ids(s.whoswho), ['@I300@', '@I400@']);
  assert.deepEqual(s.whoswho.map((p: Json) => p.term), ['your grandfather', 'your great-grandfather']);
  assert.deepEqual(s.blocks.map((b: Json) => b.type), ['p', 'h2', 'p']);
  assert.deepEqual(s.sources, [{ n: 1, title: 'Invented Census 1940', url: 'https://example.com/records/c1-r1' }]);
  assert.deepEqual(s.chunks.map((c: Json) => c.cues.map((q: Json) => q.text)), [
    ['We lived on an invented farm.', 'Mr. Example kept bees.', 'Later.', 'Then the family moved to an invented town.', 'It rained.'],
  ]);
  assert.equal(s.listen, false, 'no voice was wired into this router');
  const whos = (await call(main, '/story/the-farm?v=2', 'ben')).body.whoswho.map((p: Json) => p.term);
  assert.deepEqual(whos, ['your father', 'your grandfather'], 'Who\'s who is said from each reader\'s place');
});

test('sensitive stories follow the family-mysteries switch and never reach a guest', async () => {
  const sensitive = clone(BUNDLE);
  sensitive.stories[0].sensitive = true;
  const h = await harness(bucket(sensitive));
  try {
    assert.equal((await call(h, '/story/the-farm?v=2', 'jack')).status, 200);
    assert.equal((await call(h, '/story/the-farm', 'guest')).status, 404);
    assert.deepEqual((await call(h, '/stories', 'guest')).body.map((s: Json) => s.slug), ['escape']);
    process.env.KADE_FH_DNA_FINDINGS = 'off';
    assert.equal((await call(h, '/story/the-farm?v=2', 'owner')).status, 404);
    assert.deepEqual((await call(h, '/stories?v=2', 'owner')).body.stories, []);
    assert.equal((await call(h, '/home', 'owner')).body.featured.some((f: Json) => f.kind === 'story'), false);
  } finally {
    delete process.env.KADE_FH_DNA_FINDINGS;
    await h.close();
  }
});

test('GET /findings?v=2: discoveries for everyone let in, family mysteries behind a heads-up, each with its proof words', async () => {
  let r = await call(main, '/findings?v=2', 'cora');
  assert.deepEqual(r.body.discoveries.map((f: Json) => f.key), ['f2']);
  assert.equal(r.body.discoveries[0].spoken, 'Two brothers, one invented match. Ben and Ned Example share an invented DNA match. Proven by records.');
  assert.deepEqual(r.body.mysteries, {
    title: 'Family mysteries',
    headsUp: 'This part is about who some of your ancestors really were. It may be news to some of the family.',
    count: 1,
  });
  r = await call(main, '/findings?group=mysteries', 'cora');
  assert.deepEqual([r.body.available, r.body.findings.map((f: Json) => f.key)], [true, ['f1']]);
  r = await call(main, '/findings?v=2', 'guest');
  assert.equal(r.body.mysteries, null);
});
