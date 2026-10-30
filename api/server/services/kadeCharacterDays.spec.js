/** A character's own days: the entry parser, the head block, and who gets a day tonight. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

let mongo;
let days;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  days = require('./kadeCharacterDays');
  /* The shared house: Kiana and Harley are shared publicly; Ziggy is someone's Spotter;
   * Forge is a private character with no public share (Oct 29 2026 privacy repair). */
  const db = mongoose.connection;
  const owner = new mongoose.Types.ObjectId();
  const amber = new mongoose.Types.ObjectId();
  const ids = {};
  for (const [id, name, author] of [
    ['agent_kiana', 'Kiana', owner],
    ['agent_harley', 'Harley', owner],
    ['agent_ziggy', 'Ziggy', amber],
    ['agent_forge', 'Forge', owner],
  ]) {
    ids[id] = new mongoose.Types.ObjectId();
    await db.collection('agents').insertOne({ _id: ids[id], id, name, author });
  }
  await db.collection('aclentries').insertMany([
    { principalType: 'public', resourceType: 'agent', resourceId: ids.agent_kiana, permBits: 1 },
    { principalType: 'public', resourceType: 'agent', resourceId: ids.agent_harley, permBits: 1 },
    /* A Spotter that somehow got a public share still never travels. */
    { principalType: 'public', resourceType: 'agent', resourceId: ids.agent_ziggy, permBits: 1 },
    /* A share with one person is not the house. */
    { principalType: 'user', principalId: amber, resourceType: 'agent', resourceId: ids.agent_forge, permBits: 1 },
  ]);
  await db.collection('kadespotters').insertOne({ userId: String(amber), name: 'Ziggy', voice: 'Puck', agentId: 'agent_ziggy' });
  global.__souls = { owner: String(owner), amber: String(amber) };
});

