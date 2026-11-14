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
        return { data: { to: '+14175550100', callSid: 'CA' + 'f'.repeat(32), timeLimitMin: 15, callsLeftToday: 3, ...(replies.placed || {}) } };
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
  const out = await new Tool(fields())._call({ to_number: '4175550100', purpose: 'say hi', business: false });
  assert.match(out, /when they next check in/);
  assert.equal(/you will message them/.test(out), false);
});

/* Review, Nov 14 2026: on her own number (registered, with Kiana as its character) a left-out business flag
 * let the registry pick the friend greeting again: no A I notice, no recording notice, her memories on the
 * call. The model now has to say which it is; nothing is dialed until it does. */
test('REVIEW: place_call without business is not placed; the model is told to say true or false and call again', async () => {
  const a = loadTool({ placed: { reportBack: true } });
  const out = await new a.Tool(fields())._call({ to_number: '4175550100', purpose: 'ask if you have any deals on hemp products' });
  assert.equal(a.posts.length, 0, 'nothing was sent to the bridge');
  assert.match(out, /^Not started: no call was placed and nothing was charged\./);
  assert.match(out, /business: true for a store/);
  assert.match(out, /business: false for family/);
  // The ledger (kadeLedger.js FAIL_START) reads "Not started" as a failure, so no reply can claim a call.
  assert.match(out, /^\s*not started\b/i);
});

test('family calls say business false: no stranger greeting, no disclose', async () => {
  const b = loadTool({ placed: { reportBack: true } });
  await new b.Tool(fields())._call({ to_number: '4175550100', purpose: 'Kade wants to know if you are coming Sunday', business: 'false' });
  const fam = b.posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal(fam.business, false);
  assert.equal('disclose' in fam, false);
  assert.equal('context' in fam, false);
  assert.equal(fam.unregisteredIsBusiness, true);
});

test("a chat with no saved conversation yet ('new') sends no conversationId; the bridge then picks the newest one", async () => {
  const { Tool, posts } = loadTool({ placed: { reportBack: true } });
  await new Tool(fields({ conversationId: 'new' }))._call({ to_number: '4175550100', purpose: 'say hi', business: false });
  const body = posts.find((p) => p.url.endsWith('/outbound-call')).body;
  assert.equal(body.conversationId, undefined);
});

