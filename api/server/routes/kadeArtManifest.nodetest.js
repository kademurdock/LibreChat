/* The web art list (Sep 25 2026 art batch, plan rule 34). Every picture the
 * web shows has one blind-checked sentence in client/public/assets/art/
 * art-manifest.json, and each page that shows a picture carries that exact
 * sentence as the picture's real alt text. Kade's decision (Sep 25): no
 * separate block of picture words at the end of a page, so no source file
 * may keep the old block's class or heading, and no page may invert its
 * paintings (WebKit can match inverted-colors under Smart Invert). The
 * braille K web mark is real braille: dots 1 and 3 only. The pages are read
 * as plain text, so this runs without React, TypeScript or a server.
 *
 * Run: node --test api/server/routes/kadeArtManifest.nodetest.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../..');
const publicDir = path.join(root, 'client/public');
const artDir = path.join(publicDir, 'assets/art');
const manifestFile = path.join(artDir, 'art-manifest.json');
const ALCOVE = '/assets/library/reading-alcove.webp';

/* Which pictures each page shows, by picture name (the file name without its
 * width). A page that links any other manifest picture must carry its
 * sentence too; the scan below catches that. */
const PAGES = {
  'packages/api/src/description/page.ts': ['room-describer-booth'],
  'api/server/routes/kadeReadingRoomPage.js': ['reading-alcove', 'shelf-radio', 'shelf-music'],
  'client/src/components/Auth/HouseAtDusk.tsx': ['house-at-dusk'],
};

function manifest() {
  return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
}
function pictureName(file) {
  return path.basename(file, '.webp').replace(/-\d+$/, '');
}
function onDisk(file) {
  return path.join(publicDir, ...file.replace(/^\//, '').split('/'));
}
function sentences() {
  const out = {};
  for (const entry of manifest()) {
    const name = pictureName(entry.file);
    if (out[name] !== undefined) assert.equal(entry.description, out[name], name + ': every size of one picture has the same sentence');
    out[name] = entry.description;
  }
  return out;
}

test('the art list is well formed and every file in it exists', () => {
  const list = manifest();
  assert.ok(Array.isArray(list) && list.length > 0, 'an array of pictures');
  const seen = new Set();
  for (const entry of list) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'file'], JSON.stringify(entry));
    assert.equal(typeof entry.file, 'string');
    assert.equal(typeof entry.description, 'string');
    assert.ok(!seen.has(entry.file), entry.file + ' is listed once');
    seen.add(entry.file);
    assert.ok(entry.file.startsWith('/assets/art/') || entry.file === ALCOVE, entry.file + ' is linked as /assets/art/<file> (or is the Library alcove)');
    assert.match(entry.file, /\.webp$/, entry.file + ' is a WebP picture');
    assert.ok(fs.existsSync(onDisk(entry.file)), entry.file + ' exists at ' + path.relative(root, onDisk(entry.file)));
  }
  assert.ok(seen.has(ALCOVE), 'the Library reading-alcove banner is listed');
  sentences();
});

test('the art list holds the alt text Kade approved on Sep 25, word for word', () => {
  assert.deepEqual(sentences(), {
    'house-at-dusk': 'A two-story wood and stone lake house at dusk among pine trees, its windows lit warm with a different room glowing in each.',
    'room-describer-booth': 'A projection booth at dusk: an old film projector with two reels shines a beam through a wall opening into a small theater with red seats, beside stacked film cans, a microphone and a desk lamp.',
    'shelf-radio': 'An old wooden cathedral radio glowing on a kitchen table with a red checked runner, beside an enamel coffee pot, a mug, daisies and an oil lamp, with a full moon over the lake outside.',
    'shelf-music': 'A cabin music corner at dusk: a fiddle, a banjo and a mandolin hang above a record player and two crates of records, with a fringed lamp, a rocking chair and a lake sunset through the window.',
    'reading-alcove': 'A cozy reading room at dusk: dark blue bookshelves holding books, film reels and a cassette radio, a lit lamp, a green armchair with an orange pillow and knit throw, and a window onto a lake at sunset.',
  });
});

