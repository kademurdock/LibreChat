'use strict';
/* Part 291 review F14 + F36: the admin's real totals count each voice call once, and "charged to
 * balances" is only what people's balances were charged.
 *
 * Voice-stream turns always go through the fork, so their real cost is in a chat meter row (Kade's
 * seat, or the caller's own once voice is billed for real). The bridge's voice_chat estimate is the
 * same turns again: it stays in a caller's "charged" figure (their balance paid it) and out of every
 * real total that already has the meter rows.
 *
 * routes/kade.js needs the whole server to load, so the shipped statements are sliced out of the
 * source and run in vm against plain rows (the same pattern as kadeVoiceBill.nodetest.js).
 * Run: node --test api/server/routes/kadeUsageTotals.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../services/kadeRealCost');

const SRC = fs.readFileSync(path.join(__dirname, 'kade.js'), 'utf8');
function slice(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a > 0, `kade.js still has: ${start}`);
  const b = SRC.indexOf(end, a);
  assert.ok(b > a, `kade.js still has: ${end}`);
  return SRC.slice(a, b);
}
const helpers = slice('const usd = (credits)', 'const monthStart = ');
function run(code, vars, out) {
  const context = { ...vars, isAdminRole: R.isAdminRole, isVoiceEstimate: R.isVoiceEstimate, VOICE_ESTIMATE_SERVICE: R.VOICE_ESTIMATE_SERVICE };
  vm.createContext(context);
  vm.runInContext(`${helpers}\n${code}\n${out}`, context);
  return context;
}

const svc = (allTime, window = allTime) => ({ unit: null, quantity: { allTime: 1, window: 1 }, costUSD: { allTime, window } });
const person = (userId, role, { spend = 0, real = 0, services = {}, balance = 0 } = {}) => ({
  userId,
  name: userId,
  email: null,
  role,
  balanceUSD: balance,
  llmSpendUSD: { allTime: spend, window: spend },
  llmRealUSD: { allTime: real, window: real },
  services,
});

test('/usage: the grand real total counts voice once, and "charged" is other people only', () => {
  const userMap = {
    // Kade's seat: her own chat plus every caller's voice turns, at the charged and real price.
    kade: person('kade', 'ADMIN', { spend: 4, real: 2, services: { voice_chat: svc(0.3), tts: svc(0.05) } }),
    // Amber: typed chat on her own balance, and the voice estimate she was charged for her calls.
    amber: person('amber', 'USER', { spend: 1, real: 0.5, services: { voice_chat: svc(0.4), phone: svc(0.2) }, balance: 3 }),
    old: person('old', null, { spend: 0.2, real: 0.1 }),
  };
  const c = run(slice('    const perUser = Object.values(userMap).sort(', '    let twilio = null;'), { userMap }, 'this.totals = totals;');
  const t = c.totals;
  assert.equal(t.llmSpendUSD.allTime, 5.2, 'the charged meter everyone reads is unchanged');
  assert.equal(t.llmChargedUSD.allTime, 1.2, "F36: Kade's own rows were never charged to any balance");
  assert.equal(t.llmChargedUSD.window, 1.2);
  assert.equal(t.extraSpendUSD.allTime, 0.95, 'unchanged');
  assert.equal(t.voiceEstimateUSD.allTime, 0.7);
  assert.equal(t.extraRealUSD.allTime, 0.25);
  assert.equal(t.grandRealUSD.allTime, 2.85, 'F14: real chat 2.60 + extras 0.25, the voice estimates not added again');
  assert.equal(t.grandRealUSD.window, 2.85);
  assert.equal(t.grandSpendUSD.allTime, 6.15, 'unchanged');
});

test('/books: "cost the server" leaves the voice estimate out; the caller\'s "charged" keeps it', () => {
  const tx = [
    { _id: 'kade', spend: -4e6, turns: 40 },
    { _id: 'amber', spend: -1e6, turns: 10 },
  ];
  const real = [
    { key: { user: 'kade' }, realUSD: 2 },
    { key: { user: 'amber' }, realUSD: 0.5 },
  ];
  const ku = [
    { _id: 'kade', costUSD: 0.35, voiceUSD: 0.3 },
    { _id: 'amber', costUSD: 0.6, voiceUSD: 0.4 },
  ];
  const users = [
    { _id: 'kade', name: 'Kade', role: 'ADMIN' },
    { _id: 'amber', name: 'Amber', role: 'USER' },
  ];
  const c = run(
    slice('    const names = {}; for (const u of users)', '  } catch (e) { out.usersError'),
    { tx, real, ku, users, out: {} },
    'this.result = out;',
  );
  const byId = Object.fromEntries(c.result.users.map((u) => [u.userId, u]));
  assert.equal(byId.kade.totalUSD, 2.05, 'her real chat + speech; her own voice estimate is already in her rows');
  assert.equal(byId.amber.totalUSD, 0.7, 'real chat 0.50 + phone 0.20');
  assert.equal(byId.amber.chargedModelUSD + byId.amber.extrasUSD, 1.6, 'her balance really paid the estimate');
  assert.equal(byId.amber.voiceEstimateUSD, 0.4);
  assert.equal(c.result.totalUSD, 2.75, 'Everyone = the rows added up, each call once');
  // The aggregation really splits the voice estimate out by service name.
  assert.match(SRC, /voiceUSD: \{ \$sum: \{ \$cond: \[\{ \$eq: \['\$service', VOICE_ESTIMATE_SERVICE\] \}, '\$costUSD', 0\] \} \}/);
});

test("/my-cost: an administrator's own voice estimates are not added to her real cost; a caller's are", () => {
  const code = slice('    const subjectAdmin = isAdminRole(', '    const label = ');
  const extras = [
    { _id: 'voice_chat', costUSD: 0.3, quantity: 900 },
    { _id: 'phone', costUSD: 0.2, quantity: 4 },
  ];
  const vars = (role) => ({ subject: { role }, tx: { spend: -2e6, turns: 3 }, real: [{ realUSD: 1 }], extras });
  const admin = run(code, vars('ADMIN'), 'this.r = { extrasUSD, totalUSD, counted };');
  assert.equal(admin.r.extrasUSD, 0.2);
  assert.equal(admin.r.totalUSD, 1.2);
  assert.deepEqual(admin.r.counted.map((r) => r._id), ['phone']);
  const member = run(code, vars('USER'), 'this.r = { extrasUSD, totalUSD };');
  assert.equal(member.r.extrasUSD, 0.5);
  assert.equal(member.r.totalUSD, 1.5);
});

test("/my-usage: an administrator's chat line does not add her voice estimates; a caller's does", () => {
  const code = slice('    const qKey = {', '    month.totalUSD =');
  const blank = () => ({ llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, phoneUSD: 0, otherUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0, phone_minutes: 0 });
  const kuAgg = [
    { _id: { service: 'voice_chat', recent: true }, costUSD: 0.3, quantity: 900 },
    { _id: { service: 'phone', recent: true }, costUSD: 0.2, quantity: 4 },
  ];
  const as = (role) => {
    const all = blank();
    const month = blank();
    all.llmUSD = 1;
    month.llmUSD = 1;
    run(code, { kuAgg, req: { user: { role } }, all, month }, '');
    return { all, month };
  };
  const admin = as('ADMIN');
  assert.equal(admin.all.llmUSD, 1);
  assert.equal(admin.month.llmUSD, 1);
  assert.equal(admin.all.phoneUSD, 0.2);
  const member = as('USER');
  assert.equal(member.all.llmUSD, 1.3);
  assert.equal(member.month.llmUSD, 1.3);
});

test('the dashboard shows the new totals: charged from llmChargedUSD, voice estimates on their own line', () => {
  const pages = fs.readFileSync(path.join(__dirname, 'kadePages.js'), 'utf8');
  assert.match(pages, /charged to other people's balances, all time<\/dt><dd id="t_llm_charged">/);
  assert.match(pages, /<dd id="t_voice_est">/);
  assert.match(pages, /money\(\(t\.llmChargedUSD \|\| t\.llmSpendUSD\)\.allTime\)/);
  assert.match(pages, /money\(\(t\.extraRealUSD \|\| t\.extraSpendUSD\)\.allTime\)/);
  assert.match(pages, /the voice call estimate a caller was charged is in their "charged" figure, not in "cost the server"/);
});
