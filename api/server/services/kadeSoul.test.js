const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const S = require('./kadeSoul.js');
const { cue } = require('./kadeSoulVocabulary.js');

const NOW = new Date('2026-10-16T23:42:00Z'); // Friday 6:42 p.m. Central

test('server vocabulary reads directions exactly like the face module', async () => {
  const file = path.join(__dirname, '../../../client/src/components/Chat/character/avatar-expression.mjs');
  const client = (await import(pathToFileURL(file).href)).default;
  const corpus = [
    'dry', 'warm', 'flat and hot like I am mad on her behalf', 'flat and clipped with no patience left',
    'dry a little raspy', 'laugh', 'soft laugh', 'sigh', 'warm but not letting it slide', 'not amused',
    'soft, worried', 'excited, tripping over yourself', 'teasing', 'gentle concern', 'tired and hoarse',
    'curious, leaning in', 'smug', 'whispering', 'reset', 'clears throat', 'stunned', 'deadpan', 'heavy-hearted',
  ];
  for (const tag of corpus) {
    assert.deepStrictEqual(cue(tag), client.cue(tag), tag);
  }
});

test('a reply with no directions has no feeling', () => {
  assert.strictEqual(S.replyFeeling('Just plain words.'), null);
});

test('a reply reads its directions, weighting the last one', () => {
  const f = S.replyFeeling('%%%soft, worried%%% That sounds hard. %%%sad%%% I am sorry.');
  assert.ok(f.v < -0.3, `valence ${f.v}`);
  assert.deepStrictEqual(f.top, ['sad', 'concerned']);
  const g = S.replyFeeling('%%%laughing%%% Oh no. %%%playful%%% You did not.');
  assert.ok(g.v > 0.5);
});

test('a heavy mood fades slower than a good one', () => {
  const base = { v: 0.2, a: 0.4 };
  const heavy = { v: -0.4, a: 0.3, at: new Date(NOW.getTime() - 24 * 3.6e6) };
  const good = { v: 0.8, a: 0.5, at: new Date(NOW.getTime() - 24 * 3.6e6) };
  const dh = S.deviationNow(heavy, base, NOW);
  const dg = S.deviationNow(good, base, NOW);
  assert.ok(Math.abs(dh.dv) / 0.6 > Math.abs(dg.dv) / 0.6, 'heavy keeps more of itself after a day');
  assert.ok(S.moodWords(dh.dv, dh.da).includes('heavy') || S.moodWords(dh.dv, dh.da).includes('tender'));
});

test('the character\'s own usual register is never a mood', () => {
  const base = { v: 0.05, a: 0.3 }; // a dry character
  const mood = { v: 0.05, a: 0.3, at: NOW };
  const d = S.deviationNow(mood, base, NOW);
  assert.strictEqual(S.moodWords(d.dv, d.da), '');
});

test('blending fades the old mood before adding the new reply', () => {
  const base = { v: 0.2, a: 0.4 };
  const m = S.blendMood({ v: -0.6, a: 0.3, at: new Date(NOW.getTime() - 200 * 3.6e6) }, base, { v: 0.6, a: 0.4, top: ['warm'] }, NOW);
  assert.ok(m.v > 0.3, 'an old heavy mood long faded does not drag a warm reply down');
  assert.deepStrictEqual(m.top, ['warm']);
});

test('the base leans on the default until a character has history', () => {
  assert.deepStrictEqual(S.baseOf(null), { v: 0.2, a: 0.4 });
  const b = S.baseOf({ v: 0.0, a: 0.3, n: 30 });
  assert.strictEqual(Math.round(b.v * 100), 0);
});

test('time of day where they are', () => {
  assert.strictEqual(S.nowLine(NOW, 'America/Chicago'), "It's Friday evening, 6:42 p.m., where they are.");
  assert.match(S.nowLine(new Date('2026-10-17T07:10:00Z'), 'America/Chicago'), /2:10 a\.m\..*middle of the night/);
  assert.match(S.nowLine(NOW, 'America/Los_Angeles'), /Friday afternoon, 4:42 p\.m\./);
});

