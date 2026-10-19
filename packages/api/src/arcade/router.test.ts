/* The Arcade router (Oct 18 2026): catalog, manifests, one-hour signed pack links and
 * diagnostics, with the family shelf behind the Family feature pack. Storage and signing are
 * fakes; the pack rule is the real one (family/pack.ts). Storage keys are the ones the Revival
 * kit's tools/upload_pack.py writes, and pack.json fixtures follow tools/packlib.py's shape (see
 * the test of the kit's real pack.json near the end; no game bytes are in this file).
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
  arcadePath,
  arcadeVersion,
  createArcadeRouter,
  parseArcadeCatalog,
  parseArcadePackIndex,
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
/* A one-row pack.json with the kit's field names: blob.bytes, and a row's size as length. */
const index = (sha256: string, bytes: number, path = 'rom.z64') => ({
  format: 'kadearcade-pack/1',
  blob: { file: 'blob.bin', bytes, sha256 },
  files: [{ path, offset: 0, length: 12 }],
});
const KIT_FILES = [{ path: 'emulatorjs/loader.js', offset: 0, size: 12 }];

/* ── fakes ─────────────────────────────────────────────────────────── */
let objects = new Map<string, Buffer>();
let loads: string[] = [];
let signs: Array<{ key: string; mime: string; seconds: number }> = [];
let diags: ArcadeDiagRow[] = [];
let logs: string[] = [];
let clock = Date.parse('2026-10-18T12:00:00Z');
let storageDown = false;
let signedIn: LibraryAccount | null = null;
let children = new Set<string>();
let childCheckFails = false;
let childAsks = 0;

const put = (key: string, value: unknown) => objects.set(key, Buffer.from(JSON.stringify(value)));
function stock() {
  put('arcade/catalog.json', CATALOG);
  put('arcade/family/xena/2026-10-20a/pack.json', index(SHA_A, 47000123));
  put('arcade/public/super-tilt-bro/1.0.0/pack.json', index(SHA_B, 900123));
  put('arcade/public/kit/4.2.3-1/pack.json', index(SHA_K, 4000123, 'emulatorjs/loader.js'));
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
      child: async (req) => {
        childAsks += 1;
        if (childCheckFails) throw new Error('the account could not be read');
        return children.has(String((req as { user?: LibraryAccount }).user?.id));
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
  children = new Set();
  childCheckFails = false;
  childAsks = 0;
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

/* Every storage key the router built must be one of these shapes (upload_pack.py's layout:
 * arcade/<family|public>/<id>/<ver>/, the kit at arcade/public/kit/<ver>/). */
const SAFE_KEY =
  /^arcade\/(catalog\.json|(family|public)\/[a-z0-9-]+\/[A-Za-z0-9._-]+\/(pack\.json|blob\.bin))$/;
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
  /* The app's contract (ArcadeModels.swift ArcadeManifest and ArcadePackRef): the kit and the
   * game as two packs, each with blob.bin's size and sha256, the path that signs its link, and its
   * file table as an ARRAY of { path, offset, size }. */
  assert.deepEqual(res.body, {
    id: 'xena',
    title: 'Xena Warrior Princess',
    console: 'N64',
    access: 'family',
    version: '2026-10-20a',
    ready: true,
    packs: [
      {
        kind: 'kit',
        id: 'kit',
        version: '4.2.3-1',
        size: 4000123,
        sha256: SHA_K,
        signPath: '/api/kade/arcade/kit/4.2.3-1/pack',
        files: KIT_FILES,
      },
      {
        kind: 'game',
        id: 'xena',
        version: '2026-10-20a',
        size: 47000123,
        sha256: SHA_A,
        signPath: '/api/kade/arcade/games/xena/2026-10-20a/pack',
        files: [{ path: 'rom.z64', offset: 0, size: 12 }],
      },
    ],
  });
  for (const pack of res.body.packs as Body[]) {
    assert.ok(Array.isArray(pack.files), 'the file table is an array the app decodes');
    const signed = await get(String(pack.signPath).replace('/api/kade/arcade', ''), FAMILY);
    assert.equal(signed.status, 200, `${pack.signPath} signs`);
    assert.equal(signed.body.sha256, pack.sha256);
  }
  const top = res.body as Body;
  assert.equal(top.index, undefined, 'no object-valued index beside the packs');
  assert.equal(top.sha256, undefined, 'no one-pack fallback fields at the top');
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
    assert.equal(((res.body.packs as Body[])[1] as Body).sha256, SHA_B);
  }
});

