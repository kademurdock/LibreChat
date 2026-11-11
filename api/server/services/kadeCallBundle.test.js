'use strict';
/* The call memory bundle (Nov 10 2026): pinned cards first in the 6,000
 * characters, and waiting reminders that survive a caller that gave up.
 * Runs bare under node:test: no database, no model, a real local HTTP server
 * for the hang-up cases. All names and cards here are invented. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const B = require('./kadeCallBundle.js');

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

/* ── pinned first ─────────────────────────────────────────────────────── */

const filler = (n) => `Talked about garden project number ${n}: ${'the beans and the fence and the rain barrel. '.repeat(4)}`.trim();

function seat() {
  /* Oldest first, as getFormattedMemories writes it. The two cards that matter
   * most are the two OLDEST, which is exactly what newest-kept throws away. */
  const shared = [
    { value: 'Their name is Robin and they like to be called Rob.', date: '2026-01-02' },
    { value: 'Blind; uses a screen reader. Never describe things as "as you can see".', date: '2026-01-03' },
  ];
  const own = [];
  for (let i = 1; i <= 40; i += 1) {
    own.push({ value: filler(i), date: `2026-0${1 + Math.floor(i / 10)}-${String(10 + (i % 10)).padStart(2, '0')}` });
  }
  own.unshift({ value: 'How we talk: plain words, no pity, tease back.', date: '2026-01-04' });
  const fmt = (list) => list.map((m, i) => `${i + 1}. [${m.date}]. ${m.value}`).join('\n\n');
  const text = `# What you generally know about the user\n${fmt(shared)}\n\n# What you specifically remember on your own\n${fmt(own)}`;
  const retrievable = own.slice(1).map((m) => ({ value: m.value }));
  return { text, retrievable, shared, own };
}

test('pinned first: identity and access cards stay when the newest-kept clip would drop them', () => {
  const { text, retrievable, own } = seat();
  assert.ok(text.length > 6000, 'the seat must not fit');
  const out = B.orderPinnedFirst(text, retrievable, 6000);
  assert.ok(out.length <= 6000, `fits: ${out.length}`);
  assert.match(out, /Their name is Robin/);
  assert.match(out, /Blind; uses a screen reader/);
  assert.match(out, /How we talk: plain words/);
  /* then the newest of the rest, and the oldest of the rest go */
  assert.ok(out.includes(own[own.length - 1].value), 'the newest ordinary card is kept');
  assert.ok(!out.includes(own[1].value), 'the oldest ordinary card is dropped');
  assert.match(out, /\(some entries left out to fit\)/);
  /* headers survive and the two sections stay in their order */
  assert.ok(out.indexOf('# What you generally know') < out.indexOf('# What you specifically remember'));
});

test('pinned first: the kept ordinary cards are the newest ones, in their original order', () => {
  const { text, retrievable, own } = seat();
  const out = B.orderPinnedFirst(text, retrievable, 6000);
  const keptIdx = own.map((m, i) => (out.includes(m.value) ? i : -1)).filter((i) => i > 0);
  assert.ok(keptIdx.length >= 5, `several ordinary cards fit: ${keptIdx.length}`);
  const positions = keptIdx.map((i) => out.indexOf(own[i].value));
  assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions, 'original order kept');
  const dates = own.map((m) => m.date);
  const oldestKept = Math.min(...keptIdx.map((i) => Date.parse(dates[i])));
  const newestDropped = Math.max(...own.map((m, i) => (i > 0 && !keptIdx.includes(i) ? Date.parse(m.date) : 0)));
  assert.ok(oldestKept >= newestDropped, 'nothing dropped is newer than something kept');
});

test('pinned first: a bundle that already fits is returned byte for byte', () => {
  const small = '1. [2026-01-02]. Their name is Robin.\n\n2. [2026-02-02]. Likes beans.';
  assert.strictEqual(B.orderPinnedFirst(small, [{ value: 'Likes beans.' }], 6000), small);
});

