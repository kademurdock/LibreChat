/* Part 291: a call a family member asks for on a phone or app-voice call is billed to them, not
 * to Kade's service seat. The voice lane signs in as Kade; handleTools' loader always sets
 * userId to that seat, so the person on the line (req.kadeOnBehalfOf, else the signed-in user)
 * travels as actingUserId and KadePhoneCall sends it to the bridge, which bills the call, counts
 * the daily cap and answers check_result by that id.
 *
 * Run: node --test api/app/clients/tools/structured/KadePhoneCall.billing.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTool() {
  const posts = [];
  const stubs = {
    axios: {
      post: async (url, body) => {
        posts.push({ url, body });
        if (url.endsWith('/outbound/result')) return { data: { found: false } };
        return { data: { to: body.to, timeLimitMin: 15, callsLeftToday: 3 } };
      },
    },
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
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

const KADE_SEAT = { id: 'u-kade', role: 'ADMIN', name: 'Kade' };

async function place(fields) {
  const { Tool, posts } = loadTool();
  const tool = new Tool({ agentId: 'agent_harley', agentName: 'Harley', ...fields });
  await tool._call({ to_number: '4175550100', purpose: 'say hi' });
  const placed = posts.find((p) => p.url.endsWith('/outbound-call'));
  await tool._call({ action: 'check_result' });
  const checked = posts.find((p) => p.url.endsWith('/outbound/result'));
  return { placed: placed && placed.body, checked: checked && checked.body };
}

test('on a phone call, the person on the line is billed, capped and answered, not the seat', async () => {
  const { placed, checked } = await place({
    userId: 'u-kade',
    actingUserId: 'u-amber',
    userName: 'Amber',
    req: { user: KADE_SEAT, kadeOnBehalfOf: { id: 'u-amber', name: 'Amber' } },
  });
  assert.equal(placed.userId, 'u-amber');
  assert.equal(placed.userName, 'Amber');
  assert.equal(checked.userId, 'u-amber', "check_result finds her call, never Kade's last one");
});

test('without actingUserId the tool still reads the person on the line from the request', async () => {
  const { placed } = await place({ userId: 'u-kade', req: { user: KADE_SEAT, kadeOnBehalfOf: { id: 'u-amber' } } });
  assert.equal(placed.userId, 'u-amber');
});

test("typed chat, Kade's own calls and unknown callers are unchanged", async () => {
  const typed = await place({ userId: 'u-holly', actingUserId: 'u-holly', req: { user: { id: 'u-holly', role: 'USER' } } });
  assert.equal(typed.placed.userId, 'u-holly');
  const kade = await place({ userId: 'u-kade', actingUserId: 'u-kade', req: { user: KADE_SEAT } });
  assert.equal(kade.placed.userId, 'u-kade');
  const unknown = await place({
    userId: 'u-kade',
    actingUserId: 'u-kade',
    req: { user: KADE_SEAT, kadeOnBehalfOfUnresolved: true },
  });
  assert.equal(unknown.placed.userId, 'u-kade', 'an unknown email stays on her seat');
});

test('handleTools hands kade_phone_call the person on the line in a field the loader keeps', () => {
  const src = fs.readFileSync(path.join(__dirname, '../util/handleTools.js'), 'utf8');
  const block = src.slice(src.indexOf('    kade_phone_call: {'), src.indexOf('    kade_transcribe: {'));
  assert.match(block, /actingUserId: kadeActingUserId,/);
  assert.match(src, /const kadeActingUserId = options\.req\?\.kadeOnBehalfOf\?\.id \|\| user;/);
  // The loader overwrites userId with the signed-in seat; actingUserId survives it.
  const start = src.indexOf('const loadToolWithAuth = ');
  const end = src.indexOf('\n};', start) + 3;
  const context = { loadAuthValues: async () => ({ SOME_KEY: 'x' }) };
  vm.createContext(context);
  vm.runInContext(src.slice(start, end).replace('const loadToolWithAuth', 'this.loadToolWithAuth'), context);
  class Probe {
    constructor(fields) {
      this.fields = fields;
    }
  }
  return context
    .loadToolWithAuth('u-kade', [], Probe, { userId: 'u-amber', actingUserId: 'u-amber' })()
    .then((probe) => {
      assert.equal(probe.fields.userId, 'u-kade', 'userId is always the seat');
      assert.equal(probe.fields.actingUserId, 'u-amber');
    });
});
