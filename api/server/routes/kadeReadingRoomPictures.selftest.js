/* The Library's pictures (Sep 25 2026 art batch): the reading-alcove banner on
 * the shelf screen and the Radio and Music shelf rooms (plan Pictures 44 and
 * 50). Her rule: each picture carries its words as real alt text on the <img>
 * itself, read in the picture's own place: no aria-hidden on the img or any
 * wrapper, no extra heading or block of words, no live region, no focus stop.
 * The shelf picture's alt changes with its source. They step aside (and never
 * download) under contrast, zoom, landscape, data-saving and large-text
 * settings, and are silent wherever they step aside; a failed load keeps its
 * box and shows a plain dusk gradient, and the img itself is taken away so no
 * missing picture is announced. These checks keep it that way. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pageFile = require.resolve('./kadeReadingRoomPage');
const artDir = path.join(__dirname, '../../../client/public/assets/art');
const manifestFile = path.join(artDir, 'art-manifest.json');

function sharedHead() {
  const pages = fs.readFileSync(require.resolve('./kadePages'), 'utf8');
  const start = pages.indexOf('const SHARED_HEAD = `');
  const end = pages.indexOf('</script>`;', start) + '</script>`;'.length;
  const context = {};
  vm.runInNewContext(pages.slice(start, end) + '\nthis.SHARED_HEAD = SHARED_HEAD;', context);
  return context.SHARED_HEAD;
}
function load(head = '') {
  const context = { require: () => ({ SHARED_HEAD: head, librarianGuide: { chatUrl: '/c/new?endpoint=agents' } }), module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(pageFile, 'utf8'), context);
  return context.module.exports;
}
const HIDDEN_WHEN = '(forced-colors: active), (prefers-contrast: more), (max-width: 22.5em), (max-height: 30em), (prefers-reduced-data: reduce)';
const ALCOVE_WORDS = 'A cozy reading room at dusk: dark blue bookshelves holding books, film reels and a cassette radio, a lit lamp, a green armchair with an orange pillow and knit throw, and a window onto a lake at sunset.';
const RADIO_WORDS = 'An old wooden cathedral radio glowing on a kitchen table with a red checked runner, beside an enamel coffee pot, a mug, daisies and an oil lamp, with a full moon over the lake outside.';
const MUSIC_WORDS = 'A cabin music corner at dusk: a fiddle, a banjo and a mandolin hang above a record player and two crates of records, with a fringed lamp, a rocking chair and a lake sunset through the window.';

test('every inline script still parses with the real shared head', () => {
  const { readingRoomHtml } = load(sharedHead());
  const scripts = [...readingRoomHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3, 'the shared head script, the art step-aside check and the page script');
  for (const match of scripts) new vm.Script(match[1]);
  assert.doesNotMatch(readingRoomHtml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/, 'no template escape turned into a control character');
});

test('the alcove banner carries its words as alt text, first on the shelf screen', () => {
  const { readingRoomHtml } = load();
  const shelf = readingRoomHtml.indexOf('<section id="shelf">');
  const box = readingRoomHtml.match(/<div class="kade-art alcove-art"><img id="alcoveArt"[^>]*><\/div>/);
  assert.ok(box, 'the alcove sits in its own plain box');
  assert.match(readingRoomHtml.slice(shelf, box.index), /^<section id="shelf">\s*$/, 'first thing on the shelf screen');
  const img = box[0].match(/<img[^>]*>/)[0];
  for (const attr of ['alt="' + ALCOVE_WORDS + '"', 'width="1440"', 'height="481"', 'loading="lazy"']) assert.ok(img.includes(attr), attr);
  assert.doesNotMatch(box[0], /aria-|tabindex|role=|\ssrc=|title=/, 'not hidden from screen readers, no focus, no role, and no download until the script says the picture may show');
  assert.equal((readingRoomHtml.match(/reading-alcove\.webp/g) || []).length, 1, 'only the script names the file');
  assert.match(readingRoomHtml, /\.alcove-art \{[^}]*aspect-ratio:1440 \/ 481;[^}]*max-height:220px;/);
});

test('the shelf picture waits, hidden, in its reserved box for its shelf', () => {
  const { readingRoomHtml } = load();
  const boxes = readingRoomHtml.match(/<div class="kade-art shelf-art" id="shelfArtBox" hidden><img id="shelfArt"[^>]*><\/div>/g) || [];
  assert.equal(boxes.length, 1);
  const img = boxes[0].match(/<img[^>]*>/)[0];
  for (const attr of ['alt=""', 'width="1152"', 'height="648"', 'loading="lazy"', 'fetchpriority="low"']) assert.ok(img.includes(attr), attr);
  assert.doesNotMatch(boxes[0], /aria-|tabindex|role=|\ssrc=|title=/, 'no aria-hidden on the img or its box; its words arrive with its source');
  // above the folder list, not between a heading and its content or inside the list
  const at = readingRoomHtml.indexOf('<div class="kade-art shelf-art"');
  assert.ok(at < readingRoomHtml.indexOf('<nav class="crumbs" id="crumbs"'));
  assert.ok(at > readingRoomHtml.indexOf('<h3 id="h-local">'));
  assert.match(readingRoomHtml.slice(at - 20, at), /<\/section>\s*$/, 'right after the local section closes');
  assert.match(readingRoomHtml, /\.shelf-art \{[^}]*aspect-ratio:16 \/ 9;/);
});

test('pictures step aside under contrast, zoom, landscape, data saving and large text, and are never inverted', () => {
  const { readingRoomHtml, ART_HIDDEN_WHEN } = load();
  assert.equal(ART_HIDDEN_WHEN, HIDDEN_WHEN);
  assert.ok(readingRoomHtml.includes('@media ' + HIDDEN_WHEN + ' { .kade-art { display:none !important; } }'));
  assert.ok(readingRoomHtml.includes('.kade-art-off .kade-art { display:none !important; }'));
  assert.ok(readingRoomHtml.includes('.kade-art[hidden] { display:none !important; }'));
  assert.doesNotMatch(readingRoomHtml, /inverted-colors/, 'no inverted-colors rule: WebKit may match it under Smart Invert and show a negative');
  assert.doesNotMatch(readingRoomHtml, /kade-art[^{]*\{[^}]*(animation|transition|filter)/, 'no motion, no filter');
});

test('a missing picture is never announced: no source yet or a failed load takes the img away, not its box', () => {
  const { readingRoomHtml } = load();
  assert.ok(readingRoomHtml.includes('.kade-art.art-failed img, .kade-art img:not([src]) { display:none; }'));
  assert.doesNotMatch(readingRoomHtml, /visibility:hidden/, 'display:none, which screen readers skip, never a merely invisible picture');
  // the box keeps its space and its dusk gradient: the img is absolutely placed inside it
  assert.match(readingRoomHtml, /\.kade-art \{[^}]*position:relative;[^}]*background:linear-gradient\(/);
  assert.match(readingRoomHtml, /\.kade-art img \{[^}]*position:absolute;[^}]*color:transparent;/);
  assert.doesNotMatch(readingRoomHtml, /\.kade-art\.art-failed \{/, 'nothing hides the failed box itself');
});

test('the head check marks the page for data saving and very large text before anything is laid out', () => {
  const { readingRoomHtml } = load();
  const head = readingRoomHtml.slice(0, readingRoomHtml.indexOf('</head>'));
  const script = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('kade-art-off'));
  assert.ok(script, 'the step-aside check runs in the head');
  const run = ({ saveData, fontSize }) => {
    const classes = new Set();
    const documentElement = { classList: { add: (c) => classes.add(c) } };
    vm.runInNewContext(script, { document: { documentElement }, navigator: saveData === undefined ? {} : { connection: { saveData } }, getComputedStyle: () => ({ fontSize }) });
    return classes.has('kade-art-off');
  };
  assert.equal(run({ fontSize: '16px' }), false);
  assert.equal(run({ fontSize: '20px' }), false, '20px is still normal enough');
  assert.equal(run({ fontSize: '20.5px' }), true);
  assert.equal(run({ fontSize: '24px' }), true, "Chrome's Very large text");
  assert.equal(run({ saveData: true, fontSize: '16px' }), true, 'Data Saver');
  assert.equal(run({ saveData: false, fontSize: '16px' }), false);
});

test('no block of picture words, no extra heading, no live region: only the alt text', () => {
  const { readingRoomHtml } = load();
  assert.doesNotMatch(readingRoomHtml, /kade-pictures|Pictures on this page|picturesOnPage|shelfArtWords/, 'the end-of-page pictures block is gone');
  assert.equal((readingRoomHtml.match(/<h2\b/g) || []).length, 15, 'the same fifteen headings as before the pictures');
  assert.equal((readingRoomHtml.match(/aria-live=/g) || []).length, 1, 'still ONE live region');
  assert.equal((readingRoomHtml.match(/aria-hidden/g) || []).length, 1, 'only the breadcrumb separator is hidden');
  // each sentence is said once, as alt text: the alcove's in its <img>, the shelves' only in the script that sets them
  assert.equal(readingRoomHtml.split(ALCOVE_WORDS).length - 1, 1);
  const body = readingRoomHtml.slice(readingRoomHtml.indexOf('<body>'), readingRoomHtml.indexOf('<script src="/assets/library/requests.js'));
  for (const words of [RADIO_WORDS, MUSIC_WORDS]) {
    assert.ok(!body.includes(words), 'no shelf sentence sits in the page as text');
    assert.equal(readingRoomHtml.split(words).length - 1, 1, 'once, in the script');
  }
  // today's words for a folder change are untouched
  assert.ok(readingRoomHtml.includes("if (path !== undefined) say((archivePath || 'The archive') + ': ' + j.folders.length + ' folder' + (j.folders.length === 1 ? '' : 's') + ', ' + j.total + ' clip' + (j.total === 1 ? '' : 's') + '.');"));
});

test('alt text is the art list sentences, word for word', () => {
  const { ALCOVE_ART, SHELF_ART, ART_DIR } = load();
  assert.equal(ART_DIR, '/assets/art/');
  assert.deepEqual(Object.keys(SHELF_ART), ['radio', 'music']);
  assert.deepEqual(Object.keys(ALCOVE_ART), ['src', 'alt']);
  assert.equal(ALCOVE_ART.src, '/assets/library/reading-alcove.webp');
  assert.equal(ALCOVE_ART.alt, ALCOVE_WORDS);
  assert.equal(SHELF_ART.radio.alt, RADIO_WORDS);
  assert.equal(SHELF_ART.music.alt, MUSIC_WORDS);
  for (const words of [ALCOVE_WORDS, RADIO_WORDS, MUSIC_WORDS]) assert.doesNotMatch(words, /["'<>&\\`$]/, 'safe inside alt="..." and the page script as they are');
  const list = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const byFile = Object.fromEntries(list.map((e) => [e.file, e.description]));
  assert.equal(byFile[ALCOVE_ART.src], ALCOVE_ART.alt);
  for (const art of Object.values(SHELF_ART)) {
    for (const width of [768, 1152]) assert.equal(byFile[ART_DIR + art.file + '-' + width + '.webp'], art.alt, art.file + '-' + width);
  }
});

function webpSize(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (chunk === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  throw new Error('unknown WebP chunk ' + chunk);
}

test('each shelf picture ships small, 16:9, in both sizes the page asks for, from the served art folder', () => {
  const { SHELF_ART } = load();
  for (const art of Object.values(SHELF_ART)) {
    for (const width of [768, 1152]) {
      const file = path.join(artDir, art.file + '-' + width + '.webp');
      const buf = fs.readFileSync(file);
      assert.ok(buf.length < 150 * 1024, path.basename(file) + ' is under 150 KB');
      assert.deepEqual(webpSize(buf), [width, width * 9 / 16], path.basename(file));
    }
  }
  assert.deepEqual(fs.readdirSync(artDir).filter((f) => /^shelf-(radio|music)/.test(f) && !f.endsWith('.webp')), [], 'no full-size PNGs committed');
  assert.ok(!fs.existsSync(path.join(__dirname, '../../../client/public/art')), 'nothing left in client/public/art, which production never serves');
});

/* The browser half: run the page's own picture code against a tiny fake DOM. */
function artRig({ saveData = false, artOff = false, narrow = false } = {}) {
  const { readingRoomHtml } = load();
  const start = readingRoomHtml.indexOf('  /* pictures (Sep 25 2026 art batch)');
  const end = readingRoomHtml.indexOf("  $('libraryScope').onchange", start);
  assert.ok(start > 0 && end > start);
  const els = {};
  function classList() {
    const set = new Set();
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  }
  function box(id, hidden) {
    const b = { id, hidden, classList: classList() };
    els[id] = b;
    return b;
  }
  function img(id, parentNode, alt) {
    const handlers = {};
    const i = {
      id, parentNode, attrs: { alt }, sizes: '', handlers,
      set src(v) { this.attrs.src = v; }, get src() { return this.attrs.src || ''; },
      set srcset(v) { this.attrs.srcset = v; }, get srcset() { return this.attrs.srcset || ''; },
      set alt(v) { this.attrs.alt = String(v); }, get alt() { return this.attrs.alt || ''; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(type, fn) { handlers[type] = fn; },
    };
    els[id] = i;
    return i;
  }
  const alcoveBox = box('alcoveBox', false);
  const alcove = img('alcoveArt', alcoveBox, ALCOVE_WORDS);
  const shelfBox = box('shelfArtBox', true);
  const shelf = img('shelfArt', shelfBox, '');
  const made = [];
  const mql = { matches: narrow, listeners: [], addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); } };
  const htmlClasses = classList();
  if (artOff) htmlClasses.add('kade-art-off');
  const context = {
    $: (id) => els[id] || null,
    document: { documentElement: { classList: htmlClasses }, createElement: (tag) => { made.push(tag); return {}; } },
    window: { matchMedia: (q) => { assert.equal(q, HIDDEN_WHEN); return mql; } },
    navigator: saveData ? { connection: { saveData: true } } : {},
  };
  vm.runInNewContext(readingRoomHtml.slice(start, end) + '\nthis.showShelfArt = showShelfArt; this.shelfArtFor = shelfArtFor;', context);
  const screenChange = (matches) => { mql.matches = matches; mql.listeners.forEach((fn) => fn()); };
  return { ...context, alcove, alcoveBox, shelf, shelfBox, made, screenChange };
}

