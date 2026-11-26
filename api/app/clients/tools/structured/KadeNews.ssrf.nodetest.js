'use strict';
/* Nov 26 2026 (Part 460): the news tool's custom feed_url was used to probe *.railway.internal
 * and 127.0.0.1:9229 from inside our network. Now no feed address that is private, loopback,
 * link-local, CGNAT or an inside name is fetched, at the first request or on any of at most 3
 * redirect hops. axios and the fork's SSRF helpers are replaced by stand-ins here, so nothing
 * touches the network or DNS. The real address lists are checked in
 * ../util/kadePublicFetch.nodetest.js.
 * Run: node --test api/app/clients/tools/structured/KadeNews.ssrf.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const PRIVATE_NAMES = new Set(['localhost', 'mongo', 'rag_api']);
const isPrivateIp = (h) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) ||
  h === '::1' ||
  /^f[cd][0-9a-f]{0,2}:/.test(h) ||
  /^fe[89ab]/.test(h);
function helpers(dns = {}) {
  return {
    isSSRFTarget: (h) =>
      PRIVATE_NAMES.has(h) || isPrivateIp(h) || h.endsWith('.internal') || h.endsWith('.local'),
    resolveHostnameSSRF: async (h) =>
      isPrivateIp(h) || (dns[h] ? [].concat(dns[h]).some(isPrivateIp) : false),
    createSSRFSafeAgents: () => ({ httpAgent: 'safe-http', httpsAgent: 'safe-https' }),
  };
}

const original = Module._load;
function loadNews({ get, api }) {
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
  for (const f of ['KadeNews.js', '../util/kadeToolCache.js', '../util/kadePublicFetch.js']) {
    delete require.cache[path.join(__dirname, f)];
  }
  return require(path.join(__dirname, 'KadeNews.js'));
}

const RSS = `<rss><channel>${[1, 2, 3]
  .map((i) => `<item><title>Story ${i}</title><description>Words ${i}</description></item>`)
  .join('')}</channel></rss>`;
// Each test uses its own person, so the 5-minute feed cache never carries over.
let person = 0;
const tool = (News) => {
  const t = new News();
  t.req = { user: { id: `person-${++person}` } };
  return t;
};

test.afterEach(() => {
  Module._load = original;
  delete process.env.KADE_NEWS_SSRF;
});

test('private, loopback, link-local, CGNAT and inside feed addresses are refused before any fetch', async () => {
  const urls = [];
  const News = loadNews({
    get: async (url) => {
      urls.push(url);
      return { status: 200, data: RSS, headers: {} };
    },
    api: helpers({ 'rebind.example': ['93.184.216.34', '10.0.0.7'] }),
  });
  for (const feed_url of [
    'http://mongodb.railway.internal:27017/',
    'http://bridge.railway.internal./feed',
    'http://localhost:3080/api/config',
    'http://127.0.0.1:9229/json',
    'http://0.0.0.0/',
    'http://[::1]:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://mongo/',
    'http://printer.local/',
    'http://rebind.example/feed', // one public answer and one private answer: refused
    'http://2130706433/', // 127.0.0.1 written as one number
  ]) {
    const out = await tool(News)._call({ feed_url });
    assert.match(out, /points inside a private network/, feed_url);
  }
  assert.equal(urls.length, 0, 'nothing was fetched');
});

test('a public feed is read through the connect-time guard with redirects off', async () => {
  const calls = [];
  const News = loadNews({
    get: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, data: RSS, headers: {} };
    },
    api: helpers(),
  });
  const out = await tool(News)._call({ feed_url: 'https://news.example/rss', items_per_category: 2 });
  assert.match(out, /^Latest from https:\/\/news\.example\/rss:\n- Story 1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(calls[0].options.httpAgent, 'safe-http');
  assert.equal(calls[0].options.httpsAgent, 'safe-https');
});

test('a feed that redirects to a private address is refused at that hop', async () => {
  const fetched = [];
  const News = loadNews({
    get: async (url) => {
      fetched.push(url);
      if (url === 'https://short.example/a') {
        return { status: 302, data: '', headers: { location: 'http://127.0.0.1:9229/json' } };
      }
      return { status: 200, data: RSS, headers: {} };
    },
    api: helpers(),
  });
  const out = await tool(News)._call({ feed_url: 'https://short.example/a' });
  assert.match(out, /points inside a private network/);
  assert.deepEqual(fetched, ['https://short.example/a']);
});

test('public redirects are followed, at most 3 of them', async () => {
  const News = loadNews({
    get: async (url) => {
      if (url === 'https://a.example/old') return { status: 301, data: '', headers: { location: '/new' } };
      if (url === 'https://a.example/new') return { status: 200, data: RSS, headers: {} };
      return { status: 302, data: '', headers: { location: url + 'x' } };
    },
    api: helpers(),
  });
  assert.match(await tool(News)._call({ feed_url: 'https://a.example/old' }), /Story 1/);
  assert.match(await tool(News)._call({ feed_url: 'https://loop.example/' }), /too many redirects/);
});

test('if the helpers cannot be loaded, nothing is fetched', async () => {
  let hits = 0;
  const News = loadNews({
    get: async () => {
      hits += 1;
      return { status: 200, data: RSS, headers: {} };
    },
    api: null,
  });
  assert.match(await tool(News)._call({ feed_url: 'https://news.example/rss' }), /points inside a private network/);
  assert.equal(hits, 0);
});

test('the built-in feeds still read, through the same guard', async () => {
  const calls = [];
  const News = loadNews({
    get: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, data: RSS, headers: {} };
    },
    api: helpers(),
  });
  const out = await tool(News)._call({ categories: ['national'] });
  assert.match(out, /== NATIONAL \(NPR News\) ==\n- Story 1/);
  assert.equal(calls[0].options.maxRedirects, 0);
});

test('KADE_NEWS_SSRF=0 puts back the old unchecked fetch', async () => {
  process.env.KADE_NEWS_SSRF = '0';
  const calls = [];
  const News = loadNews({
    get: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, data: RSS, headers: {} };
    },
    api: helpers(),
  });
  assert.match(await tool(News)._call({ feed_url: 'http://10.1.2.3/rss' }), /Story 1/);
  assert.equal(calls[0].options.maxRedirects, undefined);
});
