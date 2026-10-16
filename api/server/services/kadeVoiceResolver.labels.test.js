'use strict';
/* Part 129: a label the proxy SERVES is valid whatever its shape. */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
/* The resolver requires the app's models at load; stub the alias resolver so
 * the pure validator can be tested without a database. */
const stubName = (request) => path.join(__dirname, '__stub__' + request.replace(/[^a-z]/gi, '_') + '.js');
const STUBS = {
  '~/models': 'module.exports = { getAgent: async () => globalThis.__resolverAgent || null };',
  '~/models/kadeVoicePref': 'module.exports = { getUserVoicePref: async () => globalThis.__resolverPick || null };',
  '~/server/services/Files/Audio/voiceCatalog':
    'module.exports = { fetchLiveCatalog: async () => globalThis.__resolverCatalog || { voices: null, hidden: null, aliases: null } };',
  '@librechat/data-schemas': 'module.exports = { logger: { warn() {}, error() {}, info() {} } };',
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return stubName(request);
  return origResolve.call(this, request, ...rest);
};
const fs = require('fs');
for (const [request, body] of Object.entries(STUBS)) fs.writeFileSync(stubName(request), body);
const { isValidLabel, resolveVoice } = require('./kadeVoiceResolver');
for (const f of fs.readdirSync(__dirname)) if (f.startsWith('__stub__')) fs.unlinkSync(path.join(__dirname, f));

const live = ['warm low-ish woman · turnpike', 'clear high girl · hickory', 'Voice 700'];
const aliases = ['Kiana (Comedian)', 'Birta'];
const hidden = ['Voice 31', 'clear high young woman · hickory'];

test('a descriptive label the proxy serves is valid (the Sep-2 regression)', () => {
  assert.ok(isValidLabel('warm low-ish woman · turnpike', live, aliases, hidden));
});
test('a former label (re-filed voice) is valid through hidden', () => {
  assert.ok(isValidLabel('clear high young woman · hickory', live, aliases, hidden));
});
test('a named alias is valid; a made-up name is not once aliases are known', () => {
  assert.ok(isValidLabel('Kiana (Comedian)', live, aliases, hidden));
  assert.ok(!isValidLabel('husky low woman · nonesuch', live, aliases, hidden));
});
test('a numbered label must be served or hidden', () => {
  assert.ok(isValidLabel('Voice 31', live, aliases, hidden));
  assert.ok(!isValidLabel('Voice 999', live, aliases, hidden));
  assert.ok(isValidLabel('Voice 999', null, aliases, hidden), 'no catalog reachable -> passes');
});

test('Oct 16: a pick saved under a renamed voice stays valid, read from the one shared catalog', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the resolver must not fetch /voices.json on its own');
  };
  try {
    globalThis.__resolverAgent = { name: 'Della', tts: { voiceId: 'Old Builder Name' } };
    globalThis.__resolverCatalog = {
      voices: ['New Name', 'New Builder Name'],
      hidden: ['Old Name', 'Old Builder Name'],
      aliases: ['Kiana (Comedian)'],
    };
    globalThis.__resolverPick = 'Old Name';
    let got = await resolveVoice({ userId: 'u', agentId: 'agent_della' });
    assert.strictEqual(got.voice, 'Old Name');
    assert.strictEqual(got.source, 'personal');
    globalThis.__resolverPick = null;
    got = await resolveVoice({ userId: 'u', agentId: 'agent_della' });
    assert.strictEqual(got.voice, 'Old Builder Name');
    assert.strictEqual(got.source, 'builder');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__resolverAgent;
    delete globalThis.__resolverCatalog;
    delete globalThis.__resolverPick;
  }
});