test('only the Radio and Music shelves under Audio get a picture', () => {
  const { shelfArtFor } = artRig();
  const cases = {
    'Audio/Radio': 'radio', 'Audio/Radio/Airchecks & Broadcasts': 'radio', 'Audio/Radio Commercials/Tobacco/2000s': 'radio',
    'Audio/Radio Airchecks/Undated': 'radio', 'Audio/Music': 'music', 'audio/music/Fiddle': 'music',
    '': '', Audio: '', 'Audio/Cassettes': '', 'Audio/Audiobooks': '', 'Audio/Ozarks (Springfield Area)/Radio': '',
    'Videos/Music': '', 'Videos/Commercials/Radio': '', 'Audio/Radiology lectures': '',
  };
  for (const [p, want] of Object.entries(cases)) assert.equal(shelfArtFor(p), want, p);
});

test('the alcove downloads at once on a screen that shows it, and keeps its alt', () => {
  const rig = artRig();
  assert.equal(rig.alcove.src, '/assets/library/reading-alcove.webp');
  assert.equal(rig.alcove.alt, ALCOVE_WORDS);
  assert.equal(rig.shelf.getAttribute('src'), null, 'no shelf picture before a shelf opens');
  assert.equal(rig.shelf.alt, '');
  assert.deepEqual(rig.made, [], 'the picture code adds nothing to the page');
});

