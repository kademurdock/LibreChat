/* Nov 10 2026: characters texting first (services/kadeReachOut.js). Who may get a message, the
 * caps, the doubling back-off, the off switch, the wording check and the "nothing worth saying"
 * path. The real service runs against an in-memory database (api/test/kadeFakeMongo.cjs); the
 * platform reads, the Jev reading and the character turn are stand-ins, so no model is called
 * and no network is touched. Every person, character and memory here is made up.
 *
 * Run: node --test api/server/services/kadeReachOut.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { FakeCollection, stubModules } = require('../../test/kadeFakeMongo.cjs');

stubModules({ '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } } });
const reach = require('./kadeReachOut');

const DAY = 86400000;
/* Noon Central on a made-up day, inside the texting hours. */
const NOON = new Date('2026-11-12T18:00:00Z');
const daysAgo = (n, from = NOON) => new Date(from.getTime() - n * DAY);
const uid = (n) => String(n).padStart(24, 'a');
const A1 = 'agent_testone';
const A2 = 'agent_testtwo';

let colls;
let world;
let spoke;
let judged;

/* A plan card whose day passed two days ago and nobody has said how it went. */
const planCard = (over = {}) => ({
  key: 'dentist_visit',
  value: 'Has a dentist visit to get a filling done on the morning of the tenth.',
  type: 'fact',
  agentId: null,
  staleAfter: daysAgo(2),
  updated_at: daysAgo(6),
  ...over,
});

function person(id, over = {}) {
  world.people[id] = { id, exists: true, child: false, reviewSeat: false, memoryOff: false, ...over.person };
  world.recent.push({ userId: id, lastMessageAt: over.lastMessageAt || daysAgo(4) });
  world.talked[id] = over.talked || [{ agentId: A1, turns: 40, days: 9, lastAt: daysAgo(4) }];
  world.cards[id] = over.cards || { [A1]: [planCard()] };
  world.threads[id] = over.threads || {};
}

beforeEach(() => {
  colls = {};
  world = { people: {}, recent: [], talked: {}, cards: {}, threads: {}, calls: {}, cents: null };
  spoke = [];
  judged = [];
  for (const k of Object.keys(process.env)) if (k.startsWith('KADE_REACHOUT')) delete process.env[k];
  /* Build two: a dry run is the default. These tests prove the sending machinery, so they switch it on. */
  process.env.KADE_REACHOUT_DRY = '0';
  reach._seam.coll = (name) => (colls[name] = colls[name] || new FakeCollection());
  reach._seam.data = {
    recentPeople: async () => world.recent.slice(),
    lastCallAt: async (id) => world.calls[id] || null,
    person: async (id) => world.people[id] || { id, exists: false },
    talkedWith: async (id) => world.talked[id] || [],
    characterOk: async (agentId) => agentId !== 'agent_spotter',
    cards: async (id, agentId) => (world.cards[id] && world.cards[id][agentId]) || [],
    thread: async (id, agentId) => (world.threads[id] && world.threads[id][agentId]) || '',
    turnCents: async () => world.cents,
  };
  reach._seam.judge = async (cands) => {
    judged.push(cands.map((c) => c.kind));
    return { pick: { ...cands[0], score: 0.9 }, asked: 1, cents: 0.003 };
  };
  reach._seam.speak = async (args) => {
    spoke.push(args);
    const composed = { text: 'How did the filling go? Hope the numb face wore off quick.', toolCalls: 0 };
    const ok = args.beforePost ? await args.beforePost(composed) : true;
    return ok ? { posted: true, conversationId: 'c-1', composeConversationId: 'tmp-1', text: composed.text } : { posted: false, text: composed.text };
  };
  reach._seam.setOff = null;
});

const rows = () => (colls.kadereachouts ? colls.kadereachouts.rows : []);
const row = (id) => rows().find((r) => r._id === id);
const tick = (over = {}) => reach.runTick({ now: NOON, ...over });

