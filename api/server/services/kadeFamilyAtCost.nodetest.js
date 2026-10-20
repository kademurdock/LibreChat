'use strict';
/* KADE Oct 20 2026 — FAMILY AT COST. Her words: "Yes: the fuller refund ($20.91), plus Amber's
 * failed turns, stop charging failed turns, record her $20 repayment, include the old chat paths,
 * and deploy the at-cost change."
 *
 * A Family pack account (packages/api family/pack.ts familyPack) is charged the real provider price
 * (factor 1) for chat and extras; the administrator stays exempt; everyone else keeps
 * KADE_BILLING_MULTIPLIER. A turn that ends in the recursion limit is recorded but not charged.
 *
 * The pack rule and the transaction writer are TypeScript: when tsx can be loaded (NODE_PATH with
 * tsx, as on kadepc's scratch mirror) they run for real; otherwise those cases are skipped and say so.
 * Run: node --test api/server/services/kadeFamilyAtCost.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const R = require('./kadeRealCost');

const ROOT = path.resolve(__dirname, '../../..');
const ENV = { KADE_BILLING_MULTIPLIER: '2' };
const OFF = { KADE_BILLING_MULTIPLIER: '2', KADE_FAMILY_AT_COST: '0' };

/* Real ids from the Sep 24 account list and library/access.ts. */
const AMBER = { _id: '6a5fc5fa351af41332734161', role: 'USER', username: 'missa', name: 'Amber A', kadeLibraryAccess: 'family' };
const KADE = { _id: '6a3000000000000000000001', role: 'ADMIN', name: 'Kade' };
const NONE = { _id: '6a5ad176c1b837d2fafd4fe5', role: 'USER', name: 'T', kadeLibraryAccess: 'none' };
const REVIEW_SEAT = { _id: '6a6125d73939d20b95251078', role: 'USER', name: 'Visibility Test', kadeLibraryAccess: 'family' };
const PARTY_TEST = { _id: '6a69074cc74d975de21f5b2a', role: 'USER', name: 'Party Test' };
const TEST_GUEST = { _id: '6a5ad176c1b837d2fafd4fe6', role: 'USER', name: 'Test Guest' };
const NEW_ACCOUNT = { _id: 'ffffffff0000000000000001', role: 'USER', name: 'Bob' };

/* ---- the TypeScript pieces, through tsx when it is there --------------------------------- */
let tsx = null;
try {
  require('tsx/cjs/api').register();
  tsx = true;
} catch (_) {
  tsx = false;
}
const realPack = (() => {
  if (!tsx) return null;
  try {
    return require(path.join(ROOT, 'packages/api/src/family/pack.ts')).familyPack;
  } catch (e) {
    return null;
  }
})();
const tx = (() => {
  if (!tsx) return null;
  const original = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === '@librechat/data-schemas') return { CANCEL_RATE: 1.15 };
    return original.call(this, id, parent, isMain);
  };
  try {
    return require(path.join(ROOT, 'packages/api/src/agents/transactions.ts'));
  } catch (e) {
    return null;
  } finally {
    Module._load = original;
  }
})();

/** Sticker rows (USD per million = credits per token) and a db that multiplies them like tx.ts. */
const ROWS = { 'xiaomi/mimo-v2.6-pro': { prompt: 0.435, completion: 0.87 } };
const CACHE = { 'xiaomi/mimo-v2.6-pro': { write: 0.435, read: 0.087 } };
const fakeDb = (x = 2) => ({
  getValueKey: (m) => (ROWS[m] ? m : undefined),
  getMultiplier: ({ model, tokenType }) => (ROWS[model] ? ROWS[model][tokenType] : 6) * x,
  getCacheMultiplier: ({ model, cacheType }) => (CACHE[model] ? CACHE[model][cacheType] * x : null),
});
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

/* ---- who is family ------------------------------------------------------------------------ */

