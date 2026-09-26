/* Run from the repo root:
 * node --import <tsx esm loader> --test packages/api/src/library/access.test.ts */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  FAMILY_LIBRARY_CUTOFF,
  approveTrustedUploads,
  familyLibraryAccessNote,
  familyLibraryAccountView,
  familyLibraryEmptyGuidance,
  familyLibraryMember,
  libraryDigestText,
  libraryMembershipRouter,
  libraryReviewSeat,
  libraryTestSeat,
  ownUploadsOnlyNote,
  pendingLibraryDigest,
  trustedApprovalNote,
  trustedLibraryContributor,
} from './access';
import type {
  LibraryAccountRow,
  LibraryItemRow,
  LibraryModels,
  LibrarySubmissionRow,
  UploadApprovalReceipt,
} from './access';

const AMBER_A = '6a5fc5fa351af41332734161';
const AMBER_LACEY = '6a5ad176c1b837d2fafd4fe4';
const KADE = '6a3cba4d0b0afa92194e42f7';
const DESTINY = '6aa0b852f3d755d203f9cdd1'; // the newest family account on Sep 24 (made Sep 21)
const VISCHECK = '6a6125d73939d20b95251078'; // App Review and screenshots
const EVALCLEAN = '6a572e3be680dcdaadca0f04';
const EVALFIXTURE = '6a69074cc74d975de21f5b2a';
const EARLY = '6a3f47e79be0146175d0e3e7'; // an account from late June; who it is was never confirmed
const later = (iso: string) => Types.ObjectId.createFromTime(Date.parse(iso) / 1000).toHexString();

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

test('family accounts keep access, later accounts wait for Kade, admins always have it', () => {
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined, NOTIFY_TEST_USER_IDS: undefined }, () => {
    for (const id of [AMBER_A, AMBER_LACEY, DESTINY]) assert.equal(familyLibraryMember({ id }), true, id);
    const tonight = later('2026-09-24T21:00:00Z');
    assert.equal(familyLibraryMember({ id: tonight }), false);
    assert.equal(familyLibraryMember({ id: later(FAMILY_LIBRARY_CUTOFF) }), true);
    assert.equal(familyLibraryMember({ _id: new Types.ObjectId(tonight) }), false);
    assert.equal(familyLibraryMember({ id: tonight, kadeLibraryAccess: 'family' }), true);
    assert.equal(familyLibraryMember({ id: AMBER_A, kadeLibraryAccess: 'none' }), false);
    assert.equal(familyLibraryMember({ id: KADE, role: 'ADMIN' }), true);
    assert.equal(familyLibraryMember({ id: tonight, role: 'ADMIN', kadeLibraryAccess: 'none' }), true);
    assert.equal(familyLibraryMember({ id: 'not-an-id' }), false);
    assert.equal(familyLibraryMember(null), false);
    assert.equal(familyLibraryMember(undefined), false);
  });
});

test('the App Review seat never sees the family library, whatever is set', () => {
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined }, () => {
    assert.equal(libraryReviewSeat({ id: VISCHECK }), true);
    assert.equal(familyLibraryMember({ id: VISCHECK }), false);
    assert.equal(familyLibraryMember({ id: VISCHECK, kadeLibraryAccess: 'family' }), false);
    // The default hidden list still names the seat by email, as before.
    assert.equal(familyLibraryMember({ id: AMBER_LACEY, email: 'KadeAI.Vischeck722@gmail.com' }), false);
  });
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: `reviewer@example.com, ${AMBER_LACEY}` }, () => {
    assert.equal(familyLibraryMember({ id: DESTINY, email: 'Reviewer@Example.com', kadeLibraryAccess: 'family' }), false);
    assert.equal(familyLibraryMember({ id: AMBER_LACEY }), false);
    assert.equal(familyLibraryMember({ id: VISCHECK }), false, 'the review seat is hidden even when the list changes');
    assert.equal(familyLibraryMember({ id: AMBER_A }), true);
  });
});