/* ------------------------------------------------------------- eligibility */

test('a quiet adult with a regular character and an open plan gets one message', async () => {
  person(uid(1));
  const out = await tick();
  assert.equal(out.ok, true);
  assert.equal(out.reasons.sent, 1);
  assert.equal(spoke.length, 1);
  assert.equal(spoke[0].agentId, A1);
  assert.equal(spoke[0].platformPaid, true, 'nobody pays for a text they did not ask for');
  assert.equal(spoke[0].kind, 'reach-out');
  assert.match(spoke[0].note, /dentist visit/);
  assert.match(spoke[0].note, /nothing invented/);
  assert.equal(row(`s:${uid(1)}:2026-11-12`).status, 'sent');
  assert.equal(row(`p:${uid(1)}`).ignored, 1);
});

test('who never gets one: a child, the App Review seat, memory switched off, someone still talking', async () => {
  person(uid(1), { person: { child: true } });
  person(uid(2), { person: { reviewSeat: true } });
  person(uid(3), { person: { memoryOff: true } });
  person(uid(4), { lastMessageAt: daysAgo(1) });
  const out = await tick();
  assert.deepEqual(out.reasons, { child: 1, 'review-seat': 1, 'memory-off': 1, 'not-quiet': 1 });
  assert.equal(spoke.length, 0);
  assert.equal(judged.length, 0, 'no reading is paid for someone who cannot be texted');
});

test('a call counts as talking: a person who phoned yesterday is not quiet', async () => {
  person(uid(1));
  world.calls[uid(1)] = daysAgo(1);
  const out = await tick();
  assert.deepEqual(out.reasons, { 'not-quiet': 1 });
});

test('only a character the person really talks with may write', async () => {
  person(uid(1), { talked: [{ agentId: A1, turns: 3, days: 1, lastAt: daysAgo(4) }] });
  const out = await tick();
  assert.deepEqual(out.reasons, { 'no-regular-character': 1 });
  assert.equal(spoke.length, 0);
  assert.deepEqual(
    reach.regularCharacters([
      { agentId: A1, turns: 12, days: 3, lastAt: daysAgo(9) },
      { agentId: A2, turns: 30, days: 2, lastAt: daysAgo(1) },
      { agentId: 'ephemeral_x', turns: 99, days: 9, lastAt: daysAgo(1) },
    ]).map((r) => r.agentId),
    [A1],
  );
});

test('a Spotter never texts', async () => {
  person(uid(1), { talked: [{ agentId: 'agent_spotter', turns: 50, days: 9, lastAt: daysAgo(4) }], cards: { agent_spotter: [planCard()] } });
  const out = await tick();
  assert.deepEqual(out.reasons, { 'nothing-saved-to-say': 1 });
});

test('the whole feature off: nothing runs', async () => {
  person(uid(1));
  process.env.KADE_REACHOUT = '0';
  assert.deepEqual(await tick(), { ok: false, disabled: true });
  assert.equal(rows().length, 0);
});

test('outside the texting hours nothing runs, and one hour runs once', async () => {
  person(uid(1));
  const night = await reach.runTick({ now: new Date('2026-11-12T09:00:00Z') });
  assert.equal(night.skipped, 'outside texting hours');
  await tick();
  assert.equal((await tick()).skipped, 'this hour already ran');
  assert.equal(spoke.length, 1);
});

/* ------------------------------------------------- nothing worth saying */

test('nothing saved to say: no reading, no turn, no money', async () => {
  person(uid(1), { cards: { [A1]: [{ key: 'likes_tea', value: 'Drinks strong black tea every morning.', type: 'fact' }] } });
  const out = await tick();
  assert.deepEqual(out.reasons, { 'nothing-saved-to-say': 1 });
  assert.equal(judged.length, 0);
  assert.equal(spoke.length, 0);
  assert.deepEqual(out.today, { sent: 0, checks: 0, cents: 0 });
});