test('the real Family pack rule decides the tier: family at cost, review and test seats never', { skip: !realPack && 'tsx not loadable here' }, () => {
  R.setFamilyPackRuleForTests(realPack);
  try {
    assert.equal(R.payerTier(AMBER, ENV), 'family');
    assert.equal(R.payerTier(KADE, ENV), 'admin');
    assert.equal(R.payerTier(NONE, ENV), 'user', "kadeLibraryAccess 'none' pays the platform factor");
    assert.equal(R.payerTier(REVIEW_SEAT, ENV), 'user', 'the App Review seat is never family, even marked family');
    assert.equal(R.payerTier(PARTY_TEST, ENV), 'user', 'a test seat by id');
    assert.equal(R.payerTier(TEST_GUEST, ENV), 'user', 'a test seat by name');
    assert.equal(R.payerTier(NEW_ACCOUNT, ENV), 'user', 'an account made after the cutoff waits for her yes');
    assert.equal(R.payerTier('USER', ENV), 'user', 'a bare role string is never family');
    assert.equal(R.payerTier(AMBER, OFF), 'user', 'KADE_FAMILY_AT_COST=0 puts family back at 2x');
    assert.equal(R.userPriceFactor(AMBER, ENV), 1);
    assert.equal(R.userPriceFactor(NONE, ENV), 2);
    assert.equal(R.userPriceFactor(REVIEW_SEAT, ENV), 2);
    assert.equal(R.extraChargeUSD(0.165, AMBER, ENV), 0.165, 'a Spotter minute costs her what it cost Kade');
    assert.equal(R.extraChargeUSD(0.165, NONE, ENV), 0.33);
    assert.equal(R.extraChargeUSD(0.165, KADE, ENV), 0, 'the administrator is never charged');
  } finally {
    R.setFamilyPackRuleForTests(null);
  }
});

test('every payer lookup carries kadeLibraryAccess (a lookup without it would fall back to account age)', () => {
  assert.match(R.PAYER_FIELDS, /\bkadeLibraryAccess\b/);
  assert.match(R.PAYER_FIELDS, /\brole\b/);
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('api/models/kadeUsage.js'), /\.select\(PAYER_FIELDS\)/);
  assert.match(read('api/server/services/kadeOnBehalfOf.js'), /kadeLibraryAccess: 1 \}/);
  assert.match(read('api/server/services/kadeOnBehalfOf.js'), /kadeLibraryAccess: u\.kadeLibraryAccess,/);
  assert.match(read('api/server/routes/kade.js'), /User\.findById\(uid\)\.select\(PAYER_FIELDS\)/);
  assert.match(read('api/server/services/kadeTasks.js'), /`kadeAccountType \$\{PAYER_FIELDS\}`/);
  assert.match(read('api/server/services/kadeFunding.js'), /kadeLibraryAccess: 1 \}/);
  /* Ship gate: no price helper is handed a bare .role any more (FalAI keeps it only as the
   * fallback for a payer the request does not hold, which can never be family). */
  for (const rel of [
    'api/models/kadeUsage.js',
    'api/server/routes/kade.js',
    'api/server/routes/kadeAgentBody.js',
    'api/server/routes/kadeCreateCharacter.js',
    'api/server/routes/kadeReadingRoom.js',
    'api/server/routes/kadeSoundBooth.js',
    'api/server/routes/kadeDescribedVideo.js',
    'api/server/services/Endpoints/agents/initialize.js',
    'api/server/controllers/agents/client.js',
  ]) {
    assert.doesNotMatch(read(rel), /(?:userPriceFactor|extraChargeUSD|gaugePricing|chargePricing)\([^)]*\.role\b/, rel);
  }
});

test('an explicit familyPack answer stands in for the lookup; the switch still wins', () => {
  assert.equal(R.payerTier({ role: 'USER', familyPack: true }, ENV), 'family');
  assert.equal(R.payerTier({ role: 'USER', familyPack: false }, ENV), 'user');
  assert.equal(R.payerTier({ role: 'ADMIN', familyPack: false }, ENV), 'admin');
  assert.equal(R.payerTier({ role: 'USER', familyPack: true }, OFF), 'user');
  assert.equal(R.payerTier(null, ENV), 'user');
  assert.equal(R.payerTier(undefined, ENV), 'user');
  assert.equal(R.familyAtCost({}), true, 'on by default');
  assert.equal(R.familyAtCost({ KADE_FAMILY_AT_COST: '1' }), true);
  assert.equal(R.familyAtCost({ KADE_FAMILY_AT_COST: ' 0 ' }), false);
});

test('a broken pack rule never makes anyone family', () => {
  R.setFamilyPackRuleForTests(() => {
    throw new Error('boom');
  });
  try {
    assert.equal(R.payerTier(AMBER, ENV), 'user');
  } finally {
    R.setFamilyPackRuleForTests(null);
  }
});

/* ---- chat pricing ------------------------------------------------------------------------- */

const FAM = { role: 'USER', familyPack: true };
const PERSON = { role: 'USER', familyPack: false };