/* ── child accounts ────────────────────────────────────────────────── */
test('a grown-ups-only game is absent for a child: not listed, and opened like a game that is not there', async () => {
  const KID: LibraryAccount = { id: madeAt('2026-03-01T15:00:00Z'), kadeLibraryAccess: 'family' };
  const KID_OUTSIDE: LibraryAccount = { id: madeAt('2026-10-03T15:00:00Z') };
  children = new Set([String(KID.id), String(KID_OUTSIDE.id)]);
  put('arcade/catalog.json', {
    ...CATALOG,
    games: [
      { ...CATALOG.games[0], grownUpsOnly: true },
      { ...CATALOG.games[1], id: 'grown-up-public', grownUpsOnly: true },
      CATALOG.games[1],
    ],
  });
  put('arcade/public/grown-up-public/1.0.0/pack.json', index(SHA_B, 900123));
  await mount();

  const grown = await get('/config', FAMILY);
  assert.deepEqual(
    (grown.body.catalog as Body[]).map((row) => row.id),
    ['xena', 'grown-up-public', 'super-tilt-bro'],
    'a grown-up in the pack sees every game',
  );
  const kid = await get('/config', KID);
  assert.equal(kid.body.familyPack, true, 'the child is in the family pack');
  assert.deepEqual(
    (kid.body.catalog as Body[]).map((row) => row.id),
    ['super-tilt-bro'],
  );
  assert.doesNotMatch(kid.text, /xena|warrior|grown-up-public/i);
  const kidOutside = await get('/config', KID_OUTSIDE);
  assert.deepEqual(
    (kidOutside.body.catalog as Body[]).map((row) => row.id),
    ['super-tilt-bro'],
    'no shelf for games the child would not see anyway',
  );

  /* Inside the pack: the same 404 as an unknown id. Outside it: the same refusal as any family id. */
  const unknownInside = await get('/games/not-a-game/manifest', KID);
  for (const path of [
    '/games/xena/manifest',
    '/games/xena/2026-10-20a/pack',
    '/games/grown-up-public/manifest',
    '/games/grown-up-public/1.0.0/pack',
  ]) {
    const res = await get(path, KID);
    assert.equal(res.status, 404, path);
    assert.equal(res.text, unknownInside.text, path);
    const outside = await get(path, KID_OUTSIDE);
    assert.equal(outside.status, 403, path);
    assert.equal(outside.body.error, FAMILY_PACK_ARCADE_REFUSAL);
  }
  assert.equal(signs.length, 0, 'nothing was signed for a child');
  assert.ok(
    loads.every((key) => key === 'arcade/catalog.json'),
    'no pack.json was read for a child',
  );
  assert.equal((await get('/games/super-tilt-bro/1.0.0/pack', KID)).status, 200);
  assert.equal((await get('/games/xena/2026-10-20a/pack', FAMILY)).status, 200);

  /* When the account cannot be read, it counts as a child (the Library's isChild rule). */
  childCheckFails = true;
  assert.equal((await get('/games/xena/manifest', ADMIN)).status, 404);
  assert.deepEqual(
    ((await get('/config', ADMIN)).body.catalog as Body[]).map((row) => row.id),
    ['super-tilt-bro'],
  );
});

test('with no grown-ups-only rows the child check never runs', async () => {
  children = new Set([String(FAMILY.id)]);
  assert.equal((await get('/config', FAMILY)).status, 200);
  assert.equal((await get('/games/xena/manifest', FAMILY)).status, 200, 'not marked: plays');
  assert.equal(childAsks, 0);
});

test('a game listed before its pack (or the kit) is uploaded answers ready: false and no packs', async () => {
  objects.delete('arcade/family/xena/2026-10-20a/pack.json');
  const res = await get('/games/xena/manifest', FAMILY);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, false);
  assert.deepEqual(res.body.packs, [], 'never the kit alone');
  assert.equal(res.body.size, undefined);
  assert.equal(res.body.sha256, undefined, 'nothing the app could take for a one-pack manifest');

  stock();
  objects.delete('arcade/public/kit/4.2.3-1/pack.json');
  await mount();
  const noKit = await get('/games/xena/manifest', FAMILY);
  assert.equal(noKit.body.ready, false);
  assert.deepEqual(noKit.body.packs, [], 'never the game without its kit');

  stock();
  put('arcade/catalog.json', { games: CATALOG.games });
  await mount();
  const noKitRow = await get('/games/xena/manifest', FAMILY);
  assert.equal(noKitRow.body.ready, false, 'a catalog with no kit row is not ready either');
  assert.deepEqual(noKitRow.body.packs, []);
});