test('the reading says it is not worth a text: no character turn is spent', async () => {
  person(uid(1));
  reach._seam.judge = async () => ({ pick: null, asked: 1, cents: 0.003 });
  const out = await tick();
  assert.deepEqual(out.reasons, { 'nothing-worth-saying': 1 });
  assert.equal(spoke.length, 0);
  assert.equal(out.today.sent, 0);
  assert.equal(out.today.checks, 1);
  assert.equal(out.today.cents, 0.003, 'the reading is counted at what it really cost');
  /* and not asked again the same day */
  const again = await reach.runTick({ now: new Date(NOON.getTime() + 3600000) });
  assert.deepEqual(again.reasons, { 'checked-today': 1 });
});

test('the reading cannot be had: nothing is sent', async () => {
  person(uid(1));
  reach._seam.judge = async () => {
    throw new Error('jev disabled');
  };
  const out = await tick();
  assert.deepEqual(out.reasons, { 'judge-unavailable': 1 });
  assert.equal(spoke.length, 0);
});

test('what counts as something to say', () => {
  const now = NOON;
  const kinds = (cards, thread) => reach.candidatesFor({ agentId: A1, cards, thread, now }).map((c) => c.kind);
  assert.deepEqual(kinds([planCard()]), ['plan-passed']);
  assert.deepEqual(kinds([planCard({ staleAfter: new Date(now.getTime() + 20 * 3600000) })]), ['plan-soon']);
  assert.deepEqual(kinds([planCard({ staleAfter: daysAgo(0.5) })]), [], 'not while it may still be happening');
  assert.deepEqual(kinds([planCard({ staleAfter: daysAgo(12) })]), [], 'too long ago to ask');
  assert.deepEqual(kinds([planCard({ updated_at: daysAgo(1) })]), [], 'the card already says how it went');
  assert.deepEqual(kinds([planCard({ type: 'reminder' })]), [], 'a reminder delivers itself');
  assert.deepEqual(kinds([planCard({ staleAfter: undefined })]), [], 'a date in the text is not a declared plan');
  assert.deepEqual(kinds([], 'They were halfway through planning the garden beds and wanted to pick it up again.'), ['thread']);
  assert.deepEqual(kinds([], 'short'), []);
  const used = [reach.usedKey({ agentId: A1, key: 'dentist_visit', kind: 'plan-passed', date: planCard().staleAfter, text: 'x' })];
  assert.deepEqual(reach.candidatesFor({ agentId: A1, cards: [planCard()], now, used }), [], 'the same plan is never raised twice');
});

test('a yes needs both readings: worth a text, and not a heavy thing to raise', () => {
  assert.equal(reach.worthIt({ worth: 0.82, heavy: 0.05 }), true);
  assert.equal(reach.worthIt({ worth: 0.59, heavy: 0.05 }), false, 'under the floor');
  assert.equal(reach.worthIt({ worth: 0.78, heavy: 0.97 }), false, 'a court date, a funeral, a test result: never out of the blue');
  assert.equal(reach.worthIt({ worth: 0.9 }), false, 'a missing reading is never a yes');
  assert.equal(reach.worthIt(null), false);
});

test('the judge switch off: a saved open plan is reason enough, and no reading is paid', async () => {
  person(uid(1));
  process.env.KADE_REACHOUT_JUDGE = '0';
  const out = await tick();
  assert.equal(out.reasons.sent, 1);
  assert.equal(judged.length, 0);
  assert.equal(out.today.checks, 0);
});

test('a dry run decides and sends nothing', async () => {
  person(uid(1));
  const out = await tick({ dry: true });
  assert.deepEqual(out.reasons, { 'would-send': 1 });
  assert.equal(spoke.length, 0);
  assert.equal(row(`s:${uid(1)}:2026-11-12`), undefined);
});

