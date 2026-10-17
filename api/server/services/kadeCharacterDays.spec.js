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
