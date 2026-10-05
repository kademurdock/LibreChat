const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
require('module-alias').addAlias('~', path.join(root, 'api'));
const schemas = require(path.join(root, 'packages/data-schemas/dist/index.cjs'));
const api = require(path.join(root, 'packages/api/dist/index.cjs'));
const original = Module._load;
Module._load = function (id, parent, main) {
  if (id === '@librechat/data-schemas')
    return { ...schemas, createMemoryMethods: schemas.createMethods };
  if (id === '@librechat/api') return api;
  return original.apply(this, arguments);
};
