'use strict';
/* Nov 26 2026 (Part 461): the service seat (X-Kade-Service).
 * Shows that, with TRUST_PROXY=2, Kade's own services skip the per-address
 * limits and address bans and nothing else, that the feature is off without
 * the variable, and that the header is gone before any route or logger sees it.
 * Run: node --test api/server/middleware/kadeServiceSeat.nodetest.js
 * (needs NODE_PATH pointing at a LibreChat node_modules; no network beyond 127.0.0.1, no database). */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const express = require('express');

const SECRET = 'test-only-service-seat-0123456789abcdef';
const seat = require('./kadeServiceSeat');

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.KADE_SERVICE_LIMIT_SECRET = SECRET;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

/* Load a module with some of its requires replaced, the way accessRequest.knock.nodetest.js does. */
function loadWith(path, stubs) {
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve(path)];
    return require(path);
  } finally {
    Module._load = realLoad;
  }
}

/* The same port-stripping key the real limiters use. */
function removePorts(req) {
  const ip = req?.['ip'];
  if (!ip) return ip;
  const i = ip.lastIndexOf(':');
  return i > -1 && ip.indexOf('.') !== -1 ? ip.slice(0, i) : ip;
}
const reqOf = (headers = {}) => ({ headers, rawHeaders: Object.entries(headers).flat() });

test('off when KADE_SERVICE_LIMIT_SECRET is unset or empty', () => {
  delete process.env.KADE_SERVICE_LIMIT_SECRET;
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': SECRET })), false);
  process.env.KADE_SERVICE_LIMIT_SECRET = '   ';
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': '   ' })), false);
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': '' })), false);
});

test('off when the secret is too short to be safe', () => {
  process.env.KADE_SERVICE_LIMIT_SECRET = 'short';
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': 'short' })), false);
});

test('on: only the exact value counts', () => {
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': SECRET })), true);
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': SECRET + 'x' })), false);
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': SECRET.slice(0, -1) })), false);
  assert.equal(seat.isKadeService(reqOf({ 'x-kade-service': [SECRET, SECRET] })), false);
  assert.equal(seat.isKadeService(reqOf({})), false);
  assert.equal(seat.isKadeService(null), false);
});

test('sameSecret compares without caring about length', () => {
  assert.equal(seat.sameSecret('a'.repeat(30), 'a'.repeat(30)), true);
  assert.equal(seat.sameSecret('a', 'a'.repeat(30)), false);
  assert.equal(seat.sameSecret(undefined, 'a'.repeat(30)), false);
  assert.equal(seat.sameSecret('a'.repeat(30), ''), false);
});

