const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the loaded tool and registry both accept the new help topics on the branded domain', async () => {
  const requests = [];
  const context = {
    module: { exports: {} },
    process: { env: {} },
    Map,
    Date,
    require(name) {
      if (name === 'axios')
        return {
          get: async (...args) => {
            requests.push(args);
            return {
              data: '<main><h1>Project help</h1><p>Read the saved project instructions and working documents before revising them.</p></main>',
            };
          },
        };
      if (name === '@librechat/agents/langchain/tools') return { Tool: class {} };
      if (name === '@librechat/data-schemas') return { logger: { warn() {} } };
      throw new Error(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'KadeHelp.js'), 'utf8'), context);
  const tool = new context.module.exports();
  const registry = fs.readFileSync(
    path.resolve(__dirname, '../../../../..', 'packages/api/src/tools/registry/definitions.ts'),
    'utf8',
  );
  const schema = registry.slice(
    registry.indexOf('export const kadeHelpSchema'),
    registry.indexOf('export const kadeLocationSchema'),
  );
  const registryContext = {};
  vm.runInNewContext(
    schema.replace('export const kadeHelpSchema: ExtendedJsonSchema', 'this.schema'),
    registryContext,
  );
  assert.deepEqual(
    Array.from(tool.schema.properties.topic.enum),
    Array.from(registryContext.schema.properties.topic.enum),
  );
  for (const [topic, route] of [
    ['work', 'agent-work'],
    ['projects', 'projects'],
    ['clubhouse', 'clubhouse'],
    ['privacy', 'privacy'],
    ['iphone', 'iphone'],
    ['android', 'android'],
    ['createacharacter', 'create-a-character'],
  ]) {
    assert.ok(tool.schema.properties.topic.enum.includes(topic));
    assert.match(await tool._call({ topic }), /Read the saved project/);
    const [url, options] = requests.at(-1);
    assert.equal(url, 'https://kademurdock.com/help/' + route);
    assert.match(options.headers['User-Agent'], /Chrome\//);
    assert.equal(options.headers.Authorization, undefined);
  }
});