test("the shelf picture's alt follows its source, and only a folder change touches either", () => {
  const rig = artRig();
  rig.showShelfArt('Audio/Radio');
  assert.equal(rig.shelfBox.hidden, false);
  assert.equal(rig.shelf.src, '/assets/art/shelf-radio-768.webp');
  assert.equal(rig.shelf.srcset, '/assets/art/shelf-radio-768.webp 768w, /assets/art/shelf-radio-1152.webp 1152w');
  assert.equal(rig.shelf.alt, RADIO_WORDS);

  const before = JSON.stringify(rig.shelf.attrs);
  rig.showShelfArt('Audio/Radio/Airchecks & Broadcasts');
  assert.equal(JSON.stringify(rig.shelf.attrs), before, 'a deeper radio folder changes nothing on the page');

  rig.showShelfArt('Audio/Music');
  assert.equal(rig.shelf.src, '/assets/art/shelf-music-768.webp');
  assert.equal(rig.shelf.alt, MUSIC_WORDS, 'the alt changes in the same step as the source');

  // turning the phone, zooming or switching on high contrast never touches the alt
  rig.screenChange(true);
  rig.screenChange(false);
  assert.equal(rig.shelf.alt, MUSIC_WORDS);
  assert.equal(rig.shelfBox.hidden, false, 'the CSS alone hides the box on such screens');

  rig.showShelfArt('Audio/Cassettes');
  assert.equal(rig.shelfBox.hidden, true, 'hidden, so silent');
  assert.equal(rig.shelf.getAttribute('src'), null, 'nothing more downloads');
  assert.equal(rig.shelf.getAttribute('srcset'), null);
  assert.equal(rig.shelf.alt, '');
  assert.deepEqual(rig.made, [], 'no element is ever added for the words');
});

