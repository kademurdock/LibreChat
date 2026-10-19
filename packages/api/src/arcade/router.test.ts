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
import type { ArcadeCounterStore, ArcadeDependencies, ArcadeDiagRow } from './router';

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

/** A fresh router (and so a fresh catalog cache) for every test; `extra` adds or replaces deps. */
async function mount(extra: Partial<ArcadeDependencies> = {}) {
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
      ...extra,
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
    `/match?sha1=${'0'.repeat(40)}`,
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
  assert.ok(
    logs.some((line) =>
      /kit\/4\.2\.3-2\/pack\.json lists game files under games\/ \(only games\/_plain\/ is allowed\)/.test(
        line,
      ),
    ),
  );

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
 * paths follow the real layout. Lengths, hashes and the clip's words are made up: no game bytes.
 * Since Oct 19 make_kit.py also puts the plain player in the kit (games/_plain/, with `plain` and
 * `plainSystems`), and make_pack.py writes `kit`, `title`, `romPath`, `romSha1`, `romCrc32` and
 * `accessOnly` into every game pack, full packs included. */
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
  ['games/_plain/play.html', 30, 'text/html; charset=utf-8'],
  ['games/_plain/game.js', 22, JS],
  ['games/_plain/profile.js', 18, JS],
  ['games/_plain/world.js', 16, JS],
  ['games/_plain/systems.json', 14, 'application/json'],
]);
const PLAIN_SYSTEMS = {
  nes: 'fceumm',
  gb: 'gambatte',
  gbc: 'gambatte',
  gba: 'mgba',
  n64: 'mupen64plus_next',
};
/** The ROM the made-up Xena pack was built from (a made-up sha1, no ROM bytes). */
const PACK_ROM_SHA1 = '0123456789abcdef0123456789abcdef01234567';
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
  plain: 'games/_plain/play.html',
  plainSystems: PLAIN_SYSTEMS,
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
  title: 'Xena: Warrior Princess - The Talisman of Fate',
  console: 'n64',
  kit: KIT_VER,
  shelf: 'family',
  publicBuilds: false,
  entry: 'games/xena/play.html',
  needsKit: true,
  voices: ['announcer'],
  romPath: 'games/xena/local/rom.z64',
  romSha1: PACK_ROM_SHA1,
  romCrc32: '1a2b3c4d',
  accessOnly: false,
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
    new RegExp(
      `kadearcade-pack|emulatorjsSource|emulatorjsPins|publicBuilds|needsKit|announcer|Talisman|plainSystems|romCrc32|accessOnly|${PACK_ROM_SHA1}`,
    ),
    'build facts stay on the server',
  );
  const plainManifest = res.body as Body;
  assert.equal(
    plainManifest.romPath,
    undefined,
    'the full pack names its romPath (make_pack.py writes it into every game pack), but only an access manifest passes it on',
  );
  assert.equal(plainManifest.plain, undefined, "the plain player is the kit manifest's");
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
  assert.equal(
    kit.body.plain,
    'games/_plain/play.html',
    'the plain player, for a ROM with no pack',
  );
  assert.deepEqual(kit.body.files, served(KIT_ROWS));
  assert.doesNotMatch(kit.text, /plainSystems|xena/i);
  assert.equal((await get('/games/xena/manifest', OUTSIDE)).status, 403, 'the shelf still holds');
});

