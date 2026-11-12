/* Nov 12 2026 (audit SEC-3): family check-in calls. Kade's decision: a grown-up may still ring any
 * registered relative. What is closed: a child or teen sets up, resumes or fires nothing; the
 * calling character must be one the person may use; on a voice turn the tool acts for the person
 * on the line, not the service seat; test_checkin fires only the person's own schedule.
 * The bridge, the account read and the character check are stand-ins; nothing dials.
 *
 * Run: node --test api/app/clients/tools/structured/KadePhoneCall.wellness.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ACCOUNTS = {
  'u-kade': { email: 'k@example.invalid', role: 'ADMIN' },
  'u-teen': { email: 't@example.invalid', role: 'USER', kadeAccountType: 'teen' },
  'u-amber': { email: 'a@example.invalid', role: 'USER', kadeAccountType: 'adult' },
  'u-old': { email: 'o@example.invalid', role: 'USER' },
};
const SCHEDULES = [
  { id: 'w-amber', to: '+14175550101', targetName: 'Grandma', enabled: false, agentId: 'agent_kiana', agentName: 'Kiana', days: 'daily', time: '09:00', enrolledBy: { userId: 'u-amber', userName: 'Amber' } },
  { id: 'w-other', to: '+14175550102', targetName: 'Dad', enabled: true, agentId: 'agent_kiana', agentName: 'Kiana', days: 'daily', time: '10:00', enrolledBy: { userId: 'u-skylee', userName: 'Skylee' } },
];
const USABLE = { 'u-amber': ['agent_kiana'], 'u-old': ['agent_kiana'], 'u-teen': ['agent_kiana'] };

function loadTool() {
  const seen = { posts: [], gets: [], deletes: [] };
  const target = require('../../../../server/services/kadeWellnessTarget');
  const stubs = {
    axios: {
      post: async (url, body) => {
        seen.posts.push({ url, body });
        if (url.endsWith('/wellness')) return { data: { schedule: { id: 'w-new', targetName: body.who, days: 'daily', time: body.time } } };
        if (url.endsWith('/wellness/toggle')) return { data: { schedule: { enabled: true } } };
        return { data: { note: 'Test call dialing now.' } };
      },
      get: async (url) => {
        seen.gets.push(url);
        const m = /userId=([^&]+)/.exec(url);
        const rows = m ? SCHEDULES.filter((w) => w.enrolledBy.userId === decodeURIComponent(m[1])) : SCHEDULES;
        return { data: { schedules: rows } };
      },
      delete: async (url) => {
        seen.deletes.push(url);
        return { data: {} };
      },
    },
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
    '~/server/services/kadeRealCost': require('../../../../server/services/kadeRealCost'),
    '~/server/services/kadeWellnessTarget': {
      ...target,
      wellnessAllowed: (actor, ask) =>
        target.wellnessAllowed(actor, ask, { canUseAgent: async (u, id) => (USABLE[u.id] || []).includes(id) }),
    },
    '~/models': { getUserById: async (id) => ACCOUNTS[id] || null },
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
  return { Tool: module.exports, seen };
}

/** A voice turn: the tool runs on Kade's admin seat with the person on the line named. */
const voiceTurn = (who) => ({ user: { id: 'u-kade', role: 'ADMIN' }, kadeOnBehalfOf: { id: who }, body: { kadeOnBehalfOf: `${who}@x` } });
const typed = (who) => ({ user: { id: who, ...ACCOUNTS[who] } });
async function ask(req, action, data = {}, agentId = 'agent_kiana') {
  const { Tool, seen } = loadTool();
  const tool = new Tool({ userId: req.user.id, req, agentId, agentName: 'Kiana' });
  const reply = await tool._wellness(action, data);
  return { reply, seen };
}

test('a teen on the line (admin seat) cannot schedule, and nothing is posted', async () => {
  const { reply, seen } = await ask(voiceTurn('u-teen'), 'schedule_checkin', { who: 'Grandma', time: '09:00' });
  assert.match(reply, /^Not scheduled, nothing was changed\. Check-in calls are set up by a grown-up account\./);
  assert.equal(seen.posts.length, 0);
});

test("a teen's list on a voice turn is their own, not every family schedule", async () => {
  const { seen } = await ask(voiceTurn('u-teen'), 'list_checkins');
  assert.match(seen.gets[0], /&userId=u-teen/);
});

test('a grown-up may still ring any registered relative, with a character they may use', async () => {
  const { reply, seen } = await ask(typed('u-amber'), 'schedule_checkin', { who: 'Grandma', time: '09:00' });
  assert.match(reply, /Check-in schedule created/);
  assert.equal(seen.posts[0].body.who, 'Grandma');
  assert.equal(seen.posts[0].body.enrolledBy.userId, 'u-amber');
  const untyped = await ask(typed('u-old'), 'schedule_checkin', { who: 'Dad', time: '10:00' });
  assert.match(untyped.reply, /Check-in schedule created/, 'an untyped account keeps the feature');
});

test("someone else's private character is refused", async () => {
  const { reply, seen } = await ask(typed('u-amber'), 'schedule_checkin', { who: 'Grandma', time: '09:00' }, 'agent_skylee_private');
  assert.match(reply, /That character is not one you can send\./);
  assert.equal(seen.posts.length, 0);
});

test("test_checkin on someone else's schedule fires nothing; on their own it fires", async () => {
  let r = await ask(typed('u-amber'), 'test_checkin', { schedule_id: 'w-other' });
  assert.match(r.reply, /does not belong to this user/);
  assert.equal(r.seen.posts.length, 0);
  r = await ask(typed('u-amber'), 'test_checkin', { schedule_id: 'w-amber' });
  assert.match(r.reply, /Test call dialing now/);
  assert.equal(r.seen.posts.length, 1);
});

test('a voice turn acts for the person on the line: pause and cancel check THEIR ownership', async () => {
  const r = await ask(voiceTurn('u-amber'), 'cancel_checkin', { schedule_id: 'w-other' });
  assert.match(r.reply, /does not belong to this user/);
  assert.equal(r.seen.deletes.length, 0);
});

test('a voice turn naming nobody known gets nothing', async () => {
  const req = { user: { id: 'u-kade', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true, body: {} };
  const r = await ask(req, 'list_checkins');
  assert.match(r.reply, /could not tell whose account this is/);
  assert.equal(r.seen.gets.length, 0);
});

test('Kade typing, or on the line, still manages every schedule', async () => {
  let r = await ask(typed('u-kade'), 'list_checkins');
  assert.doesNotMatch(r.seen.gets[0], /userId=/);
  assert.match(r.reply, /set up by Skylee/);
  r = await ask(voiceTurn('u-kade'), 'test_checkin', { schedule_id: 'w-other' });
  assert.match(r.reply, /Test call dialing now/);
});

test('the route gates save, fire and resume the same way (static check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../../server/routes/kade.js'), 'utf8');
  const at = src.indexOf("router.post('/wellness', requireJwtAuth");
  const route = src.slice(at, at + 3500);
  assert.match(route, /W\.wellnessAllowed\(W\.actorFromUser\(req\.user\)/);
  assert.match(route, /isSave \|\| action === 'fire' \|\| \(action === 'toggle' && willEnable\)/);
});