test('chat pricing: family pays the sticker (factor 1), everyone else db pricing (factor 2), stamped', () => {
  const db = fakeDb(2);
  const args = { model: 'xiaomi/mimo-v2.6-pro', tokenType: 'prompt' };
  const fam = R.chargePricing(FAM, db, ENV);
  near(fam.getMultiplier(args), 0.435);
  near(fam.getCacheMultiplier({ model: 'xiaomi/mimo-v2.6-pro', cacheType: 'read' }), 0.087);
  assert.equal(fam.factor, 1);
  const user = R.chargePricing(PERSON, db, ENV);
  assert.equal(user.getMultiplier, db.getMultiplier, 'exactly db pricing');
  assert.equal(user.factor, 2);
  const admin = R.chargePricing(KADE, db, ENV);
  assert.equal(admin.getMultiplier, db.getMultiplier, "admin rows stay as today (her balance is never drawn)");
  assert.equal(R.chargePricing(FAM, db, OFF).factor, 2, 'switch off: family back at 2x');
  assert.equal(R.chargePricing(FAM, db, OFF).getMultiplier, db.getMultiplier);
  /* The gauge: real for admin and family, db pricing for everyone else. */
  near(R.gaugePricing(FAM, db, ENV).getMultiplier(args), 0.435);
  near(R.gaugePricing(KADE, db, ENV).getMultiplier(args), 0.435);
  assert.equal(R.gaugePricing(PERSON, db, ENV).getMultiplier, db.getMultiplier);
  /* The assistants checkBalance hands only getMultiplier: the family price still divides. */
  near(R.chargePricing(FAM, { getMultiplier: db.getMultiplier }, ENV).getMultiplier(args), 0.435);
  assert.equal(R.chargePricing(FAM, { getMultiplier: db.getMultiplier }, ENV).getCacheMultiplier({}), null);
});

test('the pre-turn balance check estimates a family turn at 1x', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/app/clients/BaseClient.js'), 'utf8');
  assert.match(src, /getMultiplier: require\('~\/server\/services\/kadeRealCost'\)\.chargePricing\(\s*this\.options\?\.req\?\.user,\s*db,\s*\)\.getMultiplier,/);
  const db = fakeDb(2);
  const est = (account) => 50000 * R.chargePricing(account, db, ENV).getMultiplier({ model: 'xiaomi/mimo-v2.6-pro', tokenType: 'prompt' });
  near(est(FAM), 21750);
  near(est(PERSON), 43500);
});

test('the transaction writer stamps kadeFactor and prices family rows at the sticker', { skip: !tx && 'tsx not loadable here' }, async () => {
  const db = fakeDb(2);
  const meta = { user: 'u1', model: 'xiaomi/mimo-v2.6-pro', context: 'message', conversationId: 'c', balance: { enabled: true } };
  const fam = tx.prepareTokenSpend(meta, { promptTokens: 1e6, completionTokens: 1e6 }, R.chargePricing(FAM, db, ENV));
  assert.deepEqual(fam.map((e) => e.doc.kadeFactor), [1, 1]);
  near(fam[0].tokenValue, -435000);
  near(fam[1].tokenValue, -870000);
  near(fam[0].doc.rate, 0.435);
  const person = tx.prepareTokenSpend(meta, { promptTokens: 1e6, completionTokens: 1e6 }, R.chargePricing(PERSON, db, ENV));
  assert.deepEqual(person.map((e) => e.doc.kadeFactor), [2, 2]);
  near(person[0].tokenValue, -870000);
  /* Structured (cached) prompt rows carry the stamp too. */
  const s = tx.prepareStructuredTokenSpend(meta, { promptTokens: { input: 1e6, write: 0, read: 1e6 }, completionTokens: 10 }, R.chargePricing(FAM, db, ENV));
  assert.equal(s[0].doc.kadeFactor, 1);
  near(s[0].tokenValue, -(435000 + 87000));
  /* A pricing with no factor (any old caller) writes no stamp. */
  const plain = tx.prepareTokenSpend(meta, { promptTokens: 10 }, { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier });
  assert.equal('kadeFactor' in plain[0].doc, false);
  /* One balance move for the batch, at the family price. */
  const moves = [];
  const inserted = [];
  await tx.bulkWriteTransactions({ user: 'u1', docs: fam }, {
    insertMany: async (docs) => inserted.push(...docs),
    updateBalance: async (m) => moves.push(m),
  });
  assert.deepEqual(moves, [{ user: 'u1', incrementValue: -1305000 }]);
  assert.equal(inserted.length, 2);
});