test('the kit may carry the plain player (games/_plain/) and nothing else under games/', async () => {
  /* As make_kit.py writes it since Oct 19: the plain player's five files, `plain` and
   * `plainSystems`. Every import with no pack, and every pack, needs this kit. */
  objects.set('arcade/public/kit/4.2.3-1/pack.json', packJson(KIT_PACK));
  const kit = await get('/kit/4.2.3-1/manifest', REVIEW);
  assert.equal(kit.status, 200);
  assert.equal(kit.body.ready, true);
  assert.equal(kit.body.plain, 'games/_plain/play.html');
  assert.ok(
    (kit.body.files as Body[]).some((file) => file.path === 'games/_plain/play.html'),
    'the plain player is served',
  );
  assert.equal((await get('/kit/4.2.3-1/pack', REVIEW)).status, 200);
  const game = await get('/games/xena/manifest', FAMILY);
  assert.equal(game.body.ready, true, 'a game still installs with this kit');
  assert.equal(((game.body.packs as Body[])[0] as Body).version, '4.2.3-1');
  assert.equal(logs.length, 0, 'nothing was refused');

  /* A `plain` that is not a file in the kit is left out (the app's default holds), never a refusal. */
  objects.set(
    'arcade/public/kit/plain-gone/pack.json',
    packJson({ ...KIT_PACK, plain: 'games/_plain/nope.html' }),
  );
  const gone = await get('/kit/plain-gone/manifest', REVIEW);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.plain, undefined);
  objects.set(
    'arcade/public/kit/plain-bad/pack.json',
    packJson({ ...KIT_PACK, plain: '../games/_plain/play.html' }),
  );
  assert.equal((await get('/kit/plain-bad/manifest', REVIEW)).body.plain, undefined);

  /* Game files anywhere else under games/ still refuse the whole kit, whatever the case. Only
   * games/_plain/ spelled exactly that way is the plain player's. */
  let n = 0;
  for (const path of [
    'games/xena/x.js',
    'games/_plainx/a.js',
    'games/x/_plain/a.js',
    'games/_plain',
    'Games/xena/x.js',
    'games/_PLAIN/a.js',
    'games/_Plain/a.js',
    'GAMES/_plain/a.js',
  ]) {
    n += 1;
    objects.set(
      `arcade/public/kit/games-${n}/pack.json`,
      packJson({
        ...KIT_PACK,
        files: packRows([
          ...KIT_ROWS.map((row): [string, number, string] => [row.path, row.length, row.type]),
          [path, 5, JS],
        ]),
        blob: { file: 'blob.bin', bytes: blobBytes(KIT_ROWS) + 5, sha256: KIT_BLOB_SHA },
      }),
    );
    const res = await get(`/kit/games-${n}/manifest`, REVIEW);
    assert.equal(res.status, 404, `${path} refuses the kit`);
    assert.ok(
      logs.some((line) => line.includes(`kit/games-${n}/pack.json lists game files under games/`)),
      path,
    );
  }
  assert.ok(
    signs.every((s) => !s.key.includes('/games-')),
    'never signed',
  );
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

test('pack.json accessOnly counts only when exactly true, and plain only when it is a file in the pack', () => {
  const row = { path: 'games/_plain/play.html', offset: 0, length: 10 };
  const read = (fields: Record<string, unknown>) =>
    parseArcadePackIndex({ blob: { bytes: 10, sha256: SHA_K }, files: [row], ...fields });
  assert.equal(read({ accessOnly: true })?.accessOnly, true);
  for (const accessOnly of [false, 'true', 1, null, undefined])
    assert.equal(read({ accessOnly })?.accessOnly, undefined, JSON.stringify(accessOnly));
  assert.equal(read({ plain: 'games/_plain/play.html' })?.plain, 'games/_plain/play.html');
  for (const plain of ['games/_plain/other.html', '../play.html', '/games/_plain/play.html', 7])
    assert.equal(read({ plain })?.plain, undefined, JSON.stringify(plain));
  assert.notEqual(read({ plain: '../x' }), null, 'a bad plain never refuses the pack');
  assert.equal(read({ romPath: '../rom.z64' }), null, 'an unsafe romPath does');
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

/* ── Add a game: GET /match and access packs (Oct 19 2026) ─────────── */
/* A ROM the person adds stays on the phone; the app sends its No-Intro sha1. The sha1s, versions
 * and hashes here are made up: no ROM bytes. */
const ROM_XENA = PACK_ROM_SHA1;
const ROM_TILT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
const ROM_PLAIN = '1111111111222222222233333333334444444444';
const ROM_UNKNOWN = '9999999999888888888877777777776666666666';
const XENA_ACCESS = '2026-10-20a-access';
const TILT_ACCESS = '1.0.0-access';
const SHA_XA = 'd'.repeat(64);
const SHA_TA = 'e'.repeat(64);
const ADD_CATALOG = {
  ...CATALOG,
  games: [
    {
      ...CATALOG.games[0],
      romSha1: ROM_XENA,
      accessVersion: XENA_ACCESS,
      accessSize: 46000123,
      accessSha256: SHA_XA,
    },
    {
      ...CATALOG.games[1],
      romSha1: ROM_TILT,
      accessVersion: TILT_ACCESS,
      accessSize: 800123,
      accessSha256: SHA_TA,
    },
    /* Known ROM, no access pack yet (make_catalog.py writes romSha1 only with one). */
    {
      id: 'plain',
      title: 'Plain Game',
      console: 'GB',
      access: 'public',
      version: '1',
      romSha1: ROM_PLAIN,
    },
  ],
};
/** An access pack: the game pack's rows minus the ROM, plus where the page expects the ROM. */
const accessIndex = (sha256: string, bytes: number, romPath: string) => ({
  ...index(sha256, bytes, romPath.replace(/rom\.[a-z0-9]+$/, 'play.html')),
  romPath,
  romSha1: ROM_XENA,
  accessOnly: true,
});
function stockAccess() {
  put('arcade/catalog.json', ADD_CATALOG);
  put(
    `arcade/family/xena/${XENA_ACCESS}/pack.json`,
    accessIndex(SHA_XA, 46000123, 'games/xena/local/rom.z64'),
  );
  put(
    `arcade/public/super-tilt-bro/${TILT_ACCESS}/pack.json`,
    accessIndex(SHA_TA, 800123, 'games/super-tilt-bro/local/rom.nes'),
  );
}
const XENA_MATCH = {
  id: 'xena',
  title: 'Xena Warrior Princess',
  console: 'N64',
  access: 'family',
  version: XENA_ACCESS,
  size: 46000123,
  sha256: SHA_XA,
  locked: false,
  note: 'Plays by ear',
  manifestPath: `/api/kade/arcade/games/xena/manifest?version=${XENA_ACCESS}`,
  signPath: `/api/kade/arcade/games/xena/${XENA_ACCESS}/pack`,
};
const TILT_MATCH = {
  id: 'super-tilt-bro',
  title: 'Super Tilt Bro',
  console: 'NES',
  access: 'public',
  version: TILT_ACCESS,
  size: 800123,
  sha256: SHA_TA,
  locked: false,
  manifestPath: `/api/kade/arcade/games/super-tilt-bro/manifest?version=${TILT_ACCESS}`,
  signPath: `/api/kade/arcade/games/super-tilt-bro/${TILT_ACCESS}/pack`,
};
/** What an account outside the pack hears for a family ROM: no id, title, version or links. */
const SHELF_MATCH = {
  id: ARCADE_SHELF_ID,
  title: 'Family shelf',
  console: 'N64',
  access: 'family',
  version: '',
  size: 0,
  locked: true,
  note: FAMILY_PACK_NOTE,
};
const rel = (signPath: unknown) => String(signPath).replace('/api/kade/arcade', '');

test('add a game: inside the pack a family ROM matches its access pack, which installs and signs like any pack', async () => {
  stockAccess();
  await mount();
  for (const who of [FAMILY, ADMIN]) {
    const res = await get(`/match?sha1=${ROM_XENA}`, who);
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.deepEqual(res.body, { match: XENA_MATCH });
  }
  const upper = await get(`/match?sha1=${ROM_XENA.toUpperCase()}`, FAMILY);
  assert.deepEqual(upper.body, { match: XENA_MATCH }, 'the app may send upper-case hex');

  const manifest = await get(rel(XENA_MATCH.manifestPath), FAMILY);
  assert.equal(manifest.status, 200);
  assert.deepEqual(manifest.body, {
    id: 'xena',
    title: 'Xena Warrior Princess',
    console: 'N64',
    access: 'family',
    version: XENA_ACCESS,
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
        version: XENA_ACCESS,
        size: 46000123,
        sha256: SHA_XA,
        signPath: XENA_MATCH.signPath,
        files: [{ path: 'games/xena/local/play.html', offset: 0, size: 12 }],
      },
    ],
    romPath: 'games/xena/local/rom.z64',
  });
  assert.doesNotMatch(
    manifest.text,
    new RegExp(ROM_XENA),
    "the pack's romSha1 stays on the server",
  );

  const signed = await get(rel(XENA_MATCH.signPath), FAMILY);
  assert.deepEqual(signed.body, {
    url: `https://b2.test/arcade/family/xena/${XENA_ACCESS}/blob.bin?X-Amz-Expires=3600`,
    sha256: SHA_XA,
    size: 46000123,
    version: XENA_ACCESS,
    expiresIn: 3600,
  });
  /* The plain manifest still names the full game pack, without romPath. */
  const full = await get('/games/xena/manifest', FAMILY);
  assert.equal(((full.body.packs as Body[])[1] as Body).version, '2026-10-20a');
  assert.equal(full.body.romPath, undefined);
  assert.equal(
    (await get('/games/xena/manifest?version=2026-10-20a', FAMILY)).text,
    full.text,
    "?version= naming the game's own version is the plain manifest",
  );
  keysAreSafe();
});

test('add a game: outside the pack (the App Review seat too) a family ROM answers only the locked shelf row', async () => {
  stockAccess();
  await mount();
  for (const who of [OUTSIDE, REVIEW]) {
    const res = await get(`/match?sha1=${ROM_XENA}`, who);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { match: SHELF_MATCH });
    /* The exact bytes the app's ArcadeMatch decoder must read as locked, with the family reason:
     * version is empty and there is no sha256, manifestPath or signPath. */
    assert.equal(
      res.text,
      '{"match":{"id":"family-shelf","title":"Family shelf","console":"N64","access":"family","version":"","size":0,"locked":true,"note":"Part of the Family feature pack"}}',
    );
    assert.doesNotMatch(
      res.text,
      /xena|warrior|2026-10-20a|-access|Plays by ear|signPath|manifest/i,
    );
    for (const refused of [XENA_MATCH.manifestPath, XENA_MATCH.signPath]) {
      const gate = await get(rel(refused), who);
      assert.equal(gate.status, 403, refused);
      assert.equal(gate.body.error, FAMILY_PACK_ARCADE_REFUSAL);
    }
  }
  assert.equal(signs.length, 0, 'nothing was signed');
  assert.deepEqual(
    [...new Set(loads)],
    ['arcade/catalog.json'],
    'no family pack.json was read for an outsider',
  );
});

