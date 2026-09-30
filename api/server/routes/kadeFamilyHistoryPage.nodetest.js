'use strict';
/* The family history page without a browser (Sep 29 2026). The shell is a
 * template literal (kadeFamilyHistoryPage.js) and the working script is
 * client/public/assets/family/history.js. These build the page the way the
 * server does, compile every inline script, and run the script's pure parts
 * (tree layout, relationship words, the safe markdown reader) on an invented
 * family. THE REPOSITORY IS PUBLIC: every name here is made up.
 * Run: node --test kadeFamilyHistoryPage.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', '..', '..', 'client', 'public', 'assets', 'family', 'history.js');
const STYLE_PATH = path.join(__dirname, '..', '..', '..', 'client', 'public', 'assets', 'family', 'history.css');

function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) => require(path.join(__dirname, name)),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeFamilyHistoryPage.js'), 'utf8'), context);
  return context.module.exports;
}
const page = buildPage();
const html = page.familyHistoryHtml;
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

function loadParts() {
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
const parts = loadParts();
/** Values made inside the vm carry its own Array and Object; compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the page evaluates: one h1, a status region, the script and styles at one version', () => {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<h1 id="fh-title">Our family history<\/h1>/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.ok(html.includes(`/assets/family/history.js?v=${page.ASSET_VERSION}`));
  assert.ok(html.includes(`/assets/family/history.css?v=${page.ASSET_VERSION}`));
  assert.match(html, /<nav class="fh-nav" id="fh-nav" aria-label="Family history sections" hidden>/, 'the sections stay hidden until the account is known to be family');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /@I\d/, 'no tree ids in the shell');
  let sent = null;
  page.page({}, { type(t) { assert.equal(t, 'html'); return this; }, send(body) { sent = body; } });
  assert.equal(sent, html);
});

test('every inline script compiles and no backspace character crept in', () => {
  assert.ok(scripts.length >= 1, 'SHARED_HEAD brings getToken()');
  for (const s of scripts) new Function(s);
  assert.equal(html.includes('\b'), false);
});

test('history.js compiles, builds nothing from HTML strings, and avoids syntax older iPhones reject', () => {
  new vm.Script(source, { filename: 'history.js' });
  const controls = [...source].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
  assert.deepEqual(controls, [], 'no control characters (a regex word boundary typed through a heredoc becomes one)');
  assert.equal(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(source), false, 'every word reaches the page as text');
  assert.equal(/\(\?<[=!]/.test(source), false, 'regex lookbehind is a syntax error on iOS before 16.4');
  assert.equal(/[\w)\]]\?\.[\w(]|\?\?/.test(source), false, 'no optional chaining or nullish operators');
  const css = fs.readFileSync(STYLE_PATH, 'utf8');
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-contrast: more/);
  assert.match(css, /prefers-reduced-motion: no-preference/);
  assert.match(css, /forced-colors: active/);
  assert.doesNotMatch(css, /\.fh-status[^{]*\{[^}]*(display:\s*none|visibility:\s*hidden)/, 'the live region stays in the accessibility tree when empty');
  assert.doesNotMatch(css, /overscroll-behavior:\s*contain/, 'the tree frame never traps the page scroll on a phone');
  assert.match(css, /button\.chip \{[^}]*min-height: 44px/, 'source chips are 44px tap targets');
});

test('v2 relationship words retain the server viewer, side and research qualification', () => {
  assert.equal(parts.personWords({ term: 'your grandmother', sideText: "Mom's side" }), "your grandmother, Mom's side");
  assert.equal(parts.personWords({ term: 'Ada’s grandmother', sideText: "Mom's side" }), "Ada’s grandmother, Mom's side");
  assert.equal(parts.personWords({ term: 'your grandmother', research: { text: 'Best guess; not proven by records' } }, true), 'your grandmother, research finding, best guess; not proven by records');
  assert.equal(parts.personWords(null), '');
});

test('the web page uses v2 answers and displays the supplied family kind words', () => {
  assert.match(source, /[?&]v=2/);
  assert.match(source, /kindText/);
  assert.equal(parts.personWords({ term: 'you', sideText: 'you' }), 'you');
});

test('request dates use UTC and leave invalid values empty', () => {
  assert.equal(parts.dayWords('2026-03-05T23:00:00Z'), '5 March 2026');
  assert.equal(parts.dayWords('not a date'), '');
  assert.equal(parts.dayWords(null), '');
});

test('the selected archive scopes records, signed files, notes and audio without changing default requests', () => {
  for (const path of ['/me', '/person/x?v=2', '/media/x/file?size=s', '/note', '/story/example/audio/0?redirect=1']) {
    assert.equal(parts.archivePath(path, 'default'), path);
    assert.equal(parts.archivePath(path, null), path);
    const extra = parts.archivePath(path, 'example-tree');
    assert.match(extra, /[?&]archive=example-tree$/);
    assert.equal((extra.match(/\?/g) || []).length, 1);
  }
  assert.match(html, /id="fh-archives" hidden/, 'the selector reveals no archives before authorization');
});

test('a delayed body from an old archive cannot finish after a switch or an A to B to A return', async () => {
  let current = { id: 'default', seq: 0 };
  const check = parts.archiveGuard({ ...current }, () => current);
  check();
  let finish;
  const delayedBody = new Promise((resolve) => { finish = resolve; });
  const consuming = delayedBody.then(() => { check(); return 'old image bytes'; });
  current = { id: 'example-tree', seq: 1 };
  current = { id: 'default', seq: 2 };
  finish();
  await assert.rejects(consuming, (error) => error.quiet === true && /archive changed/i.test(error.message));
  const fresh = parts.archiveGuard({ ...current }, () => current);
  fresh();
  current = { id: 'example-tree', seq: 3 };
  assert.throws(fresh, (error) => error.quiet === true);
});

/* An invented family: Cora is the focus; her parents Bram and Dot, Bram's
 * parents Ezra and Pia (and a stepfather Gus), Dot's mother Hana; Cora's
 * brother Ivo, her husband Jon, their son Kit, and Kit's daughter Lua. */
