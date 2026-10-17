/**
 * KADE SOUL against a real Mongo: mood carried across turns, the time line,
 * moments kept only from real words, and every privacy gate closing the door.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/api', () => ({
  ownsPrivateMemory: (req) => {
    const actingFor = req && req.kadeOnBehalfOf && req.kadeOnBehalfOf.id;
    return Boolean(req && req.user && req.user.id) && (!actingFor || String(actingFor) === String(req.user.id));
  },
}));

const soul = require('./kadeSoul');

const AGENT = 'agent_soul_test_0000000';
let mongo;
let userId;

const req = (extra = {}) => ({ user: { id: userId }, body: { timezone: 'America/Chicago', ...extra } });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({ personalization: Object }, { strict: false }));
  const u = await User.create({ personalization: { memories: true } });
  userId = String(u._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await mongoose.connection.collection('kadesoulstates').deleteMany({});
  await mongoose.connection.collection('kademoments').deleteMany({});
  await mongoose.connection.collection('kadememoryclears').deleteMany({});
  await mongoose.connection.collection('kadememorypolicies').deleteMany({});
});

test('a heavy reply is carried into the next conversation hours later, then the time line says when', async () => {
  const t0 = new Date('2026-10-16T19:00:00Z');
  await soul.noteAfterReply({ userId, agentId: AGENT, req: req(), conversationId: 'c1', text: '%%%soft, worried%%% Oh no. %%%sad%%% I am so sorry about your dad.', now: t0 });
  const later = new Date('2026-10-16T23:42:00Z');
  const { block } = await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c2', userText: 'hey', now: later });
  expect(block).toMatch(/# Right now\nIt's Friday evening, 6:42 p\.m\., where they are\. You two last talked about 5 hours ago, this afternoon\./);
  expect(block).toMatch(/# How you're coming in\nYou're (still a little heavy|a little tender)/);
  expect(block).toMatch(/mostly sad and concerned/);
});

test('mid-conversation there is no gap line and no mood line', async () => {
  const t0 = new Date('2026-10-16T23:30:00Z');
  await soul.noteAfterReply({ userId, agentId: AGENT, req: req(), conversationId: 'c1', text: '%%%sad%%% That hurts.', now: t0 });
  const { block } = await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c1', userText: 'yeah', now: new Date('2026-10-16T23:35:00Z') });
  expect(block).toMatch(/# Right now/);
  expect(block).not.toMatch(/last talked/);
  expect(block).not.toMatch(/coming in/);
});

test('moments: real words kept, invented words refused, offered back, and rested once used', async () => {
  const evidence = 'Human: you are such a goblin of chaos honestly\nAI: guilty as charged';
  const kept = await soul.keepMoment({ userId, agentId: AGENT, quote: 'goblin of chaos', speaker: 'them', kind: 'nickname', why: 'what they call me', conversationId: 'c1', evidence });
  expect(kept.ok).toBe(true);
  const dup = await soul.keepMoment({ userId, agentId: AGENT, quote: '"Goblin of chaos!"', speaker: 'them', kind: 'nickname', conversationId: 'c1', evidence });
  expect(dup.duplicate).toBe(true);
  const fake = await soul.keepMoment({ userId, agentId: AGENT, quote: 'you are my best friend forever', speaker: 'them', kind: 'line', conversationId: 'c1', evidence });
  expect(fake.ok).toBe(false);

  const now = new Date('2026-10-17T01:00:00Z');
  const first = await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c2', userText: 'hi', now });
  expect(first.block).toMatch(/# Our stuff[\s\S]*"goblin of chaos" \(they said it, Oct \d+; a nickname: what they call me\)/);
  expect(first.recalledIds).toHaveLength(1);

  await soul.noteAfterReply({ userId, agentId: AGENT, req: req(), conversationId: 'c2', text: 'Well if it is not my favorite goblin of chaos.', recalledIds: first.recalledIds, now });
  const next = await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c2', userText: 'hi again', now: new Date('2026-10-17T02:00:00Z') });
  expect(next.block).not.toMatch(/goblin of chaos/);
});

test('privacy: voice lane for someone else, temporary chats, excluded chats, memory off and a clear all close the door', async () => {
  const t0 = new Date('2026-10-16T19:00:00Z');
  const later = new Date('2026-10-16T23:00:00Z');
  await soul.noteAfterReply({ userId, agentId: AGENT, req: req(), conversationId: 'c1', text: '%%%sad%%% Rough.', now: t0 });

  const onBehalf = { user: { id: 'service' }, kadeOnBehalfOf: { id: userId }, body: {} };
  expect((await soul.getSoulTailBlock({ userId, agentId: AGENT, req: onBehalf, conversationId: 'c2', now: later })).block).toBe('');
  expect((await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req({ isTemporary: true }), conversationId: 'c2', now: later })).block).toBe('');
  expect((await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c2', offRecord: true, now: later })).block).toBe('');

  await mongoose.connection.collection('kadememorypolicies').insertOne({ userId, conversationId: 'c9', excluded: true });
  expect((await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c9', now: later })).block).toBe('');

  /* A clear after the mood was felt: the mood is no longer carried, moments before it vanish. */
  await soul.keepMoment({ userId, agentId: AGENT, quote: 'the casserole incident', speaker: 'them', kind: 'joke', conversationId: 'c1', evidence: 'Human: never forget the casserole incident' });
  await mongoose.connection.collection('kadememoryclears').insertOne({ userId, agentId: '*', at: new Date() });
  const afterClear = await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c2', now: new Date(Date.now() + 3600000) });
  expect(afterClear.block).not.toMatch(/coming in/);
  expect(afterClear.block).not.toMatch(/casserole/);

  const User = mongoose.models.User;
  await User.updateOne({ _id: userId }, { $set: { 'personalization.memories': false } });
  expect((await soul.getSoulTailBlock({ userId, agentId: AGENT, req: req(), conversationId: 'c2', now: later })).block).toBe('');
  await User.updateOne({ _id: userId }, { $set: { 'personalization.memories': true } });
});

test('the About-page snapshot and forgetting one moment', async () => {
  const evidence = 'Human: I finally passed my driving test today!!';
  await soul.keepMoment({ userId, agentId: AGENT, quote: 'I finally passed my driving test today', speaker: 'them', kind: 'milestone', why: 'third try', conversationId: 'c1', evidence });
  const snap = await soul.soulSnapshot({ userId, agentId: AGENT });
  expect(snap.moments).toHaveLength(1);
  expect(snap.moments[0]).toMatchObject({ kind: 'milestone', speaker: 'them', why: 'third try' });
  const gone = await soul.forgetMoment({ userId, agentId: AGENT, id: snap.moments[0].id });
  expect(gone.ok).toBe(true);
  expect((await soul.soulSnapshot({ userId, agentId: AGENT })).moments).toHaveLength(0);
});
