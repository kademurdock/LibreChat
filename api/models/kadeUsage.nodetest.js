'use strict';
/* Part 295 (Sep 26 2026), her words: "Yes, double everything." Every paid extra that lands in
 * kadeusage charges everyone but the administrator the platform factor x its real cost; the row
 * keeps costUSD real (her readouts) and records chargedUSD (what the balance paid).
 *
 * kadeUsage.js loads mongoose and data-schemas, so it runs in vm against stand-ins for the User and
 * Balance models; the price rules are the real kadeRealCost module.
 * Run: node --test api/models/kadeUsage.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROLES = { kade: 'ADMIN', amber: 'USER', holly: null };

function load({ multiplier = '2', roleLookupFails = false } = {}) {
  const rows = [];
  const moves = [];
  const warnings = [];
  class Schema {
    constructor(def) {
      this.def = def;
    }
  }
  Schema.Types = { ObjectId: 'ObjectId', Mixed: 'Mixed' };
  const models = {
    KadeUsage: { create: async (row) => rows.push(row) },
    User: {
      findById: (id) => ({
        select: () => ({
          lean: async () => {
            if (roleLookupFails) throw new Error('db down');
            return id in ROLES ? { role: ROLES[id] } : null;
          },
        }),
      }),
    },
    Balance: { updateOne: async (query, update) => moves.push({ user: query.user, inc: update.$inc.tokenCredits }) },
  };
  const mongoose = { Schema, models, model: (name) => models[name] };
  const module = { exports: {} };
  const realCost = require('../server/services/kadeRealCost');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeUsage.js'), 'utf8'), {
    module,
    exports: module.exports,
    process: { env: { KADE_BILLING_MULTIPLIER: multiplier } },
    require: (name) => {
      if (name === 'mongoose') return mongoose;
      if (name === '@librechat/data-schemas') return { logger: { warn: (m) => warnings.push(m), info() {} } };
      if (name === '../server/services/kadeRealCost') {
        /* The real rules, reading this test's platform factor. */
        const env = { KADE_BILLING_MULTIPLIER: multiplier };
        return {
          ...realCost,
          userPriceFactor: (role) => realCost.userPriceFactor(role, env),
          extraChargeUSD: (cost, role) => realCost.extraChargeUSD(cost, role, env),
        };
      }
      throw new Error('unexpected require ' + name);
    },
  });
  return { U: module.exports, rows, moves, warnings };
}

test('a person pays the platform factor x the real cost, and the row keeps the real cost', async () => {
  const { U, rows, moves } = load();
  await U.logKadeUsage({ userId: 'amber', service: 'google_lyria', quantity: 1, unit: 'songs', costUSD: 0.08 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].costUSD, 0.08, 'costUSD stays real for her readouts');
  assert.equal(rows[0].chargedUSD, 0.16);
  assert.deepEqual(moves, [{ user: 'amber', inc: -160000 }]);
});

test('an account with no role set is charged like everyone else', async () => {
  const { U, rows, moves } = load();
  await U.logKadeUsage({ userId: 'holly', service: 'video_live', quantity: 3, unit: 'minutes', costUSD: 0.165 });
  assert.equal(rows[0].chargedUSD, 0.33);
  assert.deepEqual(moves, [{ user: 'holly', inc: -330000 }]);
});

test('the administrator is never charged; her row still carries the real cost', async () => {
  const { U, rows, moves } = load();
  await U.logKadeUsage({ userId: 'kade', service: 'fal_video', quantity: 5, unit: 'seconds', costUSD: 0.42 });
  assert.equal(rows[0].costUSD, 0.42);
  assert.equal(rows[0].chargedUSD, 0);
  assert.deepEqual(moves, []);
});

test('nothing is doubled twice: a $0 voice estimate (already billed as transactions) and free speech cost nothing', async () => {
  const { U, rows, moves } = load();
  await U.logKadeUsage({ userId: 'amber', service: 'voice_chat', quantity: 900, unit: 'tokens', costUSD: 0, metadata: { viaFork: true } });
  await U.logKadeUsage({ userId: 'amber', service: 'tts', quantity: 1200, unit: 'chars' });
  assert.deepEqual(rows.map((r) => r.chargedUSD), [0, 0]);
  assert.deepEqual(moves, []);
});

test('with no factor set the charge is 1x, the way it was before', async () => {
  const { U, rows, moves } = load({ multiplier: '' });
  await U.logKadeUsage({ userId: 'amber', service: 'describe', quantity: 1, unit: 'items', costUSD: 0.003 });
  assert.equal(rows[0].chargedUSD, 0.003);
  assert.deepEqual(moves, [{ user: 'amber', inc: -3000 }]);
});