/* ---- failed turns ------------------------------------------------------------------------- */

test('a turn that hit the recursion limit is recorded at factor 0: tokens kept, nothing charged', { skip: !tx && 'tsx not loadable here' }, async () => {
  const p = R.unchargedPricing('recursion_limit');
  const meta = { user: 'u1', model: 'xiaomi/mimo-v2.6-pro', context: 'message', conversationId: 'c', balance: { enabled: true } };
  const docs = tx.prepareTokenSpend(meta, { promptTokens: 90000, completionTokens: 71981 }, p);
  assert.deepEqual(docs.map((e) => [e.doc.rawAmount, e.doc.kadeFactor, e.doc.kadeUncharged]), [
    [-90000, 0, 'recursion_limit'],
    [-71981, 0, 'recursion_limit'],
  ]);
  assert.ok(docs.every((e) => e.tokenValue === 0 || Object.is(e.tokenValue, -0)));
  const moves = [];
  await tx.bulkWriteTransactions({ user: 'u1', docs }, { insertMany: async () => {}, updateBalance: async (m) => moves.push(m) });
  assert.ok(moves.every((m) => m.incrementValue === 0), 'the balance does not move');
  /* The real-cost readout still prices the tokens at today's rows. */
  const price = R.createPricer(fakeDb(2), 2);
  const g = { _id: { model: 'xiaomi/mimo-v2.6-pro', tokenType: 'completion', structured: false, afterSwitch: true, kadeFactor: 0 }, raw: 71981, charged: 0, rows: 1 };
  near(R.priceGroup(g, price, 2).realUSD, (71981 * 0.87) / 1e6);
  assert.equal(R.priceGroup(g, price, 2).chargedUSD, 0);
});

/** AgentClient's payer and pricing methods, run in vm against the real kadeRealCost. */
function loadClientPricing() {
  const src = fs.readFileSync(path.join(ROOT, 'api/server/controllers/agents/client.js'), 'utf8');
  const start = src.indexOf('  kadePayer() {');
  const end = src.lastIndexOf('  /**', src.indexOf('  kadeUsageDeps(balance) {'));
  assert.ok(start > 0 && end > start, 'client.js has kadePayer and kadeChargePricing');
  const db = fakeDb(2);
  const ctx = { db, require: (name) => (assert.equal(name, '~/server/services/kadeRealCost'), R) };
  vm.createContext(ctx);
  vm.runInContext(`this.C = class C {\n${src.slice(start, end)}\n};`, ctx);
  return (req, extra = {}) => Object.assign(new ctx.C(), { options: { req } }, extra);
}

test('client.js: the payer is the signed-in person, or the voice caller billed for the turn', () => {
  const make = loadClientPricing();
  const seat = { id: 'kade', role: 'ADMIN' };
  const caller = { id: 'amber', role: 'USER', kadeLibraryAccess: 'family', familyPack: true };
  assert.equal(make({ user: caller }).kadePayer(), caller);
  assert.equal(make({ user: seat, kadeBillTo: 'amber', kadeOnBehalfOf: caller }).kadePayer(), caller, 'a billed voice turn: the caller');
  assert.equal(make({ user: seat, kadeBillTo: 'owner', kadeOnBehalfOf: caller }).kadePayer(), null, 'outreach billed to the owner keeps the platform price');
  assert.equal(make({ user: seat, kadeBillTo: 'amber' }).kadePayer(), null, 'no resolved caller: the platform price');
  const prev = process.env.KADE_BILLING_MULTIPLIER;
  process.env.KADE_BILLING_MULTIPLIER = '2';
  try {
    assert.equal(make({ user: seat, kadeBillTo: 'amber', kadeOnBehalfOf: caller }).kadeChargePricing().factor, 1, 'a family voice caller pays 1x');
    assert.equal(make({ user: { id: 'x', role: 'USER', familyPack: false } }).kadeChargePricing().factor, 2);
    const failed = make({ user: caller }, { kadeUncharged: 'recursion_limit' }).kadeChargePricing();
    assert.equal(failed.factor, 0);
    assert.equal(failed.uncharged, 'recursion_limit');
  } finally {
    if (prev === undefined) delete process.env.KADE_BILLING_MULTIPLIER;
    else process.env.KADE_BILLING_MULTIPLIER = prev;
  }
});