test('add a game: a public ROM matches for every signed-in account', async () => {
  stockAccess();
  await mount();
  for (const who of [OUTSIDE, REVIEW, FAMILY]) {
    assert.deepEqual((await get(`/match?sha1=${ROM_TILT}`, who)).body, { match: TILT_MATCH });
  }
  const manifest = await get(rel(TILT_MATCH.manifestPath), REVIEW);
  assert.equal(manifest.body.ready, true);
  assert.equal(manifest.body.romPath, 'games/super-tilt-bro/local/rom.nes');
  const signed = await get(rel(TILT_MATCH.signPath), REVIEW);
  assert.equal(
    signed.body.url,
    `https://b2.test/arcade/public/super-tilt-bro/${TILT_ACCESS}/blob.bin?X-Amz-Expires=3600`,
  );
  keysAreSafe();
});

test('add a game: an unknown ROM, or a known one with no access pack, is no match', async () => {
  stockAccess();
  await mount();
  for (const who of [FAMILY, OUTSIDE]) {
    for (const sha1 of [ROM_UNKNOWN, ROM_PLAIN]) {
      const res = await get(`/match?sha1=${sha1}`, who);
      assert.equal(res.status, 200);
      assert.equal(res.text, '{"match":null}');
    }
  }
  /* A blob's sha256 or a game id is not a ROM sha1. */
  assert.equal((await get(`/match?sha1=${SHA_XA.slice(0, 40)}`, FAMILY)).text, '{"match":null}');
  objects = new Map();
  await mount();
  assert.equal(
    (await get(`/match?sha1=${ROM_XENA}`, FAMILY)).text,
    '{"match":null}',
    'no catalog yet: no match, no crash',
  );
});

test('add a game: a sha1 that is not 40 hex digits is refused before the catalog is read', async () => {
  stockAccess();
  await mount();
  for (const query of [
    '',
    '?sha1=',
    `?sha1=${ROM_XENA.slice(1)}`,
    `?sha1=${ROM_XENA}0`,
    `?sha1=${ROM_XENA.slice(1)}g`,
    `?sha1=%20${ROM_XENA}`,
    `?sha1=${ROM_XENA}&sha1=${ROM_TILT}`,
    `?sha1[a]=${ROM_XENA}`,
    `?sha1=..%2F${ROM_XENA.slice(3)}`,
  ]) {
    const res = await get(`/match${query}`, FAMILY);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.error, "That is not a ROM's sha1 (40 hex digits).");
  }
  assert.equal(loads.length, 0);
});