test('the manifest passes on a game page and an emulator folder from pack.json when they are safe', async () => {
  put('arcade/family/xena/2026-10-20a/pack.json', {
    ...index(SHA_A, 47000123),
    entry: 'games/xena/play.html',
  });
  put('arcade/public/kit/4.2.3-1/pack.json', {
    ...index(SHA_K, 4000123, 'emulatorjs/loader.js'),
    emulatorData: 'emulatorjs',
  });
  const res = await get('/games/xena/manifest', FAMILY);
  assert.equal(res.body.entry, 'games/xena/play.html');
  assert.equal(res.body.emulatorData, 'emulatorjs/');
  const kit = await get('/kit/4.2.3-1/manifest', OUTSIDE);
  assert.equal(kit.body.emulatorData, 'emulatorjs/');

  put('arcade/family/xena/2026-10-21/pack.json', {
    ...index(SHA_A, 47000123),
    entry: '../../etc/passwd',
  });
  assert.equal(
    (await get('/games/xena/2026-10-21/pack', FAMILY)).status,
    404,
    'an unsafe page path means the pack is not ready',
  );
});

/* ── GET /games/:id/:ver/pack ──────────────────────────────────────── */
test('the pack link is one signed GET for exactly blob.bin, for one hour', async () => {
  const res = await get('/games/xena/2026-10-20a/pack', FAMILY);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(res.body, {
    url: 'https://b2.test/arcade/family/xena/2026-10-20a/blob.bin?X-Amz-Expires=3600',
    sha256: SHA_A,
    size: 47000123,
    version: '2026-10-20a',
    expiresIn: 3600,
  });
  assert.deepEqual(signs, [
    {
      key: 'arcade/family/xena/2026-10-20a/blob.bin',
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
  put('arcade/family/xena/2026-10-21/pack.json', { blob: { size: 10 } });
  assert.equal((await get('/games/xena/2026-10-21/pack', FAMILY)).status, 404);
  objects.set('arcade/family/xena/2026-10-22/pack.json', Buffer.from('not json'));
  assert.equal((await get('/games/xena/2026-10-22/pack', FAMILY)).status, 404);
  assert.equal(signs.length, 0);
  /* An older uploaded version still signs, so a resumed download can finish. */
  put('arcade/family/xena/2026-10-19/pack.json', index(SHA_B, 500));
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
      kind: 'kit',
      id: 'kit',
      version: '4.2.3-1',
      size: 4000123,
      sha256: SHA_K,
      signPath: '/api/kade/arcade/kit/4.2.3-1/pack',
      files: KIT_FILES,
      ready: true,
    });
    const pack = await get('/kit/4.2.3-1/pack', who);
    assert.equal(pack.status, 200);
    assert.equal(
      pack.body.url,
      'https://b2.test/arcade/public/kit/4.2.3-1/blob.bin?X-Amz-Expires=3600',
    );
    assert.equal(pack.body.expiresIn, 3600);
  }
  assert.equal((await get('/kit/9.9.9/pack', OUTSIDE)).status, 404);
  assert.equal((await get('/kit/9.9.9/manifest', OUTSIDE)).status, 404);
  assert.ok(
    signs.every((s) => s.key === 'arcade/public/kit/4.2.3-1/blob.bin' && s.seconds === 3600),
  );
  keysAreSafe();
});

test('pack.json never passes through as is: extra fields are dropped, and a kit that lists games/ files is refused', async () => {
  /* What a careless pack tool might write: build notes with a local path, and game files. */
  put('arcade/public/kit/4.2.3-1/pack.json', {
    ...index(SHA_K, 4000123, 'emulatorjs/loader.js'),
    built: 'C:\\Users\\KADE\\Documents\\Revival kit',
    generator: { note: 'made for xena' },
  });
  for (const who of [REVIEW, OUTSIDE]) {
    const res = await get('/kit/4.2.3-1/manifest', who);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'files',
      'id',
      'kind',
      'ready',
      'sha256',
      'signPath',
      'size',
      'version',
    ]);
    assert.deepEqual(res.body.files, KIT_FILES);
    assert.doesNotMatch(res.text, /Revival|Users|xena|built|generator/i);
  }
  put('arcade/public/kit/4.2.3-2/pack.json', {
    format: 1,
    blob: { size: 4000123, sha256: SHA_K },
    files: [
      { path: 'emulatorjs/loader.js', offset: 0, size: 12 },
      { path: 'games/xena/profile.json', offset: 12, size: 40 },
    ],
  });
  for (const who of [REVIEW, OUTSIDE, FAMILY, ADMIN]) {
    const manifest = await get('/kit/4.2.3-2/manifest', who);
    assert.equal(manifest.status, 404, 'a kit carrying game files is not ready for anyone');
    assert.doesNotMatch(manifest.text, /xena/i);
    assert.equal((await get('/kit/4.2.3-2/pack', who)).status, 404);
  }
  assert.ok(
    signs.every((s) => s.key !== 'arcade/public/kit/4.2.3-2/blob.bin'),
    'never signed',
  );
  assert.ok(logs.some((line) => /kit\/4\.2\.3-2\/pack\.json lists files under games\//.test(line)));

  /* The game manifest gets the same projection. */
  put('arcade/family/xena/2026-10-20a/pack.json', {
    ...index(SHA_A, 47000123),
    built: 'C:\\Users\\KADE\\Documents\\Revival kit',
  });
  const game = await get('/games/xena/manifest', FAMILY);
  assert.equal(game.body.ready, true);
  assert.doesNotMatch(game.text, /Revival|built/);
});