test('client.js: the recursion limit gives a plain line, no raw error, and marks the turn uncharged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/server/controllers/agents/client.js'), 'utf8');
  const helpers = src.slice(src.indexOf('const KADE_RECURSION_REPLY ='), src.indexOf('function kadeStepLimit('));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${helpers}; this.reply = KADE_RECURSION_REPLY; this.is = isKadeRecursionLimit;`, ctx);
  assert.match(ctx.reply, /^I got stuck looking things up/);
  assert.match(ctx.reply, /Try asking again or rephrasing\./);
  assert.doesNotMatch(ctx.reply, /recursion|stop condition/i);
  assert.equal(ctx.is(new Error('Recursion limit of 14 reached without hitting a stop condition. You can increase the limit by setting the `recursionLimit` config key.')), true);
  assert.equal(ctx.is({ name: 'GraphRecursionError', message: '' }), true);
  assert.equal(ctx.is(new Error('Tavily API request failed')), false);
  const handler = src.slice(src.indexOf('const isRecursion = isKadeRecursionLimit(err);'), src.indexOf('} finally {', src.indexOf('const isRecursion = isKadeRecursionLimit(err);')));
  assert.match(handler, /this\.kadeUncharged = 'recursion_limit';/);
  assert.match(handler, /text: KADE_RECURSION_REPLY/);
  /* The raw error part is only for other failures. */
  assert.match(handler, /\} else \{\s+this\.contentParts\.push\(\{\s+type: ContentTypes\.ERROR,/);
  /* Usage and the estimate fallback both price through kadeChargePricing. */
  assert.match(src, /pricing: this\.kadeChargePricing\(\),/);
  assert.match(src, /async recordTokenUsage\(\{[^]*?const pricing = this\.kadeChargePricing\(\);/);
});

/* ---- review: failed turns are uncharged only at the platform's own limit, a few a day -------- */

/* The platform's yaml: agents.recursionLimit 14, maxRecursionLimit 1000 (kade-config.yaml). */
const AGENTS_YAML = { recursionLimit: 14, maxRecursionLimit: 1000 };
const resolveLimit = (() => {
  if (tsx) {
    try {
      return require(path.join(ROOT, 'packages/api/src/agents/config.ts')).resolveRecursionLimit;
    } catch (_) {
      /* fall through */
    }
  }
  /* The same cascade as packages/api/src/agents/config.ts, for runs without tsx. */
  return (cfg, agent) => {
    let limit = cfg?.recursionLimit ?? 50;
    if (typeof agent?.recursion_limit === 'number' && agent.recursion_limit > 0) limit = agent.recursion_limit;
    if (typeof cfg?.maxRecursionLimit === 'number' && cfg.maxRecursionLimit > 0 && limit > cfg.maxRecursionLimit) limit = cfg.maxRecursionLimit;
    return limit;
  };
})();
const limitsFor = (agent) => ({ agent: resolveLimit(AGENTS_YAML, agent), platform: resolveLimit(AGENTS_YAML, {}) });
const SEARCHING = [{ type: 'tool_call', tool_call: { name: 'web_search' } }, { type: 'text', text: 'Let me look that up.' }];
const ANSWERED = [{ type: 'text', text: 'Here is your full answer. '.repeat(12) }, { type: 'tool_call', tool_call: { name: 'kade_wikipedia' } }];

test('failed turns: uncharged at the platform limit; an agent whose limit was lowered to 2 is charged', async () => {
  const none = async () => 0;
  const kiana = await R.failedTurnUncharged({ ...toLimits(limitsFor({})), contentParts: SEARCHING, countRecent: none, env: {} });
  assert.deepEqual(kiana, { uncharged: true, why: 'recursion_limit', recent: 0 });
  const forge = await R.failedTurnUncharged({ ...toLimits(limitsFor({ recursion_limit: 999 })), contentParts: SEARCHING, countRecent: none, env: {} });
  assert.equal(forge.uncharged, true, 'a raised limit (Forge 999) still counts as the platform limit or above');
  const lowered = await R.failedTurnUncharged({ ...toLimits(limitsFor({ recursion_limit: 2 })), contentParts: SEARCHING, countRecent: none, env: {} });
  assert.deepEqual(lowered, { uncharged: false, why: 'agent_limit_below_platform' });
  const thirteen = await R.failedTurnUncharged({ ...toLimits(limitsFor({ recursion_limit: 13 })), contentParts: SEARCHING, countRecent: none, env: {} });
  assert.equal(thirteen.uncharged, false);
  const unknown = await R.failedTurnUncharged({ contentParts: SEARCHING, countRecent: none, env: {} });
  assert.equal(unknown.uncharged, false, 'no limits recorded: charged as usual');
});
function toLimits(l) {
  return { agentLimit: l.agent, platformLimit: l.platform };
}

test('failed turns: the 4th in 24 hours is charged; a streamed answer is charged; the switch and a failed count charge', async () => {
  const at = toLimits(limitsFor({}));
  for (const n of [0, 1, 2]) {
    assert.equal((await R.failedTurnUncharged({ ...at, contentParts: SEARCHING, countRecent: async () => n, env: {} })).uncharged, true, `${n} before`);
  }
  assert.deepEqual(await R.failedTurnUncharged({ ...at, contentParts: SEARCHING, countRecent: async () => 3, env: {} }), { uncharged: false, why: 'daily_cap', recent: 3 });
  assert.equal((await R.failedTurnUncharged({ ...at, contentParts: SEARCHING, countRecent: async () => 3, env: { KADE_UNCHARGED_PER_DAY: '5' } })).uncharged, true);
  assert.equal((await R.failedTurnUncharged({ ...at, contentParts: SEARCHING, countRecent: async () => 0, env: { KADE_UNCHARGED_PER_DAY: '0' } })).uncharged, false);
  assert.deepEqual(await R.failedTurnUncharged({ ...at, contentParts: ANSWERED, countRecent: async () => 0, env: {} }), { uncharged: false, why: 'answer_streamed' });
  assert.deepEqual(await R.failedTurnUncharged({ ...at, contentParts: SEARCHING, countRecent: async () => 0, env: { KADE_UNCHARGED_FAILED_TURNS: '0' } }), { uncharged: false, why: 'switched_off' });
  assert.deepEqual(
    await R.failedTurnUncharged({ ...at, contentParts: SEARCHING, countRecent: async () => { throw new Error('db down'); }, env: {} }),
    { uncharged: false, why: 'count_failed' },
  );
  assert.equal(R.unchargedPerDay({}), 3);
  assert.equal(R.unchargedPerDay({ KADE_UNCHARGED_PER_DAY: 'x' }), 3);
});

test('failed turns: the daily count is distinct uncharged turns for the payer in the last 24 hours', async () => {
  const seen = [];
  const Transaction = { distinct: async (field, q) => (seen.push([field, q]), ['m1', 'm2', null, 'm3']) };
  const now = new Date('2026-10-20T21:00:00Z');
  assert.equal(await R.countUnchargedRecent(AMBER._id, { Transaction, now }), 3);
  assert.equal(seen[0][0], 'messageId');
  assert.deepEqual(seen[0][1], { user: AMBER._id, kadeUncharged: { $exists: true }, createdAt: { $gte: new Date('2026-10-19T21:00:00Z') } });
  assert.equal(await R.countUnchargedRecent(null, { Transaction, now }), 0);
});

test('client.js: the verdict uses the recorded limits and the payer; the 4th failed turn and a lowered agent are charged', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/server/controllers/agents/client.js'), 'utf8');
  const start = src.indexOf('  kadePayer() {');
  const end = src.lastIndexOf('  /**', src.indexOf('  kadeUsageDeps(balance) {'));
  assert.ok(src.slice(start, end).includes('async kadeFailedTurnVerdict()'), 'the verdict sits with the pricing methods');
  const counted = [];
  let recent = 0;
  const realCost = { ...R, countUnchargedRecent: async (user) => (counted.push(user), recent) };
  const ctx = { db: fakeDb(2), require: (name) => (assert.equal(name, '~/server/services/kadeRealCost'), realCost) };
  vm.createContext(ctx);
  vm.runInContext(`this.C = class C {\n${src.slice(start, end)}\n};`, ctx);
  const make = (limits, parts = SEARCHING) =>
    Object.assign(new ctx.C(), { options: { req: { user: AMBER } }, kadeRecursionLimits: limits, contentParts: parts, kadeUsageUser: () => AMBER._id });
  assert.equal((await make(limitsFor({})).kadeFailedTurnVerdict()).uncharged, true);
  assert.deepEqual(counted, [AMBER._id], 'counted for the payer');
  assert.equal((await make(limitsFor({ recursion_limit: 2 })).kadeFailedTurnVerdict()).uncharged, false, 'recursion_limit 2 is charged');
  recent = 3;
  assert.equal((await make(limitsFor({})).kadeFailedTurnVerdict()).why, 'daily_cap', 'the 4th failed turn in a day is charged');
  /* The switch also covers a turn already marked. */
  const prev = process.env.KADE_UNCHARGED_FAILED_TURNS;
  process.env.KADE_UNCHARGED_FAILED_TURNS = '0';
  try {
    const marked = Object.assign(make(limitsFor({})), { kadeUncharged: 'recursion_limit' });
    assert.notEqual(marked.kadeChargePricing().factor, 0);
  } finally {
    if (prev === undefined) delete process.env.KADE_UNCHARGED_FAILED_TURNS;
    else process.env.KADE_UNCHARGED_FAILED_TURNS = prev;
  }
  /* Wiring: chatCompletion records both limits, and the catch marks the turn only on a yes, before
   * the plain line goes in. */
  assert.match(src, /const kadeAgentRecursionLimit = resolveRecursionLimit\(agentsEConfig, this\.options\.agent\);/);
  assert.match(src, /platform: resolveRecursionLimit\(agentsEConfig, \{\}\),/);
  assert.match(src, /recursionLimit: kadeStepLimit\(\s+kadeAgentRecursionLimit,/);
  const handler = src.slice(src.indexOf('const isRecursion = isKadeRecursionLimit(err);'), src.indexOf('} finally {', src.indexOf('const isRecursion = isKadeRecursionLimit(err);')));
  assert.match(handler, /const verdict = await this\.kadeFailedTurnVerdict\(\)[^;]*;\s+if \(verdict\.uncharged\) \{\s+this\.kadeUncharged = 'recursion_limit';\s+\} else \{/);
  assert.ok(handler.indexOf('kadeFailedTurnVerdict') < handler.indexOf('text: KADE_RECURSION_REPLY'));
});

test('client.js: only the graph\'s own recursion error counts, not any message that mentions a recursion limit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/server/controllers/agents/client.js'), 'utf8');
  const helpers = src.slice(src.indexOf('function isKadeRecursionLimit('), src.indexOf('function kadeStepLimit('));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${helpers}; this.is = isKadeRecursionLimit;`, ctx);
  assert.equal(ctx.is(new Error('Recursion limit of 14 reached without hitting a stop condition.')), true);
  assert.equal(ctx.is(new Error('Tool said: the recursion limit was too low')), false);
  assert.equal(ctx.is(new Error('Upstream: Recursion limit of 14 reached')), false);
});

