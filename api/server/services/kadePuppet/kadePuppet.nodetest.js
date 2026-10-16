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
        assert.ok(
          option.id === '' || (option.name && option.name.length <= 40),
          `${control.path} ${option.id}`,
        );
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
  for (const junk of [
    null,
    7,
    'x',
    [],
    { head: 'round' },
    { hair: { style: '<script>' }, accessories: 'glasses' },
    { eyes: { size: 99, spacing: -4 }, accessories: Array(50).fill('round-glasses') },
  ]) {
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
    assert.deepEqual(
      checkScene(buildScene(randomRecipe(i, { fantasy: i % 2 === 0 })).scene),
      [],
      `seed ${i}`,
    );
  }
});

test('service compiles, caches and writes the character note', async () => {
  const puppet = require('./index.js');
  const a = await puppet.compile({ hair: { style: 'afro' } });
  const b = await puppet.compile({ hair: { style: 'afro' } });
  assert.equal(a, b, 'second compile is cached');
  assert.equal(JSON.parse(a.sceneJson).schema, 'kade-puppet-scene/1');
  const once = await puppet.compile({ hair: { style: 'bob' } }, { cache: false });
  assert.notEqual(
    once,
    await puppet.compile({ hair: { style: 'bob' } }, { cache: false }),
    'one-off drawings are not cached',
  );
  assert.ok(a.sceneHash && a.description);
  const note = puppet.bodyNoteText(a.description);
  assert.ok(note.includes(a.description));
  assert.ok(!/%%%/.test(note), 'the note never demonstrates a speech tag');
  assert.equal(puppet.bodyNoteText(''), '');
  const cat = await puppet.catalog();
  assert.equal(cat.schema, 1);
  assert.ok(cat.catalog.sections.length >= 6);
});

test('hand-painted characters are never told they look like a puppet', async () => {
  const puppet = require('./index.js');
  assert.ok(puppet.HAND_PAINTED.has('agent_6llV0eMu4fmIaj8f2x1Sb'));
  assert.equal(await puppet.bodyNoteFor('agent_6llV0eMu4fmIaj8f2x1Sb'), '');
});

test('accessory ids must be real catalog entries', async () => {
  const { normalizeRecipe, describeRecipe } = await load('recipe.mjs');
  const r = normalizeRecipe({
    accessories: ['__proto__', 'constructor', 'toString', ['round-glasses'], 'round-glasses'],
  });
  assert.deepEqual(r.accessories, ['round-glasses']);
  assert.ok(!/object|tostring/i.test(describeRecipe(r)));
});

/* Oct 16 2026: what the body designer sends to OpenRouter. MiMo Pro by default,
 * thinking off, zero retention, and Pro's rates when a reply names no cost.
 * axios.post is swapped on the shared axios object, so nothing leaves the machine. */
async function designerCall(env, run, content = '{"hair":{"style":"afro"}}') {
  const axios = require('axios');
  const puppet = require('./index.js');
  const keys = [
    'OPENROUTER_KEY',
    'KADE_BODY_MODEL',
    'KADE_BODY_IN_USD_PER_M',
    'KADE_BODY_OUT_USD_PER_M',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realPost = axios.post;
  const posts = [];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { OPENROUTER_KEY: 'test-only' }, env);
  axios.post = async (...args) => {
    posts.push(args);
    return {
      data: {
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1e6, completion_tokens: 1e6 },
      },
    };
  };
  try {
    const out = await run(puppet);
    return { out, posts };
  } finally {
    axios.post = realPost;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('the body designer asks MiMo Pro with thinking off and zero retention', async () => {
  const { out, posts } = await designerCall({}, (p) =>
    p.recipeFromWords('a tall cowboy with a gray handlebar mustache'),
  );
  assert.equal(posts.length, 1);
  const [url, body] = posts[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny', allow_fallbacks: true });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(out.recipe.hair.style, 'afro');
  /* 1M tokens in and 1M out with no reported cost: Pro's two per-million rates added. */
  near(out.costUSD, 0.435 + 0.87);
});

test('a portrait goes to the designer as a picture under the same settings', async () => {
  const { posts } = await designerCall({}, (p) =>
    p.recipeFromPicture('https://example.invalid/portrait.png', 'a cowboy'),
  );
  const body = posts[0][1];
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny', allow_fallbacks: true });
  assert.deepEqual(body.messages[1].content[1], {
    type: 'image_url',
    image_url: { url: 'https://example.invalid/portrait.png' },
  });
});

test('KADE_BODY_MODEL and the KADE_BODY rates still override the defaults', async () => {
  const { out, posts } = await designerCall(
    {
      KADE_BODY_MODEL: 'xiaomi/mimo-v2.6-flash',
      KADE_BODY_IN_USD_PER_M: '0.14',
      KADE_BODY_OUT_USD_PER_M: '0.28',
    },
    (p) => p.recipeFromWords('a robot'),
  );
  assert.equal(posts[0][1].model, 'xiaomi/mimo-v2.6-flash');
  assert.deepEqual(posts[0][1].reasoning, { enabled: false });
  near(out.costUSD, 0.14 + 0.28);
});

test('a portrait of an animal or creature is refused as a creature, billed, and never drawn', async () => {
  const { posts } = await designerCall(
    {},
    (p) =>
      assert.rejects(
        p.recipeFromPicture('https://example.invalid/dog.png', 'Diggy: a cartoon golden retriever'),
        (e) => {
          assert.equal(e.code, 'creature');
          assert.equal(e.what, 'a golden retriever puppy');
          assert.equal(e.status, 422);
          near(e.costUSD, 0.435 + 0.87);
          return true;
        },
      ),
    '{"kind":"creature","what":"a golden retriever puppy"}',
  );
  const text = posts[0][1].messages[1].content[0].text;
  assert.match(text, /"kind"/);
  assert.match(text, /cat ears/);
});

test('a person with animal ears is still drawn from the portrait', async () => {
  const { out } = await designerCall(
    {},
    (p) => p.recipeFromPicture('https://example.invalid/recoil.png', 'Recoil'),
    '{"kind":"person","hair":{"style":"afro"}}',
  );
  assert.equal(out.recipe.hair.style, 'afro');
  assert.equal(out.recipe.kind, undefined);
});

test('plain words from the editor skip the person check; the backfill words ask it', async () => {
  const editor = await designerCall(
    {},
    (p) => p.recipeFromWords('a fluffy dog'),
    '{"kind":"creature"}',
  );
  assert.ok(editor.out.recipe, 'the editor still gets a recipe');
  assert.doesNotMatch(editor.posts[0][1].messages[1].content, /"kind"/);
  await designerCall(
    {},
    (p) =>
      assert.rejects(p.recipeFromWords('A character called Cluck', null, { requirePerson: true }), {
        code: 'creature',
      }),
    '{"kind":"Creature","what":"a chicken"}',
  );
});

test('an answer that is not clearly a designed person is treated as a creature', async () => {
  for (const reply of [
    '{"kind":"animal","what":"a dog"}',
    '{"what":"a chicken"}',
    '{"kind":"Robot"}',
  ]) {
    await designerCall(
      {},
      (p) =>
        assert.rejects(p.recipeFromPicture('https://example.invalid/x.png', 'X'), {
          code: 'creature',
        }),
      reply,
    );
  }
  /* An older-style answer with a design and no kind is still a person. */
  const { out } = await designerCall(
    {},
    (p) => p.recipeFromPicture('https://example.invalid/y.png', 'Y'),
    '{"hair":{"style":"afro"}}',
  );
  assert.equal(out.recipe.hair.style, 'afro');
});