test('a pack.json file table must be safe relative paths inside the blob, or the pack is not ready', async () => {
  const bad: unknown[] = [
    { path: '../secret', offset: 0, size: 1 },
    { path: '/etc/passwd', offset: 0, size: 1 },
    { path: 'a\\b.js', offset: 0, size: 1 },
    { path: 'C:/x.js', offset: 0, size: 1 },
    { path: 'a//b.js', offset: 0, size: 1 },
    { path: './a.js', offset: 0, size: 1 },
    { path: 'a/', offset: 0, size: 1 },
    { path: '.hidden', offset: 0, size: 1 },
    { path: 'rom.z64', offset: 4000120, size: 12 },
    { path: 'rom.z64', offset: -1, size: 1 },
    { path: 'rom.z64', offset: 0 },
    'rom.z64',
  ];
  let n = 0;
  for (const row of bad) {
    n += 1;
    put(`arcade/public/kit/bad-${n}/pack.json`, {
      blob: { size: 4000123, sha256: SHA_K },
      files: [{ path: 'emulatorjs/loader.js', offset: 0, size: 12 }, row],
    });
    assert.equal(
      (await get(`/kit/bad-${n}/manifest`, FAMILY)).status,
      404,
      `${JSON.stringify(row)} is refused`,
    );
  }
  put('arcade/public/kit/dupe/pack.json', {
    blob: { size: 4000123, sha256: SHA_K },
    files: [KIT_FILES[0], KIT_FILES[0]],
  });
  assert.equal((await get('/kit/dupe/manifest', FAMILY)).status, 404, 'a path listed twice');
  put('arcade/public/kit/empty/pack.json', { blob: { size: 4000123, sha256: SHA_K }, files: [] });
  assert.equal((await get('/kit/empty/manifest', FAMILY)).status, 404, 'an empty table');
  assert.equal(signs.length, 0);

  /* A voice clip's name may have spaces; "length" is read as the size. */
  assert.deepEqual(
    parseArcadePackIndex({
      blob: { size: 100, sha256: SHA_A },
      files: [
        { path: 'games/xena/audio/voice/2 of 3.mp3', offset: 10, length: 90, mime: 'audio/mpeg' },
      ],
      extra: true,
    }),
    {
      format: 1,
      blob: { size: 100, sha256: SHA_A },
      files: [
        { path: 'games/xena/audio/voice/2 of 3.mp3', offset: 10, size: 90, mime: 'audio/mpeg' },
      ],
    },
  );
  for (const value of ['games/xena/play.html', 'emulatorjs/cores/mupen64plus_next-wasm.data', 'a'])
    assert.equal(arcadePath(value), true, value);
  for (const value of ['', '/a', 'a/', '..', 'a/../b', 'a\\b', 'C:x', ' a', 'a ', '.a', 'a//b'])
    assert.equal(arcadePath(value), false, value);
});

/* ── the Revival kit's real pack.json (the Oct 18 contract) ────────── */
/* What the kit's tools/packlib.py write_pack writes, field for field, as in the built packs
 * kit-20261018-27899e08 and xena-20261018-63fdca17: json.dump(indent=1) in Python text mode
 * (Windows line endings); "format": "kadearcade-pack/1"; blob { file, bytes, sha256 } with no
 * size; rows { path, offset, length, sha256, type } sorted by path and contiguous from 0; the MIME
 * as `type`, with "; charset=utf-8" for text; the kit's EmulatorJS folder "emulatorjs/"; and
 * cloned-voice clip names that are the spoken line (163 characters in the longest so far). The
 * paths follow the real layout. Lengths, hashes and the clip's words are made up: no game bytes. */
