/* Nov 14 2026: Kade's test call with Kiana. Two things she heard from the phone tool's side:
 *  - the call opened "Hi! It's Kiana! ... kade wants to know ..." because the tool had no way to say
 *    the call was to a business, so a registered number always got the friend greeting;
 *  - Kiana said "message me back later and I'll tell you what they said", because the tool told her
 *    to say she'd "have the answer when they next check in". Her words: "It should be like, they
 *    message you when they're done with the call."
 * Now the tool sends business (and the older bridge's disclose), the chat's conversationId and
 * reportBack:true, and tells the character it will message the person when the bridge says so.
 *
 * Run: node --test api/app/clients/tools/structured/KadePhoneCall.reportback.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONVO = '5fc62783-1111-4222-8333-944445555666';

function loadTool(replies = {}) {
  const posts = [];
  const stubs = {
    axios: {
      post: async (url, body) => {
        posts.push({ url, body });
        if (url.endsWith('/outbound/result')) return { data: replies.result || { found: false } };
        return { data: { to: '+14175550100', timeLimitMin: 15, callsLeftToday: 3, ...(replies.placed || {}) } };
      },
    },
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
    '~/server/services/kadeRealCost': require('../../../../server/services/kadeRealCost'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadePhoneCall'), 'utf8'), {
    module,
    require: (name) => {
      if (!(name in stubs)) throw new Error('unexpected require ' + name);
      return stubs[name];
    },
    process: { env: { BRIDGE_SECRET: 'test-only', BRIDGE_URL: 'https://bridge.invalid' } },
  });
  return { Tool: module.exports, posts };
}

const KADE = { id: 'u-kade', role: 'ADMIN', name: 'Kade' };
const fields = (extra = {}) => ({
  userId: 'u-kade', actingUserId: 'u-kade', userName: 'Kade Murdock', agentId: 'agent_kiana', agentName: 'Kiana',
  req: { user: KADE }, conversationId: CONVO, ...extra,
});

test('HER TEST CALL: "call this gas station" goes out as a business call that reports back into this chat', async () => {
  const { Tool, posts } = loadTool({ placed: { reportBack: true, business: true } });
  const tool = new Tool(fields());
  const out = await tool._call({
    to_number: '4175550100',
    purpose: 'ask if you have any deals on hemp products right now',
    business: true,
    details: 'Especially THCP vapes and disposables: what is in stock and the prices.',
  });
  const body = posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal(body.business, true);
  assert.equal(body.disclose, true, "an older bridge's word for the same greeting");
  assert.equal(body.unregisteredIsBusiness, true, 'a number nobody registered is a store or a stranger');
  assert.equal(body.reportBack, true);
  assert.equal(body.conversationId, CONVO);
  assert.equal(body.reportAgentId, 'agent_kiana');
  assert.equal(body.reportAgentName, 'Kiana');
  assert.equal(body.context, 'Especially THCP vapes and disposables: what is in stock and the prices.');
  assert.match(out, /When the call ends you will message them here yourself/);
  assert.match(out, /Do NOT ask them to message you back or check in/);
  assert.equal(/next check in|NEXT message/.test(out), false, 'never "check back with me later"');
});

test('an older bridge that does not report back keeps the old wording (no false promise)', async () => {
  const { Tool } = loadTool({ placed: {} });
  const out = await new Tool(fields())._call({ to_number: '4175550100', purpose: 'say hi' });
  assert.match(out, /when they next check in/);
  assert.equal(/you will message them/.test(out), false);
});

test('family calls send no business flag unless the character says so; "false" means a person who knows the user', async () => {
  const a = loadTool({ placed: { reportBack: true } });
  await new a.Tool(fields())._call({ to_number: '4175550100', purpose: 'Kade wants to know if you are coming Sunday' });
  const plain = a.posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal('business' in plain, false, 'the registry decides: a registered family number gets the family greeting');
  assert.equal('disclose' in plain, false);
  assert.equal('context' in plain, false);
  assert.equal(plain.unregisteredIsBusiness, true);
  const b = loadTool({ placed: { reportBack: true } });
  await new b.Tool(fields())._call({ to_number: '4175550100', purpose: 'say hi', business: 'false' });
  const fam = b.posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal(fam.business, false);
  assert.equal('disclose' in fam, false);
});

test("a chat with no saved conversation yet ('new') sends no conversationId; the bridge then picks the newest one", async () => {
  const { Tool, posts } = loadTool({ placed: { reportBack: true } });
  await new Tool(fields({ conversationId: 'new' }))._call({ to_number: '4175550100', purpose: 'say hi' });
  const body = posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal(body.conversationId, undefined);
});

test('Kiana hands a call to Lilly: Kiana is the one who reports back', async () => {
  const { Tool, posts } = loadTool({ placed: { reportBack: true } });
  const tool = new Tool(fields({ agentId: 'agent_6llV0eMu4fmIaj8f2x1Sb' }));
  tool._findCallAgent = async () => ({ id: 'agent_lilly', name: 'Lilly' });
  await tool._call({ to_number: '4175550100', purpose: 'say hi', call_as: 'Lilly' });
  const body = posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal(body.agentId, 'agent_lilly');
  assert.equal(body.reportAgentId, 'agent_6llV0eMu4fmIaj8f2x1Sb');
});

test('check_result while it is still going: "I\'ll message you as soon as it ends", not "ask me later"', async () => {
  const { Tool } = loadTool({ result: { found: true, status: 'in-progress', to: '+14175550100', startedSecondsAgo: 40, reportBack: true } });
  const out = await new Tool(fields())._call({ action: 'check_result' });
  assert.match(out, /you'll message them as soon as it ends/);
  assert.equal(/report back when they ask/.test(out), false);
});

test('check_result after the character already reported: answer, do not repeat the whole report', async () => {
  const { Tool } = loadTool({ result: {
    found: true, status: 'completed', callSid: 'CA1', to: '+14175550100', durationSec: 74, reportBack: true, reportedToChat: true,
    transcript: [{ role: 'user', content: 'They closed down last week.' }],
  } });
  const out = await new Tool(fields())._call({ action: 'check_result' });
  assert.match(out, /Callee: They closed down last week\./);
  assert.match(out, /ALREADY messaged them/);
});

test('the guard after a quick second check keeps the report-back promise when the call reports back', async () => {
  const { Tool } = loadTool({ placed: { reportBack: true }, result: { found: true, status: 'in-progress', to: 'x', startedSecondsAgo: 5, reportBack: true } });
  const tool = new Tool(fields());
  await tool._call({ to_number: '4175550100', purpose: 'say hi' });
  await tool._call({ action: 'check_result' });
  const again = await tool._call({ action: 'check_result' });
  assert.match(again, /STOP: you just checked/);
  assert.match(again, /you'll message them as soon as it ends/);
});

test('the schema the model is given (registry) and the class schema both carry business and details', () => {
  const { Tool } = loadTool();
  const own = new Tool(fields()).schema.properties;
  assert.equal(own.business.type, 'boolean');
  assert.equal(own.details.type, 'string');
  const ts = fs.readFileSync(path.join(__dirname, '../../../../../packages/api/src/tools/registry/definitions.ts'), 'utf8');
  const start = ts.indexOf('export const kadePhoneCallSchema');
  const block = ts.slice(start, ts.indexOf('export const', start + 10));
  assert.match(block, /business: \{\s*type: 'boolean'/);
  assert.match(block, /details: \{\s*type: 'string'/);
  assert.match(ts, /When the call ends you normally message the user yourself/);
  assert.equal(/afterwards fetch the transcript with ONE action='check_result'/.test(ts), false, 'the old "fetch it afterwards" instruction is gone');
});
