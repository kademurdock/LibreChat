'use strict';
/* node --test api/server/services/kadeLibraryRequests.nodetest.js
 * The librarian's catalog and request tools must ride every turn, even when the embedder is up
 * and the person's words match neither tool (Sep 24 2026). */
const test = require('node:test');
const assert = require('node:assert');
const R = require('./kadeToolRetrieval.js');

const tools = [
  { name: 'kade_library', description: 'Catalog' },
  { name: 'kade_library_requests', description: 'Requests' },
  { name: 'kade_wikipedia', description: 'Background' },
  { name: 'kade_help', description: 'Help' },
];
/* A working embedder whose vectors never match: only the no-alias rule can keep a tool. */
const orthogonal = async (text) => (String(text).includes(':') ? [0, 1] : [1, 0]);

for (const text of [
  'Could you put in for that old Christmas special with the claymation reindeer?',
  'Any news on the thing I asked about?',
  'Do you have anything by Applegate?',
]) {
  test(`librarian keeps catalog and requests for: ${text}`, async () => {
    R._resetForTests();
    const result = await R.selectTools({ tools, text, agentId: 'librarian', embed: orthogonal });
    assert.ok(result.keep.has('kade_library'), result.reason);
    assert.ok(result.keep.has('kade_library_requests'), result.reason);
  });
}
