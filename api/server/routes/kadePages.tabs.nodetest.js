'use strict';
/* Nov 10 2026: one tab bar, the phone's: Talk, Library, Create, Play, More.
 * What these hold: the five names and where they go; the tab you are in marked for a screen reader
 * (aria-current) and for the eye by more than colour; the same bar on pages that load
 * /kade-tabbar.js; and focus landing on a section of Home when a tab opens it.
 * Run: node --test api/server/routes/kadePages.tabs.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { SHARED_HEAD, tabBarAsset } = require('./kadePages');

const HOME = '<h2 id="sec-account">Your account</h2><h2 id="sec-talk">Talk</h2><h2 id="sec-library">Library</h2><h2 id="sec-create">Create</h2><h2 id="sec-play">Play</h2><h2 id="sec-more">More</h2><h2 id="sec-web-only">Web only</h2>';
async function at(address, withAsset) {
  const head = withAsset ? '<script>' + tabBarAsset + '</script>' : SHARED_HEAD;
  const dom = new JSDOM('<!doctype html><html><head>' + head + '</head><body><main><h1>x</h1>' + HOME + '</main></body></html>', {
    url: 'https://example.invalid' + address,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 25)); // the bar is built when the page has loaded
  const nav = dom.window.document.querySelector('nav.kadetabs');
  const current = [...nav.querySelectorAll('a[aria-current]')].map((a) => [a.textContent.replace(/^\W+/, ''), a.getAttribute('aria-current')]);
  return { dom, nav, current, document: dom.window.document };
}

test('five tabs, the phone names in the phone order, each a plain link', async () => {
  const { nav, dom } = await at('/you');
  assert.equal(nav.getAttribute('aria-label'), 'Main navigation');
  const tabs = [...nav.querySelectorAll('a')].map((a) => [a.querySelector('.tx').textContent, a.getAttribute('href')]);
  assert.deepEqual(tabs, [
    ['Talk', '/home#sec-talk'],
    ['Library', '/library'],
    ['Create', '/home#sec-create'],
    ['Play', '/home#sec-play'],
    ['More', '/home#sec-more'],
  ]);
  for (const a of nav.querySelectorAll('a')) {
    assert.equal(a.querySelector('.ic').getAttribute('aria-hidden'), 'true', 'the picture is not read; the word is');
    assert.equal(a.textContent.replace(a.querySelector('.ic').textContent, ''), a.querySelector('.tx').textContent);
  }
  assert.equal(dom.window.document.querySelectorAll('nav.kadetabs').length, 1);
  dom.window.close();
});

test('the tab whose section holds the page is current; only the exact page is the current page', async () => {
  const cases = {
    '/library': [['Library', 'page']],
    '/library/search?q=meeks': [['Library', 'true']],
    '/library?book=abc': [['Library', 'true']],
    '/reading-room': [['Library', 'true']],
    '/family-history': [['Library', 'true']],
    '/home': [['Talk', 'true']],
    '/home#sec-talk': [['Talk', 'page']],
    '/home#sec-create': [['Create', 'page']],
    '/home#sec-play': [['Play', 'page']],
    '/home#sec-more': [['More', 'page']],
    '/home#sec-library': [['Library', 'true']],
    '/home#sec-web-only': [['More', 'true']],
    '/conversations': [['Talk', 'true']],
    '/spotter': [['Talk', 'true']],
    '/describe': [['Talk', 'true']],
    '/sound-booth': [['Create', 'true']],
    '/my-creations/': [['Create', 'true']],
    '/prompts/new': [['Create', 'true']],
    '/parlor': [['Play', 'true']],
    '/debate-room': [['Play', 'true']],
    '/notifications': [['More', 'true']],
    '/you': [['More', 'true']],
    '/feed-the-server': [['More', 'true']],
    '/librarything': [['More', 'true']],
  };
  for (const [address, want] of Object.entries(cases)) {
    const page = await at(address);
    assert.deepEqual(page.current, want, address);
    page.dom.window.close();
  }
});

test('the current tab is marked by more than colour, and its ring and words can be seen', () => {
  const css = SHARED_HEAD.slice(SHARED_HEAD.indexOf('/*KADE-TABS-CSS*/'), SHARED_HEAD.indexOf('/*KADE-TABS-CSS-END*/'));
  const rule = css.match(/nav\.kadetabs a\[aria-current\] \{([^}]*)\}/)[1];
  assert.match(rule, /border-top-color:/, 'a bar along the top');
  assert.match(rule, /font-weight: 800/, 'heavier letters');
  assert.match(css, /nav\.kadetabs a\[aria-current\] \.tx \{ text-decoration: underline;/, 'an underlined name');
  assert.match(css, /nav\.kadetabs a \{[^}]*border-top: 4px solid transparent;/, 'the bar has room on every tab, so nothing shifts');
  assert.ok(!/aria-current="page"\]/.test(SHARED_HEAD), 'the mark is for any current tab, not only an exact page');
  const luminance = (hex) => {
    const part = (i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * part(0) + 0.7152 * part(1) + 0.0722 * part(2);
  };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  const light = css.slice(0, css.indexOf('prefers-color-scheme: dark'));
  const colour = (block, selector) => block.match(new RegExp(selector.replace(/[.[\]]/g, '\\$&') + ' \\{[^}]*?(?:^|[ ;{])color: (#[0-9a-f]{6})'))[1];
  assert.ok(ratio(colour(light, 'nav.kadetabs a'), '#ffffff') >= 4.5, 'a tab name on the light bar');
  assert.ok(ratio(colour(light, 'nav.kadetabs a[aria-current]'), '#ffffff') >= 4.5, 'the current tab name on the light bar');
  assert.ok(ratio(colour(dark, 'nav.kadetabs a'), '#1a1d23') >= 4.5, 'a tab name on the dark bar');
  assert.ok(ratio(colour(dark, 'nav.kadetabs a[aria-current]'), '#1a1d23') >= 4.5, 'the current tab name on the dark bar');
  assert.ok(ratio(light.match(/a:focus-visible \{ outline: 3px solid (#[0-9a-f]{6})/)[1], '#ffffff') >= 3, 'the focus ring on the light bar');
  assert.ok(ratio(dark.match(/a:focus-visible \{ outline-color: (#[0-9a-f]{6})/)[1], '#1a1d23') >= 3, 'the focus ring on the dark bar');
  assert.match(css, /min-height: 56px/);
});

test('a tab that opens a section of Home puts focus on that heading, and the mark follows', async () => {
  const page = await at('/home#sec-create');
  assert.equal(page.document.activeElement.id, 'sec-create', 'arriving at a section starts there, not at the top of Home');
  assert.equal(page.document.activeElement.getAttribute('tabindex'), '-1');
  page.dom.window.location.hash = '#sec-play';
  page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent('hashchange'));
  assert.equal(page.document.activeElement.id, 'sec-play');
  assert.deepEqual([...page.nav.querySelectorAll('a[aria-current]')].map((a) => a.querySelector('.tx').textContent), ['Play']);
  page.dom.window.close();
  const plain = await at('/home');
  assert.equal(plain.document.activeElement, plain.document.body, 'plain Home never moves focus');
  plain.dom.window.close();
  const elsewhere = await at('/you#sec-create');
  assert.equal(elsewhere.document.activeElement, elsewhere.document.body, 'only on Home');
  elsewhere.dom.window.close();
});

test('/kade-tabbar.js is the same bar and the same marks, cut from the shared head', async () => {
  const page = await at('/spotter', true);
  assert.deepEqual([...page.nav.querySelectorAll('a .tx')].map((span) => span.textContent), ['Talk', 'Library', 'Create', 'Play', 'More']);
  assert.deepEqual(page.current, [['Talk', 'true']]);
  const style = [...page.document.querySelectorAll('style')].map((node) => node.textContent).join('\n');
  assert.match(style, /nav\.kadetabs a\[aria-current\] \.tx \{ text-decoration: underline;/);
  assert.match(style, /body \{ padding-bottom: calc\(96px/);
  page.dom.window.close();
  const builder = SHARED_HEAD.slice(SHARED_HEAD.indexOf('/*KADE-TABS-JS*/') + 16, SHARED_HEAD.indexOf('/*KADE-TABS-END*/'));
  assert.ok(tabBarAsset.includes(builder), 'one builder, not two copies that can drift');
  assert.equal((tabBarAsset.match(/var TABS = /g) || []).length, 1);
  assert.ok(!/'chats'|'alerts'|'you'|\/c\/new/.test(tabBarAsset), 'the old four tabs are gone');
});