test('build two: with nothing set the lane is a dry run, and nothing is sent', async () => {
  delete process.env.KADE_REACHOUT_DRY;
  assert.equal(reach.settings().dry, true);
  person(uid(1));
  const out = await tick();
  assert.equal(out.dry, true);
  assert.deepEqual(out.reasons, { 'would-send': 1 });
  assert.equal(spoke.length, 0);
  assert.equal(row(`s:${uid(1)}:2026-11-12`), undefined);
});

test('build two: the push for a first message says only that one came', async () => {
  person(uid(1));
  await tick();
  assert.equal(spoke.length, 1);
  assert.equal(spoke[0].pushText, 'Sent you a message.');
  process.env.KADE_REACHOUT_PLAIN_PUSH = '0';
  person(uid(2));
  await tick({ now: new Date(NOON.getTime() + 3600000), force: true });
  assert.equal(spoke[spoke.length - 1].pushText, undefined);
});

test('build two: the plain ways to say stop are heard, and a story about somebody else is not', () => {
  for (const off of [
    "please don't text me anymore",
    "don't message me again",
    'leave me alone',
    'stop sending me messages',
    'stop bothering me',
    "Don't text me.",
    'no more messages please',
  ]) {
    assert.equal(reach.switchWords(off), 'off', off);
  }
  for (const neither of [
    "my ex won't stop texting me",
    'he will not stop messaging me',
    'I wish she would leave me alone',
    'tell them to stop bothering me',
    "my boss doesn't stop texting me on weekends",
    "don't text me the address, email it",
  ]) {
    assert.equal(reach.switchWords(neither), null, neither);
  }
});

/* --------------------------------------------------------------------- caps */

test('one message per person per day across ALL characters', async () => {
  person(uid(1), {
    talked: [
      { agentId: A1, turns: 40, days: 9, lastAt: daysAgo(4) },
      { agentId: A2, turns: 30, days: 6, lastAt: daysAgo(5) },
    ],
    cards: { [A1]: [planCard()], [A2]: [planCard({ key: 'car_inspection', value: 'Taking the car in for its inspection on the tenth.' })] },
  });
  await tick();
  assert.equal(spoke.length, 1);
  /* later the same day, forced, with the second character's plan still unused */
  const later = await reach.runTick({ now: new Date(NOON.getTime() + 2 * 3600000), force: true });
  assert.deepEqual(later.reasons, { 'sent-today': 1 });
  assert.equal(spoke.length, 1);
});

test('the day row is claimed in one step: two servers cannot both send to one person', async () => {
  person(uid(1));
  /* The other server already holds today's row for this person. */
  await reach._seam.coll('kadereachouts').insertOne({ _id: `s:${uid(1)}:2026-11-12`, status: 'claimed' });
  const out = await tick();
  assert.deepEqual(out.reasons, { 'sent-today': 1 });
  assert.equal(spoke.length, 0);
  assert.equal(out.today.sent, 0, 'no place in the platform day was taken');
});

test('the platform ceiling on messages a day', async () => {
  for (let i = 1; i <= 5; i += 1) person(uid(i));
  process.env.KADE_REACHOUT_MAX_PER_DAY = '2';
  process.env.KADE_REACHOUT_MAX_PER_TICK = '10';
  const out = await tick();
  assert.equal(out.reasons.sent, 2);
  assert.equal(out.reasons['platform-cap'], 1);
  assert.equal(spoke.length, 2);
  assert.equal(out.today.sent, 2);
});

test('the platform ceiling on money a day', async () => {
  for (let i = 1; i <= 5; i += 1) person(uid(i));
  process.env.KADE_REACHOUT_MAX_CENTS_PER_DAY = '4';
  process.env.KADE_REACHOUT_MAX_PER_TICK = '10';
  const out = await tick();
  /* 1.5 cents is set aside per message and 0.01 per reading: two fit under 4 cents, a third does not. */
  assert.equal(spoke.length, 2);
  assert.equal(out.reasons['platform-cap'], 1);
  assert.ok(out.today.cents <= 4, `spent ${out.today.cents}`);
});

