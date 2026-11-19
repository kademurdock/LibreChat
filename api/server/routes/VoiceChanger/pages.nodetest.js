/* The Voice Changer pages as delivered (node --test; not *.test.js, so the api's Jest skips it).
 * Run from api/: node --test server/routes/VoiceChanger/pages.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const pages = require('./pages');

const { voiceChangerHtml: pageHtml, engineHostHtml: engineHtml } = pages;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'kadeVoiceChanger', 'engine', 'manifest.json'), 'utf8'));
const PAGE_JS = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');

const scriptsOf = (html) => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
/** The page's own markup: everything after the shared head's closing script. */
const bodyOf = (html) => html.slice(html.indexOf('<body'));
const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const hasAttr = (tag, name) => new RegExp('\\s' + name + '(\\s|=|>|/)', 'i').test(tag);
const textOf = (s) => s.replace(/<[^>]+>/g, '').replace(/&hellip;/g, '...').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

for (const [name, html] of Object.entries({ pageHtml, engineHtml })) {
  test(`${name}: every inline script parses and nothing is left unspliced`, () => {
    const scripts = scriptsOf(html);
    assert.ok(scripts.length > 0);
    for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s), 'a classic script that parses');
    for (const mark of ['<!-- KADE_CLIENT_SCRIPT -->', '<!-- KADE_SHARED_HEAD -->', '__VC_ENGINE_BASE__']) {
      assert.ok(!html.includes(mark), `${mark} was replaced`);
    }
  });
  test(`${name}: nothing plays by itself`, () => {
    assert.doesNotMatch(html, /\bautoplay\b/i);
    assert.doesNotMatch(html, /<(audio|video)\b/i, 'sound goes through the one AudioContext, never a media element');
  });
}

test('both pages name the same versioned engine folder, the one the manifest gives', () => {
  assert.equal(pages.engineVersion, MANIFEST.version);
  const base = `/vc-engine/${MANIFEST.version}/`;
  assert.equal(pages.engineBase, base);
  for (const html of [pageHtml, engineHtml]) {
    assert.ok(html.includes(`<meta name="vc-engine-base" content="${base}">`), 'the meta tag carries the versioned base');
  }
});

test('engine host: tiny, pure compute, imports host/bridge.js from the versioned folder', () => {
  const base = `/vc-engine/${MANIFEST.version}/`;
  assert.ok(engineHtml.length < 6000, 'the hidden page stays tiny');
  assert.ok(engineHtml.includes(`<link rel="modulepreload" href="${base}host/bridge.js">`));
  const [script] = scriptsOf(engineHtml);
  assert.match(script, /import\(base \+ 'host\/bridge\.js'\)/);
  assert.match(script, /\^\\\/vc-engine\\\/\[A-Za-z0-9\._-\]\+\\\/\$/, 'only a versioned engine path is accepted');
  assert.doesNotMatch(script.replace(/\/\*[\s\S]*?\*\//g, ''), /AudioContext|getUserMedia|SHARED_HEAD/);
  assert.doesNotMatch(engineHtml, /kadetabs|<h1/i, 'no shared head, no tab bar');
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'kadeVoiceChanger', 'engine', 'host', 'bridge.js')));
});