test('test seats start without family access; Kade can still grant one on purpose', () => {
  withEnv({ NOTIFY_TEST_USER_IDS: DESTINY }, () => {
    for (const id of [EVALCLEAN, EVALFIXTURE, DESTINY]) {
      assert.equal(libraryTestSeat({ id }), true, id);
      assert.equal(familyLibraryMember({ id }), false, id);
      assert.equal(familyLibraryMember({ id, kadeLibraryAccess: 'family' }), true, id);
    }
    // Test Guest is known by name; an unconfirmed id never shuts anyone out.
    for (const seat of [{ id: EARLY, name: 'Test Guest' }, { id: EARLY, username: 'testguest' }]) {
      assert.equal(libraryTestSeat(seat), true);
      assert.equal(familyLibraryMember(seat), false);
      assert.equal(familyLibraryMember({ ...seat, kadeLibraryAccess: 'family' }), true);
    }
    assert.equal(libraryTestSeat({ id: EARLY, name: 'Holly' }), false);
    assert.equal(familyLibraryMember({ id: EARLY, name: 'Holly' }), true);
    assert.equal(libraryTestSeat({ id: AMBER_A }), false);
  });
});

test('Amber A is the trusted uploader by default; the list can change without a deploy', () => {
  withEnv({ KADE_LIBRARY_TRUSTED_UPLOADERS: undefined }, () => {
    assert.equal(trustedLibraryContributor(AMBER_A), true);
    assert.equal(trustedLibraryContributor(AMBER_A.toUpperCase()), true);
    assert.equal(trustedLibraryContributor(AMBER_LACEY), false);
    assert.equal(trustedLibraryContributor(''), false);
  });
  withEnv({ KADE_LIBRARY_TRUSTED_UPLOADERS: ` ${AMBER_LACEY} ,` }, () => {
    assert.equal(trustedLibraryContributor(AMBER_LACEY), true);
    assert.equal(trustedLibraryContributor(AMBER_A), false);
    assert.equal(trustedLibraryContributor(''), false);
  });
  withEnv({ KADE_LIBRARY_TRUSTED_UPLOADERS: '' }, () => assert.equal(trustedLibraryContributor(AMBER_A), false));
});

test('the owner sees every account in one plain sentence, and fixed accounts have no switch', () => {
  withEnv({ KADE_LIBRARY_HIDDEN_FROM: undefined, KADE_LIBRARY_TRUSTED_UPLOADERS: undefined, NOTIFY_TEST_USER_IDS: undefined }, () => {
    const view = (row: LibraryAccountRow) => familyLibraryAccountView(row);
    assert.deepEqual(view({ _id: new Types.ObjectId(KADE), name: 'Kade Murdock', role: 'ADMIN' }), {
      id: KADE, name: 'Kade Murdock', member: true, status: 'Library owner. Always has the Family feature pack.', changeable: false, trusted: false,
    });
    const reviewer = view({ id: VISCHECK, name: 'Visibility Test' });
    assert.equal(reviewer.changeable, false);
    assert.equal(reviewer.member, false);
    assert.match(reviewer.status, /App Review/);
    assert.equal(view({ id: AMBER_LACEY, name: 'Amber Lacey' }).status, 'Has the Family feature pack. Existing family account.');
    assert.equal(
      view({ id: AMBER_A, name: 'Amber A' }).status,
      'Has the Family feature pack. Existing family account. Trusted uploader: uploads go straight into the family library.',
    );
    assert.equal(view({ id: AMBER_A, name: 'Amber A', kadeLibraryAccess: 'none' }).status, 'No Family feature pack. You turned it off.');
    assert.equal(view({ id: EVALCLEAN, name: 'tester' }).status, 'No Family feature pack. Test account.');
    assert.equal(view({ id: later('2026-10-01T00:00:00Z'), username: 'stranger' }).status, 'No Family feature pack yet. New account.');
    assert.equal(view({ id: later('2026-10-01T00:00:00Z'), name: 'Cousin', kadeLibraryAccess: 'family' }).status, 'Has the Family feature pack. You turned it on.');
    assert.equal(view({ id: EARLY }).name, 'Unnamed account');
    assert.equal(view({ id: EARLY, name: 'Test Guest' }).status, 'No Family feature pack. Test account.');
  });
});