/* ---- the old chat paths ------------------------------------------------------------------- */

test('spendTokensAs writes the legacy rows through the bulk writer at the payer price, and never throws', async () => {
  const calls = [];
  const api = {
    prepareTokenSpend: (data, usage, pricing) => {
      calls.push({ data, usage, factor: pricing.factor });
      return [{ doc: { ...data, kadeFactor: pricing.factor }, tokenValue: -1, balance: data.balance }];
    },
    prepareStructuredTokenSpend: () => [],
    bulkWriteTransactions: async (args, ops) => calls.push({ args, ops }),
  };
  const db = { ...fakeDb(2), bulkInsertTransactions: 'insert', updateBalance: 'update' };
  const prev = process.env.KADE_BILLING_MULTIPLIER;
  process.env.KADE_BILLING_MULTIPLIER = '2';
  try {
    await R.spendTokensAs(FAM, { user: 'u1', model: 'm', context: 'image_generation', conversationId: 'c', balance: { enabled: true }, extra: 'dropped' }, { promptTokens: 5, completionTokens: 7 }, { db, api });
    assert.equal(calls[0].factor, 1);
    assert.equal(calls[0].data.context, 'image_generation');
    assert.equal('extra' in calls[0].data, false, 'only transaction fields go through');
    assert.deepEqual(calls[1].ops, { insertMany: 'insert', updateBalance: 'update' });
    await R.spendTokensAs(PERSON, { user: 'u2', conversationId: 'c' }, { promptTokens: 1 }, { db, api });
    assert.equal(calls[2].factor, 2);
    assert.equal(calls[2].data.context, 'message');
  } finally {
    if (prev === undefined) delete process.env.KADE_BILLING_MULTIPLIER;
    else process.env.KADE_BILLING_MULTIPLIER = prev;
  }
  await R.spendTokensAs(FAM, { user: 'u3' }, {}, { db, api: { prepareTokenSpend: () => { throw new Error('boom'); } } });
});

