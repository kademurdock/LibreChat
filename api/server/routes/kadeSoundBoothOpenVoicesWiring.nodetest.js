'use strict';
/* Open voices wired into the real booth route (Nov 15 2026).
 *
 * kadeSoundBooth.js runs in a vm with fakes for everything outside it (no database, no bridge,
 * no model). These pin down the iPhone promise and the switch:
 *   - with the switch on, /health carries a top-level openVoices block and guide.engines lists the
 *     very same engines as a booth without the module (older iPhone builds read only that list);
 *   - with KADE_OPEN_VOICES=0, /open-voices answers 404 and /health has no openVoices key;
 *   - a harness that stubs the module still gets a booth that loads, with no openVoices anywhere;
 *   - /health never waits on a slow bridge.
 * Run: node --test api/server/routes/kadeSoundBoothOpenVoicesWiring.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROUTE = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
const LOCAL = ['./kadeSoundBoothSplit', './kadeSoundBoothScreenplay', './kadeSoundBoothPaste', './kadeSoundBoothCarry',
  './kadeSoundBoothTasks', './kadeSoundBoothErrors'];

/* The route, loaded with fakes. `openVoices` false stands the module in with an empty one; `bridge`
 * answers the open-voices health call (a promise, so a test can hold it). */
function booth({ env = {}, openVoices = true, bridge } = {}) {
  const handlers = new Map();
  const uses = [];
  const bridgeCalls = [];
  const router = Object.fromEntries(['post', 'get', 'put', 'delete', 'patch'].map((m) => [m, (p, ...v) => handlers.set(m + p, v.at(-1))]));
  router.use = (...args) => uses.push(args);
  /* Enough of @librechat/api for /health, as the ACE selftest stands it in. */
  const api = new Proxy({
    yueStyles: {}, yueStylesEnabled: () => false, yueConfigured: () => false, yueCost: 'test price',
    yueCoverSettings: (settings) => settings, yueCoverOptions: () => ({}), yueSavedOptions: (options) => options,
    musicCoverLengthGuide: (yue) => yue, musicReferenceSpeedNote: () => '',
    effectsGuide: { name: 'Stable Audio', settings: [], howToWrite: [] }, effectsConfigured: () => false,
    effectsVariant: () => ({ name: 'Stable Audio', model: 'stable', price: 0 }),
    familyFeatures: () => ({ trainedStyles: false }), writingCost: () => ({ costUSD: 0, measured: false }),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (/^create\w*Router$/.test(String(key))) return () => () => {};
      return undefined;
    },
  });
  const context = {
    module: { exports: {} }, Buffer, URL, console, AbortSignal, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }),
    process: { env: { BRIDGE_SECRET: 'offline-fixture', ...env } },
    require(name) {
      if (name === 'express') return { Router: () => router, json: () => (_req, _res, next) => next && next() };
      if (name === 'multer') return Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
      if (name === 'axios') {
        return {
          get: async (url, o) => {
            bridgeCalls.push(url);
            if (url.endsWith('/audio/open-voices/health') && bridge) return bridge(url, o);
            throw new Error('offline');
          },
          post: async () => { throw new Error('offline'); },
        };
      }
      if (name === 'crypto') return require(name);
      if (name === '@librechat/api') return api;
      if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
      if (name === '~/server/middleware') return { requireJwtAuth: (_req, _res, next) => next() };
      if (name === '~/models/kadeUsage') return { logKadeUsage: async () => {} };
      if (name === '~/server/utils/kadeSongAudience') return { songAudience: async () => 'explicit', explicitSungLines: () => [] };
      if (name === './kadeSoundBoothLink') return { createReferenceLinkRouter: () => () => {}, guideFor: (g) => g };
      if (name === './kadeSoundBoothOpenVoices') return openVoices ? require(name) : {};
      if (name === 'mongoose') return { Types: { ObjectId: { isValid: (v) => /^[0-9a-f]{24}$/i.test(String(v)) } } };
      if (name === '../services/kadeSongCharge') return require(name);
      if (LOCAL.includes(name)) return require(name);
      return {};
    },
  };
  vm.runInNewContext(ROUTE, context);
  const health = async () => {
    let status = 200;
    let body;
    const res = { status(v) { status = v; return this; }, json(v) { body = v; return this; }, setHeader() {} };
    await handlers.get('get/health')({ user: { id: 'offline-owner', role: 'USER' }, body: {}, query: {}, params: {} }, res);
    return { status, body };
  };
  /* The switch in front of /open-voices, as express would run it. */
  const openVoicesGate = () => {
    const gate = uses.find((u) => u[0] === '/open-voices');
    if (!gate) return null;
    let status = 200;
    let body;
    let passed = false;
    gate[1]({}, { status(v) { status = v; return this; }, json(v) { body = v; return this; } }, () => { passed = true; });
    return { status: passed ? 'next' : status, body };
  };
  return { health, openVoicesGate, uses, bridgeCalls, context };
}