test("the librarian's words for a closed shelf are plain and name no age rule", () => {
  for (const words of [familyLibraryAccessNote, familyLibraryEmptyGuidance]) {
    assert.match(words, /family/);
    assert.match(words, /Kade/);
    assert.doesNotMatch(words, /child|kid|grown|adult|filter|subscription|membership/i);
  }
  assert.match(familyLibraryAccessNote, /own uploads/);
  assert.match(familyLibraryAccessNote, /Do not say the library does not have it/);
  assert.match(familyLibraryEmptyGuidance, /not proof the library lacks/);
});

test('the App Review seat is never told a closed collection exists', () => {
  assert.match(ownUploadsOnlyNote, /only its own uploads/);
  assert.match(ownUploadsOnlyNote, /Do not say the catalog failed/);
  assert.doesNotMatch(ownUploadsOnlyNote, /family|Kade|approv|access|shared|child|grown|filter|subscription|membership/i);
});

test('one digest sentence for everything waiting, never one per item', () => {
  assert.equal(libraryDigestText([]), '');
  assert.equal(libraryDigestText([{ name: 'Amber', books: 0, recordings: 0, videos: 0, links: 0, reports: 0 }]), '');
  assert.equal(
    libraryDigestText([{ name: 'Amber', books: 12, recordings: 0, videos: 0, links: 0, reports: 0 }]),
    'Waiting for your yes or no on the Library page: Amber uploaded 12 books.',
  );
  assert.equal(
    libraryDigestText([
      { name: 'Karen', books: 0, recordings: 0, videos: 0, links: 1, reports: 2 },
      { name: 'Amber', books: 1, recordings: 2, videos: 1, links: 0, reports: 0 },
    ]),
    'Waiting for your yes or no on the Library page: Amber uploaded 1 book, 2 recordings and 1 video. Karen suggested 1 link and reported 2 items on the wrong shelf.',
  );
  const crowd = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => ({ name, books: 10 - i, recordings: 0, videos: 0, links: 0, reports: 0 }));
  assert.equal(
    libraryDigestText(crowd),
    'Waiting for your yes or no on the Library page: A uploaded 10 books. B uploaded 9 books. C uploaded 8 books. D uploaded 7 books. 11 more items came from other people.',
  );
});

/* ── against a real database ─────────────────────────────────────────── */

let mongo: MongoMemoryServer;
let models: LibraryModels;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  models = {
    books: mongoose.model<LibraryItemRow>('AccessBookFixture', new Schema<LibraryItemRow>({}, { strict: false })),
    submissions: mongoose.model<LibrarySubmissionRow>(
      'AccessSubmissionFixture',
      new Schema<LibrarySubmissionRow>({}, { strict: false }),
    ),
  };
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function seedAmber() {
  await models.books.deleteMany({});
  await models.submissions.deleteMany({});
  const amber = new Types.ObjectId(AMBER_A);
  const other = new Types.ObjectId(AMBER_LACEY);
  const book = async (title: string, extra: Record<string, unknown> = {}) =>
    (await models.books.create({ owner: amber, title, kind: 'text', state: 'ready', shared: false, path: 'Books/bookshare', ...extra }))._id;
  const waiting = [await book('Making Out 1'), await book('Making Out 2'), await book('An audiobook', { kind: 'audio' })];
  const uploading = await book('Half uploaded', { state: 'pending' });
  const alreadyIn = await book('Already shared', { shared: true });
  const privateOne = await book('Her own notes');
  const lacey = (await models.books.create({ owner: other, title: 'Lacey tape', kind: 'video', state: 'ready', shared: false }))._id;
  const deleted = new Types.ObjectId();
  const request = (user: Types.ObjectId, extra: Record<string, unknown>) =>
    models.submissions.create({ user, userName: 'Amber', type: 'submission', status: 'pending', url: '', ...extra });
  for (const id of waiting) await request(amber, { book: id });
  await request(amber, { book: uploading });
  await request(amber, { book: alreadyIn });
  await request(amber, { book: deleted });
  await request(amber, { url: 'https://example.com/tape' });
  await request(amber, { type: 'report', book: alreadyIn, suggestedPath: 'Books/Fiction' });
  await request(amber, { status: 'rejected', book: privateOne });
  await models.submissions.create({ user: other, userName: 'Lacey', type: 'submission', status: 'pending', book: lacey });
  return { waiting, uploading, alreadyIn, privateOne, lacey };
}

