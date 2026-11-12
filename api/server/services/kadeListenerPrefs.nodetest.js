'use strict';
/* Nov 12 2026 (decision 24): the listener's pace, fillers and delivery on the account.
 * Run: node --test api/server/services/kadeListenerPrefs.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const { buildUpdate, toListenerJson, createListenerPrefsHandlers } = require('./kadeListenerPrefs');

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

/** An in-memory stand-in that applies $set/$unset the way Mongo does for these paths. */
function memoryStore(prefs = { agent_a: 'Voice 27' }) {
  const rows = new Map();
  return {
    rows,
    getVoicePrefs: async () => prefs,
    getListener: async (userId) => rows.get(userId) || null,
    updateListener: async (userId, update) => {
      const row = JSON.parse(JSON.stringify(rows.get(userId) || { userId }));
      for (const [path, value] of Object.entries(update.$set || {})) {
        const v = value instanceof Date ? value.toISOString() : value;
        if (path.startsWith('delivery.')) {
          row.delivery = row.delivery || {};
          row.delivery[path.slice(9)] = v;
        } else {
          row[path] = v;
        }
      }
      for (const path of Object.keys(update.$unset || {})) {
        if (path.startsWith('delivery.') && row.delivery) delete row.delivery[path.slice(9)];
      }
      rows.set(userId, row);
      return row;
    },
  };
}

const quietLogger = { error() {}, warn() {} };

test('buildUpdate takes good values and refuses bad ones field by field', () => {
  const now = new Date('2026-11-12T20:00:00Z');
  const ok = buildUpdate(
    { pace: 1.234, fillers: false, delivery: { agent_a: 'STABLE', 'library-reading': null } },
    now,
  );
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.changed, true);
  assert.deepStrictEqual(ok.update.$set, {
    pace: 1.23,
    paceAt: now,
    fillers: false,
    fillersAt: now,
    'delivery.agent_a': 'STABLE',
    deliveryAt: now,
  });
  assert.deepStrictEqual(ok.update.$unset, { 'delivery.library-reading': '' });

  const character = buildUpdate({ pace: null }, now);
  assert.deepStrictEqual(character.update.$set, { pace: null, paceAt: now });

  const bad = buildUpdate(
    { pace: 3, fillers: 'yes', delivery: { 'a.b': 'STABLE', agent_x: 'LOUD', $where: 'x' } },
    now,
  );
  assert.strictEqual(bad.changed, false);
  assert.deepStrictEqual(
    bad.errors.sort(),
    ['delivery.$where', 'delivery.a.b', 'delivery.agent_x', 'fillers', 'pace'].sort(),
  );
  assert.strictEqual(buildUpdate({ delivery: [] }).changed, false);
  assert.strictEqual(buildUpdate(null).changed, false);
  assert.strictEqual(buildUpdate({ pace: Number.NaN }).changed, false);
});

test('toListenerJson leaves out what was never written, keeps null pace', () => {
  assert.deepStrictEqual(toListenerJson(null), { delivery: {} });
  const at = new Date('2026-11-12T20:00:00Z');
  assert.deepStrictEqual(toListenerJson({ pace: null, paceAt: at }), {
    delivery: {},
    pace: null,
    paceAt: at.toISOString(),
  });
  const json = toListenerJson({
    fillers: true,
    fillersAt: at,
    delivery: new Map([
      ['agent_a', 'BALANCED'],
      ['agent_b', 'junk'],
    ]),
    deliveryAt: at,
  });
  assert.deepStrictEqual(json, {
    delivery: { agent_a: 'BALANCED' },
    fillers: true,
    fillersAt: at.toISOString(),
    deliveryAt: at.toISOString(),
  });
});

test('GET keeps the old prefs map and adds listener beside it', async () => {
  const store = memoryStore();
  const { getPrefs, putListener } = createListenerPrefsHandlers(store, quietLogger);
  const req = { user: { id: 'u1' }, body: { pace: 1.2, fillers: false } };
  const put = fakeRes();
  await putListener(req, put);
  assert.strictEqual(put.statusCode, 200);
  assert.strictEqual(put.body.ok, true);
  assert.strictEqual(put.body.listener.pace, 1.2);
  assert.strictEqual(put.body.listener.fillers, false);
  assert.ok(put.body.listener.paceAt);

  const get = fakeRes();
  await getPrefs({ user: { id: 'u1' } }, get);
  assert.deepStrictEqual(get.body.prefs, { agent_a: 'Voice 27' });
  assert.strictEqual(get.body.listener.pace, 1.2);
  assert.strictEqual(get.body.listener.fillers, false);
  // another account sees nothing of u1's
  const other = fakeRes();
  await getPrefs({ user: { id: 'u2' } }, other);
  assert.deepStrictEqual(other.body.listener, { delivery: {} });
});

test('delivery merges per character and null clears one', async () => {
  const store = memoryStore();
  const { putListener } = createListenerPrefsHandlers(store, quietLogger);
  await putListener(
    { user: { id: 'u1' }, body: { delivery: { agent_a: 'STABLE', agent_b: 'CREATIVE' } } },
    fakeRes(),
  );
  const res = fakeRes();
  await putListener({ user: { id: 'u1' }, body: { delivery: { agent_a: null } } }, res);
  assert.deepStrictEqual(res.body.listener.delivery, { agent_b: 'CREATIVE' });
});

test('nothing usable answers 400 and writes nothing', async () => {
  const store = memoryStore();
  const { putListener } = createListenerPrefsHandlers(store, quietLogger);
  const res = fakeRes();
  await putListener({ user: { id: 'u1' }, body: { pace: 'fast' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(store.rows.size, 0);
});

test('a listener read failure still answers the voice map', async () => {
  const store = memoryStore();
  store.getListener = async () => {
    throw new Error('db down');
  };
  const { getPrefs } = createListenerPrefsHandlers(store, quietLogger);
  const res = fakeRes();
  await getPrefs({ user: { id: 'u1' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { prefs: { agent_a: 'Voice 27' } });
});

test('KADE_LISTENER_PREFS=0: GET is the old shape, PUT is refused', async () => {
  const before = process.env.KADE_LISTENER_PREFS;
  process.env.KADE_LISTENER_PREFS = '0';
  try {
    const store = memoryStore();
    const { getPrefs, putListener } = createListenerPrefsHandlers(store, quietLogger);
    const get = fakeRes();
    await getPrefs({ user: { id: 'u1' } }, get);
    assert.deepStrictEqual(get.body, { prefs: { agent_a: 'Voice 27' } });
    const put = fakeRes();
    await putListener({ user: { id: 'u1' }, body: { pace: 1.2 } }, put);
    assert.strictEqual(put.statusCode, 404);
    assert.strictEqual(store.rows.size, 0);
  } finally {
    if (before === undefined) delete process.env.KADE_LISTENER_PREFS;
    else process.env.KADE_LISTENER_PREFS = before;
  }
});