test('add a game: storage down on a cold start answers /match 503, never "no pack", while /config is an empty arcade', async () => {
  stockAccess();
  await mount();
  storageDown = true;
  const res = await get(`/match?sha1=${ROM_XENA}`, FAMILY);
  assert.equal(res.status, 503);
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(res.body, { error: 'The arcade could not answer just now. Please try again.' });
  const config = await get('/config', FAMILY);
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.catalog, [], '/config treats it as a passing empty arcade');
  assert.equal(
    (await get(`/match?sha1=${ROM_UNKNOWN}`, OUTSIDE)).status,
    503,
    'the empty stand-in is never taken for an answer',
  );
  clock += 11 * 1000;
  storageDown = false;
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, FAMILY)).body, { match: XENA_MATCH });
  assert.equal((await get(`/match?sha1=${ROM_UNKNOWN}`, FAMILY)).text, '{"match":null}');
  /* Once a good catalog was read, a failed re-read keeps serving it, as /config does. */
  clock += 61 * 1000;
  storageDown = true;
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, FAMILY)).body, { match: XENA_MATCH });
  /* A catalog.json that is truly missing is a good answer: no match. */
  objects = new Map();
  storageDown = false;
  await mount();
  assert.equal((await get(`/match?sha1=${ROM_XENA}`, FAMILY)).text, '{"match":null}');
});

test('add a game: an account outside the pack hears the locked row for at most 200 distinct ROMs a day', async () => {
  const romOf = (n: number) => (n + 1).toString(16).padStart(40, '0');
  put('arcade/catalog.json', {
    ...CATALOG,
    games: Array.from({ length: 202 }, (_, n) => ({
      id: `family-${n}`,
      title: `Family ${n}`,
      console: 'GB',
      access: 'family',
      version: '1',
      romSha1: romOf(n),
      accessVersion: '1-access',
      accessSize: 5,
      accessSha256: SHA_A,
    })),
  });
  await mount();
  let sent = 0;
  /* Under the match limit of 60 a minute. */
  const ask = async (n: number, who: LibraryAccount) => {
    sent += 1;
    if (sent % 50 === 0) clock += 61 * 1000;
    const res = await get(`/match?sha1=${romOf(n)}`, who);
    assert.equal(res.status, 200, `${n}`);
    return res.body.match as Body | null;
  };
  for (let n = 0; n < 200; n++) {
    const match = await ask(n, OUTSIDE);
    assert.equal(match?.locked, true, `${n}`);
    assert.equal(match?.id, ARCADE_SHELF_ID);
  }
  assert.equal(await ask(200, OUTSIDE), null, 'the 201st distinct family ROM answers null');
  assert.equal(await ask(201, OUTSIDE), null);
  assert.equal(await ask(200, OUTSIDE), null, 'asking again does not get round it');
  assert.equal((await ask(0, OUTSIDE))?.locked, true, 'a ROM already heard today still answers');
  assert.equal((await ask(199, OUTSIDE))?.locked, true);
  assert.equal((await ask(201, REVIEW))?.locked, true, 'each account has its own count');
  for (let n = 0; n < 202; n++) {
    const match = await ask(n, FAMILY);
    assert.equal(match?.locked, false, `family ${n}: inside the pack there is no cap`);
    assert.equal(match?.id, `family-${n}`);
  }
  clock += 24 * 60 * 60 * 1000;
  assert.equal((await ask(201, OUTSIDE))?.locked, true, 'a new day');
});

test('add a game: the locked-answer cap runs on the shared store the server passes, a day at a time', async () => {
  const calls: string[] = [];
  let windowMs = 0;
  const counts = new Map<string, number>();
  /* Like rate-limit-redis: get on a missing key reads back NaN hits. */
  const store: ArcadeCounterStore = {
    init: (options) => {
      windowMs = options.windowMs;
    },
    get: async (key) => {
      calls.push(`get ${key}`);
      return { totalHits: counts.has(key) ? Number(counts.get(key)) : Number.NaN };
    },
    increment: async (key) => {
      calls.push(`increment ${key}`);
      counts.set(key, (counts.get(key) || 0) + 1);
      return { totalHits: Number(counts.get(key)) };
    },
  };
  stockAccess();
  await mount({ matchLockedStore: store });
  assert.equal(windowMs, 24 * 60 * 60 * 1000);
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, OUTSIDE)).body, { match: SHELF_MATCH });
  assert.deepEqual(calls, [
    `get match-locked:${BOB}:${ROM_XENA}`,
    `increment match-locked:${BOB}`,
    `increment match-locked:${BOB}:${ROM_XENA}`,
  ]);
  calls.length = 0;
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, OUTSIDE)).body, { match: SHELF_MATCH });
  assert.deepEqual(calls, [`get match-locked:${BOB}:${ROM_XENA}`], 'a ROM already heard is free');
  calls.length = 0;
  counts.set(`match-locked:${VISCHECK}`, 200);
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, REVIEW)).body, { match: null });
  assert.equal(counts.get(`match-locked:${VISCHECK}:${ROM_XENA}`), undefined);
  calls.length = 0;
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, FAMILY)).body, { match: XENA_MATCH });
  assert.deepEqual((await get(`/match?sha1=${ROM_TILT}`, OUTSIDE)).body, { match: TILT_MATCH });
  assert.deepEqual((await get(`/match?sha1=${ROM_UNKNOWN}`, OUTSIDE)).body, { match: null });
  assert.deepEqual(calls, [], 'unlocked answers and misses never touch the cap');
});

