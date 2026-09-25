/* "Kiana, have Lilly call me" (Part 291, Sep 25 2026): the handed-off
 * character must be one the person asking may use, their own or a public
 * one. Before this, the name lookup reached Skylee's private Lilly for anyone.
 * No database: mongoose's Agent.find is a fake that applies the query's name
 * pattern and its $or the way Mongo would, so the query shape is tested too.
 *
 * Run: node --test api/app/clients/tools/structured/KadePhoneCall.callAs.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const KIANA = 'agent_6llV0eMu4fmIaj8f2x1Sb';
const AGENTS = [
  { _id: 'm1', id: 'agent_skylee_lilly', name: 'Lilly', author: 'u-skylee' },
  { _id: 'm2', id: 'agent_tester_copy', name: 'Lilly private pilot Sep 23', author: 'u-tester' },
  { _id: 'm3', id: 'agent_public_lilly', name: 'Lilly', author: 'u-kade' },
  { _id: 'm4', id: 'agent_harley', name: 'Harley', author: 'u-kade' },
  { _id: 'm5', id: 'agent_amber_lillybug', name: 'Lillybug', author: 'u-amber' },
  { _id: 'm6', id: 'agent_kade_private', name: 'Secret Santa', author: 'u-kade' },
];
const PUBLIC = ['m3', 'm4'];

/** Mongo's reading of { name: /re/, $or: [{ _id: { $in } }, { author }] }. */
function matches(agent, query) {
  if (query.name && !query.name.test(agent.name)) return false;
  if (!query.$or) return true;
  return query.$or.some((clause) =>
    clause._id
      ? clause._id.$in.map(String).includes(String(agent._id))
      : String(agent.author) === String(clause.author),
  );
}

