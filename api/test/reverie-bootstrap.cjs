const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
process.env.REVERIE_FAST = '1';
delete process.env.REFRAME_PROXY_SECRET;
process.env.NODE_PATH = [path.join(root, 'api/node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const compiled = {};
const source = path.join(root, 'packages/api/src/reverie');
for (const name of ['hangouts', 'cast', 'outdoors', 'conversation', 'appearance', 'planning', 'places', 'navigation']) {
  const file = path.join(source, name + '.ts');
  const module = new Module(file);
  module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, file);
  Object.assign(compiled, module.exports);
}
const load = Module._load;
Module._load = function(id, parent, main) {
  if (id === '@librechat/api') return compiled;
  if (id === '@librechat/data-schemas') return { logger: { info() {}, warn: console.warn, error: console.error, debug() {} } };
  if (id.startsWith('~/')) id = path.join(root, 'api', id.slice(2));
  return load.call(this, id, parent, main);
};