test('add a game: a grown-ups-only game never matches for a child, inside or outside the pack', async () => {
  const KID: LibraryAccount = { id: madeAt('2026-03-01T15:00:00Z'), kadeLibraryAccess: 'family' };
  const KID_OUTSIDE: LibraryAccount = { id: madeAt('2026-10-03T15:00:00Z') };
  children = new Set([String(KID.id), String(KID_OUTSIDE.id)]);
  stockAccess();
  put('arcade/catalog.json', {
    ...ADD_CATALOG,
    games: ADD_CATALOG.games.map((game) => ({ ...game, grownUpsOnly: true })),
  });
  await mount();
  for (const who of [KID, KID_OUTSIDE]) {
    for (const sha1 of [ROM_XENA, ROM_TILT]) {
      const res = await get(`/match?sha1=${sha1}`, who);
      assert.equal(res.text, '{"match":null}', 'not even the locked shelf row');
    }
    assert.equal((await get(rel(XENA_MATCH.manifestPath), who)).status, who === KID ? 404 : 403);
  }
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, FAMILY)).body, { match: XENA_MATCH });
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, OUTSIDE)).body, { match: SHELF_MATCH });
  childCheckFails = true;
  assert.equal(
    (await get(`/match?sha1=${ROM_TILT}`, ADMIN)).text,
    '{"match":null}',
    'an account that cannot be read counts as a child',
  );
});

test("add a game: ?version= names only the game's own version or its access pack", async () => {
  stockAccess();
  put('arcade/family/xena/2026-10-19/pack.json', index(SHA_B, 500));
  await mount();
  for (const query of [
    '?version=..%2F..%2Fpublic%2Fkit%2F4.2.3-1',
    `?version=${XENA_ACCESS}&version=${XENA_ACCESS}`,
    '?version=',
    '?version=a..b',
  ]) {
    const res = await get(`/games/xena/manifest${query}`, FAMILY);
    assert.equal(res.status, 404, query);
    assert.equal(res.body.error, 'That pack is not ready yet.');
  }
  /* A well-formed version that is neither: most likely a stored manifestPath whose access pack
   * was replaced. Its own answer, so the phone asks /match again instead of waiting forever. */
  for (const query of [
    '?version=2026-10-19',
    '?version=1.0.0-access',
    '?version=2026-10-19a-access',
  ]) {
    const res = await get(`/games/xena/manifest${query}`, FAMILY);
    assert.equal(res.status, 404, query);
    assert.equal(res.body.error, 'That accessibility pack has changed. Check the game again.');
  }
  for (const who of [OUTSIDE, REVIEW]) {
    const gate = await get('/games/xena/manifest?version=2026-10-19', who);
    assert.equal(gate.status, 403, 'the family gate comes first');
    assert.equal(gate.body.error, FAMILY_PACK_ARCADE_REFUSAL);
  }
  assert.ok(!loads.includes('arcade/family/xena/2026-10-19/pack.json'));
  /* An uploaded older version still signs (a resumed download can finish). */
  assert.equal((await get('/games/xena/2026-10-19/pack', FAMILY)).status, 200);

  /* Listed before its access pack is uploaded: ready false, nothing to install. */
  objects.delete(`arcade/family/xena/${XENA_ACCESS}/pack.json`);
  await mount();
  const early = await get(rel(XENA_MATCH.manifestPath), FAMILY);
  assert.equal(early.body.ready, false);
  assert.deepEqual(early.body.packs, []);
  assert.equal(early.body.romPath, undefined);
  assert.equal((await get(rel(XENA_MATCH.signPath), FAMILY)).status, 404);

  /* An unsafe romPath makes the access pack unusable. */
  put(`arcade/family/xena/${XENA_ACCESS}/pack.json`, {
    ...accessIndex(SHA_XA, 46000123, 'games/xena/local/rom.z64'),
    romPath: '../../rom.z64',
  });
  await mount();
  assert.equal((await get(rel(XENA_MATCH.manifestPath), FAMILY)).body.ready, false);
  assert.equal((await get(rel(XENA_MATCH.signPath), FAMILY)).status, 404);
  assert.equal(signs.length, 1);
  keysAreSafe();
});

test("add a game: a pack under the accessVersion must be an access pack, and the game's own version must not be one", async () => {
  const romPath = 'games/xena/local/rom.z64';
  const noRom = index(SHA_XA, 46000123, 'games/xena/play.html');
  const withRom = {
    ...noRom,
    files: [
      { path: 'games/xena/play.html', offset: 0, length: 12 },
      { path: romPath, offset: 12, length: 12 },
    ],
  };
  const notAccess: Array<[string, unknown]> = [
    /* An accessVersion naming an older full upload: the ROM is in it. */
    ['a full pack', { ...withRom, romPath, accessOnly: false }],
    ['a full pack that claims accessOnly', { ...withRom, romPath, accessOnly: true }],
    ['a pack from before accessOnly', { ...noRom, romPath }],
    ['accessOnly not exactly true', { ...noRom, romPath, accessOnly: 'true' }],
    ['no romPath', { ...noRom, accessOnly: true }],
    /* The phone would put the person's ROM over a kit file or another game's. */
    ['romPath on a kit file', { ...noRom, romPath: 'core/app.js', accessOnly: true }],
    ['romPath on EmulatorJS', { ...noRom, romPath: 'emulatorjs/loader.js', accessOnly: true }],
    [
      "romPath in another game's folder",
      { ...noRom, romPath: 'games/super-tilt-bro/local/rom.nes', accessOnly: true },
    ],
    [
      'romPath in a look-alike folder',
      { ...noRom, romPath: 'games/xenax/rom.z64', accessOnly: true },
    ],
    ['romPath on the games folder itself', { ...noRom, romPath: 'games/xena', accessOnly: true }],
  ];
  for (const [what, pack] of notAccess) {
    stockAccess();
    put(`arcade/family/xena/${XENA_ACCESS}/pack.json`, pack);
    logs = [];
    signs = [];
    await mount();
    const res = await get(rel(XENA_MATCH.manifestPath), FAMILY);
    assert.equal(res.status, 200, what);
    assert.equal(res.body.ready, false, what);
    assert.deepEqual(res.body.packs, [], what);
    assert.equal(res.body.romPath, undefined, what);
    assert.equal((await get(rel(XENA_MATCH.signPath), FAMILY)).status, 404, what);
    assert.equal(signs.length, 0, what);
    assert.ok(
      logs.some((line) =>
        line.startsWith(`arcade/family/xena/${XENA_ACCESS}/pack.json is not an access pack`),
      ),
      what,
    );
    assert.equal(
      (await get('/games/xena/manifest', FAMILY)).body.ready,
      true,
      'the shelf plays on',
    );
  }

  /* The game's own version naming an access pack: the shelf would install a game with no ROM. */
  stockAccess();
  put('arcade/family/xena/2026-10-20a/pack.json', accessIndex(SHA_A, 47000123, romPath));
  logs = [];
  await mount();
  const plain = await get('/games/xena/manifest', FAMILY);
  assert.equal(plain.body.ready, false);
  assert.deepEqual(plain.body.packs, []);
  assert.equal((await get('/games/xena/2026-10-20a/pack', FAMILY)).status, 404);
  assert.ok(
    logs.some((line) => /2026-10-20a\/pack\.json is an access pack \(no ROM\)/.test(line)),
    logs.join('\n'),
  );
  assert.equal((await get(rel(XENA_MATCH.manifestPath), FAMILY)).body.ready, true);

  /* Any other uploaded version is read as is, so a resumed download of a replaced pack finishes. */
  put('arcade/family/xena/2026-10-19-access/pack.json', accessIndex(SHA_B, 500, romPath));
  assert.equal((await get('/games/xena/2026-10-19-access/pack', FAMILY)).status, 200);
});