test('pinned first: with no pin list it is exactly the old newest-kept clip', () => {
  const { text } = seat();
  const { clipKeepNewest } = require('../utils/kadeClipNewest');
  assert.strictEqual(B.orderPinnedFirst(text, null, 6000), clipKeepNewest(text, 6000));
  assert.strictEqual(B.orderPinnedFirst(text, [], 6000), clipKeepNewest(text, 6000));
});

test('pinned first: a reminder card and a corrected card still match their plain words', () => {
  const big = filler(1).repeat(3);
  const text = [
    `1. [2026-01-02]. [User correction] Their name is Robin.`,
    `2. [2026-02-01]. ${big}`,
    `3. [2026-02-02]. ${big} second`,
    `4. [2026-02-03]. Call the dentist (reminder fires 11/12/2026, 09:00 CT)`,
  ].join('\n\n');
  /* the correction and the reminder are NOT in the retrievable list, so they are pinned */
  const out = B.orderPinnedFirst(text, [{ value: big }, { value: `${big} second` }], 700);
  assert.match(out, /Their name is Robin/);
  assert.match(out, /Call the dentist/);
  /* and a retrievable card written with a reminder suffix is still seen as retrievable */
  const text2 = [`1. [2026-01-02]. Their name is Robin.`, `2. [2026-02-01]. ${big} (reminder fires 11/12/2026, 09:00 CT)`, `3. [2026-02-02]. ${big} second`].join('\n\n');
  const out2 = B.orderPinnedFirst(text2, [{ value: big }, { value: `${big} second` }], 700);
  assert.match(out2, /Their name is Robin/);
  assert.ok(!out2.includes('(reminder fires'), 'the older ordinary card went first');
});

test('callCards: asks for the pin split only when the cards do not fit, and the switch turns it off', async () => {
  const { text, retrievable } = seat();
  let asked = 0;
  const getMemorySplit = async () => {
    asked += 1;
    return { retrievable };
  };
  const small = '1. [2026-01-02]. Their name is Robin.';
  assert.strictEqual(await B.callCards({ userId: 'u', agentId: 'a', text: small, getMemorySplit }), small);
  assert.strictEqual(asked, 0);
  const out = await B.callCards({ userId: 'u', agentId: 'a', text, getMemorySplit });
  assert.strictEqual(asked, 1);
  assert.match(out, /Their name is Robin/);

  const { clipKeepNewest } = require('../utils/kadeClipNewest');
  await withEnv({ KADE_CALL_PINNED_FIRST: '0' }, async () => {
    const off = await B.callCards({ userId: 'u', agentId: 'a', text, getMemorySplit });
    assert.strictEqual(off, clipKeepNewest(text, 6000), 'off is the old clip exactly');
    assert.strictEqual(asked, 1, 'and the split is not asked for');
  });
  /* a split that fails, or a small seat (null), falls back to the old clip */
  assert.strictEqual(await B.callCards({ userId: 'u', agentId: 'a', text, getMemorySplit: async () => null }), clipKeepNewest(text, 6000));
  assert.strictEqual(
    await B.callCards({ userId: 'u', agentId: 'a', text, getMemorySplit: async () => { throw new Error('db down'); } }),
    clipKeepNewest(text, 6000),
  );
});

/* ── waiting messages ─────────────────────────────────────────────────── */