test('the default ceilings: 10 messages and 25 cents a day', () => {
  const s = reach.settings({});
  assert.equal(s.maxPerDay, 10);
  assert.equal(s.maxCentsPerDay, 25);
  assert.equal(s.estCents, 1.5);
  assert.equal(s.idleDays, 3);
});

test('the real cost of a turn replaces the amount set aside', async () => {
  person(uid(1));
  world.cents = 0.8;
  const out = await tick();
  assert.equal(out.today.cents, 0.803);
  assert.equal(row(`s:${uid(1)}:2026-11-12`).cents, 0.8);
});

test('a few people a pass, not everyone at once', async () => {
  for (let i = 1; i <= 5; i += 1) person(uid(i));
  const out = await tick();
  assert.equal(out.reasons.sent, 2);
  assert.equal(spoke.length, 2);
});

/* ------------------------------------------------------------------ back-off */

test('the wait doubles each time a message goes unanswered', () => {
  const s = reach.settings({});
  assert.deepEqual([0, 1, 2, 3].map((n) => reach.gapDays(n, s)), [3, 6, 12, 24]);
});

test('ignored once: no second message until twice the wait has passed', async () => {
  person(uid(1), { cards: { [A1]: [planCard(), planCard({ key: 'car_inspection', value: 'Taking the car in for its inspection on the tenth.' })] } });
  await tick();
  assert.equal(spoke.length, 1);
  /* four days later, still silent: the wait after one ignored message is six days */
  const day4 = new Date(NOON.getTime() + 4 * DAY);
  world.cards[uid(1)][A1] = [planCard({ key: 'car_inspection', value: 'Taking the car in for its inspection.', staleAfter: daysAgo(2, day4), updated_at: daysAgo(9, day4) })];
  assert.deepEqual((await reach.runTick({ now: day4 })).reasons, { gap: 1 });
  /* seven days later it may go */
  const day7 = new Date(NOON.getTime() + 7 * DAY);
  world.cards[uid(1)][A1] = [planCard({ key: 'car_inspection', value: 'Taking the car in for its inspection.', staleAfter: daysAgo(2, day7), updated_at: daysAgo(9, day7) })];
  assert.equal((await reach.runTick({ now: day7 })).reasons.sent, 1);
  assert.equal(row(`p:${uid(1)}`).ignored, 2);
  /* and now the wait is twelve days */
  const day17 = new Date(day7.getTime() + 10 * DAY);
  world.cards[uid(1)][A1] = [planCard({ key: 'vet_trip', value: 'Taking the cat to the vet for shots.', staleAfter: daysAgo(2, day17), updated_at: daysAgo(9, day17) })];
  assert.deepEqual((await reach.runTick({ now: day17 })).reasons, { gap: 1 });
});

test('an answer starts the count over', async () => {
  person(uid(1));
  await tick();
  assert.equal(row(`p:${uid(1)}`).ignored, 1);
  /* they wrote back the next day, then went quiet for four days */
  const later = new Date(NOON.getTime() + 5 * DAY);
  world.recent[0].lastMessageAt = new Date(NOON.getTime() + 1 * DAY);
  world.cards[uid(1)][A1] = [planCard({ key: 'car_inspection', value: 'Taking the car in for its inspection.', staleAfter: daysAgo(2, later), updated_at: daysAgo(9, later) })];
  const out = await reach.runTick({ now: later });
  assert.equal(out.reasons.sent, 1);
  assert.equal(row(`p:${uid(1)}`).ignored, 1, 'back to one unanswered, not two');
});

