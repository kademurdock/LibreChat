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

/* The family sky (sky.js): a picture of the tree for sighted family, drawn on
 * one canvas from the chart's own layout. It must stay decoration only. */
const SKY_PATH = path.join(__dirname, '..', '..', '..', 'client', 'public', 'assets', 'family', 'sky.js');
const skySource = fs.readFileSync(SKY_PATH, 'utf8');
function loadSky() {
  const context = { module: { exports: {} } };
  vm.runInNewContext(skySource, context);
  return context.module.exports;
}

test('the family sky is decoration only: hidden, no stops, no words, no sound, safe syntax', () => {
  new vm.Script(skySource, { filename: 'sky.js' });
  const controls = [...skySource].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
  assert.deepEqual(controls, [], 'no control characters');
  assert.equal(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(skySource), false);
  assert.equal(/\(\?<[=!]/.test(skySource), false, 'no regex lookbehind');
  assert.equal(/[\w)\]]\?\.[\w(]|\?\?/.test(skySource), false, 'no optional chaining or nullish operators');
  assert.equal(/tabindex|tabIndex|\.focus\(|aria-live|role=|Audio|speechSynthesis|vibrate/.test(skySource), false, 'no focus, no live words, no sound');
  assert.match(source, /var canvas = el\('canvas', \{ class: 'fh-skycanvas', 'aria-hidden': 'true' \}\);/, 'the canvas is made hidden, with the box');
  assert.match(source, /var hintEl = el\('p', \{ class: 'fh-skyhint', 'aria-hidden': 'true' \}, hint\);/);
  assert.match(source, /var box = el\('div', \{ class: 'fh-sky', 'aria-hidden': 'true' \}, el\('div', \{ class: 'fh-skystage' \}, canvas\), hintEl\);/, 'the whole box and its hint are hidden from screen readers');
  assert.equal(/appendChild|insertBefore|\.append\(|\.prepend\(|\.after\(|\.before\(|replaceChild/.test(skySource), false, 'sky.js adds nothing to the page: it draws into the canvas history.js made');
  assert.match(source, /handle = Sky\.mount\(canvas, layout, \{/);
  assert.match(source, /onDrawn: function \(\) \{ box\.classList\.add\('is-drawn'\); \}/, 'the hint shows once the lights are drawn');
  assert.match(source, /\}\)\.catch\(function \(\) \{ \/\* the box keeps its plain dusk sky, its hint unseen \*\/ \}\);/, 'if they never are, nothing is taken away: the CSS keeps the hint unseen');
  assert.doesNotMatch(source, /removeChild\(hintEl\)|noSky/, 'the hint node is never removed');
  const open = Number(/var OPEN_MS = (\d+);/.exec(skySource)[1]);
  const settle = Number(/var SETTLE_MS = (\d+);/.exec(skySource)[1]);
  const turn = Number(/var TURN = ([\d.]+);/.exec(skySource)[1]);
  assert.ok(open <= 1200, 'big movements last 1.2 seconds or less');
  assert.ok(settle <= 1200, 'motion that starts by itself is over within 1.2 seconds');
  assert.ok(open <= settle, 'the lights have opened before the motion stops');
  assert.ok(turn <= 0.2, 'the turn that starts by itself is small');
  assert.match(skySource, /if \(e\.isPrimary === false\) \{\n\s+if \(down && down\.turning\) canvas\.style\.cursor = 'grab';\n\s+down = null;\n\s+spin = 0;\n\s+return;/, 'a second finger is a pinch: it never turns the sky');
  assert.match(source, /function skyStill\(\) \{\n\s+return reducedMotion\(\) \|\| storeGet\('reverie_motion'\) === 'off';/, 'Reduce Motion and the in-app motion switch make it still');
  assert.match(source, /SKY_HIDDEN_WHEN = '\(forced-colors: active\), \(prefers-contrast: more\), \(prefers-reduced-data: reduce\)'/);
  assert.match(source, /connection\.saveData\) return false/);
  assert.match(source, /fontSize\) > 20\) return false/, 'very large text leaves it out');
  assert.match(source, /'sky\.js\$1'/, 'it loads from beside history.js at the same version');
  const css = fs.readFileSync(STYLE_PATH, 'utf8');
  assert.match(css, /\.fh-sky \{[^}]*height: 240px;[^}]*height: clamp\(180px, 50vw, 380px\); max-height: max\(200px, min\(46vh, 100vh - 35rem\)\);/, 'its space is set before anything loads, with a height for browsers without clamp(); above the chart it leaves room for the chart buttons');
  assert.match(css, /\.fh-treeframe ~ \.fh-sky \{ max-height: max\(180px, 46vh\); \}/, 'after the chart it keeps its full height');
  assert.match(source, /var SKY_AFTER_WHEN = '\(max-width: 43\.7em\), \(max-height: 47\.5em\)';/, 'a phone or a short window puts it after the chart');
  assert.match(source, /var skyAfter = !!sky && skyAfterChart\(\);\n\s+if \(sky\) \{\n\s+if \(!skyAfter\) s\.appendChild\(sky\.box\);/, 'its place is chosen as the view is built');
  assert.match(source, /s\.appendChild\(frame\);\n\s+if \(skyAfter\) s\.appendChild\(sky\.box\);/, 'after the chart frame, before the key');
  assert.match(source, /if \(!window\.innerWidth\) return !!\(window\.screen && screen\.width && screen\.width < 700\);\n\s+return !!\(window\.matchMedia && window\.matchMedia\(SKY_AFTER_WHEN\)\.matches\);/, 'a background tab with no size yet goes by the screen');
  assert.doesNotMatch(/\.fh-skycanvas \{([^}]*)\}/.exec(css)[1], /touch-action/, 'until the lights are drawn, touch on the canvas is the page\'s');
  assert.match(css, /\.fh-sky\.is-drawn \.fh-skycanvas \{ touch-action: pan-y pinch-zoom; \}/, 'two fingers still zoom the page over the sky');
  assert.match(css, /@media \(forced-colors: active\), \(prefers-contrast: more\), \(prefers-reduced-data: reduce\), \(max-width: 22\.5em\), \(max-height: 30em\), print \{\s*\.fh-sky, \.fh-skynote \{ display: none !important; \}/);
  assert.match(css, /\.fh-skyhint \{[^}]*background: #0a0f24; color: #d7ddf6;/, 'its words sit on a solid strip');
  assert.match(css, /\.fh-sky:not\(\.is-drawn\) \.fh-skyhint \{ visibility: hidden; \}/, 'the hint waits for the lights');
  const lit = /\.fh-box\.is-lit \.fh-ring \{([^}]*)\}/.exec(css)[1];
  assert.match(lit, /fill-opacity: \.\d+;/, 'a lit box has a soft wash');
  assert.match(lit, /stroke-opacity: \.\d+;/, 'and a soft glow, not a solid ring');
  assert.doesNotMatch(lit, /stroke-width: 5;/, 'a lit box never looks like the focus ring');
  assert.match(css, /\.fh-box\.is-lit \.fh-boxlink:focus-visible \.fh-ring \{ stroke-opacity: 1; stroke-width: 5; \}/, 'the focus ring stays crisp on a lit box');
  assert.match(source, /legend\(data\.legend\), skyNote\)\);/, 'the key says the sky is there, inside the existing disclosure');
  assert.match(source, /var skyNote = sky \? el\('p', \{ class: 'fh-skynote' \}, 'The family sky near the chart is a picture of this same tree\. When its lights show, each light is a person, with ' \+ \(isViewer \? 'you' : skyCentre\) \+ ' in the middle, ancestors in rings above and any children below\.'\) : null;/, 'in plain words, only when the sky is shown, true wherever it sits and if its lights never draw');
  assert.doesNotMatch(source, /family sky above the chart/);
});

/* The drawing half of sky.js on a pretend canvas (no browser): enough of a
 * window and document for mount() to draw, take taps and drags, and follow
 * the page's zoom. */
function mountSky(opts, scale) {
  const listeners = (owner) => {
    owner.on = {};
    owner.addEventListener = (type, fn) => { (owner.on[type] = owner.on[type] || []).push(fn); };
    owner.removeEventListener = (type, fn) => { owner.on[type] = (owner.on[type] || []).filter((f) => f !== fn); };
    owner.fire = (type, e) => (owner.on[type] || []).slice().forEach((fn) => fn(e));
    return owner;
  };
  const ctx = new Proxy({}, {
    get(store, key) {
      if (key in store) return store[key];
      if (key === 'measureText') return () => ({ width: 50 });
      if (key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(store, key, value) { store[key] = value; return true; },
  });
  let clock = 1000;
  const frames = [];
  const viewport = listeners({ scale: scale || 1 });
  const document = listeners({ hidden: false, createElement: () => ({ getContext: () => ctx }) });
  const window = {
    visualViewport: viewport,
    devicePixelRatio: 1,
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    performance: { now: () => clock },
  };
  const host = { clientWidth: 400, clientHeight: 300 };
  const captured = [];
  const canvas = listeners({
    parentNode: host, isConnected: true, style: {}, width: 0, height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    setPointerCapture: (id) => captured.push(id),
  });
  const context = { window, document, performance: window.performance };
  vm.runInNewContext(skySource, context);
  const lights = [];
  const handle = window.KadeFamilySky.mount(canvas, parts.layoutTree(family(), { up: 4, down: 2 }), Object.assign({
    still: () => false, solid: true, focusLabel: 'You', ringName: () => 'Parents', descName: () => 'Children',
    onLight: (id) => lights.push(id), onOpen() {},
  }, opts));
  /* The opening plays to its end; then nothing more is asked for. */
  const settle = () => { clock += 5000; while (frames.length) frames.shift()(clock); };
  settle();
  let n = 0;
  const pointer = (type, x, y, more) => canvas.fire(type, Object.assign({ clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, timeStamp: (n += 16) }, more));
  const tap = (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); };
  const drag = (x0, x1, y) => {
    pointer('pointerdown', x0, y);
    for (let x = x0; x <= x1; x += 20) pointer('pointermove', x, y);
    pointer('pointerup', x1, y);
    settle();
  };
  /* Taps across the sky until one lights a star. */
  const tapAStar = () => {
    for (let y = 10; y < 300; y += 6) {
      for (let x = 10; x < 400; x += 6) {
        tap(x, y);
        if (lights.length) return [x, y];
      }
    }
    return null;
  };
  return { handle, canvas, document, viewport, lights, captured, tap, drag, tapAStar, settle };
}

test('the sky hands touch to the page while it is zoomed in, and turns again at 1', () => {
  const sky = mountSky();
  assert.equal(sky.canvas.style.touchAction, undefined, 'at 1 the CSS says pan-y pinch-zoom');
  sky.drag(60, 200, 150);
  assert.equal(sky.captured.length, 1, 'a drag at 1 turns the sky');
  sky.viewport.scale = 2;
  sky.viewport.fire('resize', {});
  assert.equal(sky.canvas.style.touchAction, 'auto', 'pinched in: one finger pans the page over the sky too');
  assert.equal(sky.canvas.style.cursor, 'default');
  sky.drag(60, 200, 150);
  assert.equal(sky.captured.length, 1, 'and a drag never turns the sky');
  assert.notEqual(sky.canvas.style.cursor, 'grabbing');
  sky.viewport.scale = 1;
  sky.viewport.fire('resize', {});
  assert.equal(sky.canvas.style.touchAction, '', 'back at 1 the CSS holds again');
  assert.equal(sky.canvas.style.cursor, 'grab');
  sky.drag(60, 200, 150);
  assert.equal(sky.captured.length, 2, 'and a drag turns it again');
  sky.handle.destroy();
  assert.deepEqual(sky.viewport.on.resize, [], 'it stops following the zoom when it goes');
});

test('a sky drawn on a page that is already zoomed in hands touch to the page from the start', () => {
  const sky = mountSky(null, 1.5);
  assert.equal(sky.canvas.style.touchAction, 'auto');
  sky.drag(60, 200, 150);
  assert.equal(sky.captured.length, 0, 'no drag turns it');
});

test('a star lit by a tap goes out when anything else on the page is pressed', () => {
  const sky = mountSky();
  const at = sky.tapAStar();
  assert.ok(at, 'a tap lights a star');
  const id = sky.lights[sky.lights.length - 1];
  assert.ok(id != null);
  sky.document.fire('pointerdown', { target: sky.canvas });
  assert.equal(sky.lights[sky.lights.length - 1], id, 'a press on the sky itself leaves it lit');
  sky.document.fire('pointerdown', { target: {} });
  assert.equal(sky.lights[sky.lights.length - 1], null, 'a press anywhere else puts it out');
  const count = sky.lights.length;
  sky.document.fire('pointerdown', { target: {} });
  assert.equal(sky.lights.length, count, 'and nothing more happens while nothing is lit');
  sky.handle.destroy();
  assert.deepEqual(sky.document.on.pointerdown, [], 'it stops listening when it goes');
});

test('a lit star says who it is in words, without the lifespan twice, with the side or research finding', () => {
  const sky = loadSky();
  const star = (node) => ({ box: { node } });
  assert.deepEqual(plain(sky.wordsFor(star({ id: 'cora', label: 'Cora Example (born 1960)', lifespan: 'born 1960' }))), ['Cora Example', 'born 1960'], 'a box with no card: the name, then the years once');
  assert.deepEqual(plain(sky.wordsFor(star({ id: 'x', label: 'Someone Example', lifespan: '' }))), ['Someone Example']);
  assert.deepEqual(plain(sky.wordsFor(star({ id: 'bram', label: 'Bram Example (1930–2001)', lifespan: '1930–2001', card: { name: 'Bram Example', term: 'your father', years: '1930–2001', side: 'father', sideText: "Dad's side" } }))),
    ['Bram Example', 'Your father, 1930–2001', "Dad's side"]);
  assert.deepEqual(plain(sky.wordsFor(star({ id: 'hana', label: 'Hana Sample', card: { name: 'Hana Sample', term: 'your grandmother', years: '1905–1980', side: 'mother', sideText: "Mom's side", research: { text: 'Best guess; not proven by records' } } }))),
    ['Hana Sample', 'Your grandmother, 1905–1980', 'Research finding'], 'a research ancestor is named as one in words, not by colour alone');
  assert.deepEqual(plain(sky.wordsFor(star({ id: 'cora', label: 'Cora Example', card: { name: 'Cora Example', term: 'you', years: null, living: true, side: 'self', sideText: 'you' } }))),
    ['Cora Example', 'You, Living'], 'the centre has no side line');
  assert.deepEqual(plain(sky.wordsFor(star({ id: 'dot', label: 'Dot Sample', card: { name: 'Dot Sample', term: "your mother, Mom's side", years: '1932–2010', side: 'mother', sideText: "Mom's side" } }))),
    ['Dot Sample', "Your mother, Mom's side, 1932–2010"], 'the side is not said twice');
});

test('the family sky places the invented family: ancestors rise in rings, Dad left, Mom right, children below', () => {
  const sky = loadSky();
  const layout = parts.layoutTree(family(), { up: 4, down: 2 });
  const scene = sky.placeStars(layout);
  const at = (id) => scene.stars.find((s) => s.id === id);
  assert.equal(scene.stars.length, layout.boxes.length, 'one star for every box in the chart');
  assert.equal(scene.focus.id, 'cora');
  assert.deepEqual([scene.focus.x, scene.focus.y, scene.focus.z], [0, 0, 0]);
  for (const s of scene.stars) assert.ok([s.x, s.y, s.z].every(Number.isFinite), `${s.id} has a place`);
  assert.ok(at('bram').y > 0 && at('ezra').y > at('bram').y, 'each generation of ancestors rises');
  assert.ok(Math.hypot(at('ezra').x, at('ezra').z) > Math.hypot(at('bram').x, at('bram').z), 'and widens');
  assert.ok(at('bram').x < 0 && at('dot').x > 0, "Dad's side to the left, Mom's to the right");
  assert.ok(at('ivo').x < 0 && at('ivo').y === 0, 'a brother stands to the left');
  assert.ok(at('jon').x > 0 && at('jon').y === 0, 'a husband stands to the right');
  assert.ok(at('kit').y < 0 && at('lua').y < at('kit').y, 'descendants hang below');
  assert.equal(at('cora').cat, 'none', 'a box with no card takes the plain colour');
  const kinds = plain(scene.links.map((l) => `${l.a.id}>${l.b.id}:${l.kind}`).sort());
  assert.ok(kinds.includes('hana>dot:research'), 'a probable parent keeps the dotted research line');
  assert.ok(kinds.includes('cora>jon:couple'));
  assert.equal(scene.links.length, layout.lines.length, 'every line in the chart is a line in the sky');
  const toLua = sky.pathTo(scene, at('lua'));
  assert.deepEqual(plain([...toLua.stars].map((s) => s.id).sort()), ['cora', 'kit', 'lua'], 'a grandchild is reached through her parent');
  const toEzra = sky.pathTo(scene, at('ezra'));
  assert.deepEqual(plain([...toEzra.stars].map((s) => s.id).sort()), ['bram', 'cora', 'ezra']);
  assert.equal(sky.placeStars(null), null);
});

test('the family sky fits the whole tree in its box at every turn', () => {
  const sky = loadSky();
  const scene = sky.placeStars(parts.layoutTree(family(), { up: 4, down: 2 }));
  for (const [w, h] of [[838, 347], [348, 190], [356, 147], [338, 140], [1200, 380]]) {
    const cam = sky.fitCamera(scene, w, h, w >= 560 ? 118 : 0);
    const pt = {};
    for (let i = 0; i < 24; i++) {
      const project = sky.projector(cam, (i / 24) * Math.PI * 2);
      for (const s of scene.stars) {
        project(s.x, s.y, s.z, pt);
        assert.ok(pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h, `${s.id} stays inside a ${w} by ${h} box`);
        assert.ok(pt.k > 0, 'nothing passes behind the viewer');
      }
    }
  }
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