test('engine host: the bridge address resolves and a missing version is said plainly', async () => {
  const [script] = scriptsOf(engineHtml);
  assert.equal((script.match(/\bimport\(/g) || []).length, 1);
  const run = (content) => {
    const imported = [];
    const win = { vcBridgeOut: [] };
    const sandbox = {
      window: win,
      document: { querySelector: () => (content === null ? null : { getAttribute: () => content }) },
      __import: (spec) => {
        imported.push(spec);
        return Promise.resolve({});
      },
    };
    vm.runInNewContext(script.replace(/\bimport\(/, '__import('), sandbox);
    return { imported, out: win.vcBridgeOut };
  };
  const good = run(`/vc-engine/${MANIFEST.version}/`);
  assert.deepEqual(good.imported, [`/vc-engine/${MANIFEST.version}/host/bridge.js`]);
  const bad = run('');
  assert.equal(bad.imported.length, 0);
  assert.equal(bad.out[0].t, 'error');
  assert.match(bad.out[0].message, /version is missing/);
});

test('page: exactly one live region, the status line', () => {
  const live = pageHtml.match(/aria-live\s*=/gi) || [];
  assert.equal(live.length, 1, 'one aria-live in the whole page, shared head included');
  const roles = pageHtml.match(/role\s*=\s*"(status|alert|log|marquee|timer)"/gi) || [];
  assert.equal(roles.length, 1);
  assert.match(pageHtml, /<div id="status" class="status" role="status" aria-live="polite">/);
  assert.doesNotMatch(PAGE_JS, /aria-live|'role'|"role"|role=|<output/i, 'the script never makes another live region');
  assert.doesNotMatch(bodyOf(pageHtml), /<output\b/i, 'an output element would be a second live region');
});

test('page: back link first, one h1, the four h2s in order', () => {
  const body = bodyOf(pageHtml);
  const firstLink = body.match(/<a\b[^>]*>/i)[0];
  assert.equal(attr(firstLink, 'href'), '/home');
  const h1 = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => textOf(m[1]));
  assert.deepEqual(h1, ['Voice Changer']);
  const h2 = [...body.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => textOf(m[1]));
  assert.deepEqual(h2, ['Your voice', 'Pick a voice', 'Fine-tune', 'Make it']);
  assert.ok(body.indexOf('<a class="back"') < body.indexOf('<h1'), 'the back link comes before the heading');
  assert.match(body, /Everything runs on your own device and is free\./);
  assert.match(body, /<details id="fineBox" open>\s*<summary><h2 id="h-fine">Fine-tune<\/h2><\/summary>/);
  assert.match(body, /<details class="chain" id="chainBox">\s*<summary><h3 id="h-chain">Effect chain<\/h3><\/summary>/, 'the chain editor starts closed');
});

test('page: every input, select and textarea has a label', () => {
  const body = bodyOf(pageHtml).replace(/<script[\s\S]*?<\/script>/gi, '');
  const forIds = new Set([...body.matchAll(/<label\b[^>]*\sfor="([^"]+)"/gi)].map((m) => m[1]));
  const ids = new Set([...body.matchAll(/\sid="([^"]+)"/gi)].map((m) => m[1]));
  const tags = [...body.matchAll(/<\/?(label|input|select|textarea)\b[^>]*>/gi)];
  let openLabels = 0;
  const unlabelled = [];
  let fields = 0;
  for (const m of tags) {
    const tag = m[0];
    const kind = m[1].toLowerCase();
    if (kind === 'label') {
      openLabels += tag.startsWith('</') ? -1 : 1;
      continue;
    }
    if (tag.startsWith('</')) continue;
    if (kind === 'input' && /type="hidden"/i.test(tag)) continue;
    fields++;
    const id = attr(tag, 'id');
    const named = (id && forIds.has(id)) || openLabels > 0 || hasAttr(tag, 'aria-label') || (attr(tag, 'aria-labelledby') || '').split(/\s+/).some((x) => ids.has(x));
    if (!named) unlabelled.push(tag);
  }
  assert.ok(fields >= 20, `the page has its controls (${fields})`);
  assert.deepEqual(unlabelled, []);
  for (const id of forIds) assert.ok(ids.has(id), `label for="${id}" points at something`);
});

test('page: the voice listbox is a real select with size and an accessible name', () => {
  const tag = pageHtml.match(/<select\b[^>]*\sid="presetList"[^>]*>/)[0];
  assert.equal(attr(tag, 'size'), '12');
  assert.match(pageHtml, /<label class="field" for="presetList" id="presetListLabel">Voices<\/label>/);
  assert.match(pageHtml, /<input type="search" id="search"/);
  assert.match(pageHtml, /<label class="check"><input type="checkbox" id="autoPv" checked> Play each voice as I move to it<\/label>/);
  assert.match(pageHtml, /<button type="button" class="act quiet" id="favBtn" aria-pressed="false">Add to favorites<\/button>/);
  assert.match(pageHtml, /<button type="button" class="act rec primary" id="recBtn" aria-pressed="false">Record<\/button>/);
  for (const v of ['4', '6', '10', '20', 'whole']) assert.match(pageHtml, new RegExp(`<option value="${v}"`));
});

test('page: the six fine-tune sliders have the ranges the engine clamps to', () => {
  const want = { pitch: [-24, 24], timbre: [-12, 12], speed: [0.5, 2], amount: [0, 100], width: [0, 200], volume: [-12, 6] };
  for (const [k, [lo, hi]] of Object.entries(want)) {
    const tag = pageHtml.match(new RegExp(`<input type="range" id="m-${k}"[^>]*>`))[0];
    assert.equal(Number(attr(tag, 'min')), lo, k);
    assert.equal(Number(attr(tag, 'max')), hi, k);
  }
});

test('page script: the engine through host/client.js, a plain microphone, a 3-minute cap', () => {
  const [, script] = scriptsOf(pageHtml);
  assert.equal(script, PAGE_JS);
  assert.match(script, /import\(S\.base \+ 'host\/client\.js'\)/);
  assert.match(script, /createEngine\(\{ base: S\.base \}\)/);
  assert.match(script, /echoCancellation: false, noiseSuppression: false, autoGainControl: false/);
  assert.match(script, /var MAX_SECONDS = 180;/);
  assert.match(script, /'\/api\/kade\/voice-changer'/);
  assert.equal((script.match(/new C\(\)/g) || []).length, 1, 'one AudioContext');
  assert.doesNotMatch(script, /\.play\(\)/, 'nothing goes through a media element');
  assert.doesNotMatch(script, /new Worker\(/, 'the Worker lives inside host/client.js');
  assert.match(script, /try \{ window\.localStorage\.setItem/, 'local storage is wrapped');
  assert.match(script, /'side'\)/, 'the other sound goes to the engine under the id side');
});

test('page: no person names, brands or trademarks in what it says', async () => {
  const { findBlockedWord } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'kadeVoiceChanger', 'engine', 'core', 'params.js')).href);
  const visible = textOf(bodyOf(pageHtml).replace(/<script[\s\S]*?<\/script>/gi, ''));
  assert.equal(findBlockedWord(visible), null);
  const strings = [...PAGE_JS.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)].map((m) => m[1]).join(' ');
  assert.equal(findBlockedWord(strings), null);
});