test('Kiana hands a call to Lilly: Kiana is the one who reports back', async () => {
  const { Tool, posts } = loadTool({ placed: { reportBack: true } });
  const tool = new Tool(fields({ agentId: 'agent_6llV0eMu4fmIaj8f2x1Sb' }));
  tool._findCallAgent = async () => ({ id: 'agent_lilly', name: 'Lilly' });
  await tool._call({ to_number: '4175550100', purpose: 'say hi', call_as: 'Lilly', business: false });
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
  await tool._call({ to_number: '4175550100', purpose: 'say hi', business: false });
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
  // Review: Kade's Part 66 wording (a business hears "on behalf of a customer" and the full name), in both places.
  const registryText = ts.slice(ts.indexOf('kade_phone_call: {'), ts.indexOf('kade_phone_call: {') + 4000);
  for (const text of [block, registryText, own.business.description, new Tool(fields()).description_for_model]) {
    assert.equal(/one of our users|calling for <the user/.test(text), false);
  }
  assert.match(block, /calling on behalf of a customer, <the user\\'s full name>/);
  assert.match(registryText, /calling on behalf of a customer, the user's full name/);
  assert.match(own.business.description, /calling on behalf of a customer, <the user's full name>/);
  assert.match(new Tool(fields()).description, /identify them by name as the person who requested it \(a store or other business hears their full name\)/);
  assert.match(registryText, /identify them by name as the requester \(a store or other business hears their full name\)/);
});

/* Review, Nov 14 2026: after a bridge restart the newest call record was an OLDER call, and check_result
 * reported it as this one. The tool now says which call it means. */
test('REVIEW: the reply after dialing names the call, and check_result asks about that call', async () => {
  const { Tool, posts } = loadTool({ placed: { reportBack: true }, result: { found: true, status: 'in-progress', to: 'x', startedSecondsAgo: 5, reportBack: true } });
  const tool = new Tool(fields());
  const out = await tool._call({ to_number: '4175550100', purpose: 'ask if you are open', business: true });
  assert.match(out, /\(call id CAf{32}\)/);
  await tool._call({ action: 'check_result' });
  const asked = posts.find((p) => p.url.endsWith('/outbound/result')).body;
  assert.equal(asked.callSid, 'CA' + 'f'.repeat(32));
  // A call id the model names wins.
  const other = loadTool({ result: { found: false } });
  await new other.Tool(fields())._call({ action: 'check_result', call_sid: 'CA' + '1'.repeat(32) });
  assert.equal(other.posts[0].body.callSid, 'CA' + '1'.repeat(32));
});

test('REVIEW: a call cut off by a restart is reported as that; a call id not on record is never swapped for another call', async () => {
  const a = loadTool({ result: {
    found: true, status: 'interrupted', callSid: 'CA9', calleeName: 'Shell', reportBack: true, reportedToChat: false,
    transcript: [{ role: 'user', content: 'We closed down last week.' }],
  } });
  const out = await new a.Tool(fields())._call({ action: 'check_result', call_sid: 'CA9' });
  assert.match(out, /was cut off: the phone system restarted on our side/);
  assert.match(out, /Callee: We closed down last week\./);
  assert.match(out, /Never guess the rest/);
  const told = loadTool({ result: { found: true, status: 'interrupted', callSid: 'CA9', reportBack: true, reportedToChat: true, transcript: [] } });
  assert.match(await new told.Tool(fields())._call({ action: 'check_result', call_sid: 'CA9' }), /ALREADY messaged them about this call/);
  const b = loadTool({ result: { found: false } });
  const gone = await new b.Tool(fields())._call({ action: 'check_result', call_sid: 'CA8' });
  assert.match(gone, /^That call is not on record/);
  const c = loadTool({ result: { found: false } });
  assert.equal(await new c.Tool(fields())._call({ action: 'check_result' }), 'No outbound calls found for this user yet.');
});

/* Verification round, Nov 14 2026: check_result asked about the last call place_call made, for six hours,
 * even when the person's newest call was a test check-in, whose own reply says "check_result also works for
 * the raw transcript". Kiana then read the store call back as the check-in. The check-in's call id (the
 * bridge's /wellness/fire answers it) is now the one check_result asks about. */
test('VERIFY 13: after a test check-in, check_result asks about the check-in, not the chat call before it', async () => {
  const posts = [];
  let schedules = [{ id: 'w1', agentId: 'agent_kiana', enabled: true, enrolledBy: { userId: 'u-kade' } }];
  const stubs = {
    axios: {
      post: async (url, body) => {
        posts.push({ url, body });
        if (url.endsWith('/outbound-call')) return { data: { to: '+14175550100', callSid: 'CA_store_call', timeLimitMin: 15, callsLeftToday: 3, reportBack: true } };
        if (url.endsWith('/wellness/fire')) return { data: { ok: true, callSid: 'CA_checkin', note: 'Test call dialing now. The summary will arrive after it ends.' } };
        return { data: { found: true, status: 'in-progress', to: 'x', startedSecondsAgo: 5, reportBack: false } };
      },
      get: async () => ({ data: { schedules } }), // the asker's own schedules (?userId=)
    },
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
    '~/server/services/kadeRealCost': require('../../../../server/services/kadeRealCost'),
    '~/server/services/kadeWellnessTarget': {
      wellnessActor: () => ({ id: 'u-kade', admin: true }),
      actorFromUser: (u) => u,
      wellnessAllowed: async () => ({ ok: true }),
      NOT_KNOWN: 'not known',
    },
  };
  // A fresh copy of the tool each time: it keeps who placed or checked what in module-level maps.
  const freshTool = () => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('./KadePhoneCall'), 'utf8'), {
      module,
      require: (name) => {
        if (!(name in stubs)) throw new Error('unexpected require ' + name);
        return stubs[name];
      },
      process: { env: { BRIDGE_SECRET: 'test-only', BRIDGE_URL: 'https://bridge.invalid' } },
    });
    return new module.exports(fields());
  };
  const lastAsk = () => posts.filter((p) => p.url.endsWith('/outbound/result')).pop().body;
  const tool = freshTool();
  await tool._call({ to_number: '4175550100', purpose: 'ask if you have any deals on hemp products', business: true });
  const fired = await tool._call({ action: 'test_checkin', schedule_id: 'w1' });
  assert.match(fired, /check_result also works for the raw transcript/);
  await tool._call({ action: 'check_result' });
  assert.equal(lastAsk().callSid, 'CA_checkin', 'the check-in just placed (before: the store call)');
  // Kade firing a schedule someone else set up: that call is on their account, so check_result asks for
  // her newest call, as before this branch, and never reads the store call back as the check-in.
  schedules = [];
  const tool2 = freshTool();
  await tool2._call({ to_number: '4175550100', purpose: 'ask if you are open', business: true });
  await tool2._call({ action: 'test_checkin', schedule_id: 'w-someone-else' });
  await tool2._call({ action: 'check_result' });
  assert.equal(lastAsk().callSid, undefined, 'no call id pinned');
});