test('how long since they last talked', () => {
  const tz = 'America/Chicago';
  assert.strictEqual(S.sinceWords(new Date(NOW.getTime() - 35 * 60000), NOW, tz), 'about 35 minutes ago');
  assert.strictEqual(S.sinceWords(new Date('2026-10-16T19:30:00Z'), NOW, tz), 'about 4 hours ago, this afternoon');
  assert.strictEqual(S.sinceWords(new Date('2026-10-15T23:00:00Z'), NOW, tz), 'yesterday evening');
  assert.strictEqual(S.sinceWords(new Date('2026-10-12T23:00:00Z'), NOW, tz), '4 days ago (Monday evening)');
  assert.strictEqual(S.sinceWords(new Date('2026-08-16T23:00:00Z'), NOW, tz), 'about 2 months ago');
});

test('a moment must really be in the conversation', () => {
  const ev = 'User: you are such a gremlin, honestly a little goblin of chaos\nAssistant: guilty';
  assert.ok(S.quoteInEvidence('a little goblin of chaos', ev));
  assert.ok(S.quoteInEvidence('“A little goblin of chaos!”', ev));
  assert.ok(!S.quoteInEvidence('you are my favorite person', ev));
  assert.ok(!S.quoteInEvidence('chaos', ev), 'one word is not a moment');
});

test('picking moments: standing bits first, nothing used lately, related ones by what they said', () => {
  const day = 86400000;
  const m = (id, quote, kind, ageDays, usedDaysAgo) => ({
    _id: id, quote, kind, why: '', createdAt: new Date(NOW - ageDays * day),
    lastUsedAt: usedDaysAgo == null ? null : new Date(NOW - usedDaysAgo * day),
  });
  const pile = [
    m('a', 'goblin of chaos', 'nickname', 10),
    m('b', 'the casserole incident', 'joke', 5, 1),
    m('c', 'I finally passed my driving test', 'milestone', 30),
    m('d', 'my tomatoes are taking over the porch', 'line', 3),
  ];
  const picked = S.pickMoments(pile, 'the tomatoes went wild again on the porch', NOW).map((x) => x._id);
  assert.deepStrictEqual(picked, ['a', 'd']);
  assert.ok(!picked.includes('b'), 'used yesterday, rests');
});

/* ── Nov 10 2026: our stuff rests, a one-word nickname is heard, a call counts as talking ── */