test("the digest counts everyone's waiting items by kind, from the database", async () => {
  await seedAmber();
  const text = await pendingLibraryDigest(models);
  assert.equal(
    text,
    'Waiting for your yes or no on the Library page: Amber uploaded 5 books and 1 recording, suggested 1 link and reported 1 item on the wrong shelf. Lacey uploaded 1 video.',
  );
  await models.submissions.updateMany({}, { $set: { status: 'approved' } });
  assert.equal(await pendingLibraryDigest(models), '');
});

test("a trusted uploader's backlog: preview, apply once, then nothing left", async () => {
  const { waiting, uploading, alreadyIn, privateOne, lacey } = await seedAmber();
  const now = new Date('2026-09-25T01:00:00Z');
  const preview = await approveTrustedUploads(models, { contributor: AMBER_A, apply: false, now });
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.approved.map((item) => item.title).sort(), ['An audiobook', 'Making Out 1', 'Making Out 2']);
  assert.deepEqual(
    { settled: preview.submissionsSettled, already: preview.alreadyShared, uploading: preview.stillUploading, missing: preview.missing, links: preview.links, notRequested: preview.notRequested },
    { settled: 4, already: 1, uploading: 1, missing: 1, links: 1, notRequested: 1 },
  );
  assert.equal(await models.books.countDocuments({ _id: { $in: waiting }, shared: true }), 0, 'a preview writes nothing');
  assert.equal(await models.submissions.countDocuments({ status: 'approved' }), 0);

  const applied: UploadApprovalReceipt = await approveTrustedUploads(models, { contributor: AMBER_A, decidedBy: KADE, apply: true, now });
  assert.equal(applied.applied, true);
  assert.equal(applied.at, '2026-09-25T01:00:00.000Z');
  assert.equal(applied.approved.length, 3);
  const shared = await models.books.find({ _id: { $in: waiting } }).lean<(LibraryItemRow & { sharedAt?: Date })[]>();
  assert.ok(shared.every((item) => item.shared === true && item.sharedAt?.getTime() === now.getTime()));
  const settled = await models.submissions
    .find({ status: 'approved' })
    .lean<(LibrarySubmissionRow & { decisionNote?: string; decidedBy?: Types.ObjectId })[]>();
  assert.equal(settled.length, 4);
  assert.ok(settled.every((row) => row.decisionNote === trustedApprovalNote && String(row.decidedBy) === KADE));
  // Everything else is exactly as it was.
  assert.equal((await models.books.findById(uploading).lean<LibraryItemRow>())?.shared, false);
  assert.equal((await models.books.findById(privateOne).lean<LibraryItemRow>())?.shared, false);
  assert.equal((await models.books.findById(lacey).lean<LibraryItemRow>())?.shared, false);
  assert.equal((await models.books.findById(alreadyIn).lean<LibraryItemRow>())?.shared, true);
  assert.equal(await models.submissions.countDocuments({ status: 'pending', url: 'https://example.com/tape' }), 1);
  assert.equal(await models.submissions.countDocuments({ status: 'pending', type: 'report' }), 1);
  assert.equal(await models.submissions.countDocuments({ status: 'pending', userName: 'Lacey' }), 1);
  assert.equal(await models.submissions.countDocuments({ status: 'rejected' }), 1);

  const again = await approveTrustedUploads(models, { contributor: AMBER_A, decidedBy: KADE, apply: true, now });
  assert.deepEqual(again.approved, []);
  assert.equal(again.submissionsSettled, 0);
  assert.equal(again.stillUploading, 1);
  await assert.rejects(approveTrustedUploads(models, { contributor: 'nobody', apply: false }));
});

/* ── the owner's routes ──────────────────────────────────────────────── */