test('after four unanswered in a row the characters stay silent until the person writes', () => {
  const s = reach.settings({});
  const base = { person: { id: uid(1), exists: true }, lastActivityAt: daysAgo(200), now: NOON, s };
  const st = { ignored: 4, lastSentAt: daysAgo(150), lastSentDay: '2026-06-01' };
  assert.deepEqual(reach.personEligible({ ...base, state: st }), { ok: false, why: 'backed-off' });
  const back = reach.reconcile(st, daysAgo(5));
  assert.equal(back.ignored, 0);
  assert.deepEqual(reach.personEligible({ ...base, lastActivityAt: daysAgo(5), state: back }), { ok: true });
});

/* ---------------------------------------------------------------- off switch */

test('the words that switch it off, and the words that bring it back', () => {
  for (const off of [
    'stop checking on me',
    'Please stop checking in on me.',
    "don't check on me",
    'Stop texting me',
    'do not text me first',
    'quit messaging me',
    'no more check-ins',
    'stop reaching out',
    'turn the friend texts off',
    'I want you to stop checking up on me okay',
  ]) {
    assert.equal(reach.switchWords(off), 'off', off);
  }
  for (const back of [
    'you can check on me again',
    'You can text me first again',
    'start checking on me again',
    'turn the check-ins back on',
    'I do want you to text me',
    'you may message me whenever',
  ]) {
    assert.equal(reach.switchWords(back), 'on', back);
  }
  for (const neither of [
    'how did the game go',
    'my sister told me to stop checking on me and her kids so much',
    'she said stop texting me so I did',
    "I can't stop checking my phone",
    'check on the roast for me',
    "you can't text me first, can you?",
    'text me the recipe',
    '',
    'stop checking on me '.repeat(40),
  ]) {
    assert.equal(reach.switchWords(neither), null, neither);
  }
});

