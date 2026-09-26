/* The Family feature pack (Part 293, Sep 25 2026): one helper on the Library's family
 * permission, and the per-feature map every client reads.
 * Run from the repo root:
 * node --import <tsx esm loader> --test packages/api/src/family/pack.test.ts */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { FAMILY_LIBRARY_CUTOFF, familyLibraryMember, libraryReviewSeat } from '../library/access';
import type { LibraryAccount } from '../library/access';
import {
  FAMILY_PACK_NAME,
  FAMILY_PACK_NOTE,
  FAMILY_PACK_REFUSAL,
  familyFeatures,
  familyFeaturesRouter,
  familyFeaturesView,
  familyPack,
  familyPackLinksGated,
} from './pack';

const KADE = '6a3cba4d0b0afa92194e42f7';
const AMBER_A = '6a5fc5fa351af41332734161';
const VISCHECK = '6a6125d73939d20b95251078'; // App Review and screenshots
const EVALCLEAN = '6a572e3be680dcdaadca0f04'; // a test seat
const EARLY = '6a3f47e79be0146175d0e3e7';
/** An ObjectId made at this moment, the way the cutoff reads an account's age. */
const madeAt = (iso: string) =>
  Math.floor(Date.parse(iso) / 1000).toString(16).padStart(8, '0') + '0000000000000000';
const BOB = madeAt('2026-10-02T15:00:00Z'); // "bob down the fictional street", after the cutoff

const OFF: NodeJS.ProcessEnv = {};
const ON: NodeJS.ProcessEnv = { KADE_FAMILY_PACK_LINKS: '1' };

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

type Row = { who: string; user: LibraryAccount | null; pack: boolean };
const table: Row[] = [
  { who: 'an admin', user: { id: BOB, role: 'ADMIN' }, pack: true },
  { who: 'an admin Kade set to none', user: { id: KADE, role: 'ADMIN', kadeLibraryAccess: 'none' }, pack: true },
  { who: 'the App Review seat', user: { id: VISCHECK }, pack: false },
  { who: 'the App Review seat even when granted', user: { id: VISCHECK, kadeLibraryAccess: 'family' }, pack: false },
  { who: 'the App Review seat by email', user: { id: AMBER_A, email: 'kadeai.vischeck722@gmail.com' }, pack: false },
  { who: 'a test seat', user: { id: EVALCLEAN }, pack: false },
  { who: 'a test seat Kade granted', user: { id: EVALCLEAN, kadeLibraryAccess: 'family' }, pack: true },
  { who: 'Test Guest by name', user: { id: EARLY, name: 'Test Guest' }, pack: false },
  { who: 'a family account from before the cutoff', user: { id: AMBER_A }, pack: true },
  { who: 'an account made at the cutoff', user: { id: madeAt(FAMILY_LIBRARY_CUTOFF) }, pack: true },
  { who: 'a family account Kade turned off', user: { id: AMBER_A, kadeLibraryAccess: 'none' }, pack: false },
  { who: 'bob, made after the cutoff', user: { id: BOB }, pack: false },
  { who: 'bob after Kade said yes', user: { id: BOB, kadeLibraryAccess: 'family' }, pack: true },
  { who: 'an account with no readable id', user: { id: 'not-an-id' }, pack: false },
  { who: 'nobody signed in', user: null, pack: false },
];

test('truth table: the pack is exactly the Library family permission', () => {
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined, NOTIFY_TEST_USER_IDS: undefined, KADE_APP_REVIEW_USER_IDS: undefined }, () => {
    for (const row of table) {
      assert.equal(familyPack(row.user), row.pack, row.who);
      assert.equal(familyPack(row.user), familyLibraryMember(row.user), `${row.who}: not a fork of the rule`);
    }
  });
});

test('truth table: media links and the family library follow the pack whatever the switch says', () => {
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined, NOTIFY_TEST_USER_IDS: undefined, KADE_APP_REVIEW_USER_IDS: undefined }, () => {
    for (const env of [OFF, ON]) {
      for (const row of table) {
        const map = familyFeatures(row.user, env);
        assert.equal(map.mediaLinks, row.pack, `${row.who} mediaLinks`);
        assert.equal(map.familyLibrary, row.pack, `${row.who} familyLibrary`);
      }
    }
  });
});

test('truth table: describer and jukebox links join the pack only when KADE_FAMILY_PACK_LINKS is exactly 1', () => {
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined, NOTIFY_TEST_USER_IDS: undefined, KADE_APP_REVIEW_USER_IDS: undefined }, () => {
    for (const row of table) {
      const off = familyFeatures(row.user, OFF);
      const on = familyFeatures(row.user, ON);
      const signedIn = row.user !== null;
      assert.equal(off.describerLinks, signedIn, `${row.who}: switch off, everyone signed in keeps describer links`);
      assert.equal(off.jukeboxLinks, signedIn, `${row.who}: switch off, everyone signed in keeps jukebox links`);
      assert.equal(on.describerLinks, row.pack, `${row.who}: switch on, describer links are the pack's`);
      assert.equal(on.jukeboxLinks, row.pack, `${row.who}: switch on, jukebox links are the pack's`);
    }
    for (const value of ['', '0', 'true', 'yes', ' 1', 'on']) {
      assert.equal(familyPackLinksGated({ KADE_FAMILY_PACK_LINKS: value }), false, JSON.stringify(value));
    }
    assert.equal(familyPackLinksGated(ON), true);
    assert.equal(familyPackLinksGated(OFF), false);
  });
});

