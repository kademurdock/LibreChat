'use strict';
/* KADE Nov 13 2026: the lookup tool through the REAL tool interface.
 *
 * The first live trial of kade_lookup failed on every call with "this.call is not a function":
 * the constructor kept a test stand-in in a field named `call`, which is the very method the chat
 * engine runs a tool by, and on the live site nothing handed one in. The older tests never saw it
 * because they called the inner `_call` directly, on a stand-in base class with no methods.
 *
 * Here the tool is built the way handleTools.js builds it (`new KadeLookup({ req, userId })`) and
 * run the way the chat engine runs it (`.invoke`, `.call`), on a base class that has those
 * methods. When the real library can be found (a clone with node_modules, or
 * KADE_TEST_NODE_MODULES pointing at a folder that holds one), the same checks also run on the
 * real class. And no tool file in this folder may write over one of the engine's method names.
 *
 * No browser, no model, no network.
 * Run: node --test api/app/clients/tools/structured/KadeLookup.interface.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

/** The shape of LangChain's tool base: invoke -> call -> _call, all on the prototype. */
class StandInTool {
  async invoke(input, config) {
    const args = input && typeof input === 'object' && input.type === 'tool_call' ? input.args : input;
    return this.call(args, config);
  }
  async call(arg, config) {
    return this._call(arg, undefined, config);
  }
}

/** The real `Tool`, if a copy of the library is anywhere to be found; else null. */
function realTool() {
  const roots = [path.join(__dirname, '../../../../'), path.join(__dirname, '../../../../../'), process.env.KADE_TEST_NODE_MODULES || ''].filter(Boolean);
  for (const root of roots) {
    try {
      const req = Module.createRequire(path.join(root, 'noop.js'));
      const lib = req('@librechat/agents/langchain/tools');
      if (lib && typeof lib.Tool === 'function') return lib.Tool;
    } catch (_) {
      /* not here */
    }
  }
  return null;
}

function loadTool(Tool) {
  const original = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === '@librechat/agents/langchain/tools') return { Tool };
    if (id === '@librechat/data-schemas') return { logger: { warn() {}, info() {}, error() {} } };
    return original.call(this, id, parent, isMain);
  };
  try {
    const file = path.join(__dirname, 'KadeLookup.js');
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = original;
  }
}

const ENV = { KADE_LOOKUP_BROWSER_URL: 'https://lookup.example.test/', KADE_LOOKUP_BROWSER_SECRET: 'a-shared-secret-of-at-least-24-characters' };
const adult = () => ({ user: { id: 'u1', role: 'USER', kadeAccountType: 'adult' } });
const ASK = { url: 'https://www.pharmacy.example/', question: 'What are the Sunday hours?' };
const fine = async () => ({ ok: true, code: 'ok', answer: 'Sunday 10 am to 4 pm.', sites: ['pharmacy.example'], trail: [], steps: 2, turns: 2, costUSD: 0 });
const textOf = (out) => (typeof out === 'string' ? out : String(out && out.content != null ? out.content : out));
const ENGINE_METHODS = ['invoke', 'call', '_call'];

function checks(label, Tool, real) {
  test(`${label}: built the way handleTools builds it, the engine's own methods are still there`, () => {
    const KadeLookup = loadTool(Tool);
    /* exactly what handleTools.js hands in: the request and the acting user id, nothing else */
    const tool = new KadeLookup({ req: adult(), userId: 'u1' });
    for (const name of ENGINE_METHODS) assert.equal(typeof tool[name], 'function', `${name} must be a method`);
    for (const name of ['invoke', 'call']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(tool, name), `the constructor must not put its own "${name}" on the tool`);
    }
    assert.equal(tool.name, 'kade_lookup');
    assert.match(tool.description, /^Look one thing up on a public web page/);
  });

  test(`${label}: invoke and call reach the worker and bring its answer back`, async () => {
    const KadeLookup = loadTool(Tool);
    const ran = [];
    const make = () => new KadeLookup({ env: ENV, req: adult(), userId: 'u1', logUsage: async () => {}, runLookupFn: async (o) => (ran.push(o), fine()) });
    assert.match(textOf(await make().invoke(ASK)), /^OK: Sunday 10 am to 4 pm\.\nRead on: pharmacy\.example/);
    assert.match(textOf(await make().call(ASK)), /^OK: Sunday 10 am to 4 pm\./);
    assert.equal(ran.length, 2);
    assert.equal(ran[0].question, ASK.question);
    assert.equal(ran[0].call, undefined, 'the live site hands in no stand-in service: the worker uses the real one');
    if (real) {
      /* the shape a chat model's tool call arrives in */
      const out = await make().invoke({ type: 'tool_call', id: 'call_1', name: 'kade_lookup', args: ASK });
      assert.match(textOf(out), /^OK: Sunday 10 am to 4 pm\./);
      assert.equal(out.tool_call_id, 'call_1');
    }
  });

  test(`${label}: a refusal comes back as words through invoke, never as a thrown error`, async () => {
    const KadeLookup = loadTool(Tool);
    const never = async () => assert.fail('the worker must not run');
    const teen = new KadeLookup({ env: ENV, req: { user: { id: 'k', role: 'USER', kadeAccountType: 'teen' } }, runLookupFn: never });
    assert.match(textOf(await teen.invoke(ASK)), /^Not started: the web lookup is for adult accounts/);
    const off = new KadeLookup({ env: {}, req: adult(), runLookupFn: never });
    assert.match(textOf(await off.invoke(ASK)), /^Not started: the web lookup is not available/);
  });
}

checks('stand-in base', StandInTool, false);
const Real = realTool();
if (Real) checks('real library', Real, true);
else test('real library: not installed beside this clone (KADE_TEST_NODE_MODULES=<folder holding node_modules> runs these too)', { skip: true }, () => {});

test('the old bug is caught: a tool that writes over "call" fails these checks', async () => {
  class Broken extends StandInTool {
    constructor(fields = {}) {
      super();
      this.call = fields.call; // the Nov 13 line
    }
    async _call() {
      return 'OK';
    }
  }
  const tool = new Broken({});
  assert.notEqual(typeof tool.call, 'function');
  await assert.rejects(() => tool.invoke({}), /this\.call is not a function/);
});

test('no tool in this folder writes over a method the chat engine runs it by', () => {
  /* Method names of LangChain's Runnable / StructuredTool. `name`, `description`, `schema`,
   * `returnDirect` and the like are fields a tool is meant to set, so they are not here. */
  const taken = ['call', 'invoke', '_call', 'run', '_run', 'stream', 'streamEvents', 'streamLog', '_streamIterator', 'batch', 'pipe', 'bind', 'withConfig', 'withRetry', 'withFallbacks', 'transform', 'getGraph', 'toJSON', 'toJSONNotImplemented', 'asTool', '_callWithConfig'];
  const rule = new RegExp(`\\bthis\\.(${taken.join('|')})\\s*=[^=]`);
  const bad = [];
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.js$/.test(name) || /\.(?:nodetest|test|spec)\.js$/.test(name)) continue;
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (rule.test(line)) bad.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(bad, [], 'a field with one of these names replaces the method of that name');
});