test('every WebP picture in client/public/assets/art has an entry', () => {
  const listed = new Set(manifest().map((e) => e.file));
  const webps = fs.readdirSync(artDir).filter((f) => f.toLowerCase().endsWith('.webp'));
  assert.ok(webps.length > 0);
  for (const f of webps) assert.ok(listed.has('/assets/art/' + f), f + ' has a description in art-manifest.json');
  assert.ok(!fs.existsSync(path.join(publicDir, 'art')), 'client/public/art is gone: production never serves it');
});

test('every description is short, plain and never starts with "image of" or "picture of"', () => {
  for (const { file, description } of manifest()) {
    const words = description.trim().split(/\s+/);
    assert.ok(words.length <= 40, file + ' is ' + words.length + ' words (40 at most)');
    assert.doesNotMatch(description.trim(), /^(an?\s+)?(image|picture)\s+of\b/i, file);
    assert.equal(description, description.trim(), file + ' has no stray spaces');
    assert.match(description, /[.]$/, file + ' is a whole sentence');
  }
});

/* How a page may give a sentence to a picture as alt text, read as plain
 * text: alt="...", alt='...', alt={'...'}, alt: '...', .alt = '...' or
 * setAttribute('alt', '...') straight around the sentence; or the sentence is
 * held in a name (HOUSE_ALT = '...', description: '...') and an alt attribute
 * or assignment close by uses that name (alt={HOUSE_ALT},
 * alt="${esc(booth.description)}", img.alt = SHELF_ART[key].alt). */
const ALT_OPENER = String.raw`(?:\balt\s*(?:=|:)\s*\{?\s*|\.setAttribute\(\s*['"]alt['"]\s*,\s*)`;
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function altUse(text, sentence) {
  const quoted = String.raw`(['"\x60])` + escapeRegExp(sentence) + String.raw`\1`;
  if (new RegExp(ALT_OPENER + quoted).test(text)) return true;
  const holders = [...text.matchAll(new RegExp(String.raw`([A-Za-z_$][\w$]*)['"]?\s*[:=]\s*(['"\x60])` + escapeRegExp(sentence) + String.raw`\2`, 'g'))].map((m) => m[1]);
  const uses = [...text.matchAll(new RegExp(ALT_OPENER + String.raw`([^;\n]{0,160})`, 'g'))].map((m) => m[1]);
  return holders.some((name) => uses.some((use) => new RegExp(String.raw`(^|[^\w$])` + escapeRegExp(name) + String.raw`($|[^\w$])`).test(use)));
}

test('the alt-text reader knows alt text when it sees it', () => {
  const s = 'A lamp at dusk.';
  for (const yes of [
    '<img alt="A lamp at dusk.">', "img.alt = 'A lamp at dusk.';", 'alt={"A lamp at dusk."}', "{ file: 'x', alt: 'A lamp at dusk.' }",
    "img.setAttribute('alt', 'A lamp at dusk.')", "const LAMP_ALT = 'A lamp at dusk.';\n<img alt={LAMP_ALT} />",
    "export const lamp = { description:\n    'A lamp at dusk.' };\nhtml`<img alt=\"${esc(lamp.description)}\">`",
    "const ART = { lamp: { alt: 'A lamp at dusk.' } };\nimg.alt = ART[key].alt;",
  ]) assert.ok(altUse(yes, s), yes);
  for (const no of [
    '<p>A lamp at dusk.</p>', "const LAMP = 'A lamp at dusk.';\n<p>{LAMP}</p>", "const LAMP = 'A lamp at dusk.';\n<img alt=\"\" />",
    "const LAMP = 'A lamp at dusk.';\n<img alt={LAMPS} />", "title: 'A lamp at dusk.'",
  ]) assert.ok(!altUse(no, s), no);
});

test('each page gives every picture it shows the art list sentence as alt text', () => {
  const words = sentences();
  const lagging = [];
  for (const [rel, names] of Object.entries(PAGES)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const shown = new Set(names);
    for (const name of Object.keys(words)) if (text.includes(name)) shown.add(name);
    for (const name of shown) {
      assert.ok(words[name], rel + ' shows ' + name + ', which is in the art list');
      if (!text.includes(words[name])) lagging.push(rel + ' lacks the sentence for ' + name);
      else if (!altUse(text, words[name])) lagging.push(rel + ' has the sentence for ' + name + ' but not as alt text');
    }
    // every picture file the page links by its full name is in the art list
    for (const m of text.matchAll(/\b[a-z][a-z0-9-]*\.webp/g)) assert.ok(words[pictureName(m[0])], rel + ' links ' + m[0] + ', which has no description');
  }
  assert.deepEqual(lagging, []);
});

