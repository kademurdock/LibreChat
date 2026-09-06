// Isolated Node regression tests: real MongoDB, with the paid writer replaced in the tests.
// Compile only the pure reflection module, so these checks don't need the whole app to boot.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
require('module-alias').addAlias('~', path.join(root, 'api'));
const file = path.join(root, 'packages/api/src/memory/reflection.ts');
const reflection = new Module(file);
reflection._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file);
const original = Module._load;
Module._load = function (id, parent, main) {
  if (id === '@librechat/api') return reflection.exports;
  if (id === '@librechat/data-schemas') return { logger: { info() {}, warn: console.warn, error: console.error } };
  return original.apply(this, arguments);
};