function loadTool({ publicIds = PUBLIC, agents = AGENTS } = {}) {
  const seen = { posts: [], queries: [], acl: [] };
  const stubs = {
    axios: {
      post: async (url, body) => {
        seen.posts.push({ url, body });
        return { data: { to: body.to, timeLimitMin: 15, callsLeftToday: 3 } };
      },
    },
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
    mongoose: {
      models: {
        Agent: {
          find(query) {
            seen.queries.push(query);
            let rows = agents.filter((a) => matches(a, query));
            const chain = {
              sort() {
                rows = rows.slice().sort((a, b) => (a._id < b._id ? -1 : 1));
                return chain;
              },
              lean: async () => rows.map((a) => ({ ...a })),
            };
            return chain;
          },
        },
      },
    },
    'librechat-data-provider': { ResourceType: { AGENT: 'agent' }, PermissionBits: { VIEW: 1 } },
    '~/server/services/PermissionService': {
      findPubliclyAccessibleResources: async (args) => {
        seen.acl.push(args);
        return publicIds;
      },
    },
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

async function askKiana({ userId, onBehalfOf, callAs, publicIds, agentId = KIANA }) {
  const { Tool, seen } = loadTool({ publicIds });
  const req = { user: { id: userId, name: 'Someone' }, ...(onBehalfOf ? { kadeOnBehalfOf: { id: onBehalfOf } } : {}) };
  const tool = new Tool({ userId, req, agentId, agentName: agentId === KIANA ? 'Kiana' : 'Harley' });
  const reply = await tool._call({ to_number: '4175550100', purpose: 'say hi', call_as: callAs });
  return { reply, seen, placedAs: seen.posts[0] && seen.posts[0].body.agentId };
}

test("anyone else asking for Lilly gets the public Lilly, never Skylee's private one", async () => {
  const { placedAs, reply, seen } = await askKiana({ userId: 'u-amber', callAs: 'lilly' });
  assert.equal(placedAs, 'agent_public_lilly');
  assert.match(reply, /Lilly is making this call/);
  assert.deepEqual(JSON.parse(JSON.stringify(seen.acl)), [{ resourceType: 'agent', requiredPermissions: 1 }]);
});

test('Skylee asking for Lilly gets her own Lilly first', async () => {
  const { placedAs } = await askKiana({ userId: 'u-skylee', callAs: 'Lilly' });
  assert.equal(placedAs, 'agent_skylee_lilly');
});

test('with no public Lilly, a stranger is told there is no such character and nothing dials', async () => {
  const { placedAs, reply, seen } = await askKiana({ userId: 'u-stranger', callAs: 'Lilly', publicIds: ['m4'] });
  assert.equal(placedAs, undefined);
  assert.equal(seen.posts.length, 0);
  assert.match(reply, /couldn't find a character named "Lilly"/);
});

test("a partial name also only reaches agents the caller may use (the tester's private copy stays hidden)", async () => {
  const { placedAs, reply } = await askKiana({ userId: 'u-stranger', callAs: 'private pilot' });
  assert.equal(placedAs, undefined);
  assert.match(reply, /couldn't find/);
  const own = await askKiana({ userId: 'u-tester', callAs: 'private pilot' });
  assert.equal(own.placedAs, 'agent_tester_copy');
});

test("an exact public name beats the caller's own partial match; the caller's own exact name beats a public one", async () => {
  assert.equal((await askKiana({ userId: 'u-amber', callAs: 'Lilly' })).placedAs, 'agent_public_lilly');
  assert.equal((await askKiana({ userId: 'u-amber', callAs: 'Lillybug' })).placedAs, 'agent_amber_lillybug');
  assert.equal((await askKiana({ userId: 'u-skylee', callAs: 'Lilly' })).placedAs, 'agent_skylee_lilly');
});

test('on a phone turn the person on the line counts, not the service seat', async () => {
  const onLine = await askKiana({ userId: 'u-kade', onBehalfOf: 'u-amber', callAs: 'Secret Santa' });
  assert.equal(onLine.placedAs, undefined, "Kade's private agent is not Amber's to use");
  const skylee = await askKiana({ userId: 'u-kade', onBehalfOf: 'u-skylee', callAs: 'Lilly' });
  assert.equal(skylee.placedAs, 'agent_skylee_lilly');
  const kade = await askKiana({ userId: 'u-kade', callAs: 'Secret Santa' });
  assert.equal(kade.placedAs, 'agent_kade_private');
});

test('the query itself asks Mongo only for public or own agents', async () => {
  const { seen } = await askKiana({ userId: 'u-amber', callAs: 'Harley' });
  const query = seen.queries[0];
  assert.ok(query.$or.some((c) => c.author === 'u-amber'));
  assert.deepEqual([...query.$or.find((c) => c._id)._id.$in], PUBLIC);
  assert.equal(seen.posts[0].body.agentId, 'agent_harley');
});

test('when the public list cannot be read, only the caller\'s own agents are usable', async () => {
  const { placedAs } = await askKiana({ userId: 'u-amber', callAs: 'Harley', publicIds: [] });
  assert.equal(placedAs, undefined);
});

test('only Kiana can hand a call on (unchanged)', async () => {
  const { reply, seen } = await askKiana({ userId: 'u-amber', callAs: 'Lilly', agentId: 'agent_harley' });
  assert.match(reply, /Only Kiana can hand a call/);
  assert.equal(seen.queries.length, 0);
});

test('pickCallAgent never returns an agent that is neither own nor public, whatever it is handed', () => {
  const { Tool } = loadTool();
  const pick = Tool.pickCallAgent;
  assert.equal(pick(AGENTS, { callAs: 'Lilly', userId: 'u-stranger', publicIds: [] }), null);
  assert.equal(pick(AGENTS, { callAs: 'Lilly', userId: 'u-amber', publicIds: [] }).id, 'agent_amber_lillybug', 'her own partial match');
  assert.equal(pick(AGENTS, { callAs: 'Lilly', userId: '', publicIds: ['m3'] }).id, 'agent_public_lilly');
  assert.equal(pick(AGENTS, { callAs: 'Lilly', userId: 'u-skylee', publicIds: ['m3'] }).id, 'agent_skylee_lilly');
  assert.equal(pick(AGENTS, { callAs: 'Lil', userId: 'u-amber', publicIds: ['m3'] }).id, 'agent_amber_lillybug');
  assert.equal(pick([], { callAs: 'Lilly', userId: 'u-amber', publicIds: PUBLIC }), null);
  assert.equal(pick(AGENTS, { callAs: 'Zed', userId: 'u-kade', publicIds: PUBLIC }), null, 'owning agents is not a name match');
  assert.equal(pick(AGENTS, { callAs: '', userId: 'u-kade', publicIds: PUBLIC }), null);
});
