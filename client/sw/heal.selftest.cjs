const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2] || __dirname + '/heal.js', 'utf8');

async function activation(specs, scope = 'https://example.test/', afterPing) {
  const handlers = {}, timers = [], navigations = [], pings = [];
  const clients = specs.map((spec, i) => ({
    id: String(i), frameType: 'top-level', visibilityState: 'visible', ...spec,
    postMessage(message) {
      pings.push(this.url);
      if (spec.responsive) handlers.message({ data: { type: 'LC_SW_PONG' }, source: this });
    },
    async navigate(url) { navigations.push(url); },
  }));
  const self = {
    registration: { scope },
    addEventListener(type, handler) { handlers[type] = handler; },
    clients: { claim: async () => {}, matchAll: async () => clients, get: async (id) => {
      const current = clients.find(c => c.id === id);
      return afterPing ? afterPing(current) : current;
    } },
  };
  vm.runInNewContext(source, { self, URL, Map, Promise, setTimeout: (fn) => timers.push(fn) });
  let done;
  handlers.activate({ waitUntil(promise) { done = promise; } });
  await new Promise(resolve => setImmediate(resolve));
  timers.forEach(fn => fn());
  await done;
  return { navigations, pings };
}

(async () => {
  const toolPaths = ['sound-booth', 'library', 'reading-room', 'home', 'parlor', 'help/library', 'feedback-dashboard'];
  let result = await activation(toolPaths.map(path => ({ url: 'https://example.test/' + path })));
  assert.deepEqual(result, { navigations: [], pings: [] }, 'tools without ping responders must remain open');
  result = await activation([{ url: 'https://example.test/c/new' }]);
  assert.deepEqual(result.navigations, ['https://example.test/c/new'], 'broken visible chat still recovers');
  for (const extra of [{ responsive: true }, { visibilityState: 'hidden' }, { frameType: 'nested' }]) {
    result = await activation([{ url: 'https://example.test/c/new', ...extra }]);
    assert.deepEqual(result.navigations, []);
  }
  result = await activation([{ url: 'https://example.test/app/sound-booth' }, { url: 'https://example.test/app/c/new' }], 'https://example.test/app/');
  assert.deepEqual(result.navigations, ['https://example.test/app/c/new'], 'subpath hosting');
  for (const url of ['https://other.test/c/new', 'https://example.test/costs', 'not a URL']) {
    assert.deepEqual((await activation([{ url }])).navigations, []);
  }
  result = await activation([{ url: 'https://example.test/c/new' }], undefined, client => ({ ...client, url: 'https://example.test/sound-booth' }));
  assert.deepEqual(result.navigations, [], 'navigation during ping must be respected');
  result = await activation([{ url: 'https://example.test/c/new' }], undefined, client => ({ ...client, visibilityState: 'hidden' }));
  assert.deepEqual(result.navigations, [], 'tab backgrounded during ping');
  console.log('Service-worker activation regression checks passed: tools, chat, hidden tabs, frames, scope and navigation races.');
})().catch(error => { console.error(error); process.exitCode = 1; });