afterEach(() => {
  delete process.env.KADE_DAYS_HOUSE;
  days._resetHouseMemo();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('an entry splits into the day, the one-liner and what they are following', () => {
  const text =
    'Rain all morning in Calico Rock, the kind that makes the river loud. I read that the county is finally fixing the low-water bridge, ' +
    'and good, it has scared folks for years. Also read about a fella in Little Rock building banjos out of cigar boxes. I want to know how they sound.\n' +
    'ONE-LINE: Harley read about the county fixing the low-water bridge and wants to hear a cigar-box banjo\n' +
    'FOLLOWING: cigar-box banjos';
  const e = days.parseEntry(text);
  expect(e.text).toMatch(/^Rain all morning/);
  expect(e.text).not.toMatch(/ONE-LINE|FOLLOWING/);
  expect(e.oneLine).toBe('Harley read about the county fixing the low-water bridge and wants to hear a cigar-box banjo');
  expect(e.following).toBe('cigar-box banjos');
  expect(days.parseEntry('Too short.\nONE-LINE: x\nFOLLOWING: y')).toBeNull();
});

test('the head block carries my last two days, what I follow, and the others', async () => {
  const c = mongoose.connection.collection('kadecharacterdays');
  await c.insertMany([
    { agentId: 'agent_harley', kind: 'day', day: '2026-10-14', name: 'Harley', text: 'Older day.', oneLine: 'old', following: 'old topic' },
    { agentId: 'agent_harley', kind: 'day', day: '2026-10-15', name: 'Harley', text: 'Middle day.', oneLine: 'mid', following: 'banjos' },
    { agentId: 'agent_harley', kind: 'day', day: '2026-10-16', name: 'Harley', text: 'Newest day.', oneLine: 'Harley wants to hear a banjo', following: 'cigar-box banjos' },
    { agentId: 'agent_kiana', kind: 'day', day: '2026-10-16', name: 'Kiana', text: 'Kiana day.', oneLine: 'Kiana read about KC jazz', following: 'jazz' },
    { agentId: 'agent_kiana', kind: 'home', home: 'Kansas City, Missouri' },
  ]);
  const block = await days.getCharacterLifeBlock('agent_harley');
  expect(block).toMatch(/^# My own days lately/);
  expect(block).toMatch(/Thursday, October 15: Middle day\.\nFriday, October 16: Newest day\./);
  expect(block).not.toMatch(/Older day/);
  expect(block).toMatch(/What I'm following this week: cigar-box banjos/);
  expect(block).toMatch(/# The others here lately\n- Kiana: Kiana read about KC jazz/);
  expect(block).not.toMatch(/Harley wants/);
  expect(await days.getCharacterLifeBlock('agent_nobody')).toBe('');
});

test('tonight\'s cast is the main cast plus whoever talked with someone this week', async () => {
  const Conversation = mongoose.models.Conversation;
  await Conversation.create({ conversationId: '11111111-1111-1111-1111-111111111111', user: 'u1', endpoint: 'agents', agent_id: 'agent_newfriend01', title: 't' });
  await Conversation.create({ conversationId: '22222222-2222-2222-2222-222222222222', user: 'u1', endpoint: 'agents', agent_id: 'agent_tempfriend1', title: 't', isTemporary: true });
  const cast = await days.castForTonight();
  for (const id of days.MAIN_CAST) expect(cast).toContain(id);
  expect(cast).toContain('agent_newfriend01');
  expect(cast).not.toContain('agent_tempfriend1');
});

describe('privacy repair (Oct 29 2026): only the shared house travels', () => {
  beforeAll(async () => {
    const c = mongoose.connection.collection('kadecharacterdays');
    await c.insertMany([
      { agentId: 'agent_ziggy', kind: 'day', day: '2026-10-16', name: 'Ziggy', text: 'Ziggy day.', oneLine: 'Ziggy is hunting a glasses privacy bug', following: 'smart glasses' },
      { agentId: 'agent_forge', kind: 'day', day: '2026-10-16', name: 'Forge', text: 'Forge day.', oneLine: 'Forge read about build caches', following: 'builds' },
    ]);
  });

  test('the shared house is publicly shared agents minus Spotters', async () => {
    const ids = await days.sharedHouseIds();
    expect([...ids].sort()).toEqual(['agent_harley', 'agent_kiana']);
  });

  test('a house character\'s head never names a private character or a Spotter', async () => {
    const block = await days.getCharacterLifeBlock('agent_harley');
    expect(block).toMatch(/- Kiana: Kiana read about KC jazz/);
    expect(block).not.toMatch(/Ziggy/);
    expect(block).not.toMatch(/Forge/);
  });

  test('a private character still has its own days, and sees only the house', async () => {
    const block = await days.getCharacterLifeBlock('agent_ziggy');
    expect(block).toMatch(/Friday, October 16: Ziggy day\./);
    expect(block).toMatch(/- Kiana:/);
    expect(block).not.toMatch(/Forge/);
  });

  test('the nightly input lists only the house', async () => {
    const prior = await mongoose.connection.collection('kadecharacterdays').find({ kind: 'day' }).sort({ day: -1 }).toArray();
    const travels = await days.travelFilter();
    const input = days.othersInput(prior, 'agent_kiana', travels);
    expect(input).toMatch(/- Harley:/);
    expect(input).not.toMatch(/Ziggy|Forge/);
  });

  test('KADE_DAYS_HOUSE=all puts the old behavior back', async () => {
    process.env.KADE_DAYS_HOUSE = 'all';
    const block = await days.getCharacterLifeBlock('agent_harley');
    expect(block).toMatch(/Ziggy/);
  });

  test('a failed house lookup lets no one-liner travel', async () => {
    const coll = mongoose.connection.collection('aclentries');
    const proto = Object.getPrototypeOf(coll);
    const realFind = proto.find;
    const spy = jest.spyOn(proto, 'find').mockImplementation(function (...args) {
      if (this.collectionName === 'aclentries') throw new Error('down');
      return realFind.apply(this, args);
    });
    const block = await days.getCharacterLifeBlock('agent_harley');
    spy.mockRestore();
    expect(block).toMatch(/# My own days lately/);
    expect(block).not.toMatch(/# The others here lately/);
  });

  test('a private character\'s days show only to its owner and admins', async () => {
    const { owner, amber } = global.__souls;
    expect(await days.daysVisibleTo('agent_kiana', { id: amber, role: 'USER' })).toBe(true);
    expect(await days.daysVisibleTo('agent_ziggy', { id: amber, role: 'USER' })).toBe(true);
    expect(await days.daysVisibleTo('agent_ziggy', { id: owner, role: 'USER' })).toBe(false);
    expect(await days.daysVisibleTo('agent_ziggy', { id: owner, role: 'ADMIN' })).toBe(true);
    expect(await days.daysVisibleTo('agent_forge', { id: amber, role: 'USER' })).toBe(false);
    expect(await days.daysVisibleTo('agent_kiana', null)).toBe(false);
  });
});