const KIT_VER = '20261018-27899e08';
const GAME_VER = '20261018-63fdca17';
const KIT_BLOB_SHA = `27899e08${'1'.repeat(56)}`;
const GAME_BLOB_SHA = `63fdca17${'2'.repeat(56)}`;
const LONG_CLIP =
  "you found the road north of the village, and the wind's at your back while the drums of the far camp keep time with every step you take (all the way home)+1.mp3";
const JS = 'text/javascript; charset=utf-8';
const BIN = 'application/octet-stream';
type KitRow = { path: string; offset: number; length: number; sha256: string; type: string };

/** Rows as write_pack lays them out: sorted by path, each starting where the last one ended. */
function packRows(list: Array<[string, number, string]>): KitRow[] {
  let offset = 0;
  return [...list]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, length, type], n) => {
      const row = { path, offset, length, sha256: n.toString(16).padStart(64, 'e'), type };
      offset += length;
      return row;
    });
}
const blobBytes = (rows: KitRow[]) => rows.reduce((sum, row) => sum + row.length, 0);
const KIT_ROWS = packRows([
  ['core/app.js', 160, JS],
  ['core/host.js', 40, JS],
  ['core/play.html', 31, 'text/html; charset=utf-8'],
  ['emulatorjs/compression/extract7z.js', 28, JS],
  ['emulatorjs/cores/mupen64plus_next-wasm.data', 145, BIN],
  ['emulatorjs/cores/reports/mupen64plus_next.json', 15, 'application/json'],
  ['emulatorjs/emulator.min.css', 25, 'text/css'],
  ['emulatorjs/emulator.min.js', 42, JS],
  ['emulatorjs/loader.js', 7, JS],
  ['emulatorjs/localization/en-US.json', 9, 'application/json'],
]);
const GAME_ROWS = packRows([
  ['games/xena/game.js', 25, JS],
  ['games/xena/gamesfx.js', 13, JS],
  ['games/xena/local/audio/game/game-opus.pack', 260, BIN],
  ['games/xena/local/audio/game/manifest.json', 58, 'application/json'],
  ['games/xena/local/audio/gen/crowd.ogg', 30, 'audio/ogg'],
  [`games/xena/local/audio/voice/${LONG_CLIP}`, 21, 'audio/mpeg'],
  ['games/xena/local/audio/voice/manifest.json', 12, 'application/json'],
  ['games/xena/local/rom.z64', 1258, BIN],
  ['games/xena/play.html', 31, 'text/html; charset=utf-8'],
  ['games/xena/profile.json', 88, 'application/json'],
]);
const KIT_PACK = {
  format: 'kadearcade-pack/1',
  version: KIT_VER,
  created: '2026-10-18T22:20:29-0500',
  kind: 'kit',
  id: 'kit',
  name: 'Revival kit',
  shelf: 'public',
  publicBuilds: true,
  emulatorjs: '4.2.3',
  emulatorjsSource: 'https://cdn.emulatorjs.org/4.2.3/data/',
  emulatorjsPins: { 'loader.js': 'f'.repeat(64), 'emulator.min.js': 'f'.repeat(64) },
  emulatorData: 'emulatorjs/',
  core: 'core/',
  files: KIT_ROWS,
  blob: { file: 'blob.bin', bytes: blobBytes(KIT_ROWS), sha256: KIT_BLOB_SHA },
};
const GAME_PACK = {
  format: 'kadearcade-pack/1',
  version: GAME_VER,
  created: '2026-10-18T23:39:56-0500',
  kind: 'game',
  id: 'xena',
  name: 'Xena: Warrior Princess - The Talisman of Fate',
  console: 'n64',
  shelf: 'family',
  publicBuilds: false,
  entry: 'games/xena/play.html',
  needsKit: true,
  voices: ['announcer'],
  files: GAME_ROWS,
  blob: { file: 'blob.bin', bytes: blobBytes(GAME_ROWS), sha256: GAME_BLOB_SHA },
};
/** pack.json's bytes as Python's json.dump(indent=1) in text mode writes them on Windows. */
const packJson = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 1).replace(/\n/g, '\r\n'));
/** A row as the manifest serves it: the kit's length becomes size, its type becomes mime. */
const served = (rows: KitRow[]) =>
  rows.map(({ path, offset, length, sha256, type }) => ({
    path,
    offset,
    size: length,
    mime: type,
    sha256,
  }));