test('the middleware remembers the answer and removes the header everywhere', () => {
  const mw = seat.kadeServiceSeat();
  const req = reqOf({ 'x-kade-service': SECRET, 'user-agent': 'ua' });
  req.rawHeaders = ['User-Agent', 'ua', 'X-Kade-Service', SECRET];
  let nexted = false;
  mw(req, {}, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(req.headers['x-kade-service'], undefined);
  assert.deepEqual(req.rawHeaders, ['User-Agent', 'ua']);
  assert.equal(seat.isKadeService(req), true);
  // The remembered answer is not an ordinary property, so it never shows up in a dump of the request.
  assert.equal(Object.keys(req).some((k) => /kade/i.test(k)), false);
  assert.equal(JSON.stringify(req).includes(SECRET), false);

  const plain = reqOf({ 'x-kade-service': 'wrong-value-wrong-value-wrong' });
  mw(plain, {}, () => {});
  assert.equal(plain.headers['x-kade-service'], undefined);
  assert.equal(seat.isKadeService(plain), false);
  // A later header added by hand cannot turn a decided request into a service.
  plain.headers['x-kade-service'] = SECRET;
  assert.equal(seat.isKadeService(plain), false);
});

/* ---------- the real limiters, through a real Express app with TRUST_PROXY=2 ---------- */

const EDGE = '79.127.178.81';
const RAILWAY_EGRESS = '152.233.10.20';

async function hit(app, { xff, service }, times) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const out = [];
  try {
    for (let i = 0; i < times; i++) {
      const headers = { 'x-forwarded-for': xff, 'content-type': 'application/json' };
      if (service) headers['x-kade-service'] = service;
      out.push(
        await new Promise((resolve, reject) => {
          const r = http.request({ host: '127.0.0.1', port, path: '/go', method: 'POST', headers }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          r.on('error', reject);
          r.end('{}');
        }),
      );
    }
  } finally {
    server.close();
  }
  return out;
}

function limiterStubs() {
  return {
    '@librechat/api': { limiterCache: () => undefined, removePorts },
    '~/cache': { logViolation: async () => {} },
    '~/server/middleware/denyRequest': async (_req, res) => res.status(429).json({ message: 'slow down' }),
  };
}

function appWith(limiter) {
  const app = express();
  app.set('trust proxy', 2);
  app.use(seat.kadeServiceSeat());
  app.use(express.json());
  app.post('/go', limiter, (req, res) =>
    res.json({ ip: req.ip, sawHeader: 'x-kade-service' in req.headers, raw: req.rawHeaders.join('|') }),
  );
  return app;
}

test('loginLimiter: a service on one Railway address is never counted; everyone else still is', async () => {
  process.env.LOGIN_MAX = '2';
  const loginLimiter = loadWith('./limiters/loginLimiter', limiterStubs());
  const app = appWith(loginLimiter);
  const xff = `${RAILWAY_EGRESS}, ${EDGE}`;

  const service = await hit(app, { xff, service: SECRET }, 6);
  assert.deepEqual(service.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  const first = JSON.parse(service[0].body);
  assert.equal(first.ip, RAILWAY_EGRESS); // TRUST_PROXY=2 really is reading the client
  assert.equal(first.sawHeader, false); // the route never saw the header
  assert.equal(first.raw.toLowerCase().includes('x-kade-service'), false);
  assert.equal(first.raw.includes(SECRET), false);

  const other = await hit(app, { xff: `198.51.100.9, ${EDGE}` }, 3);
  assert.deepEqual(other.map((r) => r.status), [200, 200, 429]);

  const wrong = await hit(app, { xff: `198.51.100.10, ${EDGE}`, service: 'not-the-secret-not-the-secret' }, 3);
  assert.deepEqual(wrong.map((r) => r.status), [200, 200, 429]);
});

test('loginLimiter: with the variable unset, the header does nothing', async () => {
  delete process.env.KADE_SERVICE_LIMIT_SECRET;
  process.env.LOGIN_MAX = '2';
  const loginLimiter = loadWith('./limiters/loginLimiter', limiterStubs());
  const out = await hit(appWith(loginLimiter), { xff: `${RAILWAY_EGRESS}, ${EDGE}`, service: SECRET }, 3);
  assert.deepEqual(out.map((r) => r.status), [200, 200, 429]);
});

test('messageIpLimiter skips a service; messageUserLimiter still counts its account', async () => {
  process.env.MESSAGE_IP_MAX = '2';
  process.env.MESSAGE_USER_MAX = '3';
  const { messageIpLimiter, messageUserLimiter } = loadWith('./limiters/messageLimiters', limiterStubs());
  const signedIn = (req, _res, next) => {
    req.user = { id: 'seat-user-1' };
    next();
  };
  const app = express();
  app.set('trust proxy', 2);
  app.use(seat.kadeServiceSeat());
  app.post('/go', signedIn, messageIpLimiter, messageUserLimiter, (_req, res) => res.json({ ok: true }));
  const out = await hit(app, { xff: `${RAILWAY_EGRESS}, ${EDGE}`, service: SECRET }, 4);
  assert.deepEqual(out.map((r) => r.status), [200, 200, 200, 429]);
});

/* ---------- address bans ---------- */

function banStubs(banLogs) {
  class FakeKeyv {
    async get() {
      return undefined;
    }
    async set() {}
  }
  return {
    keyv: { Keyv: FakeKeyv },
    '@librechat/data-schemas': { logger: { warn() {}, error() {}, info() {} } },
    '@librechat/api': { isEnabled: (v) => v === true || v === 'true', keyvMongo: {}, removePorts },
    '~/cache': { getLogStores: () => banLogs },
    './denyRequest': async (_req, res) => res.status(403).json({}),
    '~/models': { findUser: async () => null },
  };
}

function fakeBanLogs(entries) {
  const map = new Map(Object.entries(entries));
  return {
    opts: { ttl: 60 * 60 * 1000 },
    get: async (k) => map.get(k),
    set: async (k, v) => map.set(k, v),
    delete: async (k) => map.delete(k),
    map,
  };
}

function resRecorder() {
  return {
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json() {
      return this;
    },
  };
}

test('checkBan: an address ban does not stop a service, but an account ban still does', async () => {
  process.env.BAN_VIOLATIONS = 'true';
  const later = { expiresAt: Date.now() + 60 * 60 * 1000 };
  const banLogs = fakeBanLogs({ [RAILWAY_EGRESS]: later, 'banned-user': later });
  const checkBan = loadWith('./checkBan', banStubs(banLogs));
  const mw = seat.kadeServiceSeat();

  const run = async (headers, user) => {
    const req = { headers: { 'user-agent': 'node', ...headers }, rawHeaders: [], ip: RAILWAY_EGRESS, body: {} };
    if (user) req.user = { id: user };
    mw(req, {}, () => {});
    const res = resRecorder();
    let passed = false;
    await checkBan(req, res, () => (passed = true));
    return { passed, status: res.statusCode };
  };

  assert.deepEqual(await run({}, null), { passed: false, status: 403 });
  assert.deepEqual(await run({ 'x-kade-service': SECRET }, null), { passed: true, status: 200 });
  assert.deepEqual(await run({ 'x-kade-service': SECRET }, 'fine-user'), { passed: true, status: 200 });
  assert.deepEqual(await run({ 'x-kade-service': SECRET }, 'banned-user'), { passed: false, status: 403 });
});

test('banViolation: a service account is banned, its shared address is not', async () => {
  process.env.BAN_VIOLATIONS = 'true';
  process.env.BAN_INTERVAL = '1';
  const run = async (service) => {
    const banLogs = fakeBanLogs({});
    const banViolation = loadWith('../../cache/banViolation', {
      '@librechat/data-schemas': { logger: { warn() {}, error() {}, info() {} } },
      '@librechat/api': {
        isEnabled: (v) => v === true || v === 'true',
        math: (v, d) => Number(v) || d,
        removePorts,
      },
      '~/models': { deleteAllUserSessions: async () => {}, findUser: async () => ({ role: 'USER' }) },
      './getLogStores': () => banLogs,
    });
    const req = { headers: service ? { 'x-kade-service': SECRET } : {}, rawHeaders: [], ip: RAILWAY_EGRESS, user: { id: 'u1', role: 'USER' } };
    seat.kadeServiceSeat()(req, {}, () => {});
    const res = { clearCookie() {} };
    await banViolation(req, res, { type: 'logins', user_id: 'u1', prev_count: 0, violation_count: 1 });
    return banLogs.map;
  };
  const plain = await run(false);
  assert.equal(plain.has('u1'), true);
  assert.equal(plain.has(RAILWAY_EGRESS), true);
  const service = await run(true);
  assert.equal(service.has('u1'), true);
  assert.equal(service.has(RAILWAY_EGRESS), false);
});
