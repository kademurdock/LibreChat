'use strict';
/* Page escapers must be attribute-safe (SEC-2, Nov 12 2026). The page scripts
 * paste esc(...) into double-quoted attributes (aria-label, alt, value), so an
 * escaper that leaves the double quote alone is stored XSS. A text node's
 * innerHTML escapes only & < >, which is how the old DOM-based esc failed.
 * Run: node --test kadePageEscape.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.KADE_ROUTES_DIR || __dirname;

function sources() {
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue; }
      if (!/\.js$/.test(ent.name) || /\.(nodetest|test|spec)\.js$/.test(ent.name)) continue;
      out.push({ file: path.relative(DIR, p), src: fs.readFileSync(p, 'utf8') });
    }
  })(DIR);
  return out;
}

/* Every HTML escaper definition: function esc(, function escapeHtml(, and
 * esc0 = function( style aliases. escapeXml / escapeRegex are not HTML. */
const DEF = /(?:function\s+(esc\w*|escapeHtml)\s*\(|(?:const|var|let)\s+(esc\w*|escapeHtml)\s*=\s*(?:function\s*\(|\(?\w*\)?\s*=>))/g;

function bodies(src) {
  const found = [];
  let m;
  DEF.lastIndex = 0;
  while ((m = DEF.exec(src))) {
    const name = m[1] || m[2];
    if (/^escape(?!Html)/.test(name)) continue;
    const lineNo = src.slice(0, m.index).split('\n').length;
    // A one-line escaper ends on its own line; a block one within a few lines.
    const rest = src.slice(m.index).split('\n');
    const body = /\}\s*;?\s*$/.test(rest[0]) ? rest[0] : rest.slice(0, 6).join('\n');
    found.push({ name, lineNo, body });
  }
  return found;
}

test('every page escaper escapes the double quote', () => {
  let seen = 0;
  for (const { file, src } of sources()) {
    for (const b of bodies(src)) {
      seen += 1;
      assert.match(b.body, /&quot;/, file + ':' + b.lineNo + ' ' + b.name + ' does not escape the double quote');
    }
  }
  assert.ok(seen >= 10, 'found only ' + seen + ' escapers; the scan pattern is stale');
});

test('the browser escapers neutralise an attribute breakout', () => {
  const attack = 'x" style="content-visibility:auto" oncontentvisibilityautostatechange="alert(1)';
  let ran = 0;
  for (const { file, src } of sources()) {
    const re = /function esc\((\w)\)\{[^\n]*\}/g;
    let m;
    while ((m = re.exec(src))) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      if (/document\./.test(m[0])) {
        // lounge.js and kadeSoundBoothPage.js keep the DOM form plus a quote
        // replace; they cannot run without a browser, so only require the replace.
        assert.match(m[0], /&quot;/, file + ':' + lineNo + ' has a DOM-only esc');
        continue;
      }
      const esc = new Function('return (' + m[0] + ')')();
      assert.ok(!esc(attack).includes('"'), file + ':' + lineNo + ' leaves a raw double quote');
      assert.ok(!/[<>]/.test(esc('<img src=x onerror=1>')), file + ':' + lineNo + ' leaves an angle bracket');
      assert.equal(esc(null), '', file + ':' + lineNo + ' null');
      assert.equal(esc(undefined), '', file + ':' + lineNo + ' undefined');
      assert.equal(esc('Tom & Jerry'), 'Tom &amp; Jerry', file + ':' + lineNo + ' ampersand');
      ran += 1;
    }
  }
  assert.ok(ran >= 8, 'ran only ' + ran + ' escapers');
});

test('the Conversation Hall card label survives a hostile share title', () => {
  const page = sources().find((s) => s.file === 'kadeRoomPage.js');
  assert.ok(page, 'kadeRoomPage.js not found');
  const hall = page.src.slice(page.src.indexOf('const hallHtml'));
  const m = /function esc\(s\)\{[^\n]*\}/.exec(hall);
  assert.ok(m, 'hall page has no esc');
  assert.ok(!/document\./.test(m[0]), 'hall esc still leans on innerHTML');
  const esc = new Function('return (' + m[0] + ')')();
  const html = '<section class="card" aria-label="' + esc('x" onfocus="1') + '">';
  assert.equal((html.match(/"/g) || []).length, 4, 'exactly the four quotes the template wrote');
  assert.ok(!/\sonfocus=/.test(html.replace(/aria-label="[^"]*"/, '')), 'no attribute escaped the label');
});