function fakeNudges(rows) {
  const store = rows.map((r, i) => ({ _id: `n${i + 1}`, channel: 'chat', deliveredAt: null, type: 'reminder', createdAt: new Date(2026, 0, i + 1), ...r }));
  const model = {
    store,
    find(filter) {
      let out = store.filter(
        (n) => n.userId === filter.userId && n.channel === filter.channel && n.deliveredAt === null && !(filter.type && filter.type.$nin.includes(n.type)),
      );
      const chain = {
        sort: () => {
          out = out.slice().sort((a, b) => a.createdAt - b.createdAt);
          return chain;
        },
        limit: (n) => {
          out = out.slice(0, n);
          return chain;
        },
        lean: async () => out.map((n) => ({ ...n })),
      };
      return chain;
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const n of store) {
        if (filter._id.$in.includes(n._id) && n.deliveredAt === null) {
          n.deliveredAt = update.$set.deliveredAt;
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  };
  return model;
}

const delivered = (model) => model.store.filter((n) => n.deliveredAt !== null).map((n) => n._id);

/* A tiny stand-in for the route: optional delay, then hold + answer. */
function serve({ model, delayMs = 0, results }) {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const held = await B.holdCallNudges({ userId: 'u1', req, res, startedAt, exceptTypes: ['library-digest'], model });
    results.push(held);
    const body = JSON.stringify({ text: `cards${B.waitingBlock(held.pending)}` });
    if (!res.socket || res.socket.destroyed) {
      res.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function get(server, { timeoutMs, keepAlive = true } = {}) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive });
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent, headers: keepAlive ? {} : { Connection: 'close' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        agent.destroy();
        resolve({ ok: true, data });
      });
    });
    req.on('error', () => {
      agent.destroy();
      resolve({ ok: false });
    });
    if (timeoutMs) {
      setTimeout(() => req.destroy(new Error('gave up')), timeoutMs);
    }
  });
}

const closeServer = (server) => new Promise((r) => {
  server.closeAllConnections();
  server.close(r);
});

test('waiting messages: a caller that got the answer has them marked delivered, after the answer', async () => {
  const model = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }, { userId: 'u1', text: 'Digest', type: 'library-digest' }, { userId: 'u2', text: 'someone else' }]);
  const results = [];
  const server = await serve({ model, results });
  try {
    const r = await get(server);
    assert.ok(r.ok);
    assert.match(JSON.parse(r.data).text, /WAITING FOR THIS CALLER[\s\S]*- Reminder: water the beans/);
    assert.doesNotMatch(r.data, /Digest|someone else/);
    assert.strictEqual(results[0].reason, 'offered');
    assert.strictEqual(await results[0].settled, 1);
    assert.deepStrictEqual(delivered(model), ['n1'], 'only what was offered, never the digest or another person');
  } finally {
    await closeServer(server);
  }
});

test('waiting messages: marked on a connection the server closes itself after answering (Connection: close)', async () => {
  const model = fakeNudges([{ userId: 'u1', text: 'Reminder: call the vet' }]);
  const results = [];
  const server = await serve({ model, results });
  try {
    const r = await get(server, { keepAlive: false });
    assert.ok(r.ok);
    assert.strictEqual(await results[0].settled, 1);
    assert.deepStrictEqual(delivered(model), ['n1']);
  } finally {
    await closeServer(server);
  }
});

test('waiting messages: a slow bundle leaves them waiting (the bug: the bridge had already given up)', async () => {
  await withEnv({ KADE_CALL_NUDGE_BUDGET_MS: '150' }, async () => {
    const model = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }]);
    const results = [];
    const server = await serve({ model, results, delayMs: 400 });
    try {
      /* the caller is patient here, so only the budget is being tested */
      const r = await get(server);
      assert.ok(r.ok);
      assert.doesNotMatch(r.data, /WAITING FOR THIS CALLER/, 'a late answer does not carry them');
      assert.strictEqual(results[0].reason, 'slow');
      assert.deepStrictEqual(delivered(model), [], 'and nothing is marked');
    } finally {
      await closeServer(server);
    }
  });
});

test('waiting messages: a caller that hung up before the answer gets nothing marked', async () => {
  await withEnv({ KADE_CALL_NUDGE_BUDGET_MS: '5000' }, async () => {
    const model = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }]);
    const results = [];
    /* inside the budget, but the caller's own timer (100 ms) fires first */
    const server = await serve({ model, results, delayMs: 400 });
    try {
      const r = await get(server, { timeoutMs: 100 });
      assert.strictEqual(r.ok, false, 'the caller gave up');
      await new Promise((res) => setTimeout(res, 600));
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].reason, 'caller-gone');
      assert.deepStrictEqual(delivered(model), []);
    } finally {
      await closeServer(server);
    }
  });
});

