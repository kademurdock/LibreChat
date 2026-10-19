/* The Arcade router (Oct 18 2026): catalog, manifests, one-hour signed pack links and
 * diagnostics, with the family shelf behind the Family feature pack. Storage and signing are
 * fakes; the pack rule is the real one (family/pack.ts).
 * Run from the repo root:
 * node --import <tsx esm loader> --test packages/api/src/arcade/router.test.ts */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { LibraryAccount } from '../library/access';
import { FAMILY_PACK_ARCADE_REFUSAL, FAMILY_PACK_NOTE, familyFeatures } from '../family/pack';
import {
  ARCADE_SHELF_ID,
  arcadeDiagRow,
  arcadeId,
  arcadeVersion,
  createArcadeRouter,
  parseArcadeCatalog,
} from './router';
import type { ArcadeDiagRow } from './router';

const AMBER_A = '6a5fc5fa351af41332734161'; // a family account from before the cutoff
const VISCHECK = '6a6125d73939d20b95251078'; // App Review and screenshots
const madeAt = (iso: string) =>
  Math.floor(Date.parse(iso) / 1000)
    .toString(16)
    .padStart(8, '0') + '0000000000000000';
const BOB = madeAt('2026-10-02T15:00:00Z'); // made after the cutoff, never granted

const FAMILY: LibraryAccount = { id: AMBER_A };
const ADMIN: LibraryAccount = { id: BOB, role: 'ADMIN' };
const OUTSIDE: LibraryAccount = { id: BOB };
const REVIEW: LibraryAccount = { id: VISCHECK };

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_K = 'c'.repeat(64);
const CATALOG = {
  kit: { version: '4.2.3-1', size: 4000000, sha256: SHA_K },
  games: [
    {
      id: 'xena',
      title: 'Xena Warrior Princess',
      console: 'N64',
      access: 'family',
      version: '2026-10-20a',
      size: 47000000,
      sha256: SHA_A,
      note: 'Plays by ear',
    },
    {
      id: 'super-tilt-bro',
      title: 'Super Tilt Bro',
      console: 'NES',
      access: 'public',
      version: '1.0.0',
      size: 900000,
    },
  ],
};
const index = (sha256: string, size: number) => ({
  format: 1,
  blob: { size, sha256 },
  files: [{ path: 'rom.z64', offset: 0, size: 12 }],
});

/* ── fakes ─────────────────────────────────────────────────────────── */
let objects = new Map<string, Buffer>();
let loads: string[] = [];
let signs: Array<{ key: string; mime: string; seconds: number }> = [];
let diags: ArcadeDiagRow[] = [];
let logs: string[] = [];
let clock = Date.parse('2026-10-18T12:00:00Z');
let storageDown = false;
let signedIn: LibraryAccount | null = null;

const put = (key: string, value: unknown) => objects.set(key, Buffer.from(JSON.stringify(value)));
function stock() {
  put('arcade/catalog.json', CATALOG);
  put('arcade/games/xena/2026-10-20a/pack.json', index(SHA_A, 47000123));
  put('arcade/games/super-tilt-bro/1.0.0/pack.json', index(SHA_B, 900123));
  put('arcade/kit/4.2.3-1/pack.json', index(SHA_K, 4000123));
}

let server: Server;
let base = '';
let envSaved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'KADE_LIBRARY_HIDDEN_FROM',
  'NOTIFY_TEST_USER_IDS',
  'KADE_APP_REVIEW_USER_IDS',
  'KADE_FAMILY_PACK_LINKS',
];

