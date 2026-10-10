import express from 'express';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import { createAnnouncementRouter, announcementPayloadHash, announcementURL } from './router';

const agentId = 'agent_NkG_Fb8_xLz8HFJyx4gNv';
const secret = 'local-announcement-test-secret';
const userA = new Types.ObjectId(),
  userB = new Types.ObjectId(),
  testUser = new Types.ObjectId(),
  bannedUser = new Types.ObjectId();
let mongo: MongoMemoryServer, connection: Connection;
const sent: string[] = [];
let configured = true;
let outcome: 'accepted' | 'failed' | 'unknown' = 'accepted';
let banExpiry: number | string | null | undefined = Date.now() + 60000;
const payload = (id = 'angel-test-announcement') => {
  const value = {
    id,
    title: 'Meet Angel',
    body: 'A tiny sparkly cherub for a little Halloween wonder.',
    agentId,
    url: announcementURL(agentId),
  };
  return { ...value, payloadHash: announcementPayloadHash(value) };
};
const app = () =>
  express()
    .use(express.json())
    .use(
      '/api/kade/admin',
      createAnnouncementRouter({
        db: () => connection.db,
        secret: () => secret,
        configured: () => configured,
        excludedUser: (id) => id === testUser.toString(),
        readBan: async (id) => (id === bannedUser.toString() ? { expiresAt: banExpiry } : null),
        send: async (_subscription, body) => {
          sent.push(body);
          if (outcome === 'failed') throw { statusCode: 410 };
          if (outcome === 'unknown')
            throw new Error('A provider connection ended without a response.');
          return { statusCode: 201 };
        },
      }),
    );

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
}, 120000);
afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await connection.db!.dropDatabase();
  sent.length = 0;
  configured = true;
  outcome = 'accepted';
  banExpiry = Date.now() + 60000;
  const resourceId = new Types.ObjectId();
  await connection
    .db!.collection('agents')
    .insertOne({ _id: resourceId, id: agentId, name: 'Angel' });
  await connection
    .db!.collection('aclentries')
    .insertOne({ resourceId, resourceType: 'agent', principalType: 'public', permBits: 1 });
  await connection.db!.collection('users').insertMany(
    [userA, userB, testUser, bannedUser].map((_id) => ({
      _id,
      email: 'private-fixture@example.invalid',
    })),
  );
  await connection.db!.collection('kadepushsubs').insertMany(
    [
      [userA, 'one'],
      [userA, 'two'],
      [userB, 'three'],
      [testUser, 'test'],
      [bannedUser, 'banned'],
      [new Types.ObjectId(), 'deleted'],
    ].map(([userId, suffix]) => ({
      userId,
      endpoint: `https://push.example.invalid/${suffix}`,
      subscription: {
        endpoint: `https://push.example.invalid/${suffix}`,
        keys: { p256dh: 'fixture', auth: 'fixture' },
      },
    })),
  );
});

test('audience is authenticated, public-agent gated and aggregate-only, including private native input indexes', async () => {
  const api = app();
  await request(api).get(`/api/kade/admin/announcement-audience?agentId=${agentId}`).expect(403);
  const result = await request(api)
    .post('/api/kade/admin/announcement-audience')
    .set('x-bridge-secret', secret)
    .send({
      agentId,
      nativeUserIds: [
        userA.toString().toUpperCase(),
        testUser.toString(),
        bannedUser.toString(),
        new Types.ObjectId().toString(),
        userB.toString(),
      ],
    })
    .expect(200);
  expect(result.body.accounts).toEqual({ eligible: 2, total: 4, excludedTest: 1 });
  expect(result.body.web).toEqual({ configured: true, subscriptions: 3, users: 2 });
  expect(result.body.nativeEligibleIndexes).toEqual([0, 4]);
  const serialized = JSON.stringify(result.body);
  expect(serialized).not.toContain(userA.toString());
  expect(serialized).not.toContain('private-fixture');
  expect(serialized).not.toContain('push.example.invalid');
  expect(sent).toHaveLength(0);
  await connection.db!.collection('aclentries').deleteMany({});
  await request(api)
    .get(`/api/kade/admin/announcement-audience?agentId=${agentId}`)
    .set('x-bridge-secret', secret)
    .expect(404);
});

test('announcement authentication does not intercept other admin routes mounted afterward', async () => {
  const api = app().get('/api/kade/admin/front-desk', (_req, res) => res.json({ existing: true }));
  const result = await request(api).get('/api/kade/admin/front-desk').expect(200);
  expect(result.body).toEqual({ existing: true });
});

test('canonical payload rejects changed hashes and external destinations before reservation or sending', async () => {
  const api = app();
  for (const changed of [
    { ...payload(), payloadHash: 'changed' },
    { ...payload(), url: 'https://external.invalid/' },
  ])
    await request(api)
      .post('/api/kade/admin/announcement-web-push')
      .set('x-bridge-secret', secret)
      .send(changed)
      .expect(400);
  expect(await connection.db!.collection('kadeannouncementweboperations').countDocuments()).toBe(0);
  expect(sent).toHaveLength(0);
});