const chat = (id, text, extra = {}) => ({ user: { id, role: 'USER' }, body: { conversationId: 'c-1', text }, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('"stop checking on me" to any character: off for good, for every character', async () => {
  person(uid(1));
  const note = reach.noteFromWords(chat(uid(1), 'Hey, stop checking on me please.'));
  assert.equal(note, reach.NOTE_OFF);
  await settle();
  assert.equal(row(`p:${uid(1)}`).off, true);
  assert.deepEqual((await tick()).reasons, { 'off-switch': 1 });
  /* months later, still off */
  const later = new Date(NOON.getTime() + 200 * DAY);
  world.recent[0].lastMessageAt = daysAgo(5, later);
  world.cards[uid(1)][A1] = [planCard({ staleAfter: daysAgo(2, later), updated_at: daysAgo(9, later) })];
  assert.deepEqual((await reach.runTick({ now: later })).reasons, { 'off-switch': 1 });
  assert.equal(spoke.length, 0);
  assert.equal(judged.length, 0);
});

test('asking brings it back', async () => {
  person(uid(1));
  await reach.setOff(uid(1), true);
  assert.deepEqual(await reach.getSwitch(uid(1)).then((s) => s.off), true);
  const note = reach.noteFromWords(chat(uid(1), 'You can check on me again.'));
  assert.equal(note, reach.NOTE_ON);
  await settle();
  assert.equal(row(`p:${uid(1)}`).off, false);
  assert.equal((await tick()).reasons.sent, 1);
});

test('the notes never sound hurt', () => {
  assert.match(reach.NOTE_OFF, /Do not sound hurt/);
  assert.equal(reach.wordingProblem(reach.NOTE_ON), null);
});

test('who may flip the switch from where', async () => {
  const saved = [];
  reach._seam.setOff = async (id, off, via) => saved.push({ id, off, via });
  const service = { id: uid(9), role: 'ADMIN' };
  const folded = (last) =>
    '[EARLIER IN THIS CONVERSATION — context only, already handled, do not re-answer:\nTHEM: hi\nYOU: stop checking on me\n— end of earlier context. Reply ONLY to what follows.]\n\n' + last;
  /* a caller the server knows may say stop */
  assert.equal(reach.noteFromWords({ user: service, kadeOnBehalfOf: { id: uid(2) }, body: { text: folded('stop checking on me') } }), reach.NOTE_OFF);
  /* but a phone line cannot switch it back on for somebody */
  assert.equal(reach.noteFromWords({ user: service, kadeOnBehalfOf: { id: uid(2) }, body: { text: folded('you can check on me again') } }), '');
  /* a caller nobody could name changes nothing */
  assert.equal(reach.noteFromWords({ user: service, kadeOnBehalfOfUnresolved: true, body: { text: folded('stop checking on me') } }), '');
  assert.equal(reach.noteFromWords({ user: service, body: { text: folded('stop checking on me') } }), '');
  /* the character's own earlier line in a call is never the person's word */
  assert.equal(reach.noteFromWords({ user: service, kadeOnBehalfOf: { id: uid(2) }, body: { text: folded('what is for dinner') } }), '');
  /* a server-built turn is not the person speaking */
  assert.equal(reach.noteFromWords({ ...chat(uid(3), 'stop checking on me'), kadeHiddenRun: true }), '');
  await settle();
  assert.deepEqual(saved, [{ id: uid(2), off: true, via: 'call' }]);
});

test('the off-words switch off: the chat hook hears nothing', () => {
  process.env.KADE_REACHOUT_OFF_WORDS = '0';
  assert.equal(reach.noteFromWords(chat(uid(1), 'stop checking on me')), '');
});

/* -------------------------------------------------------- guilt and neediness */

test('guilt and neediness wording is never posted', () => {
  for (const bad of [
    "Hey, haven't heard from you in a while. How did the filling go?",
    "It's been a while! How was the dentist?",
    'I miss you. How did the dentist go?',
    'Missing our chats. Did the filling go okay?',
    "You've been quiet lately, everything fine after the dentist?",
    'Where have you been? How was the dentist?',
    'Did I do something wrong? Anyway, how was the filling?',
    'I was worried about you after the dentist.',
    'Just checking in on you after the dentist.',
    'Long time no talk! How did the filling go?',
    'Hey stranger, how was the dentist?',
    'No pressure, but how did the filling go?',
    "I've been waiting to hear how the dentist went.",
    'Please talk to me, how was the dentist?',
    "Why haven't you told me how the dentist went?",
    '%%%warm%%% I need to hear how the dentist went.',
  ]) {
    assert.equal(reach.wordingProblem(bad), 'needy-wording', bad);
  }
  for (const fine of [
    'How did the filling go? Hope the numb face wore off quick.',
    '%%%bright%%% So, the car inspection: did it pass or did they find something?',
    'Good luck at the dentist tomorrow. Tell me if they let you keep the tooth.',
    'Did you ever get those garden beds laid out the way you wanted?',
  ]) {
    assert.equal(reach.wordingProblem(fine), null, fine);
  }
  assert.equal(reach.wordingProblem('SKIP'), 'skip');
  assert.equal(reach.wordingProblem(' skip. '), 'skip');
  assert.equal(reach.wordingProblem(''), 'empty');
  assert.equal(reach.wordingProblem('x'.repeat(600)), 'too-long');
});

test('a needy text is dropped unposted, and not tried again that day', async () => {
  person(uid(1));
  let posted = null;
  reach._seam.speak = async (args) => {
    spoke.push(args);
    posted = await args.beforePost({ text: "Haven't heard from you in a while, how was the dentist?" });
    return { posted: false, composeConversationId: 'tmp-1' };
  };
  const out = await tick();
  assert.equal(posted, false);
  assert.deepEqual(out.reasons, { 'dropped:needy-wording': 1 });
  assert.equal(out.today.sent, 0, 'not counted as a message');
  assert.ok(out.today.cents >= 1.5, 'the turn was paid for, so it stays in the money count');
  assert.equal(row(`p:${uid(1)}`).lastSentAt, undefined, 'the person was not texted, so no back-off');
  const again = await reach.runTick({ now: new Date(NOON.getTime() + 3600000), force: true });
  assert.deepEqual(again.reasons, { 'checked-today': 1 });
  assert.equal(spoke.length, 1);
});

test('the character answers SKIP: nothing is posted and that memory is not raised again', async () => {
  person(uid(1));
  reach._seam.speak = async (args) => {
    spoke.push(args);
    await args.beforePost({ text: 'SKIP' });
    return { posted: false };
  };
  const out = await tick();
  assert.deepEqual(out.reasons, { 'dropped:skip': 1 });
  assert.equal(row(`p:${uid(1)}`).used.length, 1);
  const next = await reach.runTick({ now: new Date(NOON.getTime() + DAY) });
  assert.deepEqual(next.reasons, { 'nothing-saved-to-say': 1 });
});

test('a turn that fails is not counted as a message and is not retried that day', async () => {
  person(uid(1));
  reach._seam.speak = async () => {
    throw new Error('the site would not start the turn (500)');
  };
  const out = await tick();
  assert.deepEqual(out.reasons, { failed: 1 });
  assert.equal(out.today.sent, 0);
  assert.equal(row(`s:${uid(1)}:2026-11-12`).status, 'failed');
});

test('the note to the character: one saved thing, nothing invented, no guilt', () => {
  const note = reach.buildNote({ kind: 'plan-passed', text: 'Has a dentist visit on the tenth.', date: daysAgo(2) });
  assert.match(note, /from your own memory of them: "Has a dentist visit on the tenth\."/);
  assert.match(note, /ask, never assume/);
  assert.match(note, /only what your memory of them and your own days above actually say/);
  assert.match(note, /No guilt/);
  assert.match(note, /reply with only the word SKIP/);
});

test('the reading is shown one saved note and its kind, and nothing else about anyone', () => {
  const [c] = reach.candidatesFor({ agentId: A1, cards: [planCard()], now: NOON });
  const { state, questions } = reach.judgeAsk(c);
  assert.deepEqual(Object.keys(state), ['note', 'kind']);
  assert.deepEqual(Object.keys(questions), ['worth', 'heavy']);
  assert.equal(questions.worth.type, 'noul');
  assert.equal(questions.heavy.type, 'noul');
});

/* ---------------------------------------------- the older bridge friend texts */

test('the bridge friend text passes the same switch, the same one-a-day rule and the same ceiling', async () => {
  person(uid(1));
  person(uid(2), { person: { child: true } });
  person(uid(3));
  await reach.setOff(uid(3), true);
  const first = await reach.gateSpeak({ userId: uid(1), agentId: A1, now: NOON });
  assert.equal(first.ok, true);
  await first.done({ posted: true }, null);
  assert.equal(row(`p:${uid(1)}`).ignored, 1);
  assert.deepEqual(await reach.gateSpeak({ userId: uid(1), agentId: A2, now: NOON }), { ok: false, why: 'sent-today' });
  assert.deepEqual(await reach.gateSpeak({ userId: uid(2), agentId: A1, now: NOON }), { ok: false, why: 'child' });
  assert.deepEqual(await reach.gateSpeak({ userId: uid(3), agentId: A1, now: NOON }), { ok: false, why: 'off-switch' });
  /* and the site's own pass will not text the first person again today */
  assert.deepEqual((await tick({ userId: uid(1) })).reasons, { 'sent-today': 1 });
  process.env.KADE_REACHOUT_MAX_PER_DAY = '1';
  person(uid(4));
  assert.deepEqual(await reach.gateSpeak({ userId: uid(4), agentId: A1, now: NOON }), { ok: false, why: 'platform-cap' });
  process.env.KADE_REACHOUT_SPEAK_GATE = '0';
  assert.equal((await reach.gateSpeak({ userId: uid(3), agentId: A1, now: NOON })).ok, true, 'switch off: as before');
});