test('only the owner reaches the access routes, and fixed accounts cannot be switched', async () => {
  const users = new Map<string, LibraryAccountRow>([
    [KADE, { id: KADE, name: 'Kade Murdock', role: 'ADMIN' }],
    [VISCHECK, { id: VISCHECK, name: 'Visibility Test' }],
    [AMBER_A, { id: AMBER_A, name: 'Amber A' }],
    [AMBER_LACEY, { id: AMBER_LACEY, name: 'Amber Lacey' }],
  ]);
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/membership',
    libraryMembershipRouter({
      auth: (req, _res, next) => {
        (req as unknown as { user: { id: string; role: string } }).user = {
          id: String(req.headers['x-user'] || ''),
          role: req.headers['x-user'] === KADE ? 'ADMIN' : 'USER',
        };
        next();
      },
      owner: (req, res, next) => {
        if ((req as unknown as { user: { role: string } }).user.role === 'ADMIN') next();
        else res.status(403).json({ error: 'Only the library owner manages family access.' });
      },
      accounts: async () => [...users.values()],
      account: async (id) => users.get(id) || null,
      setAccess: async (id, access) => {
        calls.push(`${id}:${access}`);
        const row = users.get(id);
        if (!row || row.role === 'ADMIN') return null;
        row.kadeLibraryAccess = access;
        return row;
      },
      approveUploads: async (contributor, apply, decidedBy) => {
        calls.push(`approve:${contributor}:${apply}:${decidedBy}`);
        return { applied: apply, at: 'now', contributor, approved: [], submissionsSettled: 0, alreadyShared: 0, stillUploading: 0, missing: 0, links: 0, notRequested: 0 };
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/membership`;
  const call = async (path: string, user: string, body?: object) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-user': user, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  try {
    assert.equal((await call('', AMBER_A)).status, 403);
    assert.equal((await call('', AMBER_A, { id: AMBER_A, access: 'family' })).status, 403);
    assert.equal((await call('/approve-uploads', AMBER_A, { id: AMBER_A, apply: true })).status, 403);
    assert.deepEqual(calls, []);

    const list = await call('', KADE);
    assert.equal(list.status, 200);
    const accounts = list.body.accounts as { name: string; changeable: boolean }[];
    assert.deepEqual(accounts.map((row) => row.name), ['Amber A', 'Amber Lacey', 'Kade Murdock', 'Visibility Test']);
    assert.ok(!JSON.stringify(list.body).includes('@'), 'no email addresses leave the server');

    assert.equal((await call('', KADE, { id: AMBER_LACEY, access: 'maybe' })).status, 400);
    assert.equal((await call('', KADE, { id: 'x', access: 'none' })).status, 400);
    assert.equal((await call('', KADE, { id: new Types.ObjectId().toHexString(), access: 'none' })).status, 404);
    assert.equal((await call('', KADE, { id: VISCHECK, access: 'family' })).status, 409);
    assert.equal((await call('', KADE, { id: KADE, access: 'none' })).status, 409);
    const changed = await call('', KADE, { id: AMBER_LACEY, access: 'none' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.account, {
      id: AMBER_LACEY, name: 'Amber Lacey', member: false, status: 'No Family feature pack. You turned it off.', changeable: true, trusted: false,
    });
    assert.deepEqual(calls, [`${AMBER_LACEY}:none`]);

    assert.equal((await call('/approve-uploads', KADE, { id: AMBER_LACEY })).status, 400);
    assert.equal((await call('/approve-uploads', KADE, { id: AMBER_A })).status, 200);
    assert.equal((await call('/approve-uploads', KADE, { id: AMBER_A, apply: 'yes' })).body.applied, false);
    assert.equal((await call('/approve-uploads', KADE, { id: AMBER_A, apply: true })).body.applied, true);
    assert.deepEqual(calls.slice(1), [
      `approve:${AMBER_A}:false:${KADE}`,
      `approve:${AMBER_A}:false:${KADE}`,
      `approve:${AMBER_A}:true:${KADE}`,
    ]);
    // Trust rides on family access: with hers off, the backlog cannot be applied.
    assert.equal((await call('', KADE, { id: AMBER_A, access: 'none' })).status, 200);
    const refused = await call('/approve-uploads', KADE, { id: AMBER_A, apply: true });
    assert.equal(refused.status, 409);
    assert.equal((calls as string[]).filter((entry) => entry.startsWith('approve:')).length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