test('permanent and malformed ban expiries remain excluded while an expired ban permits the account', async () => {
  const api = app();
  for (const expiry of [undefined, null, 0, '', 'invalid', Date.now() + 60000]) {
    banExpiry = expiry;
    const result = await request(api)
      .post('/api/kade/admin/announcement-audience')
      .set('x-bridge-secret', secret)
      .send({ agentId, nativeUserIds: [bannedUser.toString()] })
      .expect(200);
    expect(result.body.accounts.eligible).toBe(2);
    expect(result.body.nativeEligibleIndexes).toEqual([]);
  }
  banExpiry = Date.now() - 60000;
  const result = await request(api)
    .post('/api/kade/admin/announcement-audience')
    .set('x-bridge-secret', secret)
    .send({ agentId, nativeUserIds: [bannedUser.toString()] })
    .expect(200);
  expect(result.body.accounts.eligible).toBe(3);
  expect(result.body.nativeEligibleIndexes).toEqual([0]);
  expect(sent).toHaveLength(0);
});

test('concurrent and repeated requests claim one durable operation and never repeat fanout', async () => {
  const api = app();
  const responses = await Promise.all(
    [1, 2].map(() =>
      request(api)
        .post('/api/kade/admin/announcement-web-push')
        .set('x-bridge-secret', secret)
        .send(payload()),
    ),
  );
  expect(responses.every((result) => result.status === 200)).toBe(true);
  const replay = await request(api)
    .post('/api/kade/admin/announcement-web-push')
    .set('x-bridge-secret', secret)
    .send(payload())
    .expect(200);
  expect(replay.body).toMatchObject({
    state: 'complete',
    attempted: 3,
    accepted: 3,
    failed: 0,
    unknown: 0,
  });
  expect(sent).toHaveLength(3);
  expect(JSON.parse(sent[0])).toMatchObject({
    kadeRoute: 'agent-chat',
    kadeAgentId: agentId,
    url: announcementURL(agentId),
    announcementId: payload().id,
  });
  const changed = { ...payload(), body: 'Different content' };
  changed.payloadHash = announcementPayloadHash(changed);
  await request(api)
    .post('/api/kade/admin/announcement-web-push')
    .set('x-bridge-secret', secret)
    .send(changed)
    .expect(409);
  expect(sent).toHaveLength(3);
});

test('provider rejection prunes expired subscriptions and uncertain outcomes remain unknown without resend', async () => {
  outcome = 'failed';
  const api = app();
  const failed = await request(api)
    .post('/api/kade/admin/announcement-web-push')
    .set('x-bridge-secret', secret)
    .send(payload('angel-provider-failed'))
    .expect(200);
  expect(failed.body).toMatchObject({
    state: 'failed',
    attempted: 3,
    accepted: 0,
    failed: 3,
    unknown: 0,
  });
  expect(
    await connection
      .db!.collection('kadepushsubs')
      .countDocuments({ userId: { $in: [userA, userB] } }),
  ).toBe(0);
  await connection.db!.collection('kadepushsubs').insertOne({
    userId: userA,
    subscription: {
      endpoint: 'https://push.example.invalid/recovered',
      keys: { p256dh: 'fixture', auth: 'fixture' },
    },
  });
  outcome = 'unknown';
  const unknown = await request(api)
    .post('/api/kade/admin/announcement-web-push')
    .set('x-bridge-secret', secret)
    .send(payload('angel-provider-unknown'))
    .expect(200);
  expect(unknown.body).toMatchObject({
    state: 'unknown',
    attempted: 1,
    accepted: 0,
    failed: 0,
    unknown: 1,
  });
  const before = sent.length;
  await request(api)
    .post('/api/kade/admin/announcement-web-push')
    .set('x-bridge-secret', secret)
    .send(payload('angel-provider-unknown'))
    .expect(200);
  expect(sent).toHaveLength(before);
});

test('unconfigured delivery is explicitly skipped; unfinished persisted delivery reconciles read-only', async () => {
  configured = false;
  const api = app();
  const skipped = await request(api)
    .post('/api/kade/admin/announcement-web-push')
    .set('x-bridge-secret', secret)
    .send(payload())
    .expect(200);
  expect(skipped.body).toMatchObject({ state: 'skipped', configured: false, attempted: 0 });
  expect(sent).toHaveLength(0);
  await connection.db!.collection('kadeannouncementweboperations').insertOne({
    _id: 'angel-crash-test',
    id: 'angel-crash-test',
    payloadHash: 'fixed',
    state: 'sending',
    configured: true,
    eligibleUsers: 2,
    subscriptions: 3,
    attempted: 1,
    accepted: 0,
    failed: 0,
    unknown: 1,
    updatedAt: new Date(Date.now() - 700000),
  });
  const status = await request(api)
    .get('/api/kade/admin/announcement-web-push/angel-crash-test')
    .set('x-bridge-secret', secret)
    .expect(200);
  expect(status.body.state).toBe('unknown');
  expect(sent).toHaveLength(0);
  expect(
    (
      await connection
        .db!.collection('kadeannouncementweboperations')
        .findOne({ _id: 'angel-crash-test' })
    )?.state,
  ).toBe('sending');
});
