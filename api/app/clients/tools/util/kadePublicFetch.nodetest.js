'use strict';
/* Nov 26 2026 (Part 460): the shared guard, run against the fork's REAL address checks
 * (@librechat/api isSSRFTarget / resolveHostnameSSRF, built from packages/api/src/auth). Every
 * address here is a literal or a name the guard refuses before DNS, so nothing touches the network.
 * Needs a built @librechat/api on the module path; skipped when there is none.
 * Run: node --test api/app/clients/tools/util/kadePublicFetch.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateTarget, fetchPublic, PrivateTargetError, loadSsrfHelpers } = require('./kadePublicFetch');

const helpers = loadSsrfHelpers();
const skip = helpers ? false : 'no built @librechat/api on the module path';

test('the real address lists refuse every inside address', { skip }, async () => {
  for (const url of [
    'http://railway.internal/',
    'http://kade-ai-bridge.railway.internal:8080/health',
    'http://REDIS.RAILWAY.INTERNAL./',
    'http://localhost/',
    'http://app.localhost/',
    'http://127.0.0.1:9229/json',
    'http://127.8.9.10/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://100.127.255.254/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fd12:3456:789a::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://metadata/',
    'http://mongodb/',
    'http://service.internal/',
    'http://printer.local/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.equal(await isPrivateTarget(url, { helpers }), true, url);
  }
});

test('ordinary public addresses pass the literal checks', { skip }, async () => {
  for (const url of ['http://93.184.216.34/', 'https://8.8.8.8/', 'http://100.128.0.1/', 'http://172.32.0.1/', 'http://[2606:4700::1111]/']) {
    assert.equal(await isPrivateTarget(url, { helpers }), false, url);
  }
});

test('no helpers means refused', async () => {
  assert.equal(await isPrivateTarget('https://example.com/', { helpers: null }), true);
});

test('a hop to an inside address throws before it is requested', { skip }, async () => {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } };
  };
  await assert.rejects(fetchPublic('http://93.184.216.34/feed', {}, { get, helpers }), PrivateTargetError);
  assert.deepEqual(asked, ['http://93.184.216.34/feed']);
});

test('hops are capped: three redirects are followed, the fourth is refused', { skip }, async () => {
  let n = 0;
  const get = async () => {
    n += 1;
    return { status: 302, headers: { location: `http://93.184.216.34/hop${n}` } };
  };
  await assert.rejects(fetchPublic('http://93.184.216.34/start', {}, { get, helpers, maxHops: 3 }), /too many redirects/);
  assert.equal(n, 4, 'the first request plus three redirects');
});
