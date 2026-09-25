/* The structured-tools loader never require()s a test file (Part 291 review F26, Sep 25 2026).
 * Before this, every boot loaded KadeHelp.test.js, KadeNotify.timefix.test.js and the .nodetest.js
 * files in api/app/clients/tools/structured, so their node:test suites ran inside the live server.
 *
 * Run: node --test api/server/services/start/tools.loader.nodetest.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

class Tool {}
const stubs = {
  '@librechat/agents': { Calculator: class Calculator { constructor() { this.name = 'calculator'; this.description = ''; this.schema = {}; } } },
  '@librechat/agents/langchain/tools': { Tool },
  '@librechat/data-schemas': { logger: { warn() {}, error() {}, info() {} } },
  'zod-to-json-schema': { zodToJsonSchema: (s) => s },
  'librechat-data-provider': { Tools: { function: 'function' }, ImageVisionTool: { type: 'function', function: { name: 'image_vision' } } },
  '@librechat/api': { getToolkitKey: () => undefined, oaiToolkit: {}, geminiToolkit: {} },
  '~/app/clients/tools/manifest': { toolkits: [] },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
after(() => {
  Module._load = realLoad;
});

const { loadAndFormatTools } = require('./tools');
const STRUCTURED = path.join(__dirname, '..', '..', '..', 'app', 'clients', 'tools', 'structured');
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A folder of files that record being loaded; `tools` export a Tool subclass with that name. */
function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kade-tools-loader-'));
  dirs.push(dir);
  globalThis.__kadeLoaderSeen = [];
  for (const [name, kind] of Object.entries(files)) {
    const body =
      kind === 'tool'
        ? `globalThis.__kadeLoaderSeen.push(${JSON.stringify(name)});
const { Tool } = require('@librechat/agents/langchain/tools');
module.exports = class extends Tool { constructor() { super(); this.name = ${JSON.stringify(name.replace(/\.js$/, ''))}; this.description = 'd'; this.schema = {}; } };`
        : `globalThis.__kadeLoaderSeen.push(${JSON.stringify(name)});
throw new Error('a test file was loaded as a tool');`;
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('test files of every naming style are skipped; tools beside them still load', () => {
  const dir = folder({
    'RealTool.js': 'tool',
    'Real.test.js': 'test',
    'Real.nodetest.js': 'test',
    'Real.access.nodetest.js': 'test',
    'Real.selftest.js': 'test',
    'Real.spec.js': 'test',
    'Contest.js': 'tool',
    'Latest.js': 'tool',
  });
  const tools = loadAndFormatTools({ directory: dir });
  assert.deepEqual(globalThis.__kadeLoaderSeen.sort(), ['Contest.js', 'Latest.js', 'RealTool.js']);
  assert.ok(tools.RealTool && tools.Contest && tools.Latest, 'names that merely end in "test" are still tools');
  assert.ok(tools.calculator && tools.image_vision);
});

test('every test file in tools/structured today is skipped, and no real tool there is', () => {
  const files = fs.readdirSync(STRUCTURED).filter((f) => f.endsWith('.js'));
  /* node:test, or jest at the start of a line (zod's .describe( is not a test). */
  const isTest = (f) =>
    /require\(['"]node:test['"]\)|^\s*(describe|test|it)\(|^\s*expect\(/m.test(fs.readFileSync(path.join(STRUCTURED, f), 'utf8'));
  const tests = files.filter(isTest);
  const real = files.filter((f) => !isTest(f));
  assert.ok(tests.length >= 7, `found the test files (${tests.join(', ')})`);
  assert.ok(real.includes('KadeFundingBalance.js') && real.includes('KadePhoneCall.js'));
  const dir = folder(Object.fromEntries([...tests.map((f) => [f, 'test']), ...real.map((f) => [f, 'tool'])]));
  loadAndFormatTools({ directory: dir });
  const seen = new Set(globalThis.__kadeLoaderSeen);
  assert.deepEqual(tests.filter((f) => seen.has(f)), [], 'no test file is loaded');
  assert.deepEqual(real.filter((f) => !seen.has(f)), [], 'every tool file is still loaded');
});