test("the kit's real pack.json, under the keys upload_pack.py writes, makes a ready manifest the app can install", async () => {
  objects = new Map();
  put('arcade/catalog.json', {
    kit: { version: KIT_VER, size: KIT_PACK.blob.bytes, sha256: KIT_BLOB_SHA },
    games: [
      {
        id: 'xena',
        title: 'Xena Warrior Princess',
        console: 'N64',
        access: GAME_PACK.shelf,
        version: GAME_VER,
        size: GAME_PACK.blob.bytes,
        sha256: GAME_BLOB_SHA,
      },
    ],
  });
  objects.set(`arcade/public/kit/${KIT_VER}/pack.json`, packJson(KIT_PACK));
  objects.set(`arcade/family/xena/${GAME_VER}/pack.json`, packJson(GAME_PACK));
  await mount();

  const res = await get('/games/xena/manifest', FAMILY);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id: 'xena',
    title: 'Xena Warrior Princess',
    console: 'N64',
    access: 'family',
    version: GAME_VER,
    ready: true,
    packs: [
      {
        kind: 'kit',
        id: 'kit',
        version: KIT_VER,
        size: KIT_PACK.blob.bytes,
        sha256: KIT_BLOB_SHA,
        signPath: `/api/kade/arcade/kit/${KIT_VER}/pack`,
        files: served(KIT_ROWS),
      },
      {
        kind: 'game',
        id: 'xena',
        version: GAME_VER,
        size: GAME_PACK.blob.bytes,
        sha256: GAME_BLOB_SHA,
        signPath: `/api/kade/arcade/games/xena/${GAME_VER}/pack`,
        files: served(GAME_ROWS),
      },
    ],
    entry: 'games/xena/play.html',
    emulatorData: 'emulatorjs/',
  });
  const files = (res.body.packs as Body[]).flatMap((pack) => pack.files as Body[]);
  assert.ok(
    files.every((file) => typeof file.mime === 'string'),
    'every row keeps its MIME',
  );
  assert.ok(
    files.some((file) => file.path === `games/xena/local/audio/voice/${LONG_CLIP}`),
    'the 160-character clip name is served',
  );
  assert.doesNotMatch(
    res.text,
    /kadearcade-pack|emulatorjsSource|emulatorjsPins|publicBuilds|needsKit|announcer|Talisman/,
    'build facts stay on the server',
  );
  assert.deepEqual(logs, [], 'no pack was refused');

  for (const pack of res.body.packs as Body[]) {
    const signed = await get(String(pack.signPath).replace('/api/kade/arcade', ''), FAMILY);
    assert.equal(signed.status, 200, `${pack.signPath} signs`);
    assert.equal(signed.body.sha256, pack.sha256);
    assert.equal(signed.body.size, pack.size);
  }
  assert.deepEqual(
    signs.map((s) => s.key),
    [`arcade/public/kit/${KIT_VER}/blob.bin`, `arcade/family/xena/${GAME_VER}/blob.bin`],
  );
  assert.deepEqual([...new Set(loads)].sort(), [
    'arcade/catalog.json',
    `arcade/family/xena/${GAME_VER}/pack.json`,
    `arcade/public/kit/${KIT_VER}/pack.json`,
  ]);
  keysAreSafe();

  const kit = await get(`/kit/${KIT_VER}/manifest`, REVIEW);
  assert.equal(kit.status, 200, 'the kit is open to every account');
  assert.equal(kit.body.emulatorData, 'emulatorjs/');
  assert.deepEqual(kit.body.files, served(KIT_ROWS));
  assert.equal((await get('/games/xena/manifest', OUTSIDE)).status, 403, 'the shelf still holds');
});

test("pack.json field names: blob.bytes or blob.size, and a row's MIME from type or mime, charset kept", () => {
  const row = { path: 'core/app.js', offset: 0, length: 10, type: JS };
  /* The kit writes blob.bytes, never blob.size. */
  const blob = (fields: Record<string, unknown>) =>
    parseArcadePackIndex({ blob: { sha256: SHA_K, ...fields }, files: [row] });
  assert.equal(blob({ file: 'blob.bin', bytes: 10 })?.blob.size, 10);
  assert.equal(blob({ size: 10 })?.blob.size, 10);
  assert.equal(blob({ size: 12, bytes: 10 })?.blob.size, 12, 'size wins when both are there');
  for (const fields of [{}, { bytes: 0 }, { bytes: '10' }, { bytes: -1 }, { bytes: 9 }])
    assert.equal(blob(fields), null, JSON.stringify(fields));
  assert.equal(
    parseArcadePackIndex({ blob: { bytes: 10 }, files: [row] }),
    null,
    'no sha256, no pack',
  );

  /* The kit names the MIME `type` and adds a charset to text. */
  const mimeOf = (fields: Record<string, unknown>) =>
    parseArcadePackIndex({
      blob: { bytes: 10, sha256: SHA_K },
      files: [{ path: 'core/app.js', offset: 0, length: 10, ...fields }],
    })?.files[0].mime;
  assert.equal(mimeOf({ type: JS }), JS);
  assert.equal(mimeOf({ type: 'text/html;charset=utf-8' }), 'text/html;charset=utf-8');
  assert.equal(mimeOf({ type: 'audio/mpeg' }), 'audio/mpeg');
  assert.equal(mimeOf({ mime: 'application/json', type: 'text/css' }), 'application/json');
  for (const type of [
    'text/html; charset=utf-8; x=1',
    'text/html; boundary=x',
    'Text/HTML',
    'text/html\r\nX-Header: 1',
    'text/html; charset=',
    'html',
    7,
  ])
    assert.equal(mimeOf({ type }), undefined, JSON.stringify(type));
  assert.deepEqual(
    parseArcadePackIndex({
      blob: { bytes: 10, sha256: SHA_K },
      files: [{ ...row, type: 'not a type' }],
    })?.files,
    [{ path: 'core/app.js', offset: 0, size: 10 }],
    'an odd type is dropped and the row stays',
  );
});