function family() {
  const n = (id, name, sex, born) => ({ id, label: `${name} (born ${born})`, lifespan: `born ${born}`, sex, living: false, virtual: false });
  return {
    focus: 'cora',
    nodes: [
      n('cora', 'Cora Example', 'F', 1960), n('bram', 'Bram Example', 'M', 1930), n('dot', 'Dot Sample', 'F', 1932),
      n('ezra', 'Ezra Example', 'M', 1900), n('pia', 'Pia Former', 'F', 1902), n('gus', 'Gus Step', 'M', 1898),
      n('hana', 'Hana Sample', 'F', 1905), n('ivo', 'Ivo Example', 'M', 1958), n('jon', 'Jon Partner', 'M', 1959),
      n('kit', 'Kit Partner', 'M', 1985), n('lua', 'Lua Partner', 'F', 2010),
    ],
    links: [
      { parent: 'bram', child: 'cora', kind: 'birth' }, { parent: 'dot', child: 'cora', kind: 'birth' },
      { parent: 'ezra', child: 'bram', kind: 'birth' }, { parent: 'pia', child: 'bram', kind: 'birth' },
      { parent: 'gus', child: 'bram', kind: 'step' }, { parent: 'hana', child: 'dot', kind: 'probable' },
      { parent: 'bram', child: 'ivo', kind: 'birth' }, { parent: 'dot', child: 'ivo', kind: 'birth' },
      { parent: 'cora', child: 'kit', kind: 'birth' }, { parent: 'jon', child: 'kit', kind: 'birth' },
      { parent: 'kit', child: 'lua', kind: 'birth' },
    ],
    couples: [['cora', 'jon'], ['bram', 'dot']],
  };
}

