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
import type { FamilyToolCall } from './tool';
import { familyRouterCall, readFamilyHistoryTool } from './tool';
import { familySensitiveReader } from './history';

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
  revoked: { id: id(11), kadeLibraryAccess: 'none' },
  denied: { id: id(12), kadeLibraryAccess: 'family', kadeFamilyHistory: 'none' },
  extraGuest: { id: id(9), kadeFamilyTreePerson: '@I300@' },
  otherGuest: { id: id(10), kadeFamilyHistory: 'guest' },
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
  toolCall: (who: string) => FamilyToolCall;
}> {
  let definitions = initial;
  const reads: string[] = [];
  const writes: string[] = [];
  const objects = new Map<string, Buffer>();
  const second = JSON.parse(JSON.stringify(BUNDLE)) as FamilyBundle;
  second.people['@I100@'].name = 'Aster Sample';
  second.people['@I100@'].label = 'Aster Sample';
  second.media['m-tree1'].source = {
    kind: 'member-image',
    title: 'Invented caption',
    citation: 'Example source, page 1.',
    url: 'https://example.invalid/source/1',
  };
  second.media['m-tree1'].evidenceWarning =
    'Identity review: the caption is an unverified identification.';
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
  const router = familyHistoryArchivesRouter(
    {
      auth: (req, res, next) => {
        const user =
          ACCOUNTS[String(req.headers['x-user'] || '')] ||
          (req as typeof req & { user?: FamilyHistoryAccount }).user;
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
  );
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    reads,
    writes,
    toolCall: (who) => {
      const call = familyRouterCall(router, ACCOUNTS[who]);
      // The test auth lane sees the same trusted actor; tool dispatch has no JWT headers.
      return call;
    },
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

test('explicit research notes stay attributed testimony, scoped to author and steward without changing facts', async () => {
  const h = await harness();
  const archive = `?archive=${DEFINITION.id}`;
  try {
    const saved = await h.call('/research-notes' + archive, 'second', {
      text: 'I remember a birthday picnic. This needs a source.',
      userRequestedSave: true,
      personId: '@I200@',
    });
    assert.equal(saved.status, 201);
    const note = saved.body.note as {
      author: { userId: string; personId: string };
      status: string;
      kind: string;
    };
    assert.equal(note.author.userId, id(3));
    assert.equal(note.author.personId, '@I100@');
    assert.equal(note.kind, 'unverified-recollection');
    assert.equal(note.status, 'needs-source-review');
    assert.equal(
      ((await h.call('/research-notes' + archive, 'second')).body.notes as unknown[]).length,
      1,
    );
    assert.equal(
      ((await h.call('/research-notes' + archive, 'owner')).body.notes as unknown[]).length,
      1,
    );
    assert.equal((await h.call('/research-notes' + archive, 'family')).status, 404);
    assert.equal((await h.call('/research-notes' + archive, 'extraGuest')).status, 403);
    assert.equal(((await h.call('/research-notes', 'owner')).body.notes as unknown[]).length, 0);
    assert.equal(((await h.call('/research-notes', 'family')).body.notes as unknown[]).length, 0);
    assert.ok(h.writes.every((key) => key.startsWith(DEFINITION.prefix + '/research-notes/')));
    const before = h.writes.length;
    for (const body of [
      { text: 'Unrequested old chat' },
      { text: 'Spoofed attribution', userRequestedSave: true, authorId: id(1) },
      { text: 'Not a sourced fact', userRequestedSave: true, status: 'verified' },
      { text: 'Unknown subject', userRequestedSave: true, personId: 'other-archive-person' },
    ])
      assert.equal((await h.call('/research-notes' + archive, 'second', body)).status, 400);
    assert.equal(h.writes.length, before);
    const steward = await h.call('/research-notes' + archive, 'owner', {
      text: 'New explicitly saved source lead.',
      userRequestedSave: true,
    });
    assert.equal(steward.status, 201);
    assert.equal(
      (steward.body.note as { author: { personId: string | null } }).author.personId,
      null,
    );
    assert.equal(
      ((await h.call('/research-notes' + archive, 'second')).body.notes as unknown[]).length,
      1,
    );
    assert.equal(
      ((await h.call('/research-notes' + archive, 'owner')).body.notes as unknown[]).length,
      2,
    );
    h.set([{ ...DEFINITION, members: [{ userId: id(3), personId: '@I300@' }] }]);
    const fallback = await h.call('/research-notes' + archive, 'second', {
      text: 'Explicit note from a matched person whose view is missing.',
      userRequestedSave: true,
    });
    assert.equal(fallback.status, 201);
    assert.equal(
      (fallback.body.note as { author: { personId: string | null } }).author.personId,
      '@I300@',
    );
    h.set([]);
    assert.equal((await h.call('/research-notes' + archive, 'second')).status, 404);
  } finally {
    await h.close();
  }
});

test('family tools use actual archive permissions, source warnings and account perspective; 201 is a successful save', async () => {
  const h = await harness();
  try {
    const call = h.toolCall('second');
    const discovered = (await readFamilyHistoryTool({ action: 'archives' }, call)) as {
      archives: { id: string }[];
    };
    assert.deepEqual(
      discovered.archives.map((entry) => entry.id),
      [DEFINITION.id],
    );
    const result = (await readFamilyHistoryTool(
      { action: 'person', person_id: '@I100@' },
      call,
    )) as { archive: string; result: unknown; accountContext: { viewer: { inTree: boolean } } };
    assert.equal(result.archive, DEFINITION.id);
    assert.equal(result.accountContext.viewer.inTree, true);
    assert.ok(result.result);
    const image = (await readFamilyHistoryTool({ action: 'media', media_id: 'm-tree1' }, call)) as {
      result: { source: { citation: string }; evidenceWarning: string };
    };
    assert.equal(image.result.source.citation, 'Example source, page 1.');
    assert.match(image.result.evidenceWarning, /unverified identification/);
    const owner = (await readFamilyHistoryTool(
      { action: 'person', archive: DEFINITION.id, person_id: '@I100@' },
      h.toolCall('owner'),
    )) as typeof result;
    assert.equal(owner.accountContext.viewer.inTree, false);
    const save = (await readFamilyHistoryTool(
      {
        action: 'save_note',
        text: 'Please save this current recollection.',
        user_requested_save: true,
      },
      call,
    )) as { result?: { ok: boolean }; error?: unknown };
    assert.equal(save.result?.ok, true);
    assert.equal(save.error, undefined);
    const before = h.writes.length;
    assert.ok(
      (
        (await readFamilyHistoryTool({ action: 'save_note', text: 'Old chat' }, call)) as {
          error: unknown;
        }
      ).error,
    );
    assert.ok(
      (
        (await readFamilyHistoryTool(
          {
            action: 'save_note',
            archive: DEFINITION.id,
            text: 'Fake author',
            user_requested_save: true,
            authorId: id(1),
          },
          call,
        )) as { error: unknown }
      ).error,
    );
    assert.equal(h.writes.length, before);
    const wrong = (await readFamilyHistoryTool(
      { action: 'person', archive: 'default', person_id: '@I100@' },
      call,
    )) as { error: unknown };
    assert.ok(wrong.error);
    h.set([]);
    assert.ok(
      (
        (await readFamilyHistoryTool(
          { action: 'person', archive: DEFINITION.id, person_id: '@I100@' },
          call,
        )) as { error: unknown }
      ).error,
    );
  } finally {
    await h.close();
  }
});

test('an explicitly entitled default guest reads findings without becoming a tree person; other guests and archives do not inherit it', async () => {
  const h = await harness();
  try {
    delete process.env.KADE_FH_SENSITIVE_READERS;
    assert.equal((await h.call('/findings?v=2&group=mysteries', 'guest')).body.available, false);
    process.env.KADE_FH_SENSITIVE_READERS = JSON.stringify([id(4)]);
    const me = await h.call('/me', 'guest');
    assert.equal(me.body.mode, 'guest');
    assert.equal((me.body.viewer as { inTree: boolean }).inTree, false);
    assert.equal(me.body.sensitiveFindings, true);
    const findings = await h.call('/findings?v=2&group=mysteries', 'guest');
    assert.equal(findings.body.available, true);
    assert.ok((findings.body.findings as unknown[]).length > 0);
    assert.equal(
      (await h.call('/findings?v=2&group=mysteries', 'otherGuest')).body.available,
      false,
    );
    const pack = await h.call('/me', 'stranger');
    assert.equal(
      pack.status,
      200,
      'the Family pack grants ordinary guest reading of the default archive',
    );
    assert.equal(pack.body.mode, 'guest');
    assert.equal(pack.body.sensitiveFindings, false);
    assert.equal((pack.body.viewer as { inTree: boolean }).inTree, false);
    assert.equal((await h.call('/accounts', 'stranger')).status, 403);
    assert.equal((await h.call('/findings?v=2&group=mysteries', 'stranger')).body.available, false);
    assert.equal((await h.call('/accounts', 'guest')).status, 403);
    assert.equal((await h.call('/research-notes', 'guest')).status, 403);
    h.set([{ ...DEFINITION, members: [...DEFINITION.members, { userId: id(4) }] }]);
    assert.equal(
      (await h.call(`/findings?v=2&group=mysteries&archive=${DEFINITION.id}`, 'guest')).body
        .available,
      false,
      'the default entitlement never carries to another archive',
    );
    const tool = (await readFamilyHistoryTool(
      { action: 'findings', archive: 'default' },
      h.toolCall('guest'),
    )) as { result: { researchFindings: { available: boolean; findings: unknown[] } } };
    assert.equal(tool.result.researchFindings.available, true);
    assert.ok(tool.result.researchFindings.findings.length);
    process.env.KADE_FH_SENSITIVE_READERS = '[]';
    assert.equal(
      (await h.call('/findings?v=2&group=mysteries', 'guest')).body.available,
      false,
      'revoked on the next request',
    );
    assert.equal(familySensitiveReader(ACCOUNTS.guest, '["invalid-id"]'), false);
    assert.equal(familySensitiveReader(ACCOUNTS.guest, JSON.stringify([id(4), 7])), false);
    assert.equal(familySensitiveReader(ACCOUNTS.guest, 'not-json'), false);
  } finally {
    delete process.env.KADE_FH_SENSITIVE_READERS;
    await h.close();
  }
});

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

test('pack guests lose default archive access on revocation and explicit history denials remain final', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('/me', 'stranger')).body.mode, 'guest');
    for (const who of ['revoked', 'denied', 'review', 'test']) {
      assert.equal((await h.call('/me', who)).status, 403);
      assert.equal((await h.call('/archives', who)).body.defaultArchive, null);
    }
    ACCOUNTS.stranger.kadeLibraryAccess = 'none';
    assert.equal((await h.call('/me', 'stranger')).status, 403);
    assert.equal((await h.call('/archives', 'stranger')).body.defaultArchive, null);
  } finally {
    ACCOUNTS.stranger.kadeLibraryAccess = 'family';
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
    assert.equal(
      (owner.body.viewer as { inTree: boolean }).inTree,
      false,
      'stewardship is not a tree identity',
    );
    assert.equal((owner.body.viewer as { relationToOwner: unknown }).relationToOwner, null);
    const home = (await h.call(`/home?archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((home.hero as { youAre: string }).youAre, 'You manage Aster’s family history.');
    assert.match((home.hero as { headline: string }).headline, /^Aster’s family/);
    const tree = (await h.call(`/tree?v=2&archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal(
      (tree.layout as { boxes: { you: boolean }[] }).boxes.some((box) => box.you),
      false,
    );
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
  const h = await harness([
    { ...DEFINITION, members: [...DEFINITION.members, { userId: id(1), personId: '@I100@' }] },
  ]);
  try {
    const me = (await h.call(`/me?archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((me.viewer as { inTree: boolean }).inTree, true);
    const home = (await h.call(`/home?archive=${DEFINITION.id}`, 'owner')).body;
    assert.equal((home.hero as { youAre: string }).youAre, 'This is your tree.');
  } finally {
    await h.close();
  }
});

test('a separate verified archive owner retains stewardship and only pack guest reading of the default archive', async () => {
  const before = process.env.KADE_FH_OWNER_USER_ID;
  process.env.KADE_FH_OWNER_USER_ID = id(99);
  const h = await harness();
  try {
    assert.equal((await h.call('/me', 'owner')).body.mode, 'guest');
    assert.deepEqual((await h.call('/archives', 'owner')).body, {
      archives: [
        { id: 'default', title: 'My family history' },
        { id: DEFINITION.id, title: DEFINITION.title },
      ],
      defaultArchive: 'default',
    });
    assert.equal((await h.call(`/me?archive=${DEFINITION.id}`, 'owner')).body.mode, 'owner');
  } finally {
    await h.close();
    if (before === undefined) delete process.env.KADE_FH_OWNER_USER_ID;
    else process.env.KADE_FH_OWNER_USER_ID = before;
  }
});