test('the old chat paths all price for their payer', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const abort = read('api/server/middleware/abortMiddleware.js');
  assert.match(abort, /pricing: require\('~\/server\/services\/kadeRealCost'\)\.chargePricing\(account \?\? null, db\),/);
  assert.match(abort, /account: req\.user,/);
  assert.match(abort, /spendTokensAs\(\s*req\.user,/);
  assert.doesNotMatch(abort, /db\.spendTokens\(\s*\{ \.\.\.responseMessage/);
  for (const rel of ['api/server/controllers/agents/openai.js', 'api/server/controllers/agents/responses.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /pricing: \{ getMultiplier: db\.getMultiplier/, rel);
    assert.match(src, /chargePricing\(req\.user, db\)/, rel);
  }
  for (const rel of ['api/server/controllers/assistants/chatV1.js', 'api/server/controllers/assistants/chatV2.js']) {
    assert.match(read(rel), /getMultiplier: require\('~\/server\/services\/kadeRealCost'\)\.chargePricing\(req\.user, \{/, rel);
  }
  const gemini = read('api/app/clients/tools/structured/GeminiImageGen.js');
  assert.match(gemini, /realCost\.spendTokensAs\(\s*realCost\.payerFromReq\(req, userId\),/);
  assert.doesNotMatch(gemini, /\bspendTokens\(/);
  const threads = read('api/server/services/Threads/manage.js');
  assert.match(threads, /accountOf\(user\)/);
  assert.doesNotMatch(threads, /await spendTokens\(/);
  const client = read('api/server/controllers/agents/client.js');
  assert.doesNotMatch(client, /db\.spendTokens\(\s*\{/, 'the estimate fallback no longer uses spendTokens');
  assert.doesNotMatch(client, /pricing: \{ getMultiplier: db\.getMultiplier/);
});

test('payerFromReq: the request account that is this id, or nobody', () => {
  const user = { id: 'a', role: 'USER' };
  const caller = { id: 'b', role: 'USER' };
  assert.equal(R.payerFromReq({ user }, 'a'), user);
  assert.equal(R.payerFromReq({ user }, undefined), user);
  assert.equal(R.payerFromReq({ user: { id: 'seat' }, kadeOnBehalfOf: caller }, 'b'), caller);
  assert.equal(R.payerFromReq({ user }, 'zzz'), null);
  assert.equal(R.payerFromReq(null, 'a'), null);
  assert.equal(R.payerFromReq({ user: { _id: { toString: () => 'a' } } }, 'a').constructor, Object);
});

/* ---- quotes and audits -------------------------------------------------------------------- */

test('the describer holds and settles a family run at 1x', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/server/routes/kadeDescribedVideo.js'), 'utf8');
  assert.match(src, /familyPack: payerTier\(req\.user\) === 'family',/);
  assert.match(src, /priceFactor: \(actor\) => userPriceFactor\(actor\),/);
  assert.equal(R.userPriceFactor({ id: 'a', role: 'USER', child: false, familyPack: true }, ENV), 1);
  assert.equal(R.userPriceFactor({ id: 'a', role: 'USER', child: false, familyPack: false }, ENV), 2);
  assert.equal(R.userPriceFactor({ id: 'k', role: 'ADMIN', familyPack: false }, ENV), 1);
});

test('a stamped row with no price row falls back to its own factor, an unstamped one to its date', () => {
  const price = R.createPricer(fakeDb(2), 2);
  const g = (kadeFactor) => ({ _id: { model: 'minimax/minimax-m3', tokenType: 'prompt', structured: false, afterSwitch: true, kadeFactor }, raw: 1, charged: -1e6, rows: 1 });
  near(R.priceGroup(g(1), price, 2).realUSD, 1, 'family row charged at 1x');
  near(R.priceGroup(g(2), price, 2).realUSD, 0.5);
  near(R.priceGroup(g(null), price, 2).realUSD, 0.5, 'older rows: the factor of their date');
  const stage = R.txGroupStage({ user: '$user' });
  assert.deepEqual(stage.$group._id.kadeFactor, { $ifNull: ['$kadeFactor', null] });
});

test('the transaction schema keeps kadeFactor and kadeUncharged', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'packages/data-schemas/src/schema/transaction.ts'), 'utf8');
  assert.match(schema, /kadeFactor: \{ type: Number \},/);
  assert.match(schema, /kadeUncharged: \{ type: String \},/);
});