test("add a game: the access pack's blob must be the catalog's accessSize and accessSha256", async () => {
  /* /match advertises the catalog's accessSize and accessSha256 while the manifest and the link
   * serve pack.json's blob, so a catalog edited by hand must never show one pack and serve
   * another. The real packs agree (make_catalog.py copies blob.bytes and blob.sha256). */
  const romPath = 'games/xena/local/rom.z64';
  const key = `arcade/family/xena/${XENA_ACCESS}/pack.json`;
  const mismatched: Array<[string, unknown]> = [
    ['another size', accessIndex(SHA_XA, 46000124, romPath)],
    ['another sha256', accessIndex(SHA_A, 46000123, romPath)],
    [
      'blob.size (which wins over blob.bytes) is another size',
      {
        ...accessIndex(SHA_XA, 46000123, romPath),
        blob: { file: 'blob.bin', bytes: 46000123, size: 46000999, sha256: SHA_XA },
      },
    ],
  ];
  for (const [what, pack] of mismatched) {
    stockAccess();
    put(key, pack);
    logs = [];
    signs = [];
    await mount();
    assert.deepEqual(
      (await get(`/match?sha1=${ROM_XENA}`, FAMILY)).body,
      { match: XENA_MATCH },
      `${what}: /match reads only the catalog`,
    );
    const res = await get(rel(XENA_MATCH.manifestPath), FAMILY);
    assert.equal(res.status, 200, what);
    assert.equal(res.body.ready, false, what);
    assert.deepEqual(res.body.packs, [], what);
    assert.equal(res.body.romPath, undefined, what);
    assert.equal((await get(rel(XENA_MATCH.signPath), FAMILY)).status, 404, what);
    assert.equal(signs.length, 0, what);
    assert.ok(
      logs.some((line) => line.startsWith(`${key} does not match the catalog`)),
      `${what}: ${logs.join('\n')}`,
    );
    assert.equal(
      (await get('/games/xena/manifest', FAMILY)).body.ready,
      true,
      'the shelf plays on',
    );
  }

  /* Matching again: ready, and the manifest and link serve what /match advertised. */
  stockAccess();
  logs = [];
  await mount();
  const ok = await get(rel(XENA_MATCH.manifestPath), FAMILY);
  assert.equal(ok.body.ready, true);
  const pack = (ok.body.packs as Body[])[1] as Body;
  assert.equal(pack.size, XENA_MATCH.size);
  assert.equal(pack.sha256, XENA_MATCH.sha256);
  const link = await get(rel(XENA_MATCH.signPath), FAMILY);
  assert.equal(link.status, 200);
  assert.equal(link.body.size, XENA_MATCH.size);
  assert.equal(link.body.sha256, XENA_MATCH.sha256);
  assert.ok(!logs.some((line) => line.includes('does not match the catalog')), logs.join('\n'));
});

