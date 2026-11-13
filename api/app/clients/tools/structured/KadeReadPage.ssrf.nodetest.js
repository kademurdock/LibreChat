'use strict';
/* Nov 13 2026 (sweep 0.0): the page reader never fetches a private address, at the first request
 * or on any redirect hop. The tool is loaded with axios and the fork's SSRF helpers replaced by
 * stand-ins, so nothing touches the network or DNS.
 * Run: node --test api/app/clients/tools/structured/KadeReadPage.ssrf.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

/** Stand-ins with the same contract as packages/api/src/auth/domain.ts. */
const PRIVATE_NAMES = new Set(['localhost', 'mongo', 'rag_api']);
const isPrivateIp = (h) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) ||
  h === '::1' ||
  /^f[cd][0-9a-f]{0,2}:/.test(h) ||
  /^fe[89ab]/.test(h);
function helpers(dns = {}) {
  return {
    isSSRFTarget: (h) =>
      PRIVATE_NAMES.has(h) || isPrivateIp(h) || h.endsWith('.internal') || h.endsWith('.local'),
    resolveHostnameSSRF: async (h) => isPrivateIp(h) || (dns[h] ? isPrivateIp(dns[h]) : false),
    createSSRFSafeAgents: () => ({ httpAgent: 'safe-http', httpsAgent: 'safe-https' }),
  };
}

function loadReader({ get, api }) {
  const original = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === 'axios') return { get };
    if (id === '@librechat/agents/langchain/tools') return { Tool: class {} };
    if (id === '@librechat/data-schemas') return { logger: { warn() {}, info() {}, error() {} } };
    if (id === '@librechat/api') {
      if (api === null) throw new Error('not built');
      return api;
    }
    return original.call(this, id, parent, isMain);
  };
  try {
    const file = path.join(__dirname, 'KadeReadPage.js');
    delete require.cache[file];
    return require(file);
  } finally {
    /* The tool asks for '@librechat/api' when it runs, so the stand-in stays for the test. */
    process.nextTick(() => undefined);
  }
}
const restore = (() => {
  const original = Module._load;
  return () => {
    Module._load = original;
  };
})();
const PAGE = `<html><head><title>News</title></head><body><article>${'Real words. '.repeat(30)}</article></body></html>`;
const jinaDown = () => {
  throw new Error('reader down');
};

test.afterEach(() => {
  restore();
  delete process.env.KADE_READ_PAGE_SSRF;
});

test('private, loopback, link-local and inside names are refused before anything is fetched', async () => {
  const urls = [];
  const KadeReadPage = loadReader({
    get: async (url) => {
      urls.push(url);
      return { status: 200, data: PAGE, headers: {} };
    },
    api: helpers({ 'rebind.example': '10.0.0.7' }),
  });
  const tool = new KadeReadPage();
  for (const url of [
    'http://mongodb.railway.internal:27017/',
    'http://rag.railway.internal./x',
    'http://RAILWAY.internal/',
    'http://localhost:3080/api/config',
    'http://127.0.0.1/',
    'http://[::1]:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://[fd12:3456::1]/',
    'http://mongo/',
    'http://printer.local/',
    'http://rebind.example/', // a public-looking name that resolves to a private address
    'http://2130706433/', // 127.0.0.1 written as one number
  ]) {
    assert.equal(await tool._call({ url }), KadeReadPage.PRIVATE_REFUSAL, url);
  }
  assert.equal(urls.length, 0, 'neither the outside reader nor the server fetched anything');
  assert.equal(await tool._call({ url: 'ftp://example.com/' }), 'I need a full http(s) URL.');
});

test('a public page is still read by the fallback, through the connect-time guard', async () => {
  const calls = [];
  const KadeReadPage = loadReader({
    get: async (url, options) => {
      if (url.startsWith('https://r.jina.ai/')) return jinaDown();
      calls.push({ url, options });
      return { status: 200, data: PAGE, headers: {} };
    },
    api: helpers(),
  });
  const out = await new KadeReadPage()._call({ url: 'https://news.example/story' });
  assert.match(out, /^PAGE TITLE: News\n\nReal words\./);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxRedirects, 0, 'redirects are followed by hand');
  assert.equal(calls[0].options.httpAgent, 'safe-http');
  assert.equal(calls[0].options.httpsAgent, 'safe-https');
});

test('a public link that redirects to a private address is refused at that hop', async () => {
  const fetched = [];
  const KadeReadPage = loadReader({
    get: async (url) => {
      if (url.startsWith('https://r.jina.ai/')) return jinaDown();
      fetched.push(url);
      if (url === 'https://short.example/a') {
        return { status: 302, data: '', headers: { location: 'https://hop.example/b' } };
      }
      if (url === 'https://hop.example/b') {
        return { status: 301, data: '', headers: { location: 'http://devbox.railway.internal:8080/exec' } };
      }
      return { status: 200, data: PAGE, headers: {} };
    },
    api: helpers(),
  });
  const out = await new KadeReadPage()._call({ url: 'https://short.example/a' });
  assert.equal(out, KadeReadPage.PRIVATE_REFUSAL);
  assert.deepEqual(fetched, ['https://short.example/a', 'https://hop.example/b'], 'the private hop was never requested');
});

test('public redirects are followed (relative ones too), and a redirect loop ends after five hops', async () => {
  const KadeReadPage = loadReader({
    get: async (url) => {
      if (url.startsWith('https://r.jina.ai/')) return jinaDown();
      if (url === 'https://a.example/old') return { status: 302, data: '', headers: { location: '/new' } };
      if (url === 'https://a.example/new') return { status: 200, data: PAGE, headers: {} };
      return { status: 302, data: '', headers: { location: url + 'x' } };
    },
    api: helpers(),
  });
  const tool = new KadeReadPage();
  assert.match(await tool._call({ url: 'https://a.example/old' }), /^PAGE TITLE: News/);
  assert.match(await tool._call({ url: 'https://loop.example/' }), /couldn't read that page \(too many redirects\)/);
});

test('if the helpers cannot be loaded, the fetch is refused rather than allowed', async () => {
  let hits = 0;
  const KadeReadPage = loadReader({
    get: async () => {
      hits += 1;
      return { status: 200, data: PAGE, headers: {} };
    },
    api: null,
  });
  assert.equal(await new KadeReadPage()._call({ url: 'https://news.example/' }), KadeReadPage.PRIVATE_REFUSAL);
  assert.equal(hits, 0);
});

test('KADE_READ_PAGE_SSRF=0 puts back the old unchecked fetch', async () => {
  process.env.KADE_READ_PAGE_SSRF = '0';
  const calls = [];
  const KadeReadPage = loadReader({
    get: async (url, options) => {
      if (url.startsWith('https://r.jina.ai/')) return jinaDown();
      calls.push({ url, options });
      return { status: 200, data: PAGE, headers: {} };
    },
    api: helpers(),
  });
  assert.match(await new KadeReadPage()._call({ url: 'http://10.1.2.3/' }), /^PAGE TITLE: News/);
  assert.equal(calls[0].options.maxRedirects, 5);
  assert.equal(calls[0].options.httpAgent, undefined);
});
