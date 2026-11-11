/* Run: node --test api/server/services/kadeEveryday.nodetest.js
 *
 * Home agent cards 6 and 7 (Nov 11 2026): reminders that really arrive for every character, and the
 * everyday helpers. A small in-memory stand-in plays the database; posting, pushing, chat notes and
 * the ledger are seams, so nothing here touches the network, a model or a real account. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const E = require('./kadeEveryday');
const T = require('./kadeEverydayTool');

/* ------------------------------------------------------------ the stand-in */

const same = (a, b) => (a instanceof Date || b instanceof Date ? a != null && b != null && new Date(a).getTime() === new Date(b).getTime() : a === b);

function matchOne(v, cond) {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date || typeof cond !== 'object') return same(v, cond);
  for (const [op, arg] of Object.entries(cond)) {
    if (op === '$lte' && !(v != null && new Date(v).getTime() <= new Date(arg).getTime())) return false;
    if (op === '$gte' && !(v != null && new Date(v).getTime() >= new Date(arg).getTime())) return false;
    if (op === '$ne' && (arg === null ? v === null || v === undefined : same(v, arg))) return false;
    if (op === '$in' && !arg.some((a) => (a === null ? v === null || v === undefined : same(v, a)))) return false;
    if (op === '$nin' && arg.some((a) => same(v, a))) return false;
  }
  return true;
}
const matches = (doc, filter) => Object.entries(filter || {}).every(([k, c]) => matchOne(doc[k], c));