/** A fresh router (and so a fresh catalog cache) for every test. */
async function mount() {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const app = express();
  app.use(express.json({ limit: '3mb' })); // the app-wide parser, as api/server/index.js has it
  app.use(
    '/api/kade/arcade',
    createArcadeRouter({
      auth: (req, res, next) => {
        if (!signedIn) {
          res.status(401).json({ error: 'Sign in first.' });
          return;
        }
        (req as { user?: LibraryAccount }).user = signedIn;
        next();
      },
      loadObject: async (key) => {
        loads.push(key);
        if (storageDown) throw new Error('storage unreachable');
        return objects.get(key) || null;
      },
      signGet: async (key, mime, seconds) => {
        signs.push({ key, mime, seconds });
        return `https://b2.test/${key}?X-Amz-Expires=${seconds}`;
      },
      diag: (row) => {
        diags.push(row);
      },
      now: () => clock,
      log: (message) => logs.push(message),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kade/arcade`;
}

before(() => {
  for (const key of ENV_KEYS) {
    envSaved[key] = process.env[key];
    delete process.env[key];
  }
});
after(async () => {
  for (const key of ENV_KEYS) {
    if (envSaved[key] === undefined) delete process.env[key];
    else process.env[key] = envSaved[key];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  objects = new Map();
  loads = [];
  signs = [];
  diags = [];
  logs = [];
  storageDown = false;
  clock = Date.parse('2026-10-18T12:00:00Z');
  signedIn = FAMILY;
  stock();
  await mount();
});

type Body = Record<string, unknown>;
async function get(path: string, who: LibraryAccount | null = signedIn) {
  signedIn = who;
  const res = await fetch(base + path);
  const text = await res.text();
  const json = (res.headers.get('content-type') || '').includes('json');
  return {
    status: res.status,
    cache: res.headers.get('cache-control'),
    text,
    body: (json ? JSON.parse(text) : null) as Body,
  };
}
async function post(path: string, body: string, who: LibraryAccount | null = signedIn) {
  signedIn = who;
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await res.text();
  return {
    status: res.status,
    cache: res.headers.get('cache-control'),
    body: (text ? JSON.parse(text) : null) as Body,
  };
}

/* Every storage key the router built must be one of these shapes. */
const SAFE_KEY =
  /^arcade\/(catalog\.json|games\/[a-z0-9-]+\/[A-Za-z0-9._-]+\/(pack\.json|blob\.bin)|kit\/[A-Za-z0-9._-]+\/(pack\.json|blob\.bin))$/;
function keysAreSafe() {
  for (const key of [...loads, ...signs.map((s) => s.key)]) {
    assert.match(key, SAFE_KEY, key);
    assert.doesNotMatch(key, /\.\./, key);
  }
}

/* ── GET /config ───────────────────────────────────────────────────── */
test('every route refuses nobody signed in', async () => {
  for (const path of [
    '/config',
    '/games/xena/manifest',
    '/games/xena/2026-10-20a/pack',
    '/kit/4.2.3-1/manifest',
    '/kit/4.2.3-1/pack',
  ]) {
    assert.equal((await get(path, null)).status, 401, path);
  }
  assert.equal((await post('/diag', '{"kind":"soak"}', null)).status, 401);
  assert.equal(loads.length, 0, 'storage is never read before sign-in');
  assert.equal(signs.length, 0);
});

test('no catalog in storage yet: an empty arcade, no crash, and the pack map still answers', async () => {
  objects = new Map();
  const res = await get('/config', FAMILY);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(res.body, {
    catalog: [],
    features: familyFeatures(FAMILY),
    familyPack: true,
    note: FAMILY_PACK_NOTE,
    kit: null,
  });
  assert.equal((await get('/games/xena/manifest', FAMILY)).status, 404);
  assert.equal((await get('/games/xena/2026-10-20a/pack', FAMILY)).status, 404);
  assert.equal((await get('/games/xena/manifest', OUTSIDE)).status, 403);
  assert.equal(signs.length, 0);
});

test('inside the pack every game is listed, unlocked, with the kit version', async () => {
  for (const who of [FAMILY, ADMIN]) {
    const res = await get('/config', who);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.catalog, [
      {
        id: 'xena',
        title: 'Xena Warrior Princess',
        console: 'N64',
        access: 'family',
        version: '2026-10-20a',
        size: 47000000,
        locked: false,
        note: 'Plays by ear',
      },
      {
        id: 'super-tilt-bro',
        title: 'Super Tilt Bro',
        console: 'NES',
        access: 'public',
        version: '1.0.0',
        size: 900000,
        locked: false,
      },
    ]);
    assert.equal(res.body.familyPack, true);
    assert.equal((res.body.features as Body).arcadeFamily, true);
    assert.deepEqual(res.body.kit, { version: '4.2.3-1', size: 4000000 });
  }
});

test('outside the pack (the App Review seat included) family games collapse into one greyed entry with no game names', async () => {
  for (const who of [OUTSIDE, REVIEW]) {
    const res = await get('/config', who);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.catalog, [
      {
        id: 'super-tilt-bro',
        title: 'Super Tilt Bro',
        console: 'NES',
        access: 'public',
        version: '1.0.0',
        size: 900000,
        locked: false,
      },
      {
        id: ARCADE_SHELF_ID,
        title: 'Family shelf',
        console: '',
        access: 'family',
        version: '',
        size: 0,
        locked: true,
        note: FAMILY_PACK_NOTE,
      },
    ]);
    assert.doesNotMatch(
      res.text,
      /xena|warrior|N64|2026-10-20a|Plays by ear/i,
      'nothing names a family game',
    );
    assert.equal(res.body.familyPack, false);
    assert.equal((res.body.features as Body).arcadeFamily, false);
  }
  /* A second review seat listed only in KADE_APP_REVIEW_USER_IDS, made before the cutoff. */
  process.env.KADE_APP_REVIEW_USER_IDS = AMBER_A;
  try {
    const res = await get('/config', FAMILY);
    assert.equal(res.body.familyPack, false);
    assert.doesNotMatch(res.text, /xena/i);
  } finally {
    delete process.env.KADE_APP_REVIEW_USER_IDS;
  }
});

test('with no family games there is no shelf entry, and with only family games outside the pack there is only the shelf', async () => {
  put('arcade/catalog.json', { games: [CATALOG.games[1]] });
  await mount();
  assert.deepEqual(
    ((await get('/config', OUTSIDE)).body.catalog as Body[]).map((row) => row.id),
    ['super-tilt-bro'],
  );
  put('arcade/catalog.json', { games: [CATALOG.games[0]] });
  await mount();
  assert.deepEqual(
    ((await get('/config', OUTSIDE)).body.catalog as Body[]).map((row) => row.id),
    [ARCADE_SHELF_ID],
  );
});

test('the catalog is read at most once a minute, and a failed read keeps the last good one', async () => {
  await get('/config');
  await get('/config');
  await get('/games/xena/manifest');
  assert.equal(loads.filter((key) => key === 'arcade/catalog.json').length, 1);
  clock += 61 * 1000;
  storageDown = true;
  const stale = await get('/config');
  assert.equal(stale.status, 200);
  assert.equal((stale.body.catalog as Body[]).length, 2, 'the last good catalog is served');
  assert.ok(logs.some((line) => /catalog could not be read: storage unreachable/.test(line)));
  clock += 5 * 1000;
  await get('/config');
  assert.equal(loads.filter((key) => key === 'arcade/catalog.json').length, 2, 'no retry storm');
  clock += 6 * 1000;
  storageDown = false;
  put('arcade/catalog.json', { games: [] });
  assert.deepEqual((await get('/config')).body.catalog, [], 'a fresh read after the retry wait');
});

test('a storage failure with nothing cached is an empty arcade, not an error', async () => {
  storageDown = true;
  const res = await get('/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.catalog, []);
});

/* ── GET /games/:id/manifest ───────────────────────────────────────── */
test('the manifest: a family game opens inside the pack and is refused outside it', async () => {
  const res = await get('/games/xena/manifest', FAMILY);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(res.body, {
    id: 'xena',
    title: 'Xena Warrior Princess',
    console: 'N64',
    access: 'family',
    version: '2026-10-20a',
    size: 47000123,
    sha256: SHA_A,
    kit: '4.2.3-1',
    ready: true,
    index: index(SHA_A, 47000123),
  });
  keysAreSafe();
  loads = [];
  for (const who of [OUTSIDE, REVIEW]) {
    const refused = await get('/games/xena/manifest', who);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, FAMILY_PACK_ARCADE_REFUSAL);
  }
  assert.deepEqual(loads, [], 'a refusal reads nothing (the catalog is cached)');
});

test('outside the pack an unknown id and the shelf get the same refusal as a family game, so names never leak', async () => {
  const family = await get('/games/xena/manifest', OUTSIDE);
  const unknown = await get('/games/not-a-game/manifest', OUTSIDE);
  const shelf = await get(`/games/${ARCADE_SHELF_ID}/manifest`, OUTSIDE);
  for (const res of [family, unknown, shelf]) {
    assert.equal(res.status, 403);
    assert.equal(res.text, family.text);
  }
  assert.equal(
    (await get('/games/not-a-game/manifest', FAMILY)).status,
    404,
    'inside the pack, unknown is unknown',
  );
  assert.equal((await get(`/games/${ARCADE_SHELF_ID}/manifest`, FAMILY)).status, 404);
});

test('a public game opens for everyone signed in, the App Review seat too', async () => {
  for (const who of [OUTSIDE, REVIEW, FAMILY]) {
    const res = await get('/games/super-tilt-bro/manifest', who);
    assert.equal(res.status, 200);
    assert.equal(res.body.access, 'public');
    assert.equal(res.body.sha256, SHA_B);
  }
});

test('a game listed before its pack is uploaded answers ready: false', async () => {
  objects.delete('arcade/games/xena/2026-10-20a/pack.json');
  const res = await get('/games/xena/manifest', FAMILY);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, false);
  assert.equal(res.body.index, null);
  assert.equal(res.body.size, 47000000, 'the catalog size stands in');
  assert.equal(res.body.sha256, SHA_A);
});

/* ── GET /games/:id/:ver/pack ──────────────────────────────────────── */
test('the pack link is one signed GET for exactly blob.bin, for one hour', async () => {
  const res = await get('/games/xena/2026-10-20a/pack', FAMILY);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(res.body, {
    url: 'https://b2.test/arcade/games/xena/2026-10-20a/blob.bin?X-Amz-Expires=3600',
    sha256: SHA_A,
    size: 47000123,
    version: '2026-10-20a',
    expiresIn: 3600,
  });
  assert.deepEqual(signs, [
    {
      key: 'arcade/games/xena/2026-10-20a/blob.bin',
      mime: 'application/octet-stream',
      seconds: 3600,
    },
  ]);
  keysAreSafe();
});

test('the pack route is gated on the server: outside the pack nothing is signed', async () => {
  for (const who of [OUTSIDE, REVIEW]) {
    const res = await get('/games/xena/2026-10-20a/pack', who);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, FAMILY_PACK_ARCADE_REFUSAL);
  }
  assert.equal(signs.length, 0);
  const open = await get('/games/super-tilt-bro/1.0.0/pack', REVIEW);
  assert.equal(open.status, 200);
  assert.equal(signs.length, 1);
});

test('a version with no pack.json, or one that does not name the blob, is not ready and is never signed', async () => {
  assert.equal((await get('/games/xena/2026-01-01/pack', FAMILY)).status, 404);
  put('arcade/games/xena/2026-10-21/pack.json', { blob: { size: 10 } });
  assert.equal((await get('/games/xena/2026-10-21/pack', FAMILY)).status, 404);
  objects.set('arcade/games/xena/2026-10-22/pack.json', Buffer.from('not json'));
  assert.equal((await get('/games/xena/2026-10-22/pack', FAMILY)).status, 404);
  assert.equal(signs.length, 0);
  /* An older uploaded version still signs, so a resumed download can finish. */
  put('arcade/games/xena/2026-10-19/pack.json', index(SHA_B, 5));
  const old = await get('/games/xena/2026-10-19/pack', FAMILY);
  assert.equal(old.status, 200);
  assert.equal(old.body.sha256, SHA_B);
});

test('ids and versions are checked before any storage key is built: no traversal, no odd characters', async () => {
  const bad = [
    '/games/..%2F..%2Fmedia-library/manifest',
    '/games/%2E%2E/manifest', // fetch folds this to /games/manifest: Express's own 404
    '/games/XENA/manifest',
    '/games/xena%00/manifest',
    '/games/-xena/manifest',
    `/games/${'a'.repeat(49)}/manifest`,
    '/games/xena/..%2F..%2Fsecret/pack',
    '/games/xena/%2E%2E/pack',
    '/games/xena/1..2/pack',
    '/games/xena/.hidden/pack',
    '/games/xena/v1%2Fblob.bin/pack',
    `/games/xena/${'1'.repeat(33)}/pack`,
    '/kit/..%2Fgames/pack',
    '/kit/%2E%2E/manifest',
    '/kit/4.2.3%2F..%2F..%2Fx/pack',
  ];
  for (const who of [FAMILY, ADMIN]) {
    for (const path of bad) {
      const res = await get(path, who);
      assert.ok(res.status === 404 || res.status === 400, `${path} answered ${res.status}`);
    }
  }
  assert.equal(signs.length, 0, 'nothing was signed');
  keysAreSafe();
  for (const value of ['..', 'a/b', 'a\\b', '', '.', 'a..b', 'a.', '-a'])
    assert.equal(arcadeVersion(value), false, value);
  for (const value of ['4.2.3-1', '2026-10-20a', 'v1_2', '1'])
    assert.equal(arcadeVersion(value), true, value);
  for (const value of ['xena', 'super-tilt-bro', 'n64']) assert.equal(arcadeId(value), true, value);
  for (const value of ['Xena', 'xena-', 'a_b', 'a.b', '', 'a/b', '..'])
    assert.equal(arcadeId(value), false, value);
});

/* ── the kit ───────────────────────────────────────────────────────── */
test('the kit is open-source code: every signed-in account gets its manifest and its link', async () => {
  for (const who of [OUTSIDE, REVIEW, FAMILY]) {
    const manifest = await get('/kit/4.2.3-1/manifest', who);
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.body, {
      version: '4.2.3-1',
      size: 4000123,
      sha256: SHA_K,
      ready: true,
      index: index(SHA_K, 4000123),
    });
    const pack = await get('/kit/4.2.3-1/pack', who);
    assert.equal(pack.status, 200);
    assert.equal(pack.body.url, 'https://b2.test/arcade/kit/4.2.3-1/blob.bin?X-Amz-Expires=3600');
    assert.equal(pack.body.expiresIn, 3600);
  }
  assert.equal((await get('/kit/9.9.9/pack', OUTSIDE)).status, 404);
  assert.equal((await get('/kit/9.9.9/manifest', OUTSIDE)).status, 404);
  assert.ok(signs.every((s) => s.key === 'arcade/kit/4.2.3-1/blob.bin' && s.seconds === 3600));
  keysAreSafe();
});

/* ── POST /diag ────────────────────────────────────────────────────── */
test('diagnostics keep known small fields and the account id, nothing else', async () => {
  const res = await post(
    '/diag',
    JSON.stringify({
      kind: 'soak',
      game: 'xena',
      version: '2026-10-20a',
      email: 'someone@example.com',
      stats: {
        fps: 58.7,
        heap: 67108864,
        reloads: 0,
        audio: 'running',
        lowPower: false,
        note: 'my name is Bob and I live at 12 Elm St, Springfield',
        'bad key': 1,
        nested: { a: 1 },
      },
    }),
    OUTSIDE,
  );
  assert.equal(res.status, 204);
  assert.deepEqual(diags, [
    {
      user: BOB,
      at: '2026-10-18T12:00:00.000Z',
      kind: 'soak',
      game: 'xena',
      version: '2026-10-20a',
      stats: { fps: 58.7, heap: 67108864, reloads: 0, audio: 'running', lowPower: false },
    },
  ]);
  assert.equal((await post('/diag', JSON.stringify({ kind: 'Not A Kind' }))).status, 400);
  assert.equal((await post('/diag', '[]')).status, 400);
  assert.equal(
    (await post('/diag', JSON.stringify({ kind: 'soak', pad: 'x'.repeat(5000) }))).status,
    413,
  );
});

test('diagnostics are rate-limited per account', async () => {
  for (let i = 0; i < 12; i++)
    assert.equal((await post('/diag', '{"kind":"tick"}', FAMILY)).status, 204, `report ${i}`);
  const limited = await post('/diag', '{"kind":"tick"}', FAMILY);
  assert.equal(limited.status, 429);
  assert.equal(
    (await post('/diag', '{"kind":"tick"}', OUTSIDE)).status,
    204,
    'another account is unaffected',
  );
  clock += 61 * 1000;
  assert.equal((await post('/diag', '{"kind":"tick"}', FAMILY)).status, 204, 'the minute passes');
  assert.equal(diags.length, 14);
});

test('a router without a diag store logs the report instead', async () => {
  const lines: string[] = [];
  const router = createArcadeRouter({
    auth: (req, _res, next) => {
      (req as { user?: LibraryAccount }).user = FAMILY;
      next();
    },
    loadObject: async () => null,
    signGet: async () => '',
    log: (message) => lines.push(message),
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const local = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = (local.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/diag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"kind":"boot","stats":{"fps":60}}',
    });
    assert.equal(res.status, 204);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^diag \{"user":"6a5fc5fa351af41332734161",.*"kind":"boot".*"fps":60/);
  } finally {
    await new Promise<void>((resolve) => local.close(() => resolve()));
  }
});

/* ── the catalog file ──────────────────────────────────────────────── */
test('catalog rows are checked: bad rows are dropped, and anything not exactly public is a family game', () => {
  const lines: string[] = [];
  const parsed = parseArcadeCatalog(
    {
      kit: { version: '../x', size: 1 },
      games: [
        { id: 'xena', title: 'Xena', version: '1', access: 'Public' },
        {
          id: 'open',
          title: 'Open game',
          version: '1',
          access: 'public',
          size: -5,
          sha256: 'nope',
        },
        { id: 'xena', title: 'Duplicate', version: '2', access: 'public' },
        { id: ARCADE_SHELF_ID, title: 'Impostor shelf', version: '1', access: 'public' },
        { id: '../etc', title: 'Escape', version: '1' },
        { id: 'no-version', title: 'No version' },
        { id: 'no-title', version: '1' },
        'not a row',
      ],
    },
    (message) => lines.push(message),
  );
  assert.deepEqual(parsed, {
    kit: null,
    games: [
      { id: 'xena', title: 'Xena', console: '', access: 'family', version: '1', size: 0 },
      { id: 'open', title: 'Open game', console: '', access: 'public', version: '1', size: 0 },
    ],
  });
  assert.equal(lines.length, 7, 'six bad rows and the bad kit are named in the log');
  assert.deepEqual(parseArcadeCatalog(null), { games: [], kit: null });
  assert.deepEqual(parseArcadeCatalog({ games: 'nope' }), { games: [], kit: null });
});

test('arcadeDiagRow never keeps free text', () => {
  const row = arcadeDiagRow(
    'u1',
    {
      kind: 'crash',
      game: '../x',
      version: 'a/b',
      stats: { reason: 'WebContent process ended', where: "Kade's phone" },
    },
    new Date(0),
  );
  assert.deepEqual(row, {
    user: 'u1',
    at: '1970-01-01T00:00:00.000Z',
    kind: 'crash',
    game: null,
    version: null,
    stats: { reason: 'WebContent process ended' },
  });
  assert.equal(arcadeDiagRow('u1', { stats: {} }, new Date(0)), null);
});
