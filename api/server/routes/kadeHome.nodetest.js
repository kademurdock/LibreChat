/* Oct 29 2026: the web Home follows the phone's five tabs (node --test). */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === './kadePages') return { SHARED_HEAD: '' };
  return load.call(this, request, ...rest);
};
const { homeHtml } = require('./kadeHome');
Module._load = load;

const visibleText = (html) =>
  [...html.matchAll(/<strong>([^<]*)<\/strong><small id="[^"]+">([^<]*)<\/small>/g)]
    .map((m) => `${m[1]} ${m[2]}`)
    .join('\n');

test('sections come in the phone order: Talk, Library, Create, Play, More', () => {
  const heads = [...homeHtml.matchAll(/<h2 id="sec-([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ['account', 'talk', 'library', 'create', 'play', 'more', 'web-only']);
});

test('the tiles the web was missing are there', () => {
  for (const href of ['/described-video', '/search', '/describe']) {
    assert.ok(homeHtml.includes(`href="${href}"`), href);
  }
  assert.match(homeHtml, /aria-label="The Arcade, in the phone apps"/);
  assert.match(homeHtml, /id="tile-describedvideo" style="display:none"/);
  assert.match(homeHtml, /\/api\/kade\/described-video\/config/);
});

test('Game Room, Conversation Hall and the second Spotter tile are folded away', () => {
  assert.ok(!homeHtml.includes('href="/game-room"'));
  assert.ok(!homeHtml.includes('href="/conversation-hall"'));
  assert.strictEqual(homeHtml.split('href="/spotter"').length - 1, 1);
});

test('buttons say character, never agent or companion', () => {
  const text = visibleText(homeHtml);
  assert.ok(text.length > 500);
  assert.doesNotMatch(text, /\bagents?\b/i);
  assert.doesNotMatch(text, /\bcompanions?\b/i);
  assert.match(text, /Character Builder/);
  assert.match(text, /Saved replies/);
});

test('Skills and Projects sit in a closed Power tools group', () => {
  assert.match(homeHtml, /<details class="power"><summary>Power tools<\/summary>[\s\S]*href="\/skills"[\s\S]*href="\/projects"[\s\S]*<\/details>/);
  assert.doesNotMatch(homeHtml, /<details class="power" open/);
});
