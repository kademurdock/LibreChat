const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
require('module-alias').addAlias('~', path.join(root, 'api'));
const schemas = require('@librechat/data-schemas');
require.extensions['.ts'] = function (module, file) {
  module._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  );
};
const localSchemas = {
  ...schemas,
  ...require(path.join(root, 'packages/data-schemas/src/models/people.ts')),
  ...require(path.join(root, 'packages/data-schemas/src/schema/relationship.ts')),
  ...require(path.join(root, 'packages/data-schemas/src/memory/policy.ts')),
};
let localApi = {};
const original = Module._load;
Module._load = function (id, parent, main) {
  if (id === '@librechat/data-schemas') return localSchemas;
  if (id === '@librechat/api') return localApi;
  if (id === '~/memory/policy') return localSchemas;
  if (id === '~/config/winston') return { __esModule: true, default: schemas.logger };
  return original.apply(this, arguments);
};
localSchemas.createMemoryMethods = require(
  path.join(root, 'packages/data-schemas/src/methods/memory.ts'),
).createMemoryMethods;
localApi = {
  ...require(path.join(root, 'packages/api/src/memory/continuity.ts')),
  ...require(path.join(root, 'packages/api/src/memory/reflection.ts')),
  ...require(path.join(root, 'packages/api/src/memory/people.ts')),
  ...require(path.join(root, 'packages/api/src/memory/privacy.ts')),
  ...require(path.join(root, 'packages/api/src/memory/relationship.ts')),
  ...require(path.join(root, 'packages/api/src/memory/audience.ts')),
  ...require(path.join(root, 'packages/api/src/memory/evidence.ts')),
};
