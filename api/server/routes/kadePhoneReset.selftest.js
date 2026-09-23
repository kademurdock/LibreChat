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
  const store = {
    create: async (doc) => rows.push({ _id: `row-${rows.length}`, ...doc }),
    recent: async (phone, since) => rows.filter((r) => r.phone === phone && r.createdAt > since),
    countAll: async (since) => rows.filter((r) => r.createdAt > since).length,
    latestActive: async (phone, at) =>
      rows.filter((r) => r.phone === phone && !r.used && r.expiresAt > at).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
    addAttempt: async (id) => ++rows.find((r) => r._id === id).attempts,
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
    compare: (value, digest) => digest === `hashed:${value}`,
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
  return { svc, rows, calls, updates, signedOut, logs, advance: (ms) => (clock += ms) };
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
