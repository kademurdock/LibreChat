'use strict';
/* Nov 26 2026 (Part 460): which TRUST_PROXY makes req.ip the real person on Railway.
 * Railway's traffic arrives with X-Forwarded-For "<real client>, <Railway edge>" (edges such as
 * 79.127.178.81 and 152.233.12.241) from Railway's inner proxy on the socket. With TRUST_PROXY
 * unset (index.js turns that into 1), req.ip is the edge, so every per-address limit and ban is
 * shared by everyone on that edge. TRUST_PROXY=2 trusts exactly those two hops: req.ip is the
 * client the edge saw, and anything a client writes in its own X-Forwarded-For lands further left,
 * where it is never read. kadeBlockedIps reads every entry itself, so it works either way.
 * Run: node --test api/server/kadeTrustProxy.nodetest.js (no network beyond 127.0.0.1). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { kadeBlockedIps } = require('./kadeBlockedIps');

function appWith(TRUST_PROXY) {
  const app = express();
  const trusted_proxy = Number(TRUST_PROXY) || 1; // the exact line in api/server/index.js
  app.set('trust proxy', trusted_proxy);
  app.use(kadeBlockedIps());
  app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
  return app;
}
async function ask(app, xff) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/ip', headers: xff ? { 'x-forwarded-for': xff } : {} }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
    });
  } finally {
    server.close();
  }
}
const CLIENT = '203.0.113.7';
const EDGE = '79.127.178.81';
const EDGE2 = '152.233.12.241';

test('today (TRUST_PROXY unset -> 1): req.ip is the Railway edge', async () => {
  const r = await ask(appWith(undefined), `${CLIENT}, ${EDGE}`);
  assert.equal(JSON.parse(r.body).ip, EDGE);
});
test('TRUST_PROXY=2: req.ip is the real client, on either edge', async () => {
  assert.equal(JSON.parse((await ask(appWith('2'), `${CLIENT}, ${EDGE}`)).body).ip, CLIENT);
  assert.equal(JSON.parse((await ask(appWith('2'), `${CLIENT}, ${EDGE2}`)).body).ip, CLIENT);
});
test('TRUST_PROXY=2: a client that sends its own X-Forwarded-For cannot pick req.ip', async () => {
  // The client sends "6.6.6.6"; the edge appends the real client, the inner proxy appends the edge.
  for (const spoof of ['6.6.6.6', '1.1.1.1, 6.6.6.6', '127.0.0.1']) {
    const r = await ask(appWith('2'), `${spoof}, ${CLIENT}, ${EDGE}`);
    assert.equal(JSON.parse(r.body).ip, CLIENT, spoof);
  }
});
test('TRUST_PROXY=3 would be wrong: a spoofed entry becomes req.ip', async () => {
  const r = await ask(appWith('3'), `6.6.6.6, ${CLIENT}, ${EDGE}`);
  assert.equal(JSON.parse(r.body).ip, '6.6.6.6');
});
test('kadeBlockedIps still refuses the intruder whatever TRUST_PROXY is', async () => {
  for (const tp of [undefined, '2']) {
    assert.equal((await ask(appWith(tp), `195.160.221.181, ${EDGE}`)).status, 403);
    assert.equal((await ask(appWith(tp), `6.6.6.6, 195.160.221.181, ${EDGE}`)).status, 403);
    assert.equal((await ask(appWith(tp), `${CLIENT}, ${EDGE}`)).status, 200);
  }
});