test('waiting messages: a hang-up between the read and the answer still marks nothing', async () => {
  /* No server: drive the two events by hand, close first. */
  const { EventEmitter } = require('node:events');
  const model = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }]);
  const socket = new EventEmitter();
  socket.destroyed = false;
  const res = new EventEmitter();
  res.socket = socket;
  res.statusCode = 200;
  const held = await B.holdCallNudges({ userId: 'u1', req: { socket }, res, startedAt: Date.now(), model });
  assert.strictEqual(held.pending.length, 1);
  socket.destroyed = true;
  socket.emit('close');
  res.emit('finish'); /* some stacks still report the write as finished */
  res.emit('close');
  assert.strictEqual(await held.settled, 0);
  assert.deepStrictEqual(delivered(model), []);
  assert.strictEqual(socket.listenerCount('close'), 0, 'no listener left on a kept-alive socket');
});

test('waiting messages: an error answer marks nothing, and an answer that finished late marks nothing', async () => {
  const { EventEmitter } = require('node:events');
  const mk = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    const res = new EventEmitter();
    res.socket = socket;
    res.statusCode = 200;
    return { socket, res };
  };
  const model = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }]);
  const a = mk();
  const heldA = await B.holdCallNudges({ userId: 'u1', req: {}, res: a.res, startedAt: Date.now(), model });
  a.res.statusCode = 500;
  a.res.emit('finish');
  assert.strictEqual(await heldA.settled, 0);

  let t = 1000;
  const b = mk();
  const heldB = await B.holdCallNudges({ userId: 'u1', req: {}, res: b.res, startedAt: 1000, model, clock: () => t });
  assert.strictEqual(heldB.pending.length, 1);
  t = 1000 + B.nudgeBudgetMs() + 1;
  b.res.emit('finish');
  assert.strictEqual(await heldB.settled, 0);
  assert.deepStrictEqual(delivered(model), []);

  /* and the plain good case, by hand */
  const c = mk();
  const heldC = await B.holdCallNudges({ userId: 'u1', req: {}, res: c.res, startedAt: Date.now(), model });
  c.res.emit('finish');
  c.res.emit('close');
  assert.strictEqual(await heldC.settled, 1);
  assert.deepStrictEqual(delivered(model), ['n1']);
});

test('waiting messages: the note to the character is unchanged, and empty when nothing waits', () => {
  assert.strictEqual(B.waitingBlock([]), '');
  assert.strictEqual(B.waitingBlock(undefined), '');
  assert.strictEqual(
    B.waitingBlock([{ text: 'A' }, { text: 'B' }]),
    '\n\n[WAITING FOR THIS CALLER — private note, never read this block aloud or mention a list: these are undelivered reminders/messages they have not heard yet. Work each one in naturally and EARLY, in your own words, one at a time:\n- A\n- B]',
  );
});

