/* Oct 16 2026 — puppet kit and service checks. Run: node --test kadePuppet.nodetest.js
 * (no database, no network). The kit is ESM; this file loads it the same way the
 * service does. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (name) => import(pathToFileURL(path.join(__dirname, 'kit', name)).href);

test('every catalog option compiles to a drawable scene', async () => {
  const { buildCatalog, buildScene, normalizeRecipe } = await load('recipe.mjs');
  const { checkScene } = await load('scene-check.mjs');
  const catalog = buildCatalog();
  let checked = 0;
  for (const section of catalog.sections) {
    for (const control of section.controls) {
      if (control.kind === 'slider') {
        for (const v of [0, 1]) {
          const recipe = normalizeRecipe({});
          const [a, b] = control.path.split('.');
          recipe[a][b] = v;
          assert.deepEqual(checkScene(buildScene(recipe).scene), [], `${control.path}=${v}`);
          checked++;
        }
        continue;
      }
      for (const option of control.options) {
        const recipe = normalizeRecipe({});
        if (control.kind === 'accessory') {
          recipe.accessories = option.id ? [option.id] : [];
        } else if (control.path === 'backdrop') {
          recipe.backdrop = option.id;
        } else {
          const [a, b] = control.path.split('.');
          recipe[a][b] = option.id;
        }
        const problems = checkScene(buildScene(recipe).scene);
        assert.deepEqual(problems, [], `${control.path}=${option.id}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 150, `checked ${checked} options`);
});

test('every option has a spoken name and every look has a description', async () => {
  const { buildCatalog, describeRecipe, randomRecipe } = await load('recipe.mjs');
  for (const section of buildCatalog().sections) {
    assert.ok(section.name);
    for (const control of section.controls) {
      assert.ok(control.name, control.path);
      for (const option of control.options || []) {
        assert.ok(option.id === '' || (option.name && option.name.length <= 40), `${control.path} ${option.id}`);
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const text = describeRecipe(randomRecipe(i));
    assert.ok(text.length > 60 && text.length < 1200, text);
    assert.ok(!/undefined|null|NaN|\[object/.test(text), text);
  }
});

test('normalize repairs anything into a valid recipe', async () => {
  const { normalizeRecipe } = await load('recipe.mjs');
  for (const junk of [null, 7, 'x', [], { head: 'round' }, { hair: { style: '<script>' }, accessories: 'glasses' },
    { eyes: { size: 99, spacing: -4 }, accessories: Array(50).fill('round-glasses') }]) {
    const r = normalizeRecipe(junk);
    assert.equal(r.schema, 1);
    assert.ok(r.eyes.size >= 0 && r.eyes.size <= 1);
    assert.ok(Array.isArray(r.accessories) && r.accessories.length <= 8);
    assert.equal(new Set(r.accessories).size, r.accessories.length);
  }
});

test('surprise bodies are deterministic per seed and always valid', async () => {
  const { randomRecipe, buildScene } = await load('recipe.mjs');
  const { checkScene } = await load('scene-check.mjs');
  assert.deepEqual(randomRecipe('abc'), randomRecipe('abc'));
  assert.notDeepEqual(randomRecipe('abc'), randomRecipe('abd'));
  for (let i = 0; i < 120; i++) {
    assert.deepEqual(checkScene(buildScene(randomRecipe(i, { fantasy: i % 2 === 0 })).scene), [], `seed ${i}`);
  }
});

test('service compiles, caches and writes the character note', async () => {
  const puppet = require('./index.js');
  const a = await puppet.compile({ hair: { style: 'afro' } });
  const b = await puppet.compile({ hair: { style: 'afro' } });
  assert.equal(a, b, 'second compile is cached');
  assert.equal(JSON.parse(a.sceneJson).schema, 'kade-puppet-scene/1');
  const once = await puppet.compile({ hair: { style: 'bob' } }, { cache: false });
  assert.notEqual(once, await puppet.compile({ hair: { style: 'bob' } }, { cache: false }), 'one-off drawings are not cached');
  assert.ok(a.sceneHash && a.description);
  const note = puppet.bodyNoteText(a.description);
  assert.ok(note.includes(a.description));
  assert.ok(!/%%%/.test(note), 'the note never demonstrates a speech tag');
  assert.equal(puppet.bodyNoteText(''), '');
  const cat = await puppet.catalog();
  assert.equal(cat.schema, 1);
  assert.ok(cat.catalog.sections.length >= 6);
});
