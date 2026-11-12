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

/* Review fix (Nov 12 2026): a bridge voice turn carries PHONE_SUFFIX and surface lines after her
 * words, so on the voice lane her words end at the first '[PHONE CALL'. */
const FOLD = '[earlier in this conversation, for context only; do not re-answer]\nYOU: shall I submit?\nTHEM: hmm\n[reply only to what follows.]';
const SUFFIX =
  '\n\n[PHONE CALL — you are literally on the phone with this person right now. ' +
  'Talk the way you naturally would: warm, engaged, conversational. '.repeat(28) +
  ']\n[SURFACE: this is a live voice call inside the Kade-AI app, not a telephone.]\n[The person on this call is Kade.]';
const voice = (said) => ({ user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'kade' }, body: { text: `${FOLD} ${said}${SUFFIX}` } });

test('voice: a spoken plain yes followed by the phone suffix approves the step', async () => {
  assert.ok(SUFFIX.length > 1800);
  const r = await confirm(voice('yes'), true);
  assert.match(r.out, /Approved/);
  assert.equal(r.posted, 1);
  const unfolded = { ...voice('yes'), body: { text: `yes, go ahead${SUFFIX}` } };
  assert.match((await confirm(unfolded, true)).out, /Approved/);
});

test('voice: "yes but wait", a long sentence, or the yes only in the fold does not approve', async () => {
  for (const said of ['yes but wait', 'yes, and then after that I want you to go back to the other page and read me every single heading on it slowly please']) {
    const r = await confirm(voice(said), true);
    assert.match(r.out, /^NOT YET/, said);
    assert.equal(r.posted, 0, said);
  }
  const foldOnly = { ...voice(''), body: { text: `${FOLD.replace('THEM: hmm', 'YOU: yes')}${SUFFIX}` } };
  assert.match((await confirm(foldOnly, true)).out, /^NOT YET/);
});

test('typed chat is not cut: a message that merely contains "[PHONE CALL" text is read whole', async () => {
  const r = await confirm(turn('yes [PHONE CALL note pasted here]'), true);
  assert.match(r.out, /^NOT YET/);
});