test('a second App Review or demo seat listed only in KADE_APP_REVIEW_USER_IDS never gets the pack, even made before the cutoff', () => {
  const base = { KADE_LIBRARY_HIDDEN_FROM: undefined, NOTIFY_TEST_USER_IDS: undefined };
  withEnv({ ...base, KADE_APP_REVIEW_USER_IDS: undefined }, () => {
    assert.equal(familyPack({ id: EARLY }), true, 'unlisted, this early account is family');
  });
  /* The list kadeFunding.isReviewSeat reads: split on commas, trimmed, any case. */
  withEnv({ ...base, KADE_APP_REVIEW_USER_IDS: ` ${VISCHECK} ,${EARLY.toUpperCase()} ` }, () => {
    for (const user of [{ id: EARLY }, { id: EARLY, kadeLibraryAccess: 'family' }, { _id: { toString: () => EARLY } }]) {
      assert.equal(libraryReviewSeat(user), true, 'one rule for the Library and the pack');
      assert.equal(familyPack(user), false, 'no pack, not even when granted');
      assert.equal(familyLibraryMember(user), false, 'and no family shelves');
      for (const env of [OFF, ON]) assert.equal(familyFeatures(user, env).mediaLinks, false, 'the downloader stays shut');
    }
    assert.deepEqual(familyFeatures({ id: EARLY }, ON), { mediaLinks: false, describerLinks: false, jukeboxLinks: false, familyLibrary: false });
    assert.equal(familyPack({ id: VISCHECK }), false);
    assert.equal(familyPack({ id: AMBER_A }), true, 'everyone else is unchanged');
    assert.equal(familyPack({ id: BOB, role: 'ADMIN' }), true);
  });
});

test('the map has one boolean per feature, and the view names the pack in plain words', () => {
  const map = familyFeatures({ id: AMBER_A }, OFF);
  assert.deepEqual(Object.keys(map).sort(), ['describerLinks', 'familyLibrary', 'jukeboxLinks', 'mediaLinks']);
  for (const value of Object.values(map)) assert.equal(typeof value, 'boolean');
  assert.equal(FAMILY_PACK_NAME, 'Family feature pack');
  assert.equal(FAMILY_PACK_NOTE, 'Part of the Family feature pack');
  assert.equal(FAMILY_PACK_REFUSAL, 'Media links are part of the Family feature pack. Ask Kade to add it to your account.');
  assert.deepEqual(familyFeaturesView({ id: BOB }, ON), {
    familyPack: false,
    name: FAMILY_PACK_NAME,
    note: FAMILY_PACK_NOTE,
    refusal: FAMILY_PACK_REFUSAL,
    features: { mediaLinks: false, describerLinks: false, jukeboxLinks: false, familyLibrary: false },
  });
});

/* ── GET /api/kade/features ─────────────────────────────────────────── */
let server: Server;
let base = '';
let signedIn: LibraryAccount | null = null;
before(async () => {
  const app = express();
  app.use(
    '/api/kade/features',
    familyFeaturesRouter((req, res, next) => {
      if (!signedIn) {
        res.status(401).json({ error: 'Sign in first.' });
        return;
      }
      (req as { user?: LibraryAccount }).user = signedIn;
      next();
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('GET /api/kade/features answers the signed-in person, fresh every time, and refuses nobody signed in', async () => {
  const saved = process.env.KADE_FAMILY_PACK_LINKS;
  try {
    delete process.env.KADE_FAMILY_PACK_LINKS;
    signedIn = null;
    assert.equal((await fetch(`${base}/api/kade/features`)).status, 401, 'requireJwtAuth runs first');

    signedIn = { id: AMBER_A };
    let res = await fetch(`${base}/api/kade/features`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), familyFeaturesView({ id: AMBER_A }));

    signedIn = { id: BOB };
    process.env.KADE_FAMILY_PACK_LINKS = '1';
    res = await fetch(`${base}/api/kade/features`);
    const body = (await res.json()) as { familyPack: boolean; features: Record<string, boolean> };
    assert.equal(body.familyPack, false);
    assert.deepEqual(body.features, { mediaLinks: false, describerLinks: false, jukeboxLinks: false, familyLibrary: false });
  } finally {
    if (saved === undefined) delete process.env.KADE_FAMILY_PACK_LINKS;
    else process.env.KADE_FAMILY_PACK_LINKS = saved;
  }
});
