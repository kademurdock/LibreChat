/* kade_library_requests for callers who must not act as the owner (Sep 24 2026).
 * Run: node --test api/app/clients/tools/structured/KadeLibraryRequests.access.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadTool(actor) {
  const seen = { reader: 0, run: 0 };
  class LibraryRequestError extends Error {}
  const stubs = {
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
    '@librechat/api': {
      libraryRequestsDescription: '',
      libraryRequestsSchema: {},
      compactRequestResult: (result) => result,
      LibraryRequestError,
    },
    '~/server/services/kadeLibraryRequests': {
      requestReader: async (id) => {
        seen.reader++;
        seen.id = id;
        return actor;
      },
      requests: {
        run: async () => {
          seen.run++;
          return { ok: true };
        },
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadeLibraryRequests'), 'utf8'), {
    module,
    require: (name) => stubs[name],
    JSON,
  });
  return { Tool: module.exports, seen };
}

test('an unidentified voice caller never acts as the service seat', async () => {
  const { Tool, seen } = loadTool({ id: 'kade', admin: true });
  const req = { user: { id: 'kade', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true };
  const out = JSON.parse(await new Tool({ req })._call({ action: 'list', scope: 'open' }));
  assert.match(out.error, /could not tell whose account/);
  assert.equal(seen.reader, 0);
  assert.equal(seen.run, 0);
});

test('the App Review seat hears nothing about a family collection, an owner or approval', async () => {
  const { Tool, seen } = loadTool({ id: 'review', admin: false, hidden: true, reviewSeat: true });
  const out = JSON.parse(await new Tool({ req: { user: { id: 'review' } } })._call({ action: 'create', title: 'Holes' }));
  assert.equal(seen.run, 0);
  assert.doesNotMatch(out.error, /family|Kade|member/i);
});

test('a resolved caller acts as themselves', async () => {
  const { Tool, seen } = loadTool({ id: 'amber', admin: false, hidden: false });
  const req = { user: { id: 'kade' }, kadeOnBehalfOf: { id: 'amber' } };
  const out = JSON.parse(await new Tool({ req })._call({ action: 'list' }));
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.id, 'amber');
  assert.equal(seen.run, 1);
});
