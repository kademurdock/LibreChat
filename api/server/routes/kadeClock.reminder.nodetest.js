const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('missed reminder receipt requires authentication, validates IDs, and is idempotent', async () => {
  const rows = new Map();
  let handler;
  const source = fs.readFileSync(require.resolve('./kadeClock'), 'utf8');
  const start = source.indexOf("router.post('/reminder-missed'");
  const context = { router: { post: (_, fn) => { handler = fn; } },
    authed: (req, res) => req.allowed || (res.status(403).json({ error: 'Unauthorized' }), false),
    logger: { warn() {} },
    require: (id) => id === 'crypto' ? require('node:crypto') : { KadePendingNudge: {
      updateOne: async ({ _id }, update, options) => {
        assert.equal(options.upsert, true);
        if (!rows.has(_id)) rows.set(_id, { ...update.$setOnInsert, deliveredAt: null });
      },
    } },
  };
  vm.runInNewContext(source.slice(start, source.indexOf("router.post('/summary'", start)), context);
  let status = 200, body;
  const res = { status(n) { status = n; return this; }, json(value) { body = value; return this; } };
  const req = { allowed: true, body: { userId: 'a'.repeat(24), reminderId: 'b'.repeat(12), text: 'Synthetic test', fireAt: '2026-09-23T03:00:00Z' } };
  await handler({ ...req, allowed: false }, res);
  assert.equal(status, 403); assert.equal(rows.size, 0);
  await handler({ ...req, body: { ...req.body, reminderId: 'bad' } }, res);
  assert.equal(status, 400); assert.equal(rows.size, 0);
  await handler(req, res);
  assert.equal(body.ok, true); assert.equal(rows.size, 1);
  const receipt = [...rows.values()][0];
  assert.equal(receipt.channel, 'chat');
  assert.match(receipt.text, /could not confirm delivery/);
  receipt.deliveredAt = 'already seen';
  await handler(req, res);
  assert.equal(rows.size, 1); assert.equal(receipt.deliveredAt, 'already seen');
});
