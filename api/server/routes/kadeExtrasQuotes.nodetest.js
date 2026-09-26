'use strict';
/* Part 295 review (Sep 26 2026): extras are logged at their real cost and the balance pays the
 * platform factor x that (logKadeUsage), so every price a person is asked to accept before spending
 * is their own price: 2x for everyone, the real price for Kade. These are the two pages the lane
 * first missed: the Library's Describe confirm and the character builder's portrait line.
 * Run: node --test api/server/routes/kadeExtrasQuotes.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realCost = require('../services/kadeRealCost');

const ENV = { KADE_BILLING_MULTIPLIER: '2' };
const userPriceFactor = (role) => realCost.userPriceFactor(role, ENV);
const AMBER = { id: 'amber', role: 'USER' };
const KADE = { id: 'kade', role: 'ADMIN' };

function response() {
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
    set() {
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test('the Library Describe confirm quotes what the balance will pay (real for Kade)', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'kadeReadingRoom.js'), 'utf8');
  const from = source.indexOf("router.get('/book/:id/describe/:t/estimate'");
  const to = source.indexOf('/** Anyone who can open the item', from);
  assert.ok(from >= 0 && to > from, 'the estimate route is found');
  const c = {
    router: { get: (_p, ...handlers) => (c.handler = handlers.at(-1)) },
    requireJwtAuth() {},
    openBook: async () => ({ _id: 'b1', tracks: [{ seconds: 7200, mime: 'video/mp4' }] }),
    isMedia: () => true,
    clampInt: (v) => Number(v) || 0,
    /* A two-hour film: the describer's own estimate is the real price. */
    describer: { estimate: (s) => ({ seconds: s, segments: 8, usd: 0.2502, model: 'm' }), ENABLED: () => true, queued: () => 0, progressOf: () => '' },
    userPriceFactor,
  };
  vm.runInNewContext(source.slice(from, to), c);
  const quote = async (user) => {
    const res = response();
    await c.handler({ user, params: { id: 'b1', t: '0' } }, res);
    return res.body;
  };
  const amber = await quote(AMBER);
  assert.equal(amber.usd, 0.5004, 'she confirms the price her balance pays');
  assert.equal(amber.seconds, 7200);
  assert.equal((await quote(KADE)).usd, 0.2502, 'Kade is quoted the real price');
});

test('a finished Library description says what the asker paid (the real cost for Kade)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'kadeReadingRoom.js'), 'utf8');
  const from = source.indexOf('function descriptionCost(');
  const to = source.indexOf("router.get('/book/:id/describe/:t/estimate'", from);
  assert.ok(from >= 0 && to > from, 'the helpers are found');
  const c = { isAdmin: (req) => req.user && req.user.role === 'ADMIN' };
  vm.runInNewContext(source.slice(from, to) + '; this.descriptionCost = descriptionCost; this.descriptionFor = descriptionFor;', c);
  /* Stored as the done handler writes it: the real cost, and what logKadeUsage charged the asker. */
  const charged = realCost.extraChargeUSD(0.04, 'USER', ENV);
  assert.equal(charged, 0.08);
  const d = { state: 'done', summary: 's', scenes: [], costUSD: 0.04, chargedUSD: charged, at: 1 };
  const amber = c.descriptionFor(d, { user: AMBER });
  assert.equal(amber.costUSD, 0.08, 'the confirmed $0.08 is what the page says it cost');
  assert.equal(amber.chargedUSD, undefined);
  assert.equal(c.descriptionFor(d, { user: KADE }).costUSD, 0.04, 'Kade sees the real cost');
  assert.equal(c.descriptionCost({ ...d, chargedUSD: 0 }, { user: AMBER }), 0, 'one Kade asked for names no price');
  assert.equal(c.descriptionCost({ state: 'done', costUSD: 0.04 }, { user: AMBER }), 0.04, 'an older one was charged at its real cost');
  assert.equal(c.descriptionFor({}, { user: AMBER }), null);
  assert.match(source, /chargedUSD = extraChargeUSD\(result\.costUSD, req\.user && req\.user\.role\)/, 'the done handler stores the charge');
});

