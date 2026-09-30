const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const seen = { calls: [], reads: [] };
  const users = new Map([['member', { name: 'Example Member', kadeFamilyTreePerson: 'P1' }], ['owner', { role: 'ADMIN' }]]);
  const module = { exports: {} };
  const stubs = {
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { warn() {} } },
    '@librechat/api': {
      familyHistoryToolDescription: 'Saved sources and explicitly requested notes.', familyHistoryToolSchema: {},
      readFamilyHistoryTool: async (input, call) => call(input),
    },
    '~/models': { getUserById: async (id) => { seen.reads.push(id); return users.get(id); } },
    '~/server/routes/kadeFamilyHistory': { familyToolCall: (actor) => async (input) => { seen.calls.push({ actor, input }); return { ok: true }; } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadeFamilyHistory'), 'utf8'), { module, require: (name) => stubs[name], JSON, String });
  return { Tool: module.exports, seen, users };
}

test('the tool reloads the authenticated actor every invocation; arguments cannot set attribution', async () => {
  const { Tool, seen, users } = load();
  const tool = new Tool({ req: { user: { id: 'member', role: 'ADMIN' } }, userId: 'owner' });
  await tool._call({ action: 'save_note', authorId: 'owner' });
  assert.equal(seen.calls[0].actor.id, 'member');
  assert.equal(seen.calls[0].actor.role, undefined);
  users.set('member', { name: 'Example Member', kadeFamilyHistory: 'none' });
  await tool._call({ action: 'archives' });
  assert.equal(seen.calls[1].actor.kadeFamilyTreePerson, undefined);
  assert.equal(seen.calls[1].actor.kadeFamilyHistory, 'none');
  assert.equal(seen.reads.length, 2);
});

test('resolved phone caller owns the lookup; an unresolved caller never falls back to the service seat', async () => {
  const { Tool, seen } = load();
  await new Tool({ req: { user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'member' } } })._call({ action: 'archives' });
  assert.equal(seen.calls[0].actor.id, 'member');
  const reply = JSON.parse(await new Tool({ req: { user: { id: 'owner' }, kadeOnBehalfOfUnresolved: true } })._call({ action: 'archives' }));
  assert.ok(reply.error);
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.reads.length, 1);
});

test('discovery without a request actor never reads archives', async () => {
  const { Tool, seen } = load();
  assert.ok(JSON.parse(await new Tool({ userId: 'owner' })._call({ action: 'archives' })).error);
  assert.equal(seen.calls.length, 0);
});

test('agent discovery and the execution loader both register the same authenticated tool', () => {
  const loader = fs.readFileSync(require.resolve('../util/handleTools'), 'utf8');
  const index = fs.readFileSync(require.resolve('../index'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json'), 'utf8'));
  assert.equal(manifest.filter((tool) => tool.pluginKey === 'kade_family_history').length, 1);
  assert.match(index, /const KadeFamilyHistory = require\('\.\/structured\/KadeFamilyHistory'\)/);
  assert.match(loader, /kade_family_history: KadeFamilyHistory/);
  assert.match(loader, /kade_family_history: \{ req: options\.req \}/);
});