function fakeDb() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const coll = (name) => {
    const rows = table(name);
    return {
      rows,
      async createIndex() {},
      find(filter) {
        let out = rows.filter((r) => matches(r, filter));
        const cur = {
          sort(spec) {
            const [[k, dir]] = Object.entries(spec);
            out = out.slice().sort((a, b) => (new Date(a[k]).getTime() - new Date(b[k]).getTime()) * dir);
            return cur;
          },
          limit(n) {
            out = out.slice(0, n);
            return cur;
          },
          async toArray() {
            return out.map((r) => ({ ...r }));
          },
        };
        return cur;
      },
      async findOne(filter) {
        const r = rows.find((x) => matches(x, filter));
        return r ? { ...r } : null;
      },
      async insertOne(doc) {
        if (rows.some((r) => r._id === doc._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        rows.push({ ...doc });
        return { insertedId: doc._id };
      },
      async updateOne(filter, update, opts = {}) {
        const r = rows.find((x) => matches(x, filter));
        if (r) {
          Object.assign(r, update.$set || {});
          return { matchedCount: 1, modifiedCount: 1 };
        }
        if (opts.upsert) {
          const base = {};
          for (const [k, v] of Object.entries(filter)) if (v === null || typeof v !== 'object' || v instanceof Date) base[k] = v;
          rows.push({ ...base, ...(update.$set || {}) });
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      },
      async updateMany(filter, update) {
        let n = 0;
        for (const r of rows) {
          if (matches(r, filter)) {
            Object.assign(r, update.$set || {});
            n += 1;
          }
        }
        return { matchedCount: n, modifiedCount: n };
      },
      async findOneAndUpdate(filter, update) {
        const r = rows.find((x) => matches(x, filter));
        if (!r) return null;
        Object.assign(r, update.$set || {});
        return { ...r };
      },
      async deleteOne(filter) {
        const i = rows.findIndex((x) => matches(x, filter));
        if (i >= 0) rows.splice(i, 1);
        return { deletedCount: i >= 0 ? 1 : 0 };
      },
    };
  };
  return { coll, table };
}

/* ------------------------------------------------------------- the world */

const A = 'a1a1a1a1a1a1a1a1a1a1a1a1';
const B = 'b2b2b2b2b2b2b2b2b2b2b2b2';
const HARLEY = { agentId: 'agent_harley_test', agentName: 'Harley' };
const LILLY = { agentId: 'agent_lilly_test', agentName: 'Lilly' };

function world({ start = '2026-11-11T15:00:00Z', devices = 1, web = 0 } = {}) {
  E._resetForTests();
  const db = fakeDb();
  const w = { db, clock: new Date(start), posts: [], pushes: [], webs: [], notes: [], ledger: [], stopped: [] };
  E._seam.coll = db.coll;
  E._seam.now = () => new Date(w.clock);
  E._seam.noTimers = true;
  E._seam.post = async (p) => {
    w.posts.push(p);
    return { conversationId: p.conversationId || 'convo-new' };
  };
  E._seam.push = async (p) => {
    w.pushes.push(p);
    return { sent: typeof devices === 'function' ? devices(p) : devices };
  };
  E._seam.webPush = async (p) => {
    w.webs.push(p);
    return web;
  };
  E._seam.chatNote = async (p) => {
    w.notes.push(p);
    return true;
  };
  E._seam.ledger = (row) => w.ledger.push(row);
  E._seam.bridge = { list: async () => [], cancel: async () => true };
  w.at = (iso) => {
    w.clock = new Date(iso);
  };
  w.later = (minutes) => {
    w.clock = new Date(w.clock.getTime() + minutes * 60000);
  };
  return w;
}

let turnCount = 0;
function chat(userId, text = 'please', extra = {}) {
  turnCount += 1;
  return { user: { id: userId, role: 'USER' }, body: { text, conversationId: `convo-${userId.slice(0, 4)}`, ...extra }, _t: turnCount };
}
function phone(userId, text = 'hello') {
  return {
    user: { id: 'f0f0f0f0f0f0f0f0f0f0f0f0', role: 'ADMIN' },
    kadeOnBehalfOf: { id: userId, role: 'USER' },
    body: { text, conversationId: 'new', kadeOnBehalfOf: 'caller@example.com' },
  };
}
const act = (req, action, data = {}, who = HARLEY, env = { ...process.env, KADE_REMIND_ALL: '1', KADE_EVERYDAY: '1' }) =>
  E.handle({ action, data, req, ...who, env });
const idOf = (s) => (/id (r[0-9a-f]{10})/.exec(s) || [])[1];

/* ------------------------------------------------------------- switches */

test('switches: KADE_REMIND_ALL=0 is the old tool byte for byte; KADE_EVERYDAY=0 leaves the helpers out', () => {
  const legacy = { legacyDescription: 'OLD', legacyForModel: 'OLD+', legacySchema: { type: 'object', properties: {} } };
  const off = T.notifyDefinition(legacy, { KADE_REMIND_ALL: '0' });
  assert.equal(off.mode, 'legacy');
  assert.equal(off.description, 'OLD');
  assert.equal(off.descriptionForModel, 'OLD+');
  assert.equal(off.schema, legacy.legacySchema);
  assert.equal(T.ownsAction('set_reminder', { KADE_REMIND_ALL: '0' }), false, 'the bridge keeps set_reminder');
  assert.equal(T.ownsAction('timer', { KADE_REMIND_ALL: '0', KADE_EVERYDAY: '1' }), false, 'card 7 rides on card 6');

  const remind = T.notifyDefinition(legacy, { KADE_EVERYDAY: '0' });
  assert.equal(remind.mode, 'remind');
  assert.ok(remind.schema.properties.action.enum.includes('check_back'));
  assert.ok(!remind.schema.properties.action.enum.includes('timer'));
  assert.equal(remind.schema.properties.list, undefined);
  assert.equal(T.ownsAction('set_reminder', { KADE_EVERYDAY: '0' }), true);
  assert.equal(T.ownsAction('list_add', { KADE_EVERYDAY: '0' }), false);

  const full = T.notifyDefinition(legacy, {});
  assert.equal(full.mode, 'everyday');
  for (const a of [...T.LEGACY_ACTIONS, ...T.REMIND_ACTIONS, ...T.EVERYDAY_ACTIONS]) assert.ok(full.schema.properties.action.enum.includes(a), a);
  assert.ok(full.description.length < 1000, 'short and plain for a cheap model');
  assert.ok(T.ownsAction('send', {}) === false && T.ownsAction('platform_status', {}) === false, 'the old actions stay on the bridge');
});

test('the production schema (definitions.ts) carries every word of the tool schema, and the legacy one stays', () => {
  const ts = fs.readFileSync(path.resolve(__dirname, '../../../packages/api/src/tools/registry/definitions.ts'), 'utf8');
  const strings = [
    T.DESCRIPTION_REMIND,
    T.DESCRIPTION_EVERYDAY,
    ...[T.ACTION_NOTE_BASE, T.ACTION_NOTE_EVERYDAY].flatMap((s) => s.split(/(?<=\. )/).map((x) => x.trim()).filter(Boolean)),
    ...Object.values({ ...T.FIELDS_REMIND, ...T.FIELDS_EVERYDAY }).map((f) => f.description),
  ];
  for (const s of [T.DESCRIPTION_REMIND, T.DESCRIPTION_EVERYDAY]) {
    for (const piece of s.split(/(?<=\. )/).map((x) => x.trim()).filter(Boolean)) assert.ok(ts.includes(piece), `definitions.ts lacks: ${piece}`);
  }
  for (const s of strings.slice(2)) assert.ok(ts.includes(s.length > 140 ? s.slice(0, 140) : s), `definitions.ts lacks: ${s}`);
  for (const a of [...T.REMIND_ACTIONS, ...T.EVERYDAY_ACTIONS]) assert.ok(ts.includes(`'${a}'`), a);
  for (const k of Object.keys({ ...T.FIELDS_REMIND, ...T.FIELDS_EVERYDAY })) assert.match(ts, new RegExp(`\\n\\s+${k}: \\{`), k);
  assert.match(ts, /kade_notify: kadeNotifyEntry\(/);
  assert.match(ts, /if \(!kadeNotifyRemindOn\(\)\) \{\s+return kadeNotifySchema;/);
  for (const s of T.DESCRIPTION_REMIND.concat(T.ACTION_NOTE_BASE)) assert.doesNotMatch(s, /["']/, 'no quote marks, so the check stays a text search');
});

/* ------------------------------------------------------------ card 6 */

test('a reminder is posted in the chat with that character and the lock screen names nothing; the ledger says delivered', async () => {
  const w = world();
  const said = await act(chat(A, 'remind me to call the clinic at 8'), 'set_reminder', { body: 'Call the clinic about the test results', fire_date: '2026-11-12', fire_time: '08:00' });
  assert.match(said, /^OK\. Reminder set \(id r[0-9a-f]{10}, a reminder\) for Thursday, November 12 at 8:00 AM, their time/);
  assert.equal(w.db.table('kadereminders')[0].fireAt.toISOString(), '2026-11-12T14:00:00.000Z', '8 AM Central in November is 14:00 UTC');
  assert.equal(w.ledger.at(-1).event, 'set');

  w.at('2026-11-12T13:59:00Z');
  assert.equal(await E.sweepDue(), 0, 'not before its minute');
  w.at('2026-11-12T14:00:30Z');
  assert.equal(await E.sweepDue(), 1);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].agentId, HARLEY.agentId);
  assert.equal(w.posts[0].conversationId, `convo-${A.slice(0, 4)}`, 'the conversation it was asked in');
  assert.equal(w.posts[0].text, 'Reminder: Call the clinic about the test results');
  assert.equal(w.pushes[0].body, 'Harley has a reminder for you.');
  assert.doesNotMatch(JSON.stringify(w.pushes), /clinic|results/i, 'no health words on a lock screen');
  assert.equal(w.notes.length, 0);
  const d = w.ledger.at(-1);
  assert.deepEqual([d.event, d.outcome, d.channel], ['delivery', 'delivered', 'push']);
  assert.doesNotMatch(JSON.stringify(w.ledger), /clinic/i, 'the ledger holds no words');
  assert.equal(await E.sweepDue(), 0, 'sent once');
  assert.equal(w.db.table('kadereminders')[0].status, 'sent');
});

test('full wording is the person’s own choice; medicine is still never named on a lock screen', async () => {
  const w = world({ start: '2026-11-11T13:00:00Z' });
  await act(chat(A), 'reminder_wording', { wording: 'full' });
  await act(chat(A), 'set_reminder', { body: 'Take the casserole out', in_minutes: 60 });
  await act(chat(A), 'medicine_add', { name: 'Lisinopril', times: '08:00', days: 'daily' });
  w.at('2026-11-11T14:00:30Z');
  await E.sweepDue();
  const bodies = w.pushes.map((p) => p.body);
  assert.ok(bodies.includes('Reminder: Take the casserole out'), 'full wording shows the words');
  assert.ok(bodies.includes('Harley has a reminder for you.'), 'the medicine push names nothing');
  assert.doesNotMatch(bodies.join(' '), /lisinopril|medicine/i);
  assert.ok(w.posts.some((p) => p.text === 'Time for your 8:00 AM medicine: Lisinopril.'), 'the chat names it');
  assert.equal(E.lockLine({ agentName: 'Harley', kind: 'medicine', message: 'Time for your pills', fullWording: true }), 'Harley has a reminder for you.');
});

test('no phone to reach: the message waits in the chat and that character, only, is told it tried', async () => {
  const w = world({ devices: 0, web: 0 });
  await act(chat(A), 'set_reminder', { body: 'Book the paratransit ride for Friday', label: 'ride booking', in_minutes: 5 });
  w.later(6);
  await E.sweepDue();
  assert.equal(w.posts[0].text, 'Reminder (ride booking): Book the paratransit ride for Friday');
  assert.equal(w.webs.length, 1, 'the browser push is the second try');
  assert.equal(w.notes.length, 1);
  assert.equal(w.notes[0].agentId, HARLEY.agentId, 'kept for the character who set it');
  assert.match(w.notes[0].text, /tried to reach their phone at .* and could not/);
  assert.equal(w.db.table('kadereminders')[0].status, 'missed');
  assert.equal(w.ledger.at(-1).outcome, 'not delivered');
  assert.equal(w.ledger.at(-1).channel, 'chat');
});

test('a browser push counts when the phone has none', async () => {
  const w = world({ devices: 0, web: 1 });
  await act(chat(A), 'timer', { in_minutes: 10 });
  w.later(10);
  await E.sweepDue();
  assert.equal(w.posts[0].text, 'Your 10 minute timer is done.');
  assert.equal(w.webs[0].body, 'Harley has a reminder for you.');
  assert.equal(w.notes.length, 0);
  assert.equal(w.ledger.at(-1).channel, 'web-push');
});

test('check back: at most two messages about one thing', async () => {
  const w = world();
  const first = await act(chat(A), 'set_reminder', { body: 'Refill the blood pressure pills', fire_date: '2026-11-20', fire_time: '08:00' });
  const id = idOf(first);
  const back = await act(chat(A), 'check_back', { body: 'Did the refill get called in?', fire_date: '2026-11-20', fire_time: '18:00', follows: id });
  assert.match(back, /Reminder set \(id r[0-9a-f]{10}, a check-back\)/);
  const third = await act(chat(A), 'check_back', { body: 'Did it get called in yet?', fire_date: '2026-11-21', fire_time: '10:00', follows: idOf(back) });
  assert.match(third, /^FAILED: not set, two messages about one thing is the limit/);
  w.at('2026-11-21T12:00:00Z');
  assert.equal(await E.sweepDue(), 2);
  assert.deepEqual(
    w.posts.map((p) => p.text.replace(/ \(This was due.*$/, '')),
    ['Reminder: Refill the blood pressure pills', 'Checking back, like you asked: Did the refill get called in?'],
  );
  /* Belt and braces: a third row slipped into the chain by any route is never sent. */
  const rows = w.db.table('kadereminders');
  rows.push({ ...rows[1], _id: 'r00000000ff', status: 'pending', fireAt: new Date('2026-11-21T11:00:00Z') });
  await E.sweepDue();
  assert.equal(w.posts.length, 2);
  assert.equal(rows.at(-1).status, 'capped');
});

test('"stop reminders" by text: everything waiting stops, medicine pauses, nothing is sent; asking back resumes medicine', async () => {
  const w = world();
  await act(chat(A), 'set_reminder', { body: 'Water the plants', in_minutes: 60 });
  await act(chat(A), 'medicine_add', { name: 'Vitamin D', times: '09:00', days: 'daily' });
  await act(chat(B), 'set_reminder', { body: 'Other person thing', in_minutes: 60 });
  let wrote = null;
  E._seam.setStopped = (userId, off) => {
    wrote = { userId, off };
    return Promise.resolve();
  };
  assert.equal(E.noteFromWords(chat(A, 'Please stop reminders.')), E.NOTE_OFF);
  assert.deepEqual(wrote, { userId: A, off: true });
  E._seam.setStopped = null;
  await E.setStopped(A, true);
  const rows = w.db.table('kadereminders');
  assert.equal(rows.find((r) => r.userId === A).status, 'stopped');
  assert.equal(rows.find((r) => r.userId === B).status, 'pending', 'never another person’s');
  assert.equal(w.db.table('kademedicines')[0].paused, true);
  assert.match(await act(chat(A), 'set_reminder', { body: 'x', in_minutes: 5 }), /^FAILED: they asked to stop reminders/);
  w.later(24 * 60);
  await E.sweepDue();
  assert.ok(w.posts.every((p) => p.userId === B), 'only the other person hears anything');
  assert.match(await act(chat(A), 'reminders_on'), /^OK\. Reminders are back on/);
  assert.equal(w.db.table('kademedicines')[0].paused, false);
  assert.ok(w.db.table('kademedicines')[0].nextAt > w.clock);
});

test('stop words: the person’s own order, not a story or a question; a plain phone call changes nothing', () => {
  for (const s of ['stop reminders', 'Stop all my reminders please', 'please stop reminding me.', 'no more reminders', 'turn off my reminders', 'turn the reminders off', "don't remind me anymore", 'cancel all my reminders']) {
    assert.equal(E.stopWords(s), 'off', s);
  }
  for (const s of ['stop reminding me about the dentist', 'my phone keeps reminding me', 'she said stop reminders', 'how do I stop reminders?', 'I will not stop reminding him', 'remind me to stop at the store']) {
    assert.equal(E.stopWords(s), null, s);
  }
  assert.equal(E.stopWords('turn my reminders back on'), 'on');
  world();
  let wrote = false;
  E._seam.setStopped = () => {
    wrote = true;
    return Promise.resolve();
  };
  assert.equal(E.noteFromWords(phone(A, 'stop reminders')), E.NOTE_PHONE);
  assert.equal(wrote, false, 'caller ID alone changes nothing');
  assert.equal(E.noteFromWords({ ...chat(A, 'stop reminders'), kadeHiddenRun: true }), '');
  assert.equal(E.noteFromWords(chat(A, 'stop reminders'), { KADE_REMIND_ALL: '0' }), '', 'off switch');
});

test('a plain phone call gets the time and nothing that belongs to a person; app voice and a paired phone do', async () => {
  const w = world();
  for (const [action, data] of [
    ['set_reminder', { body: 'x', in_minutes: 5 }],
    ['list_reminders', {}],
    ['list_read', { list: 'shopping' }],
    ['medicine_list', {}],
    ['contact_read', { name: 'my sister' }],
    ['timer', { in_minutes: 5 }],
  ]) {
    assert.match(await act(phone(A), action, data), /^FAILED: not on a plain phone call/, action);
  }
  assert.match(await act(phone(A), 'now'), /^OK\. It is .* where they are \(America\/Chicago\)\./);
  assert.equal(w.db.table('kadereminders').length, 0);

  const signed = phone(A);
  signed.body.kadeCallerSignedIn = true;
  assert.equal(E.laneOf(signed, {}).lane, 'phone', 'only with the app voice switch');
  assert.equal(E.laneOf(signed, { KADE_STUDIO_APP_VOICE: '1' }).lane, 'app-voice');
  E._seam.pairing = () => true;
  assert.equal(E.laneOf(phone(A), {}).lane, 'paired-phone');
  assert.match(await act(phone(A), 'contact_save', { name: 'my sister', number: '417 555 0100' }), /^OK\. Saved/);
});

/* ------------------------------------------------------------ card 7 */

test('two accounts never see each other’s lists, numbers or reminders; one person’s characters share theirs', async () => {
  const w = world();
  await act(chat(A), 'list_add', { list: 'my shopping list', item: 'milk, eggs, bread' });
  await act(chat(B), 'list_add', { list: 'shopping', item: 'dog food' });
  assert.equal(await act(chat(A), 'list_read', { list: 'shopping' }, LILLY), 'OK. The shopping list has 3 items: milk; eggs; bread.', 'Lilly reads the list Harley started');
  assert.equal(await act(chat(B), 'list_read', { list: 'shopping' }), 'OK. The shopping list has 1 item: dog food.');
  assert.match(await act(chat(B), 'list_read', {}), /1 list: shopping \(1\)/);

  await act(chat(A), 'contact_save', { name: 'my sister', number: '(417) 555-0100' });
  assert.equal(await act(chat(A), 'contact_read', { name: "my sister's number" }, LILLY), 'OK. my sister: (417) 555-0100');
  assert.match(await act(chat(B), 'contact_read', { name: 'my sister' }), /^FAILED: no saved number/);

  const mine = idOf(await act(chat(A), 'set_reminder', { body: 'A private thing', in_minutes: 30 }));
  assert.match(await act(chat(B), 'cancel_reminder', { schedule_id: mine }), /^FAILED: no waiting reminder of theirs/);
  assert.doesNotMatch(await act(chat(B), 'list_reminders'), /private/);
  assert.match(await act(chat(A), 'list_reminders', {}, LILLY), /A private thing/);
  assert.equal(w.db.table('kadereminders')[0].status, 'pending');
  for (const t of ['kadelists', 'kadecontacts', 'kadereminders']) {
    for (const r of w.db.table(t)) assert.ok(r.userId === A || r.userId === B);
  }
});

test('lists: add, remove, read with counts first, and clear only after their own yes in a later message', async () => {
  world();
  assert.match(await act(chat(A), 'list_add', { list: 'to do', item: 'call the landlord, renew library card' }), /Added call the landlord; renew library card to the to-do list/);
  assert.match(await act(chat(A), 'list_add', { list: 'todo', item: 'call the landlord' }), /nothing new .*1 already on it/);
  assert.match(await act(chat(A), 'list_remove', { list: 'to-do', item: 'landlord' }), /^OK\. Took off call the landlord/);
  for (let i = 0; i < 12; i += 1) await act(chat(A), 'list_add', { list: 'groceries', item: `thing ${i}` });
  assert.match(await act(chat(A), 'list_read', { list: 'groceries' }), /^OK\. The groceries list has 12 items\. The first ten:/);

  const ask = chat(A, 'clear my groceries list');
  assert.match(await act(ask, 'list_clear', { list: 'groceries' }), /^Not cleared yet\. Ask them: clear all 12 items/);
  assert.match(await act(ask, 'list_clear', { list: 'groceries' }), /^Not cleared yet/, 'never in the same turn as the ask');
  assert.match(await act(chat(A, 'no wait, not yet'), 'list_clear', { list: 'groceries' }), /^Not cleared yet/);
  await act(chat(A, 'clear my groceries list'), 'list_clear', { list: 'groceries' });
  assert.match(await act(chat(A, 'yes, clear it'), 'list_clear', { list: 'groceries' }), /^OK\. The groceries list is cleared \(12 items/);
  assert.equal(await act(chat(A), 'list_read', { list: 'groceries' }), 'OK. The groceries list is empty.');
});

test('medicine: times per day and days of the week, skip today, pause; doses follow the wall clock across DST', async () => {
  const w = world({ start: '2027-03-13T15:00:00Z' });
  const said = await act(chat(A), 'medicine_add', { name: 'Metformin', times: '8:00, 20:00', days: 'daily' });
  assert.match(said, /^OK\. Reminder set \(id medicine, Metformin\) at 08:00, 20:00 every day/);
  const med = () => w.db.table('kademedicines')[0];
  assert.equal(med().nextAt.toISOString(), '2027-03-14T02:00:00.000Z', 'Saturday 8 PM CST');
  w.at('2027-03-14T02:00:10Z');
  await E.sweepDue();
  assert.equal(med().nextAt.toISOString(), '2027-03-14T13:00:00.000Z', 'Sunday 8 AM is CDT after the clocks change');
  assert.equal(w.posts.at(-1).text, 'Time for your 8:00 PM medicine: Metformin.');

  w.at('2027-03-14T12:00:00Z'); /* Sunday 7 AM CDT: "skip today" means Sunday */
  assert.match(await act(chat(A), 'medicine_change', { name: 'metformin', change: 'skip_today' }), /^OK\. No Metformin reminders for the rest of today/);
  w.at('2027-03-14T13:00:30Z');
  const before = w.posts.length;
  await E.sweepDue();
  assert.equal(w.posts.length, before, 'skipped today');
  assert.equal(w.ledger.at(-1).channel, 'skipped-today');

  assert.match(await act(chat(A), 'medicine_change', { name: 'Metformin', change: 'pause' }), /paused/);
  w.at('2027-03-16T13:00:30Z');
  await E.sweepDue();
  assert.equal(w.posts.length, before);
  assert.match(await act(chat(A), 'medicine_list'), /Metformin: 08:00, 20:00 every day \(paused\)/);

  const weekly = { times: ['09:00'], days: ['mon', 'thu'], tz: 'America/Chicago' };
  assert.equal(E.nextDose(weekly, new Date('2027-03-16T12:00:00Z')).toISOString(), '2027-03-18T14:00:00.000Z', 'Tuesday -> Thursday 9 AM CDT');
  assert.match(await act(chat(A), 'medicine_add', { name: 'x', times: '25:00' }), /^FAILED: medicine_add needs times/);
  assert.match(await act(chat(A), 'medicine_add', { name: 'x', times: '08:00', days: 'someday' }), /^FAILED: days must be/);
});

test('a medicine time hours late goes in the chat only, never a buzz that could prompt a double dose', async () => {
  const w = world({ start: '2026-11-11T12:00:00Z' });
  await act(chat(A), 'medicine_add', { name: 'Warfarin', times: '08:00' });
  w.at('2026-11-11T18:30:00Z');
  await E.sweepDue();
  assert.equal(w.pushes.length, 0);
  assert.match(w.posts[0].text, /could not go out on time\. Check your pill box/);
  assert.equal(w.db.table('kademedicines')[0].nextAt.toISOString(), '2026-11-12T14:00:00.000Z');
});

test('time zones: the person’s own zone, the clocks that skip, the clocks that repeat', async () => {
  const w = world({ start: '2026-11-11T12:00:00Z' });
  assert.match(await act(chat(A), 'set_timezone', { timezone: 'Pacific time' }), /America\/Los_Angeles/);
  assert.match(await act(chat(A), 'now'), /^OK\. It is Wednesday, November 11, 2026 at 4:00 AM where they are \(America\/Los_Angeles\)\./);
  await act(chat(A), 'alarm', { fire_time: '07:00' });
  assert.equal(w.db.table('kadereminders')[0].fireAt.toISOString(), '2026-11-11T15:00:00.000Z', '7 AM Pacific');
  /* The app's own zone is used and kept when the person never said one. */
  assert.match(await act(chat(B, 'what time is it', { timezone: 'America/New_York' }), 'now'), /7:00 AM .*America\/New_York/);
  assert.equal(w.db.table('kadeeverydayprefs').find((p) => p._id === B).tz, 'America/New_York');
  assert.match(await act(chat(B), 'now'), /America\/New_York/, 'stored');

  const chi = 'America/Chicago';
  assert.equal(E.wallToUtc({ y: 2027, m: 3, d: 14, hh: 2, mm: 30 }, chi).toISOString(), '2027-03-14T08:30:00.000Z', '2:30 never happens: 3:30 CDT');
  assert.equal(E.wallToUtc({ y: 2026, m: 11, d: 1, hh: 1, mm: 30 }, chi).toISOString(), '2026-11-01T06:30:00.000Z', '1:30 happens twice: the first');
  assert.equal(E.wallToUtc({ y: 2026, m: 7, d: 4, hh: 12, mm: 0 }, 'Pacific/Honolulu').toISOString(), '2026-07-04T22:00:00.000Z');
  assert.equal(E.nextClock({ hh: 8, mm: 0 }, chi, new Date('2026-11-11T14:30:00Z')).toISOString(), '2026-11-12T14:00:00.000Z', 'past 8 today: tomorrow');
  assert.match(await act(chat(A), 'set_reminder', { body: 'x', fire_date: '2026-11-10', fire_time: '09:00' }), /^FAILED: not set, that time has already passed/);
  assert.match(await act(chat(A), 'set_reminder', { body: 'x', fire_date: '2026-02-30', fire_time: '09:00' }), /^FAILED: not set, fire_date must be/);
  assert.equal(E.zoneFromWords('EST'), 'America/New_York');
  assert.equal(E.zoneFromWords('Mars'), null);
});

test('benefits paperwork and ride booking are plain reminders with a label', async () => {
  const w = world();
  const said = await act(chat(A), 'set_reminder', { body: 'Mail the SNAP recertification form', label: 'benefits paperwork', fire_date: '2026-12-01', fire_time: '10:00' });
  assert.match(said, /a benefits paperwork reminder\) for Tuesday, December 1 at 10:00 AM/);
  w.at('2026-12-01T16:00:30Z');
  await E.sweepDue();
  assert.equal(w.posts[0].text, 'Reminder (benefits paperwork): Mail the SNAP recertification form');
  assert.equal(w.pushes[0].body, 'Harley has a reminder for you.');
});

test('the soonest thing waiting wakes the site; a row stuck mid-send goes back to waiting', async () => {
  const w = world({ start: '2026-11-11T12:00:00Z' });
  await act(chat(A), 'set_reminder', { body: 'later', in_minutes: 120 });
  await act(chat(A), 'medicine_add', { name: 'Iron', times: '07:00' });
  assert.equal((await E.nextDueAt()).toISOString(), '2026-11-11T13:00:00.000Z', 'the 7 AM medicine comes before the reminder');
  const row = w.db.table('kadereminders')[0];
  row.status = 'sending';
  row.claimedAt = new Date('2026-11-11T11:00:00Z');
  await E.sweepDue();
  assert.equal(row.status, 'pending');
});

test('the old sweep runs the new one, and the due reporter counts it', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'kadeNudges.js'), 'utf8');
  assert.match(src, /async function sweepDueReminders\(\) \{\n  const everyday = await sweepEverydayDue\(\);/);
  assert.match(src, /require\('\.\/kadeEveryday'\)\.sweepDue\(\)/);
  assert.match(src, /require\('\.\/kadeEveryday'\)\.nextDueAt\(\)/);
  const bundle = fs.readFileSync(path.resolve(__dirname, 'kadeCallBundle.js'), 'utf8');
  assert.match(bundle, /deliveredAt: null, agentId: null \}/, 'a kept note never rides a phone call');
  const client = fs.readFileSync(path.resolve(__dirname, '../controllers/agents/client.js'), 'utf8');
  assert.match(client, /require\('~\/server\/services\/kadeEveryday'\)\.noteFromWords\(this\.options\.req\)/);
  const init = fs.readFileSync(path.resolve(__dirname, 'Endpoints/agents/initialize.js'), 'utf8');
  assert.match(init, /KADE_REMIND_ALL \|\| ''\) === '0' \? \[\] : \['kade_notify'\]/);
  assert.match(init, /keywordOnly: keywordOnlyHere/);
  const tool = fs.readFileSync(path.resolve(__dirname, '../../app/clients/tools/structured/KadeNotify.js'), 'utf8');
  assert.match(tool, /ownsAction\(wanted\)/);
});

/* ------------------------------------------------- tools by keyword only */

test('kade_notify given to every character rides only when the words call for it; a record that lists it keeps it', async () => {
  const R = require('./kadeToolRetrieval');
  const tools = ['context', 'kade_memory_search', 'kade_notify', 'kade_weather', 'kade_help', 'kade_feedback', 'kade_joke'].map((name) => ({ name, description: name }));
  const embed = async () => [1, 0, 0];
  const sel = (text, keywordOnly, conversationId) =>
    R.selectTools({ tools, text, conversationId, agentId: 'a', embed, keywordOnly });
  R._resetForTests();
  assert.ok(!(await sel('how was your day?', ['kade_notify'], 'k1')).keep.has('kade_notify'), 'given, not asked for: left off');
  assert.ok((await sel('how was your day?', [], 'k2')).keep.has('kade_notify'), 'the record lists it: core, as before');
  for (const t of [
    'remind me at 8 to take my meds',
    'set a timer for ten minutes',
    'add milk to my shopping list',
    'what time is it',
    "what's my sister's number",
    'can you check back with me tonight about the refill',
    'my benefits paperwork is due Friday',
    'I need to book a ride to the clinic',
  ]) {
    R._resetForTests();
    assert.ok((await sel(t, ['kade_notify'], `k-${t.length}`)).keep.has('kade_notify'), t);
  }
  R._resetForTests();
  await sel('put eggs on my grocery list', ['kade_notify'], 'k9');
  assert.ok((await sel('yes', ['kade_notify'], 'k9')).keep.has('kade_notify'), 'stays for the yes in the same conversation');
});