/* Source folders scanned for the retired block and the invert rule. Tests
 * are skipped: they name the old block to prove it is gone. */
const SCAN_DIRS = ['client/src', 'client/public', 'client/index.html', 'packages/api/src', 'api/server'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const TEXT_FILE = /\.(?:[cm]?js|jsx|tsx?|html|css|json)$/;
const TEST_FILE = /\.(?:test|spec|selftest|nodetest)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/]/;
function sourceFiles() {
  const out = [];
  const walk = (abs) => {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) if (!SKIP_DIRS.has(entry)) walk(path.join(abs, entry));
    } else if (TEXT_FILE.test(abs) && !TEST_FILE.test(abs)) out.push(abs);
  };
  for (const rel of SCAN_DIRS) if (fs.existsSync(path.join(root, rel))) walk(path.join(root, rel));
  return out;
}

test('no source file keeps the old end-of-page pictures block or inverts a painting', () => {
  const files = sourceFiles();
  for (const rel of Object.keys(PAGES)) assert.ok(files.includes(path.join(root, rel)), rel + ' is scanned');
  const found = [];
  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (text.includes('kade-pictures')) found.push(rel + ' still has kade-pictures');
    if (text.includes('Pictures on this page')) found.push(rel + ' still has "Pictures on this page"');
    if (/@media[^{};\n]*inverted-colors/.test(text)) found.push(rel + ' still has an inverted-colors rule');
  }
  assert.deepEqual(found, []);
});

test('every page links art as /assets/art/<file>, never /art/ or a relative assets/art/', () => {
  for (const rel of Object.keys(PAGES)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    // "/art/" with no folder name in front of it ("/assets/art/" and "client/public/assets/art" are fine)
    const old = [...text.matchAll(/(^|[^A-Za-z0-9_-])\/art\//g)];
    assert.deepEqual(old.map((m) => text.slice(m.index, m.index + 40)), [], rel + ' links art through the old /art/ address');
    // "assets/art/" with no slash in front of it resolves against the page's own address
    const relative = [...text.matchAll(/(^|[^/A-Za-z0-9_.-])assets\/art\//g)];
    assert.deepEqual(relative.map((m) => text.slice(m.index, m.index + 40)), [], rel + ' links art with a relative assets/art/ address');
  }
});

test('the braille K web mark has only dots 1 and 3 filled', () => {
  const svg = fs.readFileSync(path.join(artDir, 'kade-braille-mark-navy-v1.svg'), 'utf8');
  const circles = [...svg.matchAll(/<circle\b([^>]*)\/?>/g)].map((m) => {
    const attr = (k) => { const a = m[1].match(new RegExp('\\s' + k + '="([^"]*)"')); return a ? a[1] : null; };
    return { dot: attr('data-braille-dot'), cx: Number(attr('cx')), cy: Number(attr('cy')), fill: attr('fill') };
  });
  assert.equal(circles.length, 6, 'one braille cell: six dot places');
  // number each place from where it sits: left column top to bottom is 1 2 3, right column is 4 5 6
  const xs = [...new Set(circles.map((c) => c.cx))].sort((a, b) => a - b);
  const ys = [...new Set(circles.map((c) => c.cy))].sort((a, b) => a - b);
  assert.equal(xs.length, 2, 'two columns');
  assert.equal(ys.length, 3, 'three rows');
  const filled = [];
  for (const c of circles) {
    const place = xs.indexOf(c.cx) * 3 + ys.indexOf(c.cy) + 1;
    assert.equal(c.dot, String(place), 'data-braille-dot matches where the dot sits');
    const lit = c.fill !== null && c.fill.toLowerCase() !== 'none' && c.fill.toLowerCase() !== 'transparent';
    if (lit) filled.push(place);
  }
  assert.deepEqual(filled.sort(), [1, 3], 'braille K is dots 1 and 3');
});