test('a described-video row is never debited here; it records what its wallet charged', async () => {
  const { U, rows, moves } = load();
  const meta = { source: 'described-video', job: 'j1', kind: 'vision', walletHandled: true };
  await U.logKadeUsage({ userId: 'amber', service: 'describe', quantity: 1, unit: 'requests', costUSD: 0.02, metadata: meta });
  await U.logKadeUsage({ userId: 'amber', service: 'describe', quantity: 1, unit: 'requests', costUSD: 0.02, chargedUSD: 0.04, metadata: meta });
  await U.logKadeUsage({ userId: 'amber', service: 'describe', quantity: 1, unit: 'requests', costUSD: 0.02, metadata: { ...meta, chargedUSD: 0.04 } });
  await U.logKadeUsage({ userId: 'kade', service: 'describe', quantity: 1, unit: 'requests', costUSD: 0.02, chargedUSD: 0.04, metadata: meta });
  /* What its wallet never charges: platform-paid dialogue timing and voice samples. */
  await U.logKadeUsage({ userId: 'amber', service: 'describe', quantity: 1, unit: 'requests', costUSD: 0.01, metadata: { ...meta, kind: 'transcription-included' } });
  await U.logKadeUsage({ userId: 'amber', service: 'describe', quantity: 1, unit: 'requests', costUSD: 0.001, metadata: { ...meta, job: 'voice-sample', kind: 'speech' } });
  assert.deepEqual(rows.map((r) => r.chargedUSD), [0.02, 0.04, 0.04, 0, 0, 0], "1x today, the wallet's own figure when it says one, never Kade, never the included work");
  assert.deepEqual(moves, [], 'the wallet already took the money');
});

test('a refund row gives back exactly what the original charged', async () => {
  const { U, rows, moves } = load();
  await U.logKadeUsage({ userId: 'amber', service: 'fal_video', quantity: 5, unit: 'seconds', costUSD: -0.42, chargedUSD: -0.84, metadata: { refund_for: 'r1' } });
  await U.logKadeUsage({ userId: 'amber', service: 'fal_video', quantity: 5, unit: 'seconds', costUSD: -0.42, metadata: { refund_for: 'r2' } });
  await U.logKadeUsage({ userId: 'amber', service: 'fal_video', quantity: 5, unit: 'seconds', costUSD: -0.42, chargedUSD: -0.42, metadata: { refund_for: 'old-1x' } });
  await U.logKadeUsage({ userId: 'kade', service: 'fal_video', quantity: 5, unit: 'seconds', costUSD: -0.42, chargedUSD: -0.42 });
  assert.deepEqual(rows.map((r) => r.chargedUSD), [-0.84, -0.84, -0.42, 0]);
  assert.deepEqual(moves, [
    { user: 'amber', inc: 840000 },
    { user: 'amber', inc: 840000 },
    { user: 'amber', inc: 420000 },
  ]);
});

test('an unknown payer is never charged (it might be Kade) and the row says so', async () => {
  const { U, rows, moves, warnings } = load({ roleLookupFails: true });
  await U.logKadeUsage({ userId: 'amber', service: 'phone', quantity: 2, unit: 'minutes', costUSD: 0.03 });
  assert.equal(rows[0].costUSD, 0.03);
  assert.equal(rows[0].chargedUSD, 0);
  assert.deepEqual(moves, []);
  assert.match(warnings.join('\n'), /role lookup failed, phone not charged/);
});

test('quotes: the factor a person is shown, and a failed lookup quotes 1x', async () => {
  const { U } = load();
  assert.equal(await U.priceFactorForUser('amber'), 2);
  assert.equal(await U.priceFactorForUser('kade'), 1);
  assert.equal(await U.priceFactorForUser(null), 1);
  assert.equal(await load({ roleLookupFails: true }).U.priceFactorForUser('amber'), 1);
});

test('chargedFor: what a My Creations asset cost its owner; unknown when the account cannot be read', async () => {
  const { U } = load();
  assert.equal(await U.chargedFor('amber', 0.63), 1.26);
  assert.equal(await U.chargedFor('kade', 0.63), 0);
  assert.equal(await load({ roleLookupFails: true }).U.chargedFor('amber', 0.63), undefined);
});

test('deductKadeCredits takes exactly what it is given, never from the administrator', async () => {
  const { U, moves } = load();
  await U.deductKadeCredits('amber', 0.5);
  await U.deductKadeCredits('kade', 0.5);
  await U.deductKadeCredits('amber', -0.5);
  assert.deepEqual(moves, [{ user: 'amber', inc: -500000 }]);
});

test('readers fall back to costUSD on rows written before Part 295 (they were charged 1x)', () => {
  const { U } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(U.CHARGED_USD)), { $ifNull: ['$chargedUSD', '$costUSD'] });
});
