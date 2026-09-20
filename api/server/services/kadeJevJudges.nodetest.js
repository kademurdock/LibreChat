'use strict';
/* Part 236 (Sep 20 2026). Plain node:test, not jest (the name keeps jest's
 * testMatch off it): kadeJev.js and kadeJevJudges.js have no app dependencies,
 * so this runs anywhere, including the Deno shim on kadepc:
 *   node --test api/server/services/kadeJevJudges.nodetest.js
 * No network: fetch and ask are stubbed. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jev = require('./kadeJev');
const J = require('./kadeJevJudges');

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
  let r;
  try {
    r = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}
const ON = { TYPESAFE_API_KEY: 'apikey_test', KADE_JEV: undefined, KADE_JEV_LIBRARY: undefined, KADE_JEV_KEEPER_SHADOW: undefined, KADE_JEV_TOOLS_SHADOW: undefined };

test('enabled: needs a key, obeys the master kill and the per-feature kill', () => {
  withEnv({ ...ON, TYPESAFE_API_KEY: undefined }, () => assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), false));
  withEnv(ON, () => assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), true));
  withEnv({ ...ON, KADE_JEV: '0' }, () => assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), false));
  withEnv({ ...ON, KADE_JEV_LIBRARY: '0' }, () => {
    assert.strictEqual(jev.enabled('KADE_JEV_LIBRARY'), false);
    assert.strictEqual(jev.enabled('KADE_JEV_TOOLS_SHADOW'), true);
  });
});

test('ask: throws with no key and never calls fetch', async () => {
  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, json: async () => ({ answers: {} }) }; };
  try {
    await withEnv({ ...ON, TYPESAFE_API_KEY: undefined }, () => assert.rejects(jev.ask({}, {}), /disabled/));
    assert.strictEqual(called, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('ask: pins the model, sends the bearer, counts ok and failed, throws on HTTP and on no answers', async () => {
  const realFetch = global.fetch;
  try {
    await withEnv(ON, async () => {
      let seen = null;
      global.fetch = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ answers: { a: { noul: 0.5 } } }) }; };
      const ok0 = jev.counts.ok;
      const r = await jev.ask({ message: 'hi' }, { a: { type: 'noul' } });
      assert.strictEqual(r.answers.a.noul, 0.5);
      assert.strictEqual(jev.counts.ok, ok0 + 1);
      const body = JSON.parse(seen.opts.body);
      assert.strictEqual(body.model, jev.MODEL);
      assert.notStrictEqual(body.model, 'jev-latest');
      assert.strictEqual(seen.opts.headers.Authorization, 'Bearer apikey_test');

      const f0 = jev.counts.failed;
      global.fetch = async () => ({ ok: false, status: 500 });
      await assert.rejects(jev.ask({}, {}), /HTTP 500/);
      global.fetch = async () => ({ ok: true, json: async () => ({}) });
      await assert.rejects(jev.ask({}, {}), /no answers/);
      global.fetch = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
      await assert.rejects(jev.ask({}, {}, 20), /timeout 20ms/);
      assert.strictEqual(jev.counts.failed, f0 + 3);
      assert.strictEqual(JSON.stringify(jev.health()).includes('apikey_test'), false);
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('the shelf slugs are exactly the 26 shelves of the sort route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'kadeReadingRoomSort.js'), 'utf8');
  const m = src.match(/const SHELVES = (\[[\s\S]*?\]);/);
  assert.ok(m, 'SHELVES found in the route');
  const SHELVES = vm.runInNewContext(m[1]);
  assert.strictEqual(SHELVES.length, 26);
  assert.deepStrictEqual(Object.values(J.SHELF_OF).sort(), [...SHELVES].sort());
  assert.deepStrictEqual(Object.keys(J.SHELF_OF).sort(), Object.keys(J.SHELF_CRITERIA).sort());
});

const ans = (choice, confidence, noul) => ({ shelf: { choice, confidence }, adult: { noul } });
const plain = { _id: '1', title: 'The Silent Witness', synopsis: 'A detective has 48 hours.' };

test('decideBook: files only when sure of the shelf AND decisive on adult', () => {
  withEnv({ KADE_JEV_LIBRARY_MIN_CONF: undefined, KADE_JEV_LIBRARY_ADULT_LOW: undefined, KADE_JEV_LIBRARY_ADULT_HIGH: undefined }, () => {
    assert.deepStrictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.99, 0.04)), { shelf: 'Fiction — Mystery & thriller', adult: false });
    assert.equal(J.decideBook(plain, ans('fiction_romance', 0.95, 0.97)), null, 'an adult reading goes to the second reader: Jev alone never hides a book');
    assert.strictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.69, 0.04)), null, 'unsure shelf');
    assert.strictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.99, 0.16)), null, 'adult between the lines');
    assert.strictEqual(J.decideBook(plain, ans('fiction_mystery_thriller', 0.99, 0.84)), null, 'adult between the lines');
    assert.strictEqual(J.decideBook(plain, ans('made_up_shelf', 0.99, 0.01)), null, 'unknown shelf');
    assert.strictEqual(J.decideBook(plain, { shelf: { choice: 'poetry', confidence: 0.99 } }), null, 'no adult answer');
    assert.strictEqual(J.decideBook(plain, null), null);
  });
});

test('decideBook: a "not adult" is never taken on trust when the metadata uses an adult word', () => {
  const erotic = { _id: '2', title: 'Bound to Him: An Erotic Novel', synopsis: 'A billionaire.' };
  assert.strictEqual(J.decideBook(erotic, ans('fiction_romance', 0.99, 0.02)), null);
  assert.equal(J.decideBook(erotic, ans('fiction_romance', 0.99, 0.99)), null);
  const coy = { _id: '3', title: 'After Dark', synopsis: 'Tales of desire. Adults only.' };
  assert.strictEqual(J.decideBook(coy, ans('fiction_short_stories', 0.99, 0.02)), null);
  assert.strictEqual(J.decideBook(plain, ans('nonfiction_sex_dating', 0.99, 0.02)), null, 'sex shelf + not adult = second reader');
});

test('sortBooks: failures and the undecided go to leftovers in order; never throws', async () => {
  await withEnv(ON, async () => {
    const books = [{ _id: 'a', title: 'A' }, { _id: 'b', title: 'B' }, { _id: 'c', title: 'C' }, { _id: 'd', title: 'D' }];
    const ask = async (state) => {
      if (state.title === 'B') throw new Error('timeout');
      if (state.title === 'D') return { answers: ans('poetry', 0.5, 0.01), usage: { input_tokens: 1000 } };
      return { answers: ans('poetry', 0.99, 0.01), usage: { input_tokens: 1000 } };
    };
    const r = await J.sortBooks(books, { ask });
    assert.deepStrictEqual(Object.keys(r.out).sort(), ['a', 'c']);
    assert.deepStrictEqual(r.leftovers.map((b) => b._id), ['b', 'd']);
    assert.ok(Math.abs(r.costUSD - (3000 * 0.042) / 1e6) < 1e-12);
  });
});

test('sortBooks: switched off, every book is a leftover and Jev is never asked', async () => {
  let asked = 0;
  const ask = async () => { asked++; return { answers: ans('poetry', 0.99, 0.01) }; };
  const books = [{ _id: 'a', title: 'A' }];
  for (const env of [{ ...ON, KADE_JEV_LIBRARY: '0' }, { ...ON, KADE_JEV: '0' }, { ...ON, TYPESAFE_API_KEY: undefined }]) {
    const r = await withEnv(env, () => J.sortBooks(books, { ask }));
    assert.deepStrictEqual(r.out, {});
    assert.strictEqual(r.leftovers.length, 1);
  }
  assert.strictEqual(asked, 0);
});

test('keeperState: last human turn is latestUser, voice tags stripped, langchain and plain shapes', () => {
  const msgs = [
    { _getType: () => 'human', content: 'my cat is Kasper' },
    { _getType: () => 'ai', content: [{ type: 'text', text: 'Good name.' }] },
    { role: 'user', content: '%%%warm%%% we got a kitten, Biscuit' },
  ];
  const s = J.keeperState(msgs);
  assert.strictEqual(s.latestUser, 'we got a kitten, Biscuit');
  assert.ok(s.earlier.includes('PERSON: my cat is Kasper'));
  assert.ok(s.earlier.includes('ASSISTANT: Good name.'));
  assert.strictEqual(J.keeperState([{ role: 'assistant', content: 'hi' }]), null);
  assert.strictEqual(J.keeperState(null), null);
});

test('keeperWrote: reads cards from attachments, the logbook from the flag', () => {
  const card = { type: 'memory', memory: { type: 'update', key: 'cat' } };
  const err = { type: 'memory', memory: { type: 'error', key: 'cat' } };
  assert.strictEqual(J.keeperWrote({ attachments: [card], logged: false }), 'card');
  assert.strictEqual(J.keeperWrote({ attachments: [null, card], logged: true }), 'card+log');
  assert.strictEqual(J.keeperWrote({ attachments: [], logged: true }), 'log');
  assert.strictEqual(J.keeperWrote({ attachments: [err, null], logged: false }), 'nothing');
  assert.strictEqual(J.keeperWrote({ attachments: undefined, logged: false }), 'nothing');
  assert.strictEqual(J.keeperWrote({ failed: true }), 'error');
});

test('keeper shadow: one line, never rejects, silent when off or when Jev fails', async () => {
  const msgs = [{ role: 'user', content: 'we got a kitten' }];
  const lines = [];
  const log = (l) => lines.push(l);
  await withEnv(ON, async () => {
    const good = J.keeperShadowStart(msgs, { ask: async () => ({ answers: { card: { noul: 0.891 }, log: { noul: 0.9 } } }) });
    J.keeperShadowFinish(good, { attachments: [{ memory: { type: 'update' } }], logged: false, messageId: 'm1', log });
    await good;
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(lines, ['[kadeJev][keeper-shadow] card=0.89 log=0.90 keeper_wrote=card msg=m1']);

    const bad = J.keeperShadowStart(msgs, { ask: async () => { throw new Error('timeout'); } });
    assert.strictEqual(await bad, null);
    J.keeperShadowFinish(bad, { log });
    const malformed = J.keeperShadowStart(msgs, { ask: async () => ({ answers: { card: {}, log: {} } }) });
    assert.strictEqual(await malformed, null);
    J.keeperShadowFinish(null, { log });
    J.keeperShadowFinish(good, { log: () => { throw new Error('logger down'); } });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lines.length, 1);
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_KEEPER_SHADOW: '0' }, () => J.keeperShadowStart(msgs, { ask: async () => { asked++; } }));
  assert.strictEqual(off, null);
  assert.strictEqual(asked, 0);
});

test('tools shadow: asks only about loaded tools, logs one line, never rejects, never touches keep', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  await withEnv(ON, async () => {
    let seenQ = null;
    let seenState = null;
    const ask = async (state, questions) => {
      seenState = state;
      seenQ = questions;
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: k === 'kade_news' ? 0.96 : 0.05 };
      return { answers };
    };
    const keep = new Set(['kade_weather', 'kade_help']);
    const r = await J.toolsShadow({ text: '%%%tag%%% whats the news looking like tonight', tools: ['kade_news', 'kade_weather', 'kade_help', 'kade_joke'], keep, log }, { ask });
    assert.deepStrictEqual(Object.keys(seenQ).sort(), ['kade_news', 'kade_weather']);
    assert.strictEqual(seenState.message, 'whats the news looking like tonight');
    assert.strictEqual(r.kade_news, 0.96);
    assert.deepStrictEqual(lines, ['[kadeJev][tools-shadow] kept=[kade_weather] jev={kade_news:0.96,kade_weather:0.05}']);
    assert.deepStrictEqual([...keep], ['kade_weather', 'kade_help']);

    assert.strictEqual(await J.toolsShadow({ text: 'hi', tools: ['kade_news'], keep, log }, { ask: async () => { throw new Error('HTTP 500'); } }), null);
    assert.strictEqual(await J.toolsShadow({ text: 'hi', tools: ['kade_joke'], keep, log }, { ask }), null, 'none of the five loaded');
    assert.strictEqual(await J.toolsShadow({ text: '', tools: ['kade_news'], keep, log }, { ask }), null);
    assert.strictEqual(lines.length, 1);
  });
  let asked = 0;
  const off = await withEnv({ ...ON, KADE_JEV_TOOLS_SHADOW: '0' }, () => J.toolsShadow({ text: 'news?', tools: ['kade_news'], keep: new Set(), log }, { ask: async () => { asked++; } }));
  assert.strictEqual(off, null);
  assert.strictEqual(asked, 0);
});
