/* Nov 12 2026 (audit SEC-12): a yes to the PC driver's permission question must be Kade's own
 * plain yes, in her own latest message. The character may refuse a step by itself, never allow
 * one. The real KadeDrivePc.js and services/kadeSpendGate.js run here; the bridge is a stand-in.
 * Run: node --test api/app/clients/tools/structured/KadeDrivePc.confirm.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { stubModules } = require('../../../../test/kadeFakeMongo.cjs');

const posts = [];
stubModules({
  axios: {
    post: async (url, body) => {
      posts.push({ url, body });
      return { data: {} };
    },
  },
  '@librechat/agents/langchain/tools': { Tool: class {} },
  '@librechat/data-schemas': { logger: { warn() {}, info() {}, error() {} } },
  '~/server/services/kadeSpendGate': require(path.join(__dirname, '../../../../server/services/kadeSpendGate')),
});
process.env.NVDA_TOOL_SECRET = 'test-only';
process.env.KADE_OWNER_USER_ID = 'kade';
const KadeDrivePc = require('./KadeDrivePc');

const turn = (text, extra = {}) => ({ user: { id: 'kade', role: 'ADMIN' }, body: { text, ...extra } });
async function confirm(req, approve) {
  posts.length = 0;
  const tool = new KadeDrivePc({ req, userId: 'kade', agentName: 'Kiana' });
  const out = await tool._call({ action: 'confirm', run_id: 'r1', approve });
  return { out, posted: posts.length };
}

test('her plain yes approves the step', async () => {
  for (const text of ['yes', 'yes, go ahead', 'ok submit it', 'yes Kiana, press it']) {
    const r = await confirm(turn(text), true);
    assert.match(r.out, /Approved/, text);
    assert.equal(r.posted, 1);
  }
});

test('anything that is not a plain yes holds the step and nothing is sent', async () => {
  for (const text of ['what is it waiting on?', 'yes, but first read me the page', 'no', 'yes, archive it']) {
    const r = await confirm(turn(text), true);
    assert.match(r.out, /^NOT YET: nothing was approved/, text);
    assert.equal(r.posted, 0, text);
  }
});

test('a regenerated reply and a background job never approve', async () => {
  assert.match((await confirm(turn('yes', { isRegenerate: true }), true)).out, /^NOT YET/);
  assert.match((await confirm({ ...turn('yes'), kadeHiddenRun: true }, true)).out, /^NOT YET/);
});

test('refusing a step needs no yes', async () => {
  const r = await confirm(turn('hmm, what was that?'), false);
  assert.match(r.out, /Refused/);
  assert.equal(r.posted, 1);
});
