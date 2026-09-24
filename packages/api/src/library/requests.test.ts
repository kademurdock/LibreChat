import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createLibraryRequestModel } from '../../../data-schemas/src/models/libraryRequest';
import { libraryRequestService, RequestError } from './requests';
import { libraryAccess } from './catalog';
import { familyLibraryMember, trustedLibraryContributor } from './access';
import { libraryConsultation } from './consultation';
import { readingText, readingJacket, printDisabilityNotice } from './text';
import type { RequestActor, RequestInput, RequestDependencies } from './requests';
import type { CatalogItem } from './catalog';

let mongo: MongoMemoryServer;
const member = {
  id: new Types.ObjectId().toHexString(),
  name: 'Reader One',
  admin: false,
  child: false,
  hidden: false,
};
const other = { ...member, id: new Types.ObjectId().toHexString(), name: 'Reader Two' };
const owner = {
  ...member,
  id: new Types.ObjectId().toHexString(),
  name: 'Library owner',
  admin: true,
};
const actors = new Map([member, other, owner].map((actor) => [actor.id, actor]));
const rows = createLibraryRequestModel(mongoose);
const books = mongoose.model<CatalogItem>(
  'RequestedBookFixture',
  new Schema<CatalogItem>({}, { strict: false }),
);
const shared = new Types.ObjectId(),
  privateItem = new Types.ObjectId(),
  adultItem = new Types.ObjectId();
let notifications = 0,
  researchStarts = 0;