const ready = async () => ({ data: { enabled: true, engines: { voxcpm: { configured: true }, ming: { configured: false } } } });

test('switch on: /health gains openVoices at the top, and guide.engines is the same list as without it', async () => {
  const plain = await booth({ openVoices: false }).health();
  assert.equal(plain.status, 200);
  const on = booth({ bridge: ready });
  const h = await on.health();
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(h.body.guide.engines), Object.keys(plain.body.guide.engines));
  assert.equal(JSON.stringify(h.body.guide), JSON.stringify(plain.body.guide), 'the guide the iPhone reads is untouched');
  assert.deepEqual(Object.keys(h.body.engines), Object.keys(plain.body.engines));
  assert.ok(h.body.openVoices, 'a top-level openVoices block');
  assert.deepEqual(h.body.openVoices.engines.map((e) => e.id), ['voxcpm']);
  for (const id of ['voxcpm', 'ming']) {
    assert.equal(id in h.body.guide.engines, false);
    assert.equal(id in h.body.engines, false);
  }
  assert.equal(on.openVoicesGate().status, 'next');
});

test('KADE_OPEN_VOICES=0: /open-voices is 404 and /health has no openVoices key', async () => {
  const off = booth({ env: { KADE_OPEN_VOICES: '0' }, bridge: ready });
  const h = await off.health();
  assert.equal(h.status, 200);
  assert.equal('openVoices' in h.body, false);
  const gate = off.openVoicesGate();
  assert.equal(gate.status, 404);
  assert.match(gate.body.error, /switched off/);
  assert.equal(off.bridgeCalls.some((u) => u.includes('open-voices')), false, 'no bridge call while off');
});

test('a stubbed module: the booth still loads, with no openVoices anywhere', async () => {
  const stub = booth({ openVoices: false });
  const h = await stub.health();
  assert.equal(h.status, 200);
  assert.equal('openVoices' in h.body, false);
  assert.equal(stub.openVoicesGate(), null, 'no /open-voices routes');
});

test('/health does not wait on a slow bridge', async () => {
  let release;
  const slow = booth({ bridge: () => new Promise((r) => { release = () => r({ data: { enabled: true, engines: { voxcpm: { configured: true } } } }); }) });
  const t0 = Date.now();
  const h = await slow.health();
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(h.body.openVoices.engines, [], 'nothing known yet');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await slow.health()).body.openVoices.engines.map((e) => e.id), ['voxcpm'], 'the answer arrives for the next look');
});

test('Chatterbox and DramaBox ride in openVoices.moreEngines; openVoices.engines and the guide are unchanged', async () => {
  const all = async () => ({ data: { enabled: true, engines: { voxcpm: { configured: true }, ming: { configured: false }, chatterbox: { configured: true }, dramabox: { configured: true } } } });
  const h = await booth({ bridge: all }).health();
  assert.deepEqual(h.body.openVoices.engines.map((e) => e.id), ['voxcpm']);
  assert.deepEqual(h.body.openVoices.moreEngines.map((e) => e.id), ['chatterbox', 'dramabox']);
  const plain = await booth({ openVoices: false }).health();
  assert.equal(JSON.stringify(h.body.guide), JSON.stringify(plain.body.guide));
  for (const id of ['chatterbox', 'dramabox']) assert.equal(id in h.body.guide.engines, false);
  const off = await booth({ bridge: ready }).health();
  assert.deepEqual(off.body.openVoices.moreEngines, [], 'unset on the bridge: not offered');
});
