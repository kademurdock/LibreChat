const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real schema registry and definition loader without installing unrelated
// image/search providers. Those external schemas are unused by this family-only turn.
function loader() {
  const cache = new Map();
  const unused = () => { throw new Error('An unrelated provider was unexpectedly used.'); };
  const image = { name: 'unused_image', description: 'Unused image tool.', schema: {} };
  const stubs = {
    '@librechat/agents': {
      Providers: { GOOGLE: 'google', VERTEXAI: 'vertexai' },
      WebSearchToolDefinition: { name: 'web_search', description: 'Unused search.', schema: {} },
      CalculatorToolDefinition: { name: 'calculator', description: 'Unused calculator.', schema: {} },
      createToolSearch: unused, createBashProgrammaticToolCallingTool: unused,
    },
    '@librechat/data-schemas': { logger: { warn() {}, debug() {} } },
    'librechat-data-provider': {
      Constants: { mcp_delimiter: '_mcp_', mcp_all: 'all' }, isActionTool: () => false,
    },
    '~/mcp/zod': { resolveJsonSchemaRefs: unused, normalizeJsonSchema: unused, sanitizeGeminiSchema: unused },
    '~/tools/toolkits/gemini': { geminiToolkit: { gemini_image_gen: image } },
    '~/tools/toolkits/oai': { oaiToolkit: { image_gen_oai: image, image_edit_oai: image } },
  };
  function load(filename) {
    const file = path.resolve(filename);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename: file })(
      (name) => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('.')
        ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name), module, module.exports,
    );
    return module.exports;
  }
  return load;
}

test('event-driven family agent receives its saved-source schema instead of silently losing the tool', async () => {
  const load = loader();
  const { loadToolDefinitions } = load(path.join(__dirname, 'definitions.ts'));
  const { familyHistoryToolDescription, familyHistoryToolSchema } = load(path.join(__dirname, '../family/tool.ts'));
  const result = await loadToolDefinitions(
    { userId: 'synthetic-family-user', agentId: 'synthetic-helix', tools: ['kade_family_history'] },
    { isBuiltInTool: (name) => name === 'kade_family_history', getOrFetchMCPServerTools: async () => { throw new Error('Unexpected MCP lookup.'); } },
  );
  assert.equal(result.toolDefinitions.length, 1);
  assert.equal(result.toolDefinitions[0].name, 'kade_family_history');
  assert.equal(result.toolDefinitions[0].description, familyHistoryToolDescription);
  assert.deepEqual(result.toolDefinitions[0].parameters, familyHistoryToolSchema);
  assert.deepEqual(result.toolRegistry.get('kade_family_history').allowed_callers, ['direct']);
  assert.equal(result.toolDefinitions[0].parameters.additionalProperties, false);
  assert.equal(result.toolDefinitions[0].parameters.properties.authorId, undefined);
});