test('the tree chart: ancestors above (father left), sibling left, spouse right, descendants below, no overlaps', () => {
  const layout = parts.layoutTree(family(), { up: 4, down: 2 });
  const at = (id) => layout.boxes.find((b) => b.id === id);
  assert.equal(layout.focus.id, 'cora');
  assert.equal(at('bram').gen, 1);
  assert.equal(at('ezra').gen, 2);
  assert.ok(at('bram').cx < at('dot').cx, "the father's line is on the left");
  assert.equal(layout.focus.cx, (at('bram').cx + at('dot').cx) / 2, 'the focus sits between her parents');
  assert.ok(at('bram').top < layout.focus.top && at('ezra').top < at('bram').top, 'ancestors fan upward');
  assert.equal(at('ivo').top, layout.focus.top);
  assert.ok(at('ivo').cx < layout.focus.cx, 'siblings to the left');
  assert.ok(at('jon').cx > layout.focus.cx, 'spouse to the right');
  assert.ok(at('kit').top > layout.focus.top && at('lua').top > at('kit').top, 'descendants below');
  assert.equal(at('kit').role, 'descendant');
  assert.equal(layout.boxes.filter((b) => b.id === 'gus').length, 0, 'the stepfather is not a second father box');
  assert.deepEqual(plain(layout.extraParents.map((p) => [p.id, p.child, p.kind])), [['gus', 'bram', 'step']]);
  assert.deepEqual(plain(layout.unplaced.map((u) => u.id)), ['gus'], 'he is listed in the text version instead');
  const rows = new Map();
  for (const b of layout.boxes) {
    for (const other of rows.get(b.top) || []) assert.ok(Math.abs(other.left - b.left) >= layout.box.w, `${b.id} overlaps ${other.id}`);
    rows.set(b.top, (rows.get(b.top) || []).concat(b));
    assert.ok(b.left >= 0 && b.left + layout.box.w <= layout.width, `${b.id} is inside the chart`);
    assert.ok(b.top >= 0 && b.top + layout.box.h <= layout.height);
  }
  const probable = layout.lines.find((l) => l.from.id === 'hana');
  assert.equal(probable.kind, 'probable', 'a research-finding parent keeps its dotted line');
  assert.ok(layout.lines.some((l) => l.kind === 'couple' && l.to.id === 'jon'));
  assert.ok(layout.lines.some((l) => l.from.id === 'jon' && l.to.id === 'kit'), 'a child hangs from both parents');
  assert.ok(layout.lines.some((l) => l.from.id === 'bram' && l.to.id === 'ivo'), 'the sibling hangs from the shared parents');
});

test('the text version says whose child each descendant and sibling is, and how they are linked', () => {
  const tree = family();
  tree.nodes.push({ id: 'mo', label: 'Mo Partner (born 2012)', lifespan: 'born 2012', sex: 'U', living: true, virtual: false });
  tree.links.push({ parent: 'kit', child: 'mo', kind: 'step' });
  const layout = parts.layoutTree(tree, { up: 4, down: 2 });
  const words = (id) => parts.parentWords(layout.boxes.find((b) => b.id === id), layout);
  assert.equal(words('kit'), 'son of Cora Example and Jon Partner', "which spouse is the child's other parent");
  assert.equal(words('lua'), 'daughter of Kit Partner', 'which child a grandchild belongs to');
  assert.equal(words('mo'), 'child of Kit Partner (step)', 'a step link is said, not only drawn dashed');
  assert.equal(words('ivo'), 'son of Bram Example and Dot Sample');
  assert.equal(words('cora'), 'daughter of Bram Example and Dot Sample');
});

test('only web addresses become source links', () => {
  const { webHref } = parts;
  assert.equal(webHref('https://example.com/records/1'), 'https://example.com/records/1');
  assert.equal(webHref('http://example.com/memorial/2'), 'http://example.com/memorial/2');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,hi', 'mailto:a@example.com', '#/person/x', 'vbscript:x', '', null, undefined]) {
    assert.equal(webHref(bad), null, String(bad));
  }
  assert.match(source, /if \(webHref\(r\.url\) && r\.url !== savedUrl\) card\.appendChild/, 'a record link goes through webHref');
  assert.match(source, /if \(webHref\(savedUrl\)\) card\.appendChild/, 'an independent recovery link goes through webHref');
  assert.match(source, /if \(webHref\(m\.url\)\) card\.appendChild/, 'a memorial link goes through webHref');
  assert.match(source, /function newTab\(href, text, extraClass\) \{\n\s+var safe = webHref\(href\);\n\s+if \(!safe\) return document\.createTextNode\(text\);/, 'and newTab itself refuses anything else');
});

test('the tree chart honours the generation limits and survives a loop in the data', () => {
  const small = parts.layoutTree(family(), { up: 1, down: 0 });
  assert.deepEqual(plain(small.boxes.map((b) => b.id).sort()), ['bram', 'cora', 'dot', 'ivo', 'jon']);
  const loop = family();
  loop.links.push({ parent: 'cora', child: 'ezra', kind: 'birth' });
  const looped = parts.layoutTree(loop, { up: 8, down: 0 });
  assert.ok(looped.boxes.length < 40, 'a parent loop does not run away');
  assert.equal(parts.layoutTree({ focus: 'nobody', nodes: [], links: [] }), null);
  assert.equal(parts.generationName(1), 'Parents');
  assert.equal(parts.generationName(4), '2nd great-grandparents');
  assert.equal(parts.generationName(13), '11th great-grandparents');
  assert.equal(parts.descendantName(2), 'Grandchildren');
});