let notificationFails = false;
const deps: RequestDependencies = {
  requests: rows,
  reader: async (id) => actors.get(id) || null,
  book: async (id, reader) => {
    const item = await books.findOne({ ...libraryAccess(reader), _id: id }).lean();
    return item ? { id: String(item._id), title: item.title || '' } : null;
  },
  notify: async () => {
    notifications++;
    if (notificationFails) throw new Error('Network timeout');
    return { state: 'sent' };
  },
  startResearch: async () => {
    researchStarts++;
    return { id: 'research-fixture', note: 'Started' };
  },
  researchStatus: async () => ({
    state: 'done',
    note: 'Possible title identified, not yet acquired.',
  }),
};
const service = libraryRequestService(deps);
async function create(title: string, actor: RequestActor = member) {
  const result = await service.run(
    {
      action: 'create',
      title,
      media: 'radio',
      clues: 'A remembered station and a morning program.',
    },
    actor,
  );
  assert.ok(result.request);
  return result.request;
}
async function rejects(input: RequestInput, actor: RequestActor, status: number) {
  await assert.rejects(
    service.run(input, actor),
    (error: Error) => error instanceof RequestError && error.status === status,
  );
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await rows.init();
  await books.insertMany([
    {
      _id: shared,
      owner: new Types.ObjectId(owner.id),
      title: 'Ready shared radio',
      state: 'ready',
      shared: true,
    },
    {
      _id: privateItem,
      owner: new Types.ObjectId(other.id),
      title: 'Private recording',
      state: 'ready',
      shared: false,
    },
    {
      _id: adultItem,
      owner: new Types.ObjectId(owner.id),
      title: 'Adult recording',
      state: 'ready',
      shared: true,
      grownUpsOnly: true,
    },
  ]);
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('concurrent duplicate requests persist only once', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => create('Remembered wolf commercial')),
  );
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(await rows.countDocuments({ title: 'Remembered wolf commercial' }), 1);
});
test('requesters cannot read another person’s requests or use an all scope to list them', async () => {
  const row = await create('Private request clue');
  await rejects({ action: 'details', id: row.id }, other, 404);
  const list = await service.run({ action: 'list', scope: 'all' }, other);
  assert.equal(list.requests?.length, 0);
  assert.ok(
    (await service.run({ action: 'list', scope: 'all' }, owner)).requests?.some(
      (entry) => entry.id === row.id,
    ),
  );
});
test('only owner can fulfill, and private or age-restricted items cannot be used', async () => {
  const row = await create('Fulfillment permissions');
  const input: RequestInput = {
    action: 'update',
    id: row.id,
    version: 1,
    status: 'fulfilled',
    book: String(shared),
    note: 'Added it.',
  };
  await rejects(input, member, 403);
  await rejects({ ...input, book: String(privateItem) }, owner, 400);
  member.child = true;
  await rejects({ ...input, book: String(adultItem) }, owner, 400);
  member.child = false;
  const saved = (await service.run(input, owner)).request!;
  assert.equal(saved.status, 'fulfilled');
  assert.equal(saved.item?.id, String(shared));
  const result = (await service.run({ action: 'details', id: row.id }, member)).request!;
  assert.equal(result.unread, true);
  await service.run({ action: 'read', id: row.id, version: 2 }, member);
  assert.equal(
    (await service.run({ action: 'details', id: row.id }, member)).request?.unread,
    false,
  );
});
test('concurrent updates reject stale versions without overwriting saved clues', async () => {
  const row = await create('Racing notes');
  await service.run(
    { action: 'note', id: row.id, version: 1, note: 'I remember a lighthouse.' },
    member,
  );
  await rejects(
    { action: 'update', id: row.id, version: 1, status: 'searching', note: 'Searching' },
    owner,
    409,
  );
  assert.equal(
    (await service.run({ action: 'details', id: row.id }, member)).request?.history.at(-1)?.note,
    'I remember a lighthouse.',
  );
});
test('notification failure leaves a durable unread update and is not resent after an uncertain send', async () => {
  await service.notifications();
  const beforeCount = notifications;
  const row = await create('Notification reliability');
  await service.run(
    {
      action: 'update',
      id: row.id,
      version: 1,
      status: 'searching',
      note: 'Looking for the original tape.',
    },
    owner,
  );
  notificationFails = true;
  await service.notifications();
  await service.notifications();
  notificationFails = false;
  assert.equal(notifications, beforeCount + 1);
  const saved = (await service.run({ action: 'details', id: row.id }, member)).request!;
  assert.equal(saved.notification?.state, 'unconfirmed');
  assert.equal(saved.unread, true);
});
test('research needs the requester’s consent, starts once and never marks a request fulfilled', async () => {
  const row = await create('Find a half remembered book');
  await rejects({ action: 'research', id: row.id }, member, 400);
  await rejects({ action: 'research', id: row.id, researchConsent: true }, owner, 403);
  await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      service.run({ action: 'research', id: row.id, researchConsent: true }, member),
    ),
  );
  assert.equal(researchStarts, 1);
  const result = (await service.run({ action: 'research_status', id: row.id }, member)).request!;
  assert.equal(result.research?.state, 'done');
  assert.equal(result.status, 'requested');
});
test('restricted accounts cannot request shared media or receive inaccessible fulfillment links', async () => {
  const row = await create('Access later removed');
  await service.run(
    {
      action: 'update',
      id: row.id,
      version: 1,
      status: 'fulfilled',
      book: String(shared),
      note: 'Added it.',
    },
    owner,
  );
  member.hidden = true;
  await rejects({ action: 'create', title: 'Restricted new request' }, member, 403);
  const result = (await service.run({ action: 'details', id: row.id }, member)).request!;
  assert.equal(result.item, null);
  assert.ok(result.availabilityNote);
  member.hidden = false;
});
test('current family accounts keep access; new and explicitly removed accounts do not', () => {
  const old = '6a5fc5fa351af41332734161';
  const future = Types.ObjectId.createFromTime(
    Date.parse('2026-09-25T00:00:00Z') / 1000,
  ).toHexString();
  assert.equal(familyLibraryMember({ id: old }), true);
  assert.equal(familyLibraryMember({ id: future }), false);
  assert.equal(familyLibraryMember({ id: old, kadeLibraryAccess: 'none' }), false);
  assert.equal(familyLibraryMember({ id: future, kadeLibraryAccess: 'family' }), true);
  assert.equal(familyLibraryMember(null), false);
  assert.equal(trustedLibraryContributor(old), true);
  assert.equal(trustedLibraryContributor('6a5ad176c1b837d2fafd4fe4'), false);
});
test('consultation honors explicit settings and never automatically recurses from the librarian', () => {
  assert.equal(libraryConsultation('agent_o7TKU3lK0Euo0MKgpNpvZ', undefined), undefined);
  assert.deepEqual(libraryConsultation('kiana', undefined), {
    enabled: true,
    allowSelf: false,
    agent_ids: ['agent_o7TKU3lK0Euo0MKgpNpvZ'],
  });
  assert.deepEqual(libraryConsultation('kiana', { enabled: false }), { enabled: false });
});
test('reading text hides steering but preserves bracketed prose; old notices become source-neutral', () => {
  assert.equal(
    readingText('%%%warm and gentle%%%Hello [a handwritten note]. [sound:bell]'),
    'Hello [a handwritten note].',
  );
  assert.equal(
    readingJacket(
      'From Bookshare, for people with print disabilities. Please do not pass this book on.',
    ),
    printDisabilityNotice,
  );
});