test('page script: what goes to the engine keeps a preset\'s cleanup choice (mastering keeps its low end)', () => {
  // Pull presetToSend() out of the delivered script and run it over the real presets.
  const from = PAGE_JS.indexOf('  function presetToSend()');
  const to = PAGE_JS.indexOf('  function previewKey()');
  assert.ok(from > 0 && to > from);
  const presetsDir = path.join(__dirname, '..', '..', 'kadeVoiceChanger', 'engine', 'presets');
  const load = (f) => { const j = JSON.parse(fs.readFileSync(path.join(presetsDir, f), 'utf8')); return Array.isArray(j) ? j : j.presets; };
  const mastering = load('mastering.json');
  const voices = load('robots.json');
  assert.ok(mastering.length > 0 && mastering.every((p) => p.cleanup === false), 'the mastering presets ask for no cleanup');
  const ctx = { S: { cur: null, userById: new Map() }, chainToSend: () => ctx.S.cur.chain };
  vm.runInNewContext(PAGE_JS.slice(from, to) + '\nthis.presetToSend = presetToSend;', ctx);
  const send = (p, custom) => { ctx.S.cur = { base: p, name: custom ? 'Custom' : p.name, chain: p.chain, custom: !!custom }; return ctx.presetToSend(); };
  for (const p of mastering) {
    assert.equal(send(p).cleanup, false, p.name);
    assert.equal(send(p, true).cleanup, false, p.name + ' after a tweak');
  }
  for (const p of voices) assert.equal('cleanup' in send(p), false, p.name);
  // the text export carries it too, and the import reads it back
  assert.match(PAGE_JS, /if \(S\.cur\.base\.cleanup === false\) o\.cleanup = false;/);
  assert.match(PAGE_JS, /cleanup: o\.cleanup === false \? false : undefined/);
});

test('page script: search ranks like the engine catalog and splits nothing past 150', () => {
  // Pull search() and its helpers out of the delivered script and run them over the real catalog.
  const from = PAGE_JS.indexOf('  var FIELD_WEIGHTS');
  const to = PAGE_JS.indexOf('  /* ---------------------------------------------------------------- lists */');
  assert.ok(from > 0 && to > from);
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'kadeVoiceChanger', 'engine', 'catalog.json'), 'utf8'));
  const S = { mine: [], shared: [], catalog, catName: new Map(catalog.categories.map((c) => [c.id, c.name])) };
  const ctx = { S };
  vm.runInNewContext(PAGE_JS.slice(from, to) + '\nthis.search = search;', ctx);
  const hits = ctx.search('robot');
  assert.ok(hits.length > 0, 'robot finds voices');
  assert.ok(hits.every((p) => /robot/i.test([p.name, (p.tags || []).join(' '), p.sub, p.cat, p.about].join(' '))));
  assert.equal(ctx.search('   ').length, 0);
  assert.equal(ctx.search('zzzqqq').length, 0);
  for (const l of catalog.lists) assert.ok(l.count <= 150, `${l.name} holds ${l.count}`);
});
