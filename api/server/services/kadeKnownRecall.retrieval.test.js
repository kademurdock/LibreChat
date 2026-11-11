/* Nov 11 2026 (cards 8 and 9): kade_known and kade_recall attach by the person's own words only.
 * Plain node:test, no network: node --test api/server/services/kadeKnownRecall.retrieval.test.js
 * (kadeToolRetrieval loads @librechat/data-schemas for its logger: run with NODE_PATH at an
 * installed copy's node_modules.) Every line here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('./kadeToolRetrieval');

const hits = (name, text) => R.ALIASES[name].some((re) => re.test(text));

test('both tools are keyword only', () => {
  assert.ok(R.KEYWORD_ONLY.has('kade_known'));
  assert.ok(R.KEYWORD_ONLY.has('kade_recall'));
  assert.ok(R.KEYWORD_ONLY.has('kade_studio'), 'the song tool stays keyword only');
});

test('kade_known: what do you know about me, forget that, you remember that wrong', () => {
  for (const s of [
    'What do you know about me?',
    'what do you remember about me',
    'what have you got on me',
    'Forget that.',
    'please forget everything',
    'forget what I told you about the clinic',
    "don't remember that",
    'you got that wrong, it was Friday',
    'you remember it wrong',
    'forget everything from my mail',
  ]) {
    assert.ok(hits('kade_known', s), s);
  }
  for (const s of ['I keep forgetting my keys', 'do you know a good pie recipe', 'that is wrong of them', 'I forgot to call mom']) {
    assert.ok(!hits('kade_known', s), s);
  }
});

test('kade_recall: what was that number, did I tell you, search my chats', () => {
  for (const s of [
    'what was that pharmacy number from last week?',
    'What was the name of that place you told me about?',
    'did I ever tell you about the roofer before?',
    'search my old chats for the plumber',
    'look back through our conversations',
    'when did I tell you about the move?',
  ]) {
    assert.ok(hits('kade_recall', s), s);
  }
  for (const s of ['what is the weather', 'tell me a joke', 'what was that? I could not hear you']) {
    assert.ok(!hits('kade_recall', s), s);
  }
});

test('the registration touch points agree: index, handleTools, manifest, definitions, autoTools', () => {
  const root = path.resolve(__dirname, '../../..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const manifest = JSON.parse(read('api/app/clients/tools/manifest.json'));
  for (const [name, file, schema] of [
    ['kade_known', 'KadeKnown', 'kadeKnownSchema'],
    ['kade_recall', 'KadeRecall', 'kadeRecallSchema'],
  ]) {
    assert.ok(manifest.some((m) => m.pluginKey === name), `${name} in manifest.json`);
    assert.match(read('api/app/clients/tools/index.js'), new RegExp(`const ${file} = require\\('./structured/${file}'\\)`));
    assert.match(read('api/app/clients/tools/util/handleTools.js'), new RegExp(`${name}: ${file},`));
    assert.match(read('api/app/clients/tools/util/handleTools.js'), new RegExp(`${name}: \\{\\s*req: options\\.req,`));
    const defs = read('packages/api/src/tools/registry/definitions.ts');
    assert.match(defs, new RegExp(`${name}: \\{\\s*name: '${name}',`));
    assert.match(defs, new RegExp(`schema: ${schema},`));
    assert.match(read('api/server/services/Endpoints/agents/initialize.js'), new RegExp(`\\['${name}'\\]`));
    /* the class and the TypeScript schema describe the same fields */
    const cls = read(`api/app/clients/tools/structured/${file}.js`);
    const props = (src, start) => {
      const body = src.slice(src.indexOf(start));
      const block = body.slice(0, body.indexOf('\n  required:'));
      return [...block.matchAll(/^ {4}([a-z_]+): \{/gm)].map((m) => m[1]).sort();
    };
    assert.deepEqual(props(cls, `const ${schema} = {`), props(defs, `export const ${schema}: ExtendedJsonSchema = {`), `${name} schema fields`);
    const desc = (src) => (src.match(/this\.description =\s*([\s\S]*?);\n/) || [])[1];
    const clsDesc = desc(cls)
      .split(/'\s*\+\s*'/)
      .join('')
      .replace(/^'|'$/g, '');
    assert.ok(defs.includes(clsDesc), `${name}: definitions.ts description matches the class`);
    assert.ok(clsDesc.length < 520, `${name}: the description stays short for a cheap model (${clsDesc.length})`);
  }
});