const DAY = 86400000;
const withEnv = async (vars, fn) => {
  const before = {};
  for (const k of Object.keys(vars)) {
    before[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
};
const mom = (id, quote, kind, ageDays, extra = {}) => ({
  _id: id, quote, kind, why: '', speaker: 'them', createdAt: new Date(NOW - ageDays * DAY), lastUsedAt: null, ...extra,
});

test('a one-word nickname is heard in the reply; before, it never could be', async () => {
  assert.strictEqual(S.momentUsed('Sparrow', 'Morning, Sparrow. Sleep okay?'), true);
  assert.strictEqual(S.momentUsed('Sparrow', "%%%warm%%% That is Sparrow's whole thing, though."), true, 'possessive');
  assert.strictEqual(S.momentUsed('Sparrow', 'The sparrows were loud this morning.'), false, 'a whole word, not a piece of one');
  assert.strictEqual(S.momentUsed('Bo', 'Okay, Bo, tell me everything.'), true, 'two letters is still a name');
  assert.strictEqual(S.momentUsed('Bo', 'A bowl of soup and a book.'), false);
  assert.strictEqual(S.momentUsed('warm', '%%%warm%%% Good to hear your voice.'), false, 'a voice direction is not the character saying it');
  /* the two-or-more-word rule is the Oct 16 one, unchanged */
  assert.strictEqual(S.momentUsed('goblin of chaos', 'Well if it is not my favorite goblin of chaos.'), true);
  assert.strictEqual(S.momentUsed('the casserole incident', 'How was your day?'), false);
  await withEnv({ KADE_SOUL_MOMENT_REST: '0' }, () => {
    assert.strictEqual(S.momentUsed('Sparrow', 'Morning, Sparrow.'), false, 'switched off: the old blind spot, exactly');
    assert.strictEqual(S.momentUsed('goblin of chaos', 'my favorite goblin of chaos'), true);
  });
});

test('offers are counted per moment, and a joke rests after the set number', () => {
  const recalled = [
    mom('n', 'Sparrow', 'nickname', 40, { offers: 400 }),
    mom('j1', 'the casserole incident', 'joke', 9, { offers: 3 }),
    mom('j2', 'never trust a quiet goose', 'joke', 8, { offers: 4 }),
    mom('l', 'my tomatoes are taking over the porch', 'line', 3),
  ];
  const plan = S.offerPlan(recalled, 'Honestly? Never trust a quiet goose.', NOW);
  assert.deepStrictEqual(plan.usedIds, ['j2']);
  assert.deepStrictEqual(plan.restIds, ['j2'], 'the fifth offer starts the rest');
  assert.deepStrictEqual(plan.countIds, ['n', 'j1', 'l'], 'everything else is counted; a nickname never rests however often it is offered');
  assert.strictEqual(plan.restUntil.getTime(), NOW.getTime() + 14 * DAY);
});

test('the number of offers and the length of the rest are settings', async () => {
  await withEnv({ KADE_SOUL_MOMENT_OFFERS: '2', KADE_SOUL_MOMENT_REST_DAYS: '3' }, () => {
    const plan = S.offerPlan([mom('j', 'the casserole incident', 'joke', 9, { offers: 1 })], 'Hi.', NOW);
    assert.deepStrictEqual(plan.restIds, ['j']);
    assert.strictEqual(plan.restUntil.getTime(), NOW.getTime() + 3 * DAY);
  });
  await withEnv({ KADE_SOUL_MOMENT_REST: '0' }, () => {
    const plan = S.offerPlan([mom('j', 'the casserole incident', 'joke', 9, { offers: 99 })], 'Oh, the casserole incident.', NOW);
    assert.deepStrictEqual(plan, { usedIds: ['j'], restIds: [], countIds: [], restUntil: plan.restUntil }, 'off: nothing counted, nothing rested, use still marked');
  });
});

test('a resting joke is not offered, the next one takes its place, and it comes back after the rest', () => {
  const pile = [
    mom('j1', 'the casserole incident', 'joke', 5, { restUntil: new Date(NOW.getTime() + 10 * DAY) }),
    mom('j2', 'never trust a quiet goose', 'joke', 6),
    mom('j3', 'the great sock heist', 'joke', 7),
    mom('l', 'my tomatoes are taking over the porch', 'line', 3, { restUntil: new Date(NOW.getTime() + 10 * DAY) }),
  ];
  const ids = (now, text = '') => S.pickMoments(pile, text, now).map((m) => m._id);
  assert.deepStrictEqual(ids(NOW), ['j2', 'j3']);
  assert.deepStrictEqual(ids(NOW, 'the tomatoes went wild again on the porch'), ['j2', 'j3'], 'a resting line is not offered even when the talk turns to it');
  const later = new Date(NOW.getTime() + 11 * DAY);
  assert.deepStrictEqual(ids(later, 'the tomatoes went wild again on the porch'), ['j1', 'j2', 'l'], 'rest over');
});

test('a nickname never rests: used today, offered a thousand times, still there, with one joke beside it', async () => {
  const pile = [
    mom('n', 'Sparrow', 'nickname', 40, { lastUsedAt: new Date(NOW - 3600000), offers: 1000, restUntil: new Date(NOW.getTime() + 10 * DAY) }),
    mom('n2', 'Captain', 'nickname', 50),
    mom('j1', 'the casserole incident', 'joke', 5),
    mom('j2', 'never trust a quiet goose', 'joke', 6),
  ];
  assert.deepStrictEqual(S.pickMoments(pile, '', NOW).map((m) => m._id), ['n', 'j1'], 'still two standing lines, never more');
  /* no jokes free: the second nickname takes the other place */
  const noJokes = pile.map((m) => (m.kind === 'joke' ? { ...m, lastUsedAt: new Date(NOW - 3600000) } : m));
  assert.deepStrictEqual(S.pickMoments(noJokes, '', NOW).map((m) => m._id), ['n', 'n2']);
  await withEnv({ KADE_SOUL_MOMENT_REST: '0' }, () => {
    /* off: the Oct 16 rule, where a nickname used today hides for two days */
    assert.deepStrictEqual(S.pickMoments(pile, '', NOW).map((m) => m._id), ['j1', 'j2']);
  });
});

test('the block tells the character which moment it called back last, never a nickname, never one on offer', async () => {
  const tz = 'America/Chicago';
  const pile = [
    mom('n', 'Sparrow', 'nickname', 40, { lastUsedAt: new Date(NOW - 600000) }),
    mom('j1', 'the casserole incident', 'joke', 5, { lastUsedAt: new Date(NOW - 26 * 3600000) }),
    mom('j2', 'never trust a quiet goose', 'joke', 6, { lastUsedAt: new Date(NOW - 20 * DAY) }),
    mom('j3', 'the great sock heist', 'joke', 7),
  ];
  assert.strictEqual(S.lastUsedMoment(pile, NOW)._id, 'j1');
  const { text, recalledIds } = S.ourStuffSection(pile, '', NOW, tz);
  assert.deepStrictEqual(recalledIds, ['n', 'j2']);
  assert.match(text, /^# Our stuff\n/);
  assert.ok(text.endsWith('\nThe one you called back most recently was "the casserole incident", yesterday afternoon. Let that one rest for now.'), text);
  /* nothing used lately: no such line */
  const fresh = pile.map((m) => ({ ...m, lastUsedAt: m.kind === 'nickname' ? m.lastUsedAt : null }));
  assert.doesNotMatch(S.ourStuffSection(fresh, '', NOW, tz).text, /most recently/);
  /* used long ago: not worth saying */
  assert.strictEqual(S.lastUsedMoment([mom('j', 'the great sock heist', 'joke', 90, { lastUsedAt: new Date(NOW - 45 * DAY) })], NOW), null);
  /* the last-used one is on offer again this turn: do not offer it and tell it to rest in one breath */
  const back = [mom('j', 'the great sock heist', 'joke', 9, { lastUsedAt: new Date(NOW - 5 * DAY) })];
  const again = S.ourStuffSection(back, '', NOW, tz);
  assert.deepStrictEqual(again.recalledIds, ['j']);
  assert.doesNotMatch(again.text, /most recently/);
  /* nothing to offer: no section at all */
  assert.deepStrictEqual(S.ourStuffSection([], 'hello', NOW, tz), { text: '', recalledIds: [] });
  await withEnv({ KADE_SOUL_MOMENT_REST: '0' }, () => {
    assert.doesNotMatch(S.ourStuffSection(pile, '', NOW, tz).text, /most recently/);
  });
});

/* A stand-in for the two collections: just enough of find / findOne / updateOne /
 * updateMany, with $set, $inc, $max, $setOnInsert and upsert, to run the storage
 * paths with no database. $max follows Mongo: a missing or null field loses to a date. */
function fakeDb() {
  const data = { kadesoulstates: [], kademoments: [] };
  const match = (doc, filter) =>
    Object.entries(filter).every(([k, v]) => (v && typeof v === 'object' && Array.isArray(v.$in) ? v.$in.map(String).includes(String(doc[k])) : doc[k] === v));
  const apply = (doc, update, inserting) => {
    for (const [k, v] of Object.entries(update.$set || {})) doc[k] = v;
    for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (Number(doc[k]) || 0) + v;
    for (const [k, v] of Object.entries(update.$max || {})) {
      if (doc[k] == null || new Date(doc[k]).getTime() < new Date(v).getTime()) doc[k] = v;
    }
    if (inserting) for (const [k, v] of Object.entries(update.$setOnInsert || {})) doc[k] = v;
  };
  const writes = [];
  const coll = (name) => ({
    createIndex: async () => 'ok',
    findOne: async (filter) => data[name].find((d) => match(d, filter)) || null,
    find: (filter) => ({ toArray: async () => data[name].filter((d) => match(d, filter)) }),
    updateOne: async (filter, update, opts = {}) => {
      writes.push({ name, filter, update });
      let doc = data[name].find((d) => match(d, filter));
      const inserting = !doc && opts.upsert;
      if (inserting) {
        doc = { ...filter };
        data[name].push(doc);
      }
      if (doc) apply(doc, update, inserting);
      return { matchedCount: doc && !inserting ? 1 : 0 };
    },
    updateMany: async (filter, update) => {
      writes.push({ name, filter, update });
      const docs = data[name].filter((d) => match(d, filter));
      docs.forEach((d) => apply(d, update, false));
      return { modifiedCount: docs.length };
    },
  });
  return { data, coll, writes };
}

async function withFakeDb(fn, { allowed = async () => true } = {}) {
  const db = fakeDb();
  const seam = S.__seam;
  const before = { ...seam };
  seam.coll = db.coll;
  seam.allowed = allowed;
  seam.objectId = function FakeId(id) {
    this.id = String(id);
  };
  seam.objectId.prototype.toString = function toString() {
    return this.id;
  };
  try {
    return await fn(db);
  } finally {
    Object.assign(seam, before);
  }
}

test('after a reply: offers counted in storage, the fifth offer rests the joke, the nickname is marked used and stays', async () => {
  await withFakeDb(async (db) => {
    db.data.kademoments.push(
      { ...mom('n', 'Sparrow', 'nickname', 40), userId: 'u1', agentId: 'agent_x' },
      { ...mom('j', 'the casserole incident', 'joke', 9), userId: 'u1', agentId: 'agent_x' },
      { ...mom('other', 'someone else entirely', 'joke', 9), userId: 'u2', agentId: 'agent_x' },
    );
    const turn = (text, at) => S.noteAfterReply({ userId: 'u1', agentId: 'agent_x', req: {}, conversationId: 'c1', text, recalledIds: ['n', 'j', 'other'], now: at });
    for (let i = 0; i < 4; i += 1) {
      const r = await turn('Morning, Sparrow.', new Date(NOW.getTime() + i * 60000));
      assert.strictEqual(r.ok, true);
    }
    const joke = db.data.kademoments.find((m) => m._id === 'j');
    const name = db.data.kademoments.find((m) => m._id === 'n');
    assert.strictEqual(joke.offers, 4);
    assert.strictEqual(joke.restUntil, undefined, 'four offers: not resting yet');
    assert.strictEqual(name.uses, 4, 'the one-word nickname was heard every time');
    const fifth = new Date(NOW.getTime() + 5 * 60000);
    await turn('Morning, Sparrow.', fifth);
    assert.strictEqual(joke.offers, 0, 'the count starts over');
    assert.strictEqual(joke.offersTotal, 5);
    assert.strictEqual(joke.rests, 1);
    assert.strictEqual(new Date(joke.restUntil).getTime(), fifth.getTime() + 14 * DAY);
    assert.strictEqual(name.offers, 5);
    assert.strictEqual(name.restUntil, undefined, 'a nickname never rests');
    assert.strictEqual(db.data.kademoments.find((m) => m._id === 'other').offers, undefined, "another person's moment is never touched");
    /* and the pick agrees with the storage */
    const mine = db.data.kademoments.filter((m) => m.userId === 'u1');
    assert.deepStrictEqual(S.pickMoments(mine, '', fifth).map((m) => m._id), ['n']);
    assert.deepStrictEqual(S.pickMoments(mine, '', new Date(fifth.getTime() + 15 * DAY)).map((m) => m._id), ['n', 'j']);
  });
});

test('after a reply with the rest rule off: no offer is written at all', async () => {
  await withEnv({ KADE_SOUL_MOMENT_REST: '0' }, () =>
    withFakeDb(async (db) => {
      db.data.kademoments.push({ ...mom('j', 'the casserole incident', 'joke', 9), userId: 'u1', agentId: 'agent_x' });
      await S.noteAfterReply({ userId: 'u1', agentId: 'agent_x', req: {}, conversationId: 'c1', text: 'Hi there.', recalledIds: ['j'], now: NOW });
      assert.deepStrictEqual(db.writes.filter((w) => w.name === 'kademoments'), []);
    }),
  );
});

/* ── a call counts as talking ── */

const END = new Date('2026-10-16T22:10:00Z');
const call = (extra = {}) => ({
  _id: 'call1',
  user: 'u1',
  agentId: 'agent_x',
  surface: 'phone',
  endedAt: END,
  metadata: { callSid: 'CAxxxx', outbound: false },
  turns: [
    { role: 'assistant', text: 'Hey you.' },
    { role: 'user', text: 'Hi, it is me.' },
    { role: 'assistant', text: 'Good to hear you.' },
  ],
  ...extra,
});

test('a call is stamped from its own last turn time, never from now', () => {
  /* the phone bridge sends no turn times: the time the call ended */
  assert.deepStrictEqual(S.callTalkStamp(call(), NOW), { at: END });
  /* turns that carry times: the last one, whatever order they arrive in */
  const timed = call({
    turns: [
      { role: 'user', text: 'Hi.', at: '2026-10-16T22:01:00Z' },
      { role: 'assistant', text: 'Hey.', at: '2026-10-16T22:04:30Z' },
      { role: 'user', text: 'Bye.', at: '2026-10-16T22:03:00Z' },
    ],
  });
  assert.deepStrictEqual(S.callTalkStamp(timed, NOW), { at: new Date('2026-10-16T22:04:30Z') });
  /* filed a day late: still the call's time, not the filing time */
  assert.deepStrictEqual(S.callTalkStamp(call(), new Date(NOW.getTime() + DAY)), { at: END });
  /* no time anywhere: refuse rather than guess */
  assert.deepStrictEqual(S.callTalkStamp(call({ endedAt: undefined }), NOW), { skip: 'no-time' });
  /* a clock a little ahead is pulled back to now; one far ahead is refused */
  assert.deepStrictEqual(S.callTalkStamp(call({ endedAt: new Date(NOW.getTime() + 120000) }), NOW), { at: NOW });
  assert.deepStrictEqual(S.callTalkStamp(call({ endedAt: new Date(NOW.getTime() + DAY) }), NOW), { skip: 'time-ahead' });
});

test('a call does not count: unresolved caller, no character, voicemail, nobody spoke, outbound never really answered', () => {
  assert.deepStrictEqual(S.callTalkStamp(null, NOW), { skip: 'no-caller' });
  assert.deepStrictEqual(S.callTalkStamp(call({ user: null }), NOW), { skip: 'no-caller' });
  assert.deepStrictEqual(S.callTalkStamp(call({ agentId: '' }), NOW), { skip: 'no-character' });
  assert.deepStrictEqual(S.callTalkStamp(call({ agentId: 'ephemeral_1' }), NOW), { skip: 'no-character' });
  const voicemail = call({
    metadata: { outbound: true },
    turns: [
      { role: 'user', text: 'You have reached the mailbox of' },
      { role: 'user', text: 'please leave a message after the tone' },
      { role: 'assistant', text: '[VOICEMAIL LEFT] Hey, it is me, call when you can.' },
    ],
  });
  assert.deepStrictEqual(S.callTalkStamp(voicemail, NOW), { skip: 'voicemail' });
  assert.deepStrictEqual(S.callTalkStamp(call({ turns: [{ role: 'assistant', text: 'Hello? Anyone?' }] }), NOW), { skip: 'nobody-spoke' });
  assert.deepStrictEqual(S.callTalkStamp(call({ turns: [{ role: 'user', text: '   ' }, { role: 'assistant', text: 'Hello?' }] }), NOW), { skip: 'nobody-spoke' });
  const machine = call({ metadata: { outbound: true }, turns: [{ role: 'assistant', text: 'Hi, it is me.' }, { role: 'user', text: 'Leave a message.' }] });
  assert.deepStrictEqual(S.callTalkStamp(machine, NOW), { skip: 'outbound-unanswered' });
  const answered = call({ metadata: { outbound: true }, turns: [{ role: 'user', text: 'Hello?' }, { role: 'assistant', text: 'Hi, it is me.' }, { role: 'user', text: 'Oh hey!' }] });
  assert.deepStrictEqual(S.callTalkStamp(answered, NOW), { at: END });
});

test('the stamp is written once, survives a second ingest, and never moves backwards', async () => {
  await withFakeDb(async (db) => {
    const first = await S.noteCallTalked(call(), { now: NOW });
    assert.deepStrictEqual(first, { ok: true, at: END });
    const row = db.data.kadesoulstates[0];
    assert.strictEqual(row.userId, 'u1');
    assert.strictEqual(row.agentId, 'agent_x');
    assert.strictEqual(new Date(row.lastTurnAt).getTime(), END.getTime());
    assert.strictEqual(row.mood, undefined, 'a time and nothing else: no mood from a call');
    /* the bridge's stop and close both fire: the same call again, later */
    await S.noteCallTalked(call(), { now: new Date(NOW.getTime() + 60000) });
    assert.strictEqual(db.data.kadesoulstates.length, 1);
    assert.strictEqual(new Date(row.lastTurnAt).getTime(), END.getTime());
    /* a text turn after the call, then an OLDER call is filed late: the newer time stays */
    const texted = new Date(END.getTime() + 3600000);
    row.lastTurnAt = texted;
    await S.noteCallTalked(call({ _id: 'call0', endedAt: new Date(END.getTime() - DAY) }), { now: new Date(NOW.getTime() + 2 * 3600000) });
    assert.strictEqual(new Date(row.lastTurnAt).getTime(), texted.getTime(), 'never backwards');
    /* a newer call moves it forward */
    const newer = new Date(END.getTime() + 2 * 3600000);
    await S.noteCallTalked(call({ _id: 'call2', endedAt: newer }), { now: new Date(newer.getTime() + 1000) });
    assert.strictEqual(new Date(row.lastTurnAt).getTime(), newer.getTime());
  });
});

test('no stamp when memory is off for the person, when the call may not count, or when switched off', async () => {
  const asked = [];
  await withFakeDb(
    async (db) => {
      assert.deepStrictEqual(await S.noteCallTalked(call({ mergedConversationId: 'conv9' }), { now: NOW }), { ok: false, skipped: 'memory-off' });
      assert.deepStrictEqual(asked[0], { userId: 'u1', agentId: 'agent_x', req: null, conversationId: 'conv9', write: true }, 'the same gate the text lane writes through');
      assert.strictEqual(db.writes.length, 0);
    },
    { allowed: async (p) => { asked.push(p); return false; } },
  );
  await withFakeDb(async (db) => {
    assert.deepStrictEqual(await S.noteCallTalked(call({ user: undefined }), { now: NOW }), { ok: false, skipped: 'no-caller' });
    assert.deepStrictEqual(await S.noteCallTalked(call({ turns: [{ role: 'assistant', text: '[VOICEMAIL LEFT] call me' }] }), { now: NOW }), { ok: false, skipped: 'voicemail' });
    await withEnv({ KADE_SOUL_CALL_TALKED: '0' }, async () => {
      assert.deepStrictEqual(await S.noteCallTalked(call(), { now: NOW }), { ok: false, skipped: 'off' });
    });
    await withEnv({ KADE_SOUL: '0' }, async () => {
      assert.deepStrictEqual(await S.noteCallTalked(call(), { now: NOW }), { ok: false, skipped: 'off' });
    });
    assert.strictEqual(db.writes.length, 0);
  });
});

test('a storage failure never throws out of the stamp', async () => {
  const seam = S.__seam;
  const before = { ...seam };
  seam.allowed = async () => true;
  seam.coll = () => ({ createIndex: async () => 'ok', updateOne: async () => { throw new Error('db down'); } });
  try {
    const r = await S.noteCallTalked(call(), { now: NOW });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'db down');
  } finally {
    Object.assign(seam, before);
  }
});