test('clip names are long: a path part up to 255 characters, a whole path up to 1,024', () => {
  assert.equal(LONG_CLIP.length, 160);
  assert.equal(arcadePath(`games/xena/local/audio/voice/${LONG_CLIP}`), true);
  assert.equal(arcadePath('a'.repeat(255)), true);
  assert.equal(arcadePath('a'.repeat(256)), false);
  const part = 'b'.repeat(204);
  assert.equal(arcadePath(Array(5).fill(part).join('/')), true, '1,024 characters');
  assert.equal(arcadePath(`${Array(5).fill(part).join('/')}c`), false, '1,025 characters');
  for (const value of [
    ` ${LONG_CLIP}`,
    `${LONG_CLIP} `,
    `${LONG_CLIP}/`,
    `voice/../${LONG_CLIP}`,
    `${LONG_CLIP.slice(0, -4)}?.mp3`,
  ])
    assert.equal(arcadePath(value), false, value);
});

test('the shelf folder comes from the catalog access: the old layout and the other shelf are never read', async () => {
  objects = new Map();
  put('arcade/catalog.json', CATALOG);
  /* The layout before the Oct 18 contract, which no tool writes. */
  put('arcade/games/xena/2026-10-20a/pack.json', index(SHA_A, 47000123));
  put('arcade/games/super-tilt-bro/1.0.0/pack.json', index(SHA_B, 900123));
  put('arcade/kit/4.2.3-1/pack.json', index(SHA_K, 4000123, 'emulatorjs/loader.js'));
  /* Each pack on the other shelf from the one its catalog row (or the kit) says. */
  put('arcade/public/xena/2026-10-20a/pack.json', index(SHA_A, 47000123));
  put('arcade/family/super-tilt-bro/1.0.0/pack.json', index(SHA_B, 900123));
  put('arcade/family/kit/4.2.3-1/pack.json', index(SHA_K, 4000123, 'emulatorjs/loader.js'));
  await mount();
  assert.equal((await get('/games/xena/manifest', FAMILY)).body.ready, false);
  assert.equal((await get('/games/super-tilt-bro/manifest', FAMILY)).body.ready, false);
  for (const path of [
    '/games/xena/2026-10-20a/pack',
    '/games/super-tilt-bro/1.0.0/pack',
    '/kit/4.2.3-1/pack',
    '/kit/4.2.3-1/manifest',
  ])
    assert.equal((await get(path, FAMILY)).status, 404, path);
  assert.equal(signs.length, 0);
  assert.deepEqual([...new Set(loads)].sort(), [
    'arcade/catalog.json',
    'arcade/family/xena/2026-10-20a/pack.json',
    'arcade/public/kit/4.2.3-1/pack.json',
    'arcade/public/super-tilt-bro/1.0.0/pack.json',
  ]);
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
        mode: 'fight',
        lowPower: false,
        device: 'iPhone16,2',
        note: 'my name is Bob and I live at 12 Elm St, Springfield',
        email: 'kade murdock gmail.com',
        kademurdock_gmail_com: 1,
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
      stats: {
        fps: 58.7,
        heap: 67108864,
        reloads: 0,
        audio: 'running',
        mode: 'fight',
        lowPower: false,
        device: 'iPhone16,2',
      },
    },
  ]);
  assert.equal((await post('/diag', JSON.stringify({ kind: 'Not A Kind' }))).status, 400);
  assert.equal(
    (await post('/diag', JSON.stringify({ kind: 'kademurdock' }))).status,
    400,
    'a kind that is not on the list is refused, so it cannot carry a word either',
  );
  assert.equal((await post('/diag', '[]')).status, 400);
  assert.equal(
    (await post('/diag', JSON.stringify({ kind: 'soak', pad: 'x'.repeat(5000) }))).status,
    413,
  );
});

