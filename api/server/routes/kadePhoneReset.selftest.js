/* Behaviour tests for password reset by phone call. Run with no install:
 *
 *   node --test api/server/routes/kadePhoneReset.selftest.js
 *
 * The rules run for real (kadePhoneResetCore.js) against an in-memory store, a
 * fake clock and a fake phone, so every limit and every refusal is exercised.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./kadePhoneResetCore');

const PHONE = '(417) 555-0142';
const DIGITS = '4175550142';
const USER = { _id: 'user-1', email: `p${DIGITS}@phone.kade-ai.invalid` };

function harness({ users = [USER], callFails = false } = {}) {
  let clock = 1_800_000_000_000;
  let nextCode = 0;
  const rows = [];
  const calls = [];
  const updates = [];
  const signedOut = [];
  const logs = [];
  const compares = [];
  const store = {
    create: async (doc) => rows.push({ _id: `row-${rows.length}`, ...doc }),
    recent: async (phone, since) => rows.filter((r) => r.phone === phone && r.createdAt > since),
    countAll: async (since) => rows.filter((r) => r.createdAt > since).length,
    // A copy, as a database read is: what a request holds does not change when another request writes.
    latestActive: async (phone, at) => {
      const row = rows.filter((r) => r.phone === phone && !r.used && r.expiresAt > at).sort((a, b) => b.createdAt - a.createdAt)[0];
      return row ? { ...row } : null;
    },
    // One step, as the database does it: only a row with tries left is counted up.
    claimAttempt: async (id, max) => {
      const row = rows.find((r) => r._id === id && !r.used && r.attempts < max);
      return row ? ++row.attempts : null;
    },
    useAll: async (phone) => rows.filter((r) => r.phone === phone).forEach((r) => (r.used = true)),
  };
  const log = (level) => (...args) => logs.push([level, args.map(String).join(' ')]);
  const rules = core.createPhoneReset({
    findUser: async (query) => users.find((u) => u.email === query.email) || null,
    updateUser: async (id, fields) => updates.push({ id, fields }),
    deleteAllUserSessions: async ({ userId }) => signedOut.push(userId),
    store,
    callCode: async (to, code) => {
      calls.push({ to, code });
      if (callFails) throw new Error('bridge answered 502');
    },
    hash: (value) => `hashed:${value}`,
    compare: (value, digest) => {
      compares.push(value);
      return digest === `hashed:${value}`;
    },
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    now: () => clock,
    randomCode: () => String(123456 + nextCode++).padStart(6, '0'),
  });
  // The call is placed after the answer goes back (so timing reveals nothing);
  // let it land before a test looks at it.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const svc = {
    start: async (args) => {
      const out = await rules.start(args);
      await settle();
      return out;
    },
    finish: rules.finish,
  };
  return { svc, rules, rows, calls, updates, signedOut, logs, compares, advance: (ms) => (clock += ms) };
}

test('the right code sets a hashed password and signs every session out', async () => {
  const h = harness();
  const started = await h.svc.start({ phone: PHONE, ip: '1.2.3.4' });
  assert.strictEqual(started.status, 200);
  assert.deepStrictEqual(h.calls.map((c) => c.to), ['+14175550142']);
  const done = await h.svc.finish({ phone: PHONE, code: h.calls[0].code, password: 'new-password-1' });
  assert.strictEqual(done.status, 200);
  assert.deepStrictEqual(h.updates, [{ id: 'user-1', fields: { password: 'hashed:new-password-1' } }]);
  assert.deepStrictEqual(h.signedOut, ['user-1']);
  const again = await h.svc.finish({ phone: PHONE, code: h.calls[0].code, password: 'another-pass-2' });
  assert.strictEqual(again.status, 400, 'a code works once');
});

test('an unknown number gets the same answer and no call', async () => {
  const h = harness({ users: [] });
  const known = await harness().svc.start({ phone: PHONE, ip: 'a' });
  const unknown = await h.svc.start({ phone: PHONE, ip: 'a' });
  assert.deepStrictEqual(unknown, known);
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(h.rows.length, 0);
});

test('a broken call still answers the same, so the form reveals nothing', async () => {
  const h = harness({ callFails: true });
  const out = await h.svc.start({ phone: PHONE, ip: 'a' });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.message, core.START_MESSAGE);
  assert.ok(h.logs.some(([level]) => level === 'error'));
});

test('five wrong codes cancel the code, even for the right one after', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: 'a' });
  let last;
  for (let i = 0; i < core.MAX_TRIES; i++) {
    last = await h.svc.finish({ phone: PHONE, code: '000000', password: 'new-password-1' });
    assert.strictEqual(last.status, 400);
  }
  assert.match(last.body.message, /cancelled/);
  const right = await h.svc.finish({ phone: PHONE, code: h.calls[0].code, password: 'new-password-1' });
  assert.strictEqual(right.status, 400);
  assert.strictEqual(h.updates.length, 0);
});

test('Nov 10 2026: a burst of guesses sent at once gets five tries, not one try each', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: '1.2.3.4' });
  const right = h.calls[0].code;
  // 200 wrong codes and then the right one, all in flight together: before the fix every one of
  // them read "0 tries used" before any was counted, so all 201 were compared and the right one won.
  const guesses = Array.from({ length: 200 }, (_, i) => String(900000 + i));
  const answers = await Promise.all(
    [...guesses, right].map((code) => h.svc.finish({ phone: PHONE, code, password: 'new-password-1' })),
  );
  assert.strictEqual(h.compares.length, core.MAX_TRIES, 'only five codes were ever compared');
  assert.ok(answers.every((a) => a.status === 400), 'the burst never reached the right code');
  assert.deepStrictEqual(h.updates, [], 'no password was changed');
  assert.strictEqual(h.rows[0].attempts, core.MAX_TRIES);
  assert.strictEqual(h.rows[0].used, true, 'and the code is cancelled');
});

test('Nov 10 2026: the per-address table forgets addresses with nothing in the last hour', async () => {
  const h = harness();
  for (let i = 0; i <= core.IP_TABLE_SWEEP_AT; i++) {
    await h.rules.start({ phone: PHONE, ip: `10.0.${Math.floor(i / 250)}.${i % 250}` });
  }
  assert.strictEqual(h.rules.ipTableSize(), core.IP_TABLE_SWEEP_AT + 1, 'all remembered inside the hour');
  h.advance(61 * 60 * 1000);
  await h.rules.start({ phone: PHONE, ip: '192.0.2.1' });
  await h.rules.start({ phone: PHONE, ip: '192.0.2.2' });
  assert.strictEqual(h.rules.ipTableSize(), 2, 'the 2,001 stale addresses are gone (they were kept for ever)');
  // Ten an hour still holds for a fresh address after the sweep.
  let refused = 0;
  for (let i = 0; i < 12; i++) {
    if ((await h.rules.start({ phone: PHONE, ip: '192.0.2.9' })).status === 429) refused += 1;
  }
  assert.strictEqual(refused, 2);
});

test('the wrong-code message counts down the tries left', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: 'a' });
  const out = await h.svc.finish({ phone: PHONE, code: '999999', password: 'new-password-1' });
  assert.match(out.body.message, /4 tries left/);
});

test('a code expires after ten minutes', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: 'a' });
  h.advance(core.CODE_TTL_MS + 1000);
  const out = await h.svc.finish({ phone: PHONE, code: h.calls[0].code, password: 'new-password-1' });
  assert.strictEqual(out.status, 400);
  assert.match(out.body.message, /expired/);
});

test('one call per number every two minutes, and three a day', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: 'a' });
  await h.svc.start({ phone: PHONE, ip: 'a' });
  assert.strictEqual(h.calls.length, 1, 'a second press within two minutes does not call again');
  h.advance(core.PER_NUMBER_GAP_MS + 1000);
  await h.svc.start({ phone: PHONE, ip: 'b' });
  h.advance(core.PER_NUMBER_GAP_MS + 1000);
  await h.svc.start({ phone: PHONE, ip: 'c' });
  h.advance(core.PER_NUMBER_GAP_MS + 1000);
  await h.svc.start({ phone: PHONE, ip: 'd' });
  assert.strictEqual(h.calls.length, core.PER_NUMBER_DAILY);
  h.advance(24 * 60 * 60 * 1000);
  await h.svc.start({ phone: PHONE, ip: 'e' });
  assert.strictEqual(h.calls.length, core.PER_NUMBER_DAILY + 1, 'the next day it works again');
});

test('the newest code is the one that counts', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: 'a' });
  h.advance(core.PER_NUMBER_GAP_MS + 1000);
  await h.svc.start({ phone: PHONE, ip: 'a' });
  const done = await h.svc.finish({ phone: PHONE, code: h.calls[1].code, password: 'new-password-1' });
  assert.strictEqual(done.status, 200);
});

test('ten starts an hour from one address, then a plain refusal', async () => {
  const h = harness({ users: [] });
  for (let i = 0; i < core.PER_IP_HOURLY; i++) {
    assert.strictEqual((await h.svc.start({ phone: PHONE, ip: 'same' })).status, 200);
  }
  assert.strictEqual((await h.svc.start({ phone: PHONE, ip: 'same' })).status, 429);
  h.advance(60 * 60 * 1000 + 1000);
  assert.strictEqual((await h.svc.start({ phone: PHONE, ip: 'same' })).status, 200);
});

test('the platform stops calling after its daily limit', async () => {
  const users = Array.from({ length: core.PLATFORM_DAILY + 3 }, (_, i) => {
    const d = String(4175550000 + i);
    return { _id: `u${i}`, email: `p${d}@phone.kade-ai.invalid`, d };
  });
  const h = harness({ users });
  for (const u of users) {
    await h.svc.start({ phone: u.d, ip: u.d });
  }
  assert.strictEqual(h.calls.length, core.PLATFORM_DAILY);
});

test('bad input is refused plainly', async () => {
  const h = harness();
  assert.strictEqual((await h.svc.start({ phone: '12345', ip: 'a' })).status, 400);
  await h.svc.start({ phone: PHONE, ip: 'a' });
  assert.match((await h.svc.finish({ phone: PHONE, code: '12', password: 'new-password-1' })).body.message, /six digits/);
  assert.match((await h.svc.finish({ phone: PHONE, code: h.calls[0].code, password: 'short' })).body.message, /8 to 128/);
});

test('logs never carry a code, a password or a full phone number', async () => {
  const h = harness();
  await h.svc.start({ phone: PHONE, ip: 'a' });
  await h.svc.finish({ phone: PHONE, code: '000000', password: 'secret-pass-9' });
  await h.svc.finish({ phone: PHONE, code: h.calls[0].code, password: 'secret-pass-9' });
  const text = h.logs.map(([, line]) => line).join('\n');
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, new RegExp(h.calls[0].code));
  assert.doesNotMatch(text, /secret-pass-9/);
  assert.doesNotMatch(text, new RegExp(DIGITS));
});

test('the wiring hashes with bcrypt cost 10 and mounts public routes only', () => {
  const src = fs.readFileSync(path.join(__dirname, 'kadePhoneReset.js'), 'utf8');
  assert.match(src, /bcrypt\.hashSync\(value, 10\)/);
  assert.match(src, /router\.post\(\s*'\/phone-reset\/start'/);
  assert.match(src, /router\.post\(\s*'\/phone-reset\/finish'/);
  assert.doesNotMatch(src, /logger\.\w+\([^)]*\bcode\b[^)]*\)/, 'the wiring never logs the code');
});
