import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(readFileSync(new URL('./help.ts', import.meta.url), 'utf8'));
const { publicHelp } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

function response() {
  return {
    code: 200,
    headers: {},
    status(n) {
      this.code = n;
      return this;
    },
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    type(t) {
      this.contentType = t;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}
test('public help preserves branded URL and never forwards account data or query parameters', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    sent = args;
    return new Response('<h1>Help</h1>', { headers: { 'Content-Type': 'text/html' } });
  });
  const res = response();
  await publicHelp(
    {
      path: '/help/projects/',
      originalUrl: '/help/projects/?q=private',
      headers: { cookie: 'secret', authorization: 'secret' },
    },
    res,
  );
  assert.equal(res.code, 200);
  assert.equal(res.body, '<h1>Help</h1>');
  assert.equal(sent[0], 'https://inworld-tts-proxy-production.up.railway.app/help/projects');
  assert.deepEqual(Object.keys(sent[1].headers).sort(), [
    'Accept',
    'User-Agent',
    'X-Kade-Help-Proxy',
  ]);
  assert.equal(sent[1].redirect, 'error');
});
test('unsupported paths never reach an upstream', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upstream'));
  for (const path of [
    '/api/private',
    '/help/../private',
    '/help/%2e%2e',
    '/help/a/b',
    '//other-host/help',
  ]) {
    const res = response();
    await publicHelp({ path }, res);
    assert.equal(res.code, 404);
  }
  assert.equal(fetch.mock.callCount(), 0);
});
test('unknown articles return 404 and upstream failure gives usable branded recovery', async (t) => {
  for (const [upstream, expected] of [
    [new Response('missing', { status: 404 }), 404],
    [new Response('error', { status: 500 }), 503],
    [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), 503],
  ]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => upstream);
    const res = response();
    await publicHelp({ path: '/help/unknown' }, res);
    assert.equal(res.code, expected);
    assert.doesNotMatch(res.body, /railway|secret/);
    mocked.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('timeout');
  });
  const res = response();
  await publicHelp({ path: '/help' }, res);
  assert.equal(res.code, 503);
  assert.match(res.body, /Return to Kade Home/);
});
test('Android download uses only the fixed APK route and expected media type', async (t) => {
  let url;
  t.mock.method(globalThis, 'fetch', async (target) => {
    url = target;
    return new Response('apk', {
      headers: { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': '3' },
    });
  });
  const res = response();
  await publicHelp({ path: '/help/android-download' }, res);
  assert.match(url, /\/Kade-AI\.apk$/);
  assert.equal(res.body.toString(), 'apk');
  assert.match(res.headers['Content-Disposition'], /attachment/);
});