test('diagnostics are rate-limited per account, with room over one report every five seconds', async () => {
  for (let i = 0; i < 30; i++)
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
  assert.equal(diags.length, 32);
});

test('manifest and pack requests are rate-limited per account', async () => {
  const paths = ['/kit/4.2.3-1/manifest', '/kit/4.2.3-1/pack', '/games/xena/manifest'];
  for (let i = 0; i < 60; i++) {
    const path = i < 57 ? `/kit/v${i}/pack` : paths[i - 57];
    const res = await get(path, FAMILY);
    assert.ok(res.status === 200 || res.status === 404, `${path} answered ${res.status}`);
  }
  for (const path of [...paths, '/games/xena/2026-10-20a/pack', '/kit/v99/manifest']) {
    assert.equal((await get(path, FAMILY)).status, 429, path);
  }
  assert.equal((await get('/config', FAMILY)).status, 200, '/config reads only the cached catalog');
  assert.equal((await get('/kit/4.2.3-1/pack', OUTSIDE)).status, 200, 'another account is fine');
  clock += 61 * 1000;
  assert.equal((await get('/kit/4.2.3-1/pack', FAMILY)).status, 200, 'the minute passes');
});

test('made-up versions never push a real pack index out of the cache', async () => {
  const kitKey = 'arcade/public/kit/4.2.3-1/pack.json';
  assert.equal((await get('/kit/4.2.3-1/pack', FAMILY)).status, 200);
  for (let i = 0; i < 200; i++) {
    signedIn = {
      id: madeAt('2026-10-02T15:00:00Z').slice(0, 20) + i.toString(16).padStart(4, '0'),
    };
    assert.equal((await get(`/kit/junk-${i}/manifest`)).status, 404);
  }
  assert.equal((await get('/kit/4.2.3-1/pack', FAMILY)).status, 200);
  assert.equal(
    loads.filter((key) => key === kitKey).length,
    1,
    'the real index was read once and stayed cached',
  );
  /* Recent misses are cached too: asking again for the newest made-up version reads nothing. */
  const before = loads.length;
  signedIn = OUTSIDE;
  assert.equal((await get('/kit/junk-199/manifest')).status, 404);
  assert.equal(loads.length, before);
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
        { id: 'kit', title: 'Impostor kit', version: '1', access: 'public' },
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
  assert.equal(lines.length, 8, 'seven bad rows and the bad kit are named in the log');
  assert.deepEqual(
    parseArcadeCatalog({
      games: [
        { id: 'a', title: 'A', version: '1', grownUpsOnly: true },
        { id: 'b', title: 'B', version: '1', grownUpsOnly: 'yes' },
      ],
    }).games.map((game) => game.grownUpsOnly),
    [true, undefined],
    'grown-ups-only only when the catalog says exactly true',
  );
  assert.deepEqual(parseArcadeCatalog(null), { games: [], kit: null });
  assert.deepEqual(parseArcadeCatalog({ games: 'nope' }), { games: [], kit: null });
});

test('arcadeDiagRow never keeps free text: only listed stat names, and words only from their lists', () => {
  const row = arcadeDiagRow(
    'u1',
    {
      kind: 'crash',
      game: '../x',
      version: 'a/b',
      stats: {
        reason: 'WebContent process ended',
        where: "Kade's phone",
        who: 'Kade Murdock',
        city: 'Springfield MO',
        audio: 'kade murdock',
        mode: 'Springfield',
        thermal: 'serious',
        device: 'iPhone of Kade',
        os: '26.0.1',
        heap: '67108864',
        fps: Infinity,
        lowPower: 'yes',
        voiceOver: true,
      },
    },
    new Date(0),
  );
  const inherited = arcadeDiagRow(
    'u1',
    JSON.parse('{"kind":"tick","stats":{"__proto__":1,"constructor":1,"toString":"x"}}'),
    new Date(0),
  );
  assert.deepEqual(inherited?.stats, {}, 'names inherited from Object are not on the list');
  assert.deepEqual(row, {
    user: 'u1',
    at: '1970-01-01T00:00:00.000Z',
    kind: 'crash',
    game: null,
    version: null,
    stats: { thermal: 'serious', os: '26.0.1', voiceOver: true },
  });
  assert.equal(arcadeDiagRow('u1', { stats: {} }, new Date(0)), null);
  assert.equal(arcadeDiagRow('u1', { kind: 'hello-kade' }, new Date(0)), null);
});
