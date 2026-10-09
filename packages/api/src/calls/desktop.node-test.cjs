const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const express = require('express');

const file = path.join(__dirname, 'desktop.ts');
const compiled = new Module(file, module);
compiled.filename = file;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file);
const { createDesktopCallsRouter, webCallSessionId } = compiled.exports;
const lease = '11111111-1111-4111-8111-111111111111';
const firedAt = new Date().toISOString();
const ring = { planId: 'one', ringId: `one:${firedAt}`, agentId: 'kiana', agentName: 'Kiana', purpose: 'Check in', firedAt, expiresAt: new Date(Date.now() + 180000).toISOString() };

test('call history exposes only the bridge-generated web session identifier shape', () => {
  assert.equal(webCallSessionId('web-mabc123-xyz123'), 'web-mabc123-xyz123');
  for (const value of [undefined, null, {}, 12, 'web:private@example.invalid', 'web-foo-../../secret', 'other-id']) assert.equal(webCallSessionId(value), null);
});

async function fixture(options = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/kade/calls', createDesktopCallsRouter({
    auth: (req, res, next) => req.headers.authorization === 'fixture' ? next() : res.status(401).json({ error: 'Sign in' }),
    userId: () => 'signed-in-owner', bridgeUrl: 'https://bridge.invalid', secret: 'server-only-secret',
    request: async (url, init) => {
      calls.push({ url: String(url), init });
      if (options.fail) throw Error('server-only-secret must never appear');
      return new Response(JSON.stringify(options.payload ?? (init.method === 'POST' ? { ok: true, expiresAt: ring.expiresAt } : { rings: [{ ...ring, privateField: 'do not send' }] })), { status: options.status ?? 200 });
    }, ...options.deps,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/kade/calls`;
  return { calls, get: (route, init = {}) => fetch(base + route, { headers: { authorization: 'fixture', 'content-type': 'application/json' }, ...init }), close: () => { server.closeAllConnections(); server.close(); } };
}

test('signed-in owner is authoritative; upstream and downstream secrets cannot be injected', async () => {
  const f = await fixture();
  try {
    const response = await f.get('/pending?userId=somebody-else&secret=client-value');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { rings: [ring] });
    assert.equal(f.calls[0].url, 'https://bridge.invalid/call-plans/pending?userId=signed-in-owner');
    assert.equal(f.calls[0].init.headers['x-notify-secret'], 'server-only-secret');
    assert.equal(f.calls[0].init.redirect, 'error');
    assert.ok(f.calls[0].init.signal);
  } finally { f.close(); }
});

test('presence forwards only validated lease, setting and server owner', async () => {
  const f = await fixture();
  try {
    let response = await f.get('/presence', { method: 'POST', body: JSON.stringify({ enabled: true, leaseId: lease, userId: 'other', secret: 'other' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { userId: 'signed-in-owner', enabled: true, leaseId: lease });
    response = await f.get('/presence', { method: 'POST', body: JSON.stringify({ enabled: false, leaseId: lease }) });
    assert.deepEqual(await response.json(), { ok: true, expiresAt: null });
  } finally { f.close(); }
});

test('bridge-only server configuration uses its own header without exposing the key', async () => {
  const f = await fixture({ deps: { secret: 'server-bridge-key', secretHeader: 'x-bridge-secret' } });
  try {
    const response = await f.get('/pending');
    assert.equal(response.status, 200);
    assert.equal(f.calls[0].init.headers['x-bridge-secret'], 'server-bridge-key');
    assert.equal(f.calls[0].init.headers['x-notify-secret'], undefined);
    assert.equal((await response.text()).includes('server-bridge-key'), false);
  } finally { f.close(); }
});

test('authentication and invalid presence stop before a bridge request', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/pending', { headers: {} })).status, 401);
    for (const body of [{}, { enabled: 'true', leaseId: lease }, { enabled: true, leaseId: 'invalid' }]) {
      assert.equal((await f.get('/presence', { method: 'POST', body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('missing owner, configuration and insecure target fail closed', async () => {
  for (const deps of [{ userId: () => '' }, { secret: '' }, { bridgeUrl: 'http://bridge.invalid' }, { bridgeUrl: 'https://name:password@bridge.invalid' }]) {
    const f = await fixture({ deps });
    try {
      assert.ok([401, 503].includes((await f.get('/pending')).status));
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  }
});

test('upstream errors are generic and malformed projections are never surfaced', async () => {
  for (const options of [{ fail: true }, { status: 500 }, { payload: null, status: 500 }, { payload: {} }]) {
    const f = await fixture(options);
    try {
      const response = await f.get('/pending');
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes('server-only-secret'), false);
    } finally { f.close(); }
  }
  const f = await fixture({ payload: { rings: [null, {}, { ...ring, ringId: 'not-the-current-fire' }, { ...ring, firedAt: 'invalid' }, ring] } });
  try { assert.deepEqual(await (await f.get('/pending')).json(), { rings: [ring] }); }
  finally { f.close(); }
});

test('presence needs an actual valid upstream lease acknowledgement', async () => {
  for (const payload of [{ ok: false }, { ok: true }, { ok: true, expiresAt: 'bad' }]) {
    const f = await fixture({ payload });
    try { assert.equal((await f.get('/presence', { method: 'POST', body: JSON.stringify({ enabled: true, leaseId: lease }) })).status, 503); }
    finally { f.close(); }
  }
});
