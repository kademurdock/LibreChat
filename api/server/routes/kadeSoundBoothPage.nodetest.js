'use strict';
/* The Sound Booth page without a browser (Sep 25 2026). The page's script is
 * written inside a JS template literal, so a regex like /\nLyrics:/ must be
 * typed with doubled backslashes in the source. These build the page the way
 * the server does, compile every inline script, and read what a browser would
 * actually receive. Run: node --test kadeSoundBoothPage.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  return context.module.exports.soundBoothHtml;
}
const html = buildPage();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('every inline script compiles and no backspace character crept in', () => {
  assert.ok(scripts.length >= 1);
  for (const s of scripts) new Function(s);
  assert.equal(html.includes('\b'), false);
});

test('a Lyria draft is split like a YuE2 draft, and an instrumental is left whole', () => {
  const line = html.split('\n').find((l) => l.includes("engine==='yue2'||engine==='lyria'") && l.includes('result.split('));
  assert.ok(line, 'the draft handler splits both music engines');
  const literal = line.match(/result\.split\((\/[^/]*\/i)\)/);
  assert.ok(literal, 'the split is a regex literal');
  assert.equal(literal[1], '/\\nLyrics:\\s*/i', 'the browser receives single backslashes');
  const re = vm.runInNewContext(literal[1]);
  const draft = 'A 1970s soul song, Rhodes and brushed drums.\n\nLyrics:\n[Verse 1]\nthe words';
  const parts = draft.split(re);
  assert.equal(parts[0].trim(), 'A 1970s soul song, Rhodes and brushed drums.');
  assert.equal(parts.slice(1).join('\n').trim(), '[Verse 1]\nthe words');
  assert.equal('A slow instrumental theme. Instrumental only, no vocals.'.split(re).length, 1);
  assert.match(line, /if\(engine==='yue2'\)throw/, 'only YuE2 refuses a draft without words');
});

test('the library card shows the words it sang apart from the description', () => {
  assert.match(html, /<summary>Words it sang<\/summary>/);
  assert.match(html, /p\.sungLyrics \?/);
});