function loadBuilder(logged) {
  const handlers = {};
  const router = {
    use() {},
    get: (p, ...h) => (handlers[`GET ${p}`] = h.at(-1)),
    post: (p, ...h) => (handlers[`POST ${p}`] = h.at(-1)),
  };
  const express = Object.assign(() => ({}), { Router: () => router, json: () => (_q, _s, next) => next && next() });
  const stubs = {
    express,
    https: {},
    axios: {
      post: async () => ({ data: { choices: [{ message: { content: 'draft' } }], usage: { prompt_tokens: 10000, completion_tokens: 20000 } } }),
    },
    '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
    '~/server/middleware': { requireJwtAuth() {} },
    '~/models/kadeUsage': { logKadeUsage: async (row) => logged.push(row), fluxCost: (_endpoint, n = 1) => 0.03 * n },
    '~/server/services/kadeRealCost': { ...realCost, userPriceFactor },
    './kadePages': { SHARED_HEAD: '' },
    '~/server/services/kadePersonaWriter': {
      PERSONA_CRAFT: 'craft',
      personaUserContent: () => 'content',
      parsePersonaOutput: () => ({ instructions: 'x'.repeat(300), questions: [], notes: '' }),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeCreateCharacter.js'), 'utf8'), {
    module,
    exports: module.exports,
    require: (name) => {
      if (!(name in stubs)) throw new Error('unexpected require ' + name);
      return stubs[name];
    },
    process: { env: { REFRAME_PROXY_SECRET: 'test-only' } },
    Buffer,
    setTimeout,
    console,
  });
  return { handlers, page: module.exports.createCharacterPage };
}

test("the character builder's portrait line and persona price are this person's price", async () => {
  const logged = [];
  const { handlers, page } = loadBuilder(logged);
  const quiz = (user) => {
    const res = response();
    handlers['GET /quiz']({ user }, res);
    return res.body;
  };
  assert.equal(quiz(AMBER).portraitUSD, 0.06, 'a 3-cent portrait takes 6 cents from her balance');
  assert.equal(quiz(AMBER).priceFactor, 2);
  assert.equal(quiz(KADE).portraitUSD, 0.03);
  assert.ok(Array.isArray(quiz(AMBER).quiz));

  const html = response();
  page({}, html);
  assert.doesNotMatch(html.body, /costs 3 cents/, 'no fixed price on the page');
  assert.match(html.body, /it costs '\+portraitPrice\(\)\+' of picture credit/);
  const fn = html.body.match(/function portraitPrice\(\)\{[^\n]*\}/);
  assert.ok(fn, 'the page words its price from the quiz answer');
  const said = (usd) => vm.runInNewContext(`var portraitUSD=${JSON.stringify(usd)}; ${fn[0]} portraitPrice();`);
  assert.equal(said(0.06), '6 cents');
  assert.equal(said(0.03), '3 cents');
  assert.equal(said(null), 'a few cents', 'an old answer without a price still reads sensibly');
  /* Review: both portrait buttons named a fixed 3 cents while a USER pays 6. */
  const CENT = String.fromCharCode(0xa2);
  assert.ok(!html.body.includes('3' + CENT), 'no fixed price on either portrait button');
  assert.match(html.body, /Paint their portrait'\+portraitTag\(\)\+'/);
  assert.match(html.body, /Paint a different one'\+portraitTag\(\)\+'/);
  const tagFn = html.body.match(/function portraitTag\(\)\{[^\n]*\}/);
  assert.ok(tagFn, 'the buttons word their price from the quiz answer');
  const tag = (usd) => vm.runInNewContext(`var portraitUSD=${JSON.stringify(usd)}; ${tagFn[0]} portraitTag();`);
  assert.equal(tag(0.06), ' (6' + CENT + ')');
  assert.equal(tag(0.03), ' (3' + CENT + ')', 'Kade sees the real price');
  assert.equal(tag(null), '', 'an old answer without a price names none');

  const write = async (user) => {
    const res = response();
    await handlers['POST /write-persona']({ user, body: { description: 'A warm, funny neighbour.' } }, res);
    return res.body;
  };
  /* 10,000 in at $0.075/M and 20,000 out at $0.25/M: $0.00575 real. */
  assert.equal((await write(AMBER)).costUSD, 0.0115, 'she is told what her balance paid');
  assert.equal((await write(KADE)).costUSD, 0.00575, 'Kade is told the real cost');
  assert.equal(logged.length, 2);
  assert.ok(logged.every((r) => Math.abs(r.costUSD - 0.00575) < 1e-12), 'the row keeps the real cost; logKadeUsage charges the factor');
});
