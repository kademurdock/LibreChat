// node --test api/server/routes/kadeLiveFace.nodetest.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFaces, decide } = require('./LiveFace/policy');

const faces = { agent_kiana: 'face-k', agent_harley: 'face-h' };

test('faces parse from JSON or pairs', () => {
  assert.deepEqual(parseFaces('{"agent_kiana":"face-k","x":""}'), { agent_kiana: 'face-k' });
  assert.deepEqual(parseFaces('agent_kiana=face-k, agent_harley=face-h'), faces);
  assert.deepEqual(parseFaces(''), {});
  assert.deepEqual(parseFaces('{broken'), {});
});

test('a blind account never opens a paid face', () => {
  for (const sight of ['nonvisual', null, undefined, '']) {
    const v = decide({ configured: true, faces, agentId: 'agent_kiana', sight, liveFaces: true });
    assert.equal(v.ok, false, String(sight));
    assert.equal(v.code, 'not_sighted');
  }
});

test('a sighted account with the switch on gets the face id', () => {
  assert.deepEqual(
    decide({ configured: true, faces, agentId: 'agent_harley', sight: 'sighted', liveFaces: true }),
    { ok: true, faceId: 'face-h' },
  );
});

test('the switch, a missing face and no setup each refuse with their own code', () => {
  assert.equal(decide({ configured: true, faces, agentId: 'agent_harley', sight: 'sighted', liveFaces: false }).code, 'off');
  assert.equal(decide({ configured: true, faces, agentId: 'agent_della', sight: 'sighted', liveFaces: true }).code, 'no_face');
  assert.equal(decide({ configured: false, faces, agentId: 'agent_kiana', sight: 'sighted', liveFaces: true }).code, 'unconfigured');
});

test('the page carries its script inline and one LiveKit browser build', () => {
  const html = fs.readFileSync(path.join(__dirname, 'LiveFace/page.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'LiveFace/page.js'), 'utf8');
  assert.equal((html.match(/livekit-client\.umd\.min\.js/g) || []).length, 1);
  assert.ok(html.includes('<!-- KADE_CLIENT_SCRIPT -->'));
  assert.ok(script.includes("'/compose/webrtc/livekit'"));
  assert.ok(script.includes("ws.send('DONE')"));
  assert.ok(script.includes("ws.send('SKIP')"));
  // The fragment is scrubbed before anything else runs: tokens never sit in the address.
  assert.ok(script.indexOf('history.replaceState') < script.indexOf('new WebSocket'));
});