test('the route is wired: timed from its first line, cards through callCards, messages held not taken', () => {
  const src = require('node:fs').readFileSync(require.resolve('../routes/kade.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("router.get('/call-memories'");
  const route = src.slice(start, src.indexOf('router.feedPage', start));
  assert.ok(start > 0 && route.length > 500);
  assert.match(route, /^router\.get\('\/call-memories', async \(req, res\) => \{\n {2}const startedAt = Date\.now\(\);/);
  assert.match(route, /callBundle\.callCards\(\{ userId: uid, agentId, text: withoutKeys \|\| '', max: 6000 \}\)/);
  assert.match(route, /callBundle\.holdCallNudges\(\{ userId: uid, req, res, startedAt, limit: 5, exceptTypes: \['library-digest'\], callerWaitMs: req\.query\.wait \}\)/);
  /* the old take-before-answer path exists only behind the off switch */
  const safe = route.indexOf('callBundle.safeNudgesOn()');
  const take = route.indexOf('takePendingChatNudges(uid');
  assert.ok(safe > 0 && take > safe, 'takePendingChatNudges sits in the else branch');
  /* nothing slow may sit between holding the messages and answering */
  const tail = route.slice(route.indexOf('callBundle.waitingBlock(pending)'));
  assert.doesNotMatch(tail.slice(0, tail.indexOf('return res.json')), /await /);
});

test('switches default on and read "0" as off', async () => {
  assert.strictEqual(B.pinnedFirstOn(), true);
  assert.strictEqual(B.safeNudgesOn(), true);
  assert.strictEqual(B.nudgeBudgetMs(), 1800);
  await withEnv({ KADE_CALL_PINNED_FIRST: '0', KADE_CALL_NUDGE_SAFE: '0', KADE_CALL_NUDGE_BUDGET_MS: 'junk' }, async () => {
    assert.strictEqual(B.pinnedFirstOn(), false);
    assert.strictEqual(B.safeNudgesOn(), false);
    assert.strictEqual(B.nudgeBudgetMs(), 1800);
  });
});

test('review fix: the budget follows how long the caller says it waits; a set number wins; junk and no word keep 1,800', async () => {
  assert.strictEqual(B.nudgeBudgetMs('6000'), 5300);
  assert.strictEqual(B.nudgeBudgetMs(6000), 5300);
  assert.strictEqual(B.nudgeBudgetMs('2500'), 1800);
  assert.strictEqual(B.nudgeBudgetMs('15000'), 14300);
  for (const junk of [undefined, null, '', ' ', 'soon', '999', '15001', '-6000', 'NaN', ['6000', '9000'], {}]) {
    assert.strictEqual(B.nudgeBudgetMs(junk), 1800, String(junk));
  }
  await withEnv({ KADE_CALL_NUDGE_BUDGET_MS: '900' }, async () => {
    assert.strictEqual(B.nudgeBudgetMs('6000'), 900);
  });
  await withEnv({ KADE_CALL_NUDGE_CALLER_WAIT: '0' }, async () => {
    assert.strictEqual(B.nudgeBudgetMs('6000'), 1800);
  });
});

test('review fix: a route that took 2 s still hands the messages to a caller that waits 6 s, and to no one that waits 2.5 s', async () => {
  const { EventEmitter } = require('node:events');
  const mk = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    const res = new EventEmitter();
    res.socket = socket;
    res.statusCode = 200;
    return { socket, res };
  };
  const model = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }]);
  /* an older bridge (no word on its wait): 2 s is past the 1.8 s budget */
  const old = mk();
  const heldOld = await B.holdCallNudges({ userId: 'u1', req: {}, res: old.res, startedAt: 1000, model, clock: () => 3000 });
  assert.strictEqual(heldOld.reason, 'slow');
  assert.deepStrictEqual(heldOld.pending, []);
  const short = mk();
  const heldShort = await B.holdCallNudges({ userId: 'u1', req: {}, res: short.res, startedAt: 1000, model, clock: () => 3000, callerWaitMs: '2500' });
  assert.strictEqual(heldShort.reason, 'slow');
  assert.deepStrictEqual(delivered(model), []);
  /* the bridge that waits 6 s gets them, and they are marked once the answer is out */
  let t = 3000;
  const now = mk();
  const held = await B.holdCallNudges({ userId: 'u1', req: {}, res: now.res, startedAt: 1000, model, clock: () => t, callerWaitMs: '6000' });
  assert.strictEqual(held.reason, 'offered');
  assert.strictEqual(held.pending.length, 1);
  t = 3200;
  now.res.emit('finish');
  assert.strictEqual(await held.settled, 1);
  assert.deepStrictEqual(delivered(model), ['n1']);
  /* past even that caller's patience they stay waiting */
  const model2 = fakeNudges([{ userId: 'u1', text: 'Reminder: water the beans' }]);
  const late = mk();
  const heldLate = await B.holdCallNudges({ userId: 'u1', req: {}, res: late.res, startedAt: 1000, model: model2, clock: () => 6400, callerWaitMs: '6000' });
  assert.strictEqual(heldLate.reason, 'slow');
  assert.deepStrictEqual(delivered(model2), []);
});
