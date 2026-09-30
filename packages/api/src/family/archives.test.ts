/* Invented archives and accounts only. Separate archives must never inherit the family pack. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { FamilyBundle, FamilyHistoryAccount } from './history';
import type { FamilyArchiveDefinition } from './archives';
import { familyArchiveDefinitions, familyHistoryArchivesRouter } from './archives';

const FIXTURES = join(__dirname, '__fixtures__', 'history');
const BUNDLE: FamilyBundle = JSON.parse(readFileSync(join(FIXTURES, 'bundle.json'), 'utf8'));
const OWNER_VIEW = readFileSync(join(FIXTURES, 'views', 'I100.json'));
const MEMBER_VIEW = readFileSync(join(FIXTURES, 'views', 'I200.json'));
const id = (n: number): string => n.toString(16).padStart(24, 'a');
const DEFINITION: FamilyArchiveDefinition = {
  id: 'example-tree',
  title: 'A second invented family',
  prefix: 'family-archives/example-tree',
  ownerUserId: id(1),
  members: [{ userId: id(3), personId: '@I100@' }, { userId: id(9) }],
};
const ACCOUNTS: Record<string, FamilyHistoryAccount> = {
  owner: { id: id(1), role: 'ADMIN', name: 'Owner Example' },
  family: { id: id(2), name: 'Matched Example', kadeFamilyTreePerson: '@I200@' },
  second: { id: id(3), name: 'Second Example' },
  guest: { id: id(4), kadeFamilyHistory: 'guest' },
  admin: { id: id(5), role: 'ADMIN' },
  review: { id: id(6), role: 'ADMIN' },
  test: { id: id(7), username: 'Test Guest' },
  stranger: { id: id(8), kadeLibraryAccess: 'family' },
  extraGuest: { id: id(9), kadeFamilyTreePerson: '@I300@' },
};
process.env.KADE_APP_REVIEW_USER_IDS = id(6);
delete process.env.KADE_FH_OWNER_USER_ID;

async function harness(initial: FamilyArchiveDefinition[] = [DEFINITION]): Promise<{
  call: (
    path: string,
    who: string,
    body?: Record<string, unknown>,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  set: (definitions: FamilyArchiveDefinition[]) => void;
  close: () => Promise<void>;
  reads: string[];
  writes: string[];
}> {
  let definitions = initial;
  const reads: string[] = [];
  const writes: string[] = [];
  const objects = new Map<string, Buffer>();
  const second = JSON.parse(JSON.stringify(BUNDLE)) as FamilyBundle;
  second.people['@I100@'].name = 'Aster Sample';
  second.people['@I100@'].label = 'Aster Sample';
  for (const [prefix, bundle] of [
    ['family-history', BUNDLE],
    [DEFINITION.prefix, second],
  ] as const) {
    objects.set(
      `${prefix}/current.json`,
      Buffer.from(JSON.stringify({ version: 'v1', anchors: ['@I100@', '@I200@'] })),
    );
    objects.set(`${prefix}/v1/bundle.json.gz`, gzipSync(JSON.stringify(bundle)));
    objects.set(`${prefix}/v1/views/I100.json.gz`, gzipSync(OWNER_VIEW));
    objects.set(`${prefix}/v1/views/I200.json.gz`, gzipSync(MEMBER_VIEW));
    objects.set(`${prefix}/media/m-tree1.s.aaaa0002.jpg`, Buffer.from(`Saved image for ${prefix}`));
  }
  const app = express();
  app.use(
    '/api',
    familyHistoryArchivesRouter(
      {
        auth: (req, res, next) => {
          const user = ACCOUNTS[String(req.headers['x-user'] || '')];
          if (!user) {
            res.status(401).json({ error: 'Sign in' });
            return;
          }
          Object.assign(req, { user });
          next();
        },
        loadObject: async (key) => {
          reads.push(key);
          return objects.get(key) || null;
        },
        signGet: async (key) => `https://example.invalid/${key}`,
        findUsers: async () => Object.values(ACCOUNTS),
        setUserFields: async () => {
          throw new Error('This test never grants access');
        },
        putObject: async (key, bytes) => {
          writes.push(key);
          objects.set(key, bytes);
        },
        listKeys: async (prefix) =>
          Array.from(objects.keys()).filter((key) => key.startsWith(prefix)),
        now: () => Date.parse('2026-03-05T12:00:00Z'),
      },
      { archives: () => definitions },
    ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    reads,
    writes,
    set: (value) => {
      definitions = value;
    },
    call: async (path, who, body) => {
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-user': who, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test('the private archive configuration rejects malformed identities and overlapping storage prefixes', () => {
  assert.deepEqual(familyArchiveDefinitions(undefined), []);
  assert.deepEqual(familyArchiveDefinitions(JSON.stringify([DEFINITION])), [DEFINITION]);
  for (const changed of [
    { id: 'default' },
    { id: '../tree' },
    { prefix: 'family-history/inbox' },
    { prefix: 'family-history' },
    { prefix: '../other' },
    { ownerUserId: 'guess-by-name' },
    { members: [{ userId: id(3), personId: '' }] },
    { members: [{ userId: 'Second Example' }] },
    { members: [{ userId: id(3) }, { userId: id(3) }] },
  ])
    assert.throws(() => familyArchiveDefinitions(JSON.stringify([{ ...DEFINITION, ...changed }])));
  assert.throws(() => familyArchiveDefinitions('not json'));
  assert.throws(() =>
    familyArchiveDefinitions(
      JSON.stringify([
        DEFINITION,
        { ...DEFINITION, id: 'another', prefix: DEFINITION.prefix + '/child' },
      ]),
    ),
  );
});

test('archive catalog exposes only authorized titles; default family, friends, admins and the pack do not inherit another tree', async () => {
  const h = await harness();
  try {
    assert.deepEqual((await h.call('/archives', 'owner')).body, {
      archives: [
        { id: 'default', title: 'My family history' },
        { id: DEFINITION.id, title: DEFINITION.title },
      ],
      defaultArchive: 'default',
    });
    assert.deepEqual((await h.call('/archives', 'second')).body, {
      archives: [{ id: DEFINITION.id, title: DEFINITION.title }],
      defaultArchive: DEFINITION.id,
    });
    for (const who of ['family', 'guest', 'admin', 'stranger', 'review', 'test']) {
      const catalog = (await h.call('/archives', who)).body;
      assert.equal(JSON.stringify(catalog).includes(DEFINITION.title), false, who);
      assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, who)).status, 404, who);
    }
    assert.equal(h.reads.length, 0, 'catalog and denied probes never read private bundles');
    assert.equal((await h.call('/me?archive=unknown', 'owner')).status, 404);
    assert.equal((await h.call('/me?archive[]=example-tree', 'owner')).status, 404);
  } finally {
    await h.close();
  }
});

test('same tree and media ids remain isolated by archive, with explicit bindings and original default behavior', async () => {
  const h = await harness();
  try {
    const original = await h.call('/me', 'owner');
    const explicitDefault = await h.call('/me?archive=default', 'owner');
    assert.deepEqual(explicitDefault, original);
    const second = await h.call(`/me?archive=${DEFINITION.id}`, 'second');
    assert.equal(second.status, 200);
    assert.equal((second.body.viewer as { name: string }).name, 'Aster Sample');
    assert.equal(second.body.mode, 'family');
    const owner = await h.call(`/me?archive=${DEFINITION.id}`, 'owner');
    assert.equal(owner.body.mode, 'owner');
    assert.equal((owner.body.viewer as { inTree: boolean }).inTree, false, 'stewardship is not a tree identity');
    assert.equal((owner.body.viewer as { relationToOwner: unknown }).relationToOwner, null);
    const home = (await h.call(`/home?archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((home.hero as { youAre: string }).youAre, 'You manage Aster’s family history.');
    assert.match((home.hero as { headline: string }).headline, /^Aster’s family/);
    const tree = (await h.call(`/tree?v=2&archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((tree.layout as { boxes: { you: boolean }[] }).boxes.some((box) => box.you), false);
    assert.equal((await h.call(`/dna?archive=${DEFINITION.id}`, 'owner')).body.test, null);
    const guest = await h.call(`/me?archive=${DEFINITION.id}`, 'extraGuest');
    assert.equal(
      guest.body.mode,
      'guest',
      'a default-tree match never becomes an extra-tree identity',
    );
    const a = await h.call('/media/m-tree1?size=t', 'owner');
    const b = await h.call(`/media/m-tree1?size=t&archive=${DEFINITION.id}`, 'owner');
    assert.match(String(a.body.url), /\/family-history\/media\//);
    assert.match(String(b.body.url), /\/family-archives\/example-tree\/media\//);
    assert.notEqual(a.body.url, b.body.url);
    assert.equal((await h.call(`/accounts?archive=${DEFINITION.id}`, 'owner')).status, 403);
    assert.equal((await h.call(`/ACCOUNTS?archive=${DEFINITION.id}`, 'owner')).status, 403);
    assert.equal(
      (
        await h.call(`/match?archive=${DEFINITION.id}`, 'owner', {
          userId: id(2),
          personId: '@I100@',
        })
      ).status,
      403,
    );
    assert.equal((await h.call(`/ask?archive=${DEFINITION.id}`, 'second', {})).status, 403);
    const note = await h.call(`/note?archive=${DEFINITION.id}`, 'second', {
      kind: 'memory',
      text: 'An invented memory for the second archive.',
    });
    assert.equal(note.status, 200);
    assert.ok(h.writes.every((key) => key.startsWith(DEFINITION.prefix + '/inbox/')));
    const defaultNotes = await h.call('/notes', 'owner');
    assert.deepEqual(defaultNotes.body, []);
    const scopedNotes = await h.call(`/notes?archive=${DEFINITION.id}`, 'owner');
    assert.equal((scopedNotes.body as unknown as unknown[]).length, 1);
  } finally {
    await h.close();
  }
});

test('membership revocation applies immediately and invalid catalog configuration fails closed without disabling the default', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'second')).status, 200);
    h.set([{ ...DEFINITION, members: [] }]);
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'second')).status, 404);
    assert.deepEqual((await h.call('/archives', 'second')).body, {
      archives: [],
      defaultArchive: null,
    });
    h.set([{ ...DEFINITION, prefix: 'family-history' }]);
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'owner')).status, 404);
    assert.equal((await h.call('/me', 'owner')).status, 200);
  } finally {
    await h.close();
  }
});

test('a non-admin owner configuration does not promote an account or implicitly grant it archive access', async () => {
  const h = await harness([{ ...DEFINITION, ownerUserId: id(3), members: [] }]);
  try {
    assert.deepEqual((await h.call('/archives', 'second')).body, {
      archives: [],
      defaultArchive: null,
    });
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'second')).status, 404);
    h.set([
      { ...DEFINITION, ownerUserId: id(3), members: [{ userId: id(3), personId: '@I100@' }] },
    ]);
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'second')).body.mode, 'family');
    assert.equal((await h.call(`/notes?archive=${DEFINITION.id}`, 'second')).status, 403);
  } finally {
    await h.close();
  }
});

test('a reviewed owner-to-person binding uses that tree identity without changing the default archive', async () => {
  const h = await harness([{ ...DEFINITION, members: [...DEFINITION.members, { userId: id(1), personId: '@I100@' }] }]);
  try {
    const me = (await h.call(`/me?archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((me.viewer as { inTree: boolean }).inTree, true);
    const home = (await h.call(`/home?archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((home.hero as { youAre: string }).youAre, 'This is your tree.');
  } finally { await h.close(); }
});

test('a separate verified archive owner does not need access to the default archive', async () => {
  const before = process.env.KADE_FH_OWNER_USER_ID;
  process.env.KADE_FH_OWNER_USER_ID = id(99);
  const h = await harness();
  try {
    assert.equal((await h.call('/me', 'owner')).status, 403);
    assert.deepEqual((await h.call('/archives', 'owner')).body, {
      archives: [{ id: DEFINITION.id, title: DEFINITION.title }],
      defaultArchive: DEFINITION.id,
    });
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'owner')).body.mode, 'owner');
  } finally {
    await h.close();
    if (before === undefined) delete process.env.KADE_FH_OWNER_USER_ID;
    else process.env.KADE_FH_OWNER_USER_ID = before;
  }
});