test('a picture that fails keeps its box, and the CSS takes its img away', () => {
  const rig = artRig();
  rig.showShelfArt('Audio/Radio');
  rig.shelf.handlers.error.call(rig.shelf);
  assert.equal(rig.shelfBox.hidden, false, 'the reserved space stays');
  assert.ok(rig.shelfBox.classList.contains('art-failed'), 'the dusk gradient shows and the img is display:none');
  rig.showShelfArt('Audio/Music');
  assert.ok(!rig.shelfBox.classList.contains('art-failed'), 'a new shelf tries its own picture');
  assert.equal(rig.shelf.alt, MUSIC_WORDS);
  rig.shelf.handlers.load.call(rig.shelf);
  assert.ok(!rig.shelfBox.classList.contains('art-failed'));

  rig.alcove.handlers.error.call(rig.alcove);
  assert.ok(rig.alcoveBox.classList.contains('art-failed'));
  assert.equal(rig.alcoveBox.hidden, false);
});

test('a screen that hides the pictures never downloads them, and a later wide screen does', () => {
  const rig = artRig({ narrow: true });
  assert.equal(rig.alcove.getAttribute('src'), null, 'no alcove download on a narrow, zoomed or high-contrast screen');
  rig.showShelfArt('Audio/Radio');
  assert.equal(rig.shelf.getAttribute('src'), null, 'no shelf download either');
  assert.equal(rig.shelf.alt, RADIO_WORDS, 'ready for when it shows; silent meanwhile, since the CSS hides the box and a sourceless img');
  rig.screenChange(false);
  assert.equal(rig.alcove.src, '/assets/library/reading-alcove.webp');
  assert.equal(rig.shelf.src, '/assets/art/shelf-radio-768.webp');
  assert.equal(rig.shelf.alt, RADIO_WORDS);
});

for (const [label, opts] of [['Data Saver', { saveData: true }], ['very large text (kade-art-off)', { artOff: true }]]) {
  test(label + ' gets no picture downloads', () => {
    const rig = artRig(opts);
    assert.equal(rig.alcove.getAttribute('src'), null);
    rig.showShelfArt('Audio/Music');
    assert.equal(rig.shelf.getAttribute('src'), null);
    assert.equal(rig.shelf.alt, MUSIC_WORDS);
    rig.screenChange(true); rig.screenChange(false);
    assert.equal(rig.shelf.getAttribute('src'), null, 'a screen change does not sneak a download in');
  });
}