test('add a game: catalog romSha1 and access pack fields are checked one by one', () => {
  const lines: string[] = [];
  const row = { title: 'T', version: '1', access: 'public' };
  const parsed = parseArcadeCatalog(
    {
      games: [
        {
          ...row,
          id: 'a',
          romSha1: ROM_XENA,
          accessVersion: '1-access',
          accessSize: 5,
          accessSha256: SHA_A,
        },
        {
          ...row,
          id: 'b',
          romSha1: ROM_XENA,
          accessVersion: '1-access',
          accessSize: 6,
          accessSha256: SHA_B,
        },
        { ...row, id: 'c', romSha1: ROM_TILT.toUpperCase() },
        { ...row, id: 'd', romSha1: ROM_TILT.slice(1) },
        { ...row, id: 'e', romSha1: 7 },
        { ...row, id: 'f', accessVersion: '1', accessSize: 5, accessSha256: SHA_A },
        { ...row, id: 'g', accessVersion: '../x', accessSize: 5, accessSha256: SHA_A },
        { ...row, id: 'h', accessVersion: '2', accessSize: -1, accessSha256: 'nope' },
        { ...row, id: 'i', accessSize: 5, accessSha256: SHA_A },
        { ...row, id: 'j', accessVersion: '2', accessSha256: SHA_A },
        { ...row, id: 'k', accessVersion: '2', accessSize: 0, accessSha256: SHA_A },
        { ...row, id: 'l', accessVersion: '2', accessSize: 5.5, accessSha256: SHA_A },
        { ...row, id: 'm', accessVersion: '2', accessSize: 5, accessSha256: SHA_A.toUpperCase() },
        { ...row, id: 'n', accessVersion: '2', accessSize: 5 },
        /* A ROM with no access pack never blocks a later row that has one. */
        { ...row, id: 'o', romSha1: ROM_TILT },
        {
          ...row,
          id: 'p',
          romSha1: ROM_TILT,
          accessVersion: '1-access',
          accessSize: 7,
          accessSha256: SHA_K,
        },
        { ...row, id: 'q', romSha1: ROM_TILT },
      ],
    },
    (message) => lines.push(message),
  );
  const base = { title: 'T', console: '', access: 'public', version: '1', size: 0 };
  assert.deepEqual(parsed.games, [
    {
      ...base,
      id: 'a',
      romSha1: ROM_XENA,
      accessVersion: '1-access',
      accessSize: 5,
      accessSha256: SHA_A,
    },
    { ...base, id: 'b', accessVersion: '1-access', accessSize: 6, accessSha256: SHA_B },
    { ...base, id: 'c' },
    { ...base, id: 'd' },
    { ...base, id: 'e' },
    { ...base, id: 'f' },
    { ...base, id: 'g' },
    { ...base, id: 'h' },
    { ...base, id: 'i' },
    { ...base, id: 'j' },
    { ...base, id: 'k' },
    { ...base, id: 'l' },
    { ...base, id: 'm' },
    { ...base, id: 'n' },
    { ...base, id: 'o', romSha1: ROM_TILT },
    {
      ...base,
      id: 'p',
      romSha1: ROM_TILT,
      accessVersion: '1-access',
      accessSize: 7,
      accessSha256: SHA_K,
    },
    { ...base, id: 'q', romSha1: ROM_TILT },
  ]);
  const VERSION = "accessVersion must be a version of its own, not the game's";
  const SIZE = 'accessSize must be a whole number of bytes above 0';
  const HASH = 'accessSha256 must be 64 lower-case hex digits';
  assert.deepEqual(lines, [
    'catalog row 1 (b): romSha1 was dropped: an earlier game has that ROM',
    'catalog row 2 (c): romSha1 was dropped: it must be 40 lower-case hex digits',
    'catalog row 3 (d): romSha1 was dropped: it must be 40 lower-case hex digits',
    'catalog row 4 (e): romSha1 was dropped: it must be 40 lower-case hex digits',
    `catalog row 5 (f): the access pack was dropped: ${VERSION}`,
    `catalog row 6 (g): the access pack was dropped: ${VERSION}`,
    `catalog row 7 (h): the access pack was dropped: ${SIZE}; ${HASH}`,
    'catalog row 8 (i): the access pack was dropped: accessVersion is missing',
    `catalog row 9 (j): the access pack was dropped: ${SIZE}`,
    `catalog row 10 (k): the access pack was dropped: ${SIZE}`,
    `catalog row 11 (l): the access pack was dropped: ${SIZE}`,
    `catalog row 12 (m): the access pack was dropped: ${HASH}`,
    `catalog row 13 (n): the access pack was dropped: ${HASH}`,
  ]);
});

test('add a game: a ROM listed first with no access pack never blocks the row that has one', async () => {
  stockAccess();
  put('arcade/catalog.json', {
    ...ADD_CATALOG,
    games: [
      {
        id: 'tilt-notes',
        title: 'Notes',
        console: 'NES',
        access: 'public',
        version: '1',
        romSha1: ROM_TILT,
      },
      /* Half an access pack (no sha256): dropped whole, so it cannot claim the ROM either. */
      {
        id: 'tilt-half',
        title: 'Half',
        console: 'NES',
        access: 'public',
        version: '1',
        romSha1: ROM_TILT,
        accessVersion: '1-access',
        accessSize: 5,
      },
      ...ADD_CATALOG.games,
    ],
  });
  await mount();
  assert.deepEqual((await get(`/match?sha1=${ROM_TILT}`, OUTSIDE)).body, { match: TILT_MATCH });
  assert.ok(
    logs.some((line) => /\(tilt-half\): the access pack was dropped: accessSha256/.test(line)),
  );
  assert.ok(!logs.some((line) => /super-tilt-bro\): romSha1 was dropped/.test(line)));
});