test('stories: markdown becomes plain text nodes, links are limited, source paths become chips', () => {
  const { parseMarkdown, parseInline } = parts;
  const blocks = parseMarkdown([
    '# Ada Example',
    '',
    'She moved in **1901** and *never* looked back [records/ancestry/1234/5678.json].',
    '<script>alert(1)</script> <img src=x onerror=alert(2)>',
    '',
    '- a [safe link](https://example.com/page) and [a trap](javascript:alert(3))',
    '- [home](#/person/ada)',
    '',
    '1. first',
    '2. second',
    '',
    '> A quote from a letter.',
    '',
    '| Name | Age |',
    '| --- | --- |',
    '| Ada \\| Example | 32 |',
    '',
    '---',
  ].join('\n'));
  assert.deepEqual(plain(blocks.map((b) => b.type)), ['heading', 'paragraph', 'list', 'list', 'quote', 'table', 'rule']);
  const para = blocks[1].inline;
  assert.deepEqual(plain(para.find((n) => n.t === 'strong').c), [{ t: 'text', v: '1901' }]);
  assert.deepEqual(plain(para.find((n) => n.t === 'em').c), [{ t: 'text', v: 'never' }]);
  assert.deepEqual(plain(para.find((n) => n.t === 'source')), { t: 'source', v: 'records/ancestry/1234/5678.json' });
  assert.ok(para.some((n) => n.t === 'text' && n.v.includes('<script>alert(1)</script>')), 'raw HTML stays words on the page');
  const items = blocks[2].items;
  assert.deepEqual(plain(items[0].find((n) => n.t === 'link')), { t: 'link', href: 'https://example.com/page', c: [{ t: 'text', v: 'safe link' }] });
  assert.equal(items[0].some((n) => n.t === 'link' && /javascript/i.test(n.href)), false, 'a javascript: link is not a link');
  assert.equal(items[1][0].href, '#/person/ada');
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(plain(blocks[5].rows[0][0]), [{ t: 'text', v: 'Ada | Example' }]);
  assert.equal(parts.safeHref('JaVaScRiPt:alert(1)'), null);
  assert.equal(parts.safeHref('data:text/html,hi'), null);
  assert.deepEqual(plain(parseInline('[a/b.json; c/d.json]').map((n) => n.v)), ['a/b.json', 'c/d.json']);
  assert.deepEqual(plain(parseInline('[x]')), [{ t: 'text', v: '[x]' }], 'a plain bracket is not a source');
  assert.deepEqual(plain(parseInline('snake_case_word')), [{ t: 'text', v: 'snake_case_word' }]);
  assert.equal(parseInline('see https://example.com/a.')[1].href, 'https://example.com/a');
});

test('Home shows the Family history tile only after /me says access', () => {
  const home = require('./kadeHome').homeHtml;
  assert.match(home, /<a class="hubitem" href="\/family-history" id="tile-familyhistory" style="display:none"/);
  assert.match(home, /apiGet\('\/api\/kade\/family-history\/me', t\)\.then\(/, 'not awaited, so a slow bundle load never holds up Sign out');
  assert.match(home, /if\(fj && fj\.access\)\{ document\.getElementById\('tile-familyhistory'\)\.style\.display=''; \}/);
  assert.match(home, /apiGet\('\/api\/kade\/family-history\/archives', t\)/, 'an account authorized only for an extra archive can still discover Family history');
  const homeScripts = [...home.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const s of homeScripts) new Function(s);
  assert.equal(home.includes('\b'), false);
});

test('the service worker never reloads the family history as a broken chat page', () => {
  const heal = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'sw', 'heal.js'), 'utf8');
  const context = { self: { registration: { scope: 'https://example.test/' }, addEventListener() {} }, URL, Map, Promise, setTimeout };
  vm.runInNewContext(heal, context);
  const client = (url) => ({ frameType: 'top-level', visibilityState: 'visible', url });
  assert.equal(context.isRecoverableAppClient(client('https://example.test/family-history')), false);
  assert.equal(context.isRecoverableAppClient(client('https://example.test/family-history#/tree')), false);
  assert.equal(context.isRecoverableAppClient(client('https://example.test/c/new')), true, 'the chat app still recovers');
});