test("add a game: the kit's real access pack.json (make_pack.py --access-only) matches, installs and signs", async () => {
  const ACCESS_VER = `${GAME_VER}-access`;
  const ACCESS_ROWS = packRows(
    GAME_ROWS.filter((row) => row.path !== 'games/xena/local/rom.z64').map(
      (row): [string, number, string] => [row.path, row.length, row.type],
    ),
  );
  const ACCESS_SHA = `5a17c0de${'3'.repeat(56)}`;
  const ACCESS_PACK = {
    ...GAME_PACK,
    version: ACCESS_VER,
    romPath: 'games/xena/local/rom.z64',
    romSha1: ROM_XENA,
    accessOnly: true,
    files: ACCESS_ROWS,
    blob: { file: 'blob.bin', bytes: blobBytes(ACCESS_ROWS), sha256: ACCESS_SHA },
  };
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
        romSha1: ACCESS_PACK.romSha1,
        accessVersion: ACCESS_PACK.version,
        accessSize: ACCESS_PACK.blob.bytes,
        accessSha256: ACCESS_PACK.blob.sha256,
      },
    ],
  });
  objects.set(`arcade/public/kit/${KIT_VER}/pack.json`, packJson(KIT_PACK));
  objects.set(`arcade/family/xena/${GAME_VER}/pack.json`, packJson(GAME_PACK));
  objects.set(`arcade/family/xena/${ACCESS_VER}/pack.json`, packJson(ACCESS_PACK));
  await mount();

  const res = await get(`/match?sha1=${ROM_XENA}`, FAMILY);
  assert.deepEqual(res.body, {
    match: {
      id: 'xena',
      title: 'Xena Warrior Princess',
      console: 'N64',
      access: 'family',
      version: ACCESS_VER,
      size: blobBytes(ACCESS_ROWS),
      sha256: ACCESS_SHA,
      locked: false,
      manifestPath: `/api/kade/arcade/games/xena/manifest?version=${ACCESS_VER}`,
      signPath: `/api/kade/arcade/games/xena/${ACCESS_VER}/pack`,
    },
  });
  const match = res.body.match as Body;
  const manifest = await get(rel(match.manifestPath), FAMILY);
  assert.deepEqual(manifest.body, {
    id: 'xena',
    title: 'Xena Warrior Princess',
    console: 'N64',
    access: 'family',
    version: ACCESS_VER,
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
        version: ACCESS_VER,
        size: blobBytes(ACCESS_ROWS),
        sha256: ACCESS_SHA,
        signPath: match.signPath,
        files: served(ACCESS_ROWS),
      },
    ],
    entry: 'games/xena/play.html',
    emulatorData: 'emulatorjs/',
    romPath: 'games/xena/local/rom.z64',
  });
  const files = (manifest.body.packs as Body[]).flatMap((pack) => pack.files as Body[]);
  assert.ok(!files.some((file) => file.path === 'games/xena/local/rom.z64'), 'no ROM in the pack');
  assert.doesNotMatch(manifest.text, new RegExp(`${ROM_XENA}|Talisman|needsKit|accessOnly`));
  /* The full pack names the same romPath (make_pack.py writes it into every game pack); its
   * plain manifest, the family shelf's download with the ROM inside, never passes it on. */
  const full = await get('/games/xena/manifest', FAMILY);
  assert.equal(full.body.ready, true);
  assert.equal(((full.body.packs as Body[])[1] as Body).version, GAME_VER);
  assert.equal(full.body.romPath, undefined);
  assert.deepEqual(logs, [], 'no pack or catalog field was refused');

  const signed = await get(rel(match.signPath), FAMILY);
  assert.equal(signed.status, 200);
  assert.equal(signed.body.sha256, match.sha256);
  assert.equal(signed.body.size, match.size);
  assert.deepEqual(
    signs.map((s) => s.key),
    [`arcade/family/xena/${ACCESS_VER}/blob.bin`],
  );
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, REVIEW)).body, { match: SHELF_MATCH });
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
    const res = await get(path, FAMILY);
    assert.equal(res.status, 429, path);
    assert.equal(
      res.body.error,
      'That is a lot of arcade requests at once. Try again in a minute.',
    );
  }
  assert.equal(
    (await get(`/match?sha1=${'0'.repeat(40)}`, FAMILY)).status,
    200,
    '/match has a bucket of its own',
  );
  assert.equal((await get('/config', FAMILY)).status, 200, '/config reads only the cached catalog');
  assert.equal((await get('/kit/4.2.3-1/pack', OUTSIDE)).status, 200, 'another account is fine');
  clock += 61 * 1000;
  assert.equal((await get('/kit/4.2.3-1/pack', FAMILY)).status, 200, 'the minute passes');
});

test('adding a pile of ROMs never blocks a download: /match has its own limit of 60 a minute', async () => {
  stockAccess();
  await mount();
  for (let i = 0; i < 60; i++) {
    const sha1 = i.toString(16).padStart(40, '0');
    assert.equal((await get(`/match?sha1=${sha1}`, FAMILY)).status, 200, `match ${i}`);
  }
  const limited = await get(`/match?sha1=${ROM_XENA}`, FAMILY);
  assert.equal(limited.status, 429);
  assert.equal(limited.cache, 'no-store');
  assert.equal(
    limited.body.error,
    'That is a lot of games to check at once. The rest will be checked in a minute.',
  );
  assert.equal(limited.body.match, undefined, 'a 429 is "ask again", never "no pack"');
  /* The person picks "Download the accessibility pack" for a game that did match. */
  const manifest = await get(rel(XENA_MATCH.manifestPath), FAMILY);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.ready, true);
  assert.equal((await get(rel(XENA_MATCH.signPath), FAMILY)).status, 200);
  assert.equal((await get(`/match?sha1=${ROM_XENA}`, OUTSIDE)).status, 200, 'per account');
  clock += 61 * 1000;
  assert.deepEqual((await get(`/match?sha1=${ROM_XENA}`, FAMILY)).body, { match: XENA_MATCH });
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

test("arcadeDiagRow keeps every core the kit's telemetry names, the plain player's included", () => {
  /* core/telemetry.js reports the page's core: mupen64plus_next for N64 packs, and the plain
   * player's fceumm (NES), gambatte (Game Boy, Game Boy Color) or mgba (Game Boy Advance). */
  for (const core of ['mupen64plus_next', 'parallel_n64', 'fceumm', 'gambatte', 'mgba']) {
    const row = arcadeDiagRow('u1', { kind: 'telemetry', stats: { core, fps: 60 } }, new Date(0));
    assert.deepEqual(row?.stats, { core, fps: 60 }, core);
  }
  for (const core of ['MGBA', 'snes9x', 'mgba ', 'gambatte-legacy']) {
    const row = arcadeDiagRow('u1', { kind: 'telemetry', stats: { core, fps: 60 } }, new Date(0));
    assert.deepEqual(row?.stats, { fps: 60 }, `${core} is dropped, the rest of the row kept`);
  }
});
