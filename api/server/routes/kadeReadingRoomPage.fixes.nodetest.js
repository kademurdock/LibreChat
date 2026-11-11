'use strict';
/* Nov 10 2026 (redesign): the smaller problems from the Library and design review.
 * What these hold: a shelf drawn 60 rows at a time; adding to a playlist from a menu in the page
 * (no typed number in a browser prompt); and the Request an account page's landmark, field edges
 * and target sizes; and the sign-in eye button's name.
 * Run: node --test api/server/routes/kadeReadingRoomPage.fixes.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { row, place, answers, open, settle, JSDOM } = require('./kadeReadingRoomPage.rig');

const AT = 'https://example.invalid/library';

test('your shelf is drawn 60 at a time; Show more puts focus on the first new row and says the count', async () => {
  const kept = answers.shelf;
  try {
    const borrowed = Array.from({ length: 150 }, (_, i) => row(200 + i, { progress: place('2026-10-01T00:00:00Z', { finished: true }) }));
    answers.shelf = () => ({ me: 'me1', librarian: false, familyLibrary: true, mine: [], borrowed });
    const page = open(AT + '/continue');
    await settle(120);
    const rows = () => page.$('mineList').querySelectorAll('li[data-book]').length;
    assert.equal(rows(), 60);
    assert.equal(page.$('mineCount').textContent, '150 items · showing the first 60');
    const more = page.$('mineMore');
    assert.equal(more.textContent, 'Show 60 more');
    assert.equal(more.getAttribute('aria-label'), 'Show 60 more from your shelf, 90 not shown yet');
    more.focus();
    more.click();
    assert.equal(rows(), 120);
    assert.equal(page.document.activeElement.getAttribute('aria-label'), 'Open Clip 260', 'focus is on the first new row');
    await settle();
    assert.equal(page.$('live').textContent, 'Showing 120 of 150.');
    page.$('mineMore').click();
    assert.equal(rows(), 150);
    assert.equal(page.$('mineMore'), null, 'no button when everything is shown');
    assert.equal(page.$('mineCount').textContent, '150 items');
    assert.equal(page.$('mineList').querySelector('ul').getAttribute('aria-labelledby'), 'h-mine');
    page.dom.window.close();
    /* coming back from an item far down the shelf: enough rows are drawn for it to be there */
    const back = open(AT + '/continue', { 'library-return': JSON.stringify({ id: 'id280', host: 'mineList', at: Date.now() }) });
    await settle(150);
    assert.equal(back.$('mineList').querySelectorAll('li[data-book]').length, 120);
    assert.equal(back.document.activeElement.getAttribute('aria-label'), 'Open Clip 280');
    back.dom.window.close();
  } finally {
    answers.shelf = kept;
  }
});

test('Add to a playlist is a menu in the page, with focus looked after; no typed number', async () => {
  const kept = answers.collections;
  const posted = [];
  try {
    answers.collections = (url) => {
      if (/collections\/[^/]+\/items/.test(url)) {
        posted.push(url);
        return {};
      }
      if (posted.includes('new')) return { collection: { id: 'c9', title: 'Rainy day' } };
      return { mine: [{ id: 'c1', title: 'Saturday morning', count: 12 }, { id: 'c2', title: 'KY3', count: 1 }], shared: [] };
    };
    const page = open(AT + '?book=id1');
    page.window.prompt = () => {
      throw new Error('no browser prompt');
    };
    await settle();
    const button = page.$('addCollBtn');
    assert.equal(button.textContent, 'Add to a playlist');
    assert.equal(page.$('addCollPanel').hidden, true);
    button.click();
    await settle();
    assert.equal(page.$('addCollPanel').hidden, false);
    assert.equal(page.$('addCollPanel').getAttribute('role'), 'group');
    const menu = page.$('addCollSel');
    assert.equal(page.document.activeElement, menu, 'focus goes to the menu');
    assert.equal(page.document.querySelector('label[for="addCollSel"]').textContent, 'Add to which playlist?');
    assert.deepEqual([...menu.options].map((o) => o.textContent), ['Saturday morning (12 items)', 'KY3 (1 item)', 'A new playlist']);
    assert.equal(page.$('addCollNewWrap').hidden, true, 'the name box is only there for a new playlist');
    menu.value = 'c2';
    page.$('addCollGo').click();
    await settle();
    assert.ok(posted[0].includes('/collections/c2/items'));
    assert.equal(page.$('live').textContent, 'Added to KY3.');
    assert.equal(page.$('addCollPanel').hidden, true);
    assert.equal(page.document.activeElement, button, 'and back to the button afterwards');
    button.click();
    await settle();
    menu.value = '';
    menu.dispatchEvent(new page.window.Event('change'));
    assert.equal(page.$('addCollNewWrap').hidden, false);
    assert.equal(page.document.querySelector('label[for="addCollNew"]').textContent, 'Name for the new playlist');
    page.$('addCollGo').click();
    await settle();
    assert.equal(page.$('live').textContent, 'Give the new playlist a name first.');
    assert.equal(page.document.activeElement.id, 'addCollNew');
    page.$('addCollNew').value = 'Rainy day';
    posted.push('new');
    page.$('addCollGo').click();
    await settle();
    assert.ok(posted.at(-1).includes('/collections/c9/items'));
    assert.equal(page.$('live').textContent, 'Added to Rainy day.');
    button.click();
    await settle();
    page.$('addCollCancel').click();
    assert.equal(page.$('addCollPanel').hidden, true);
    assert.equal(page.document.activeElement, button);
    page.dom.window.close();
  } finally {
    answers.collections = kept;
  }
});

test('Request an account: a main landmark, field edges and targets that pass, focus kept after sending', () => {
  const { requestAccessHtml } = require('./kadePages');
  const { document } = new JSDOM(requestAccessHtml).window;
  assert.equal(document.querySelectorAll('main').length, 1);
  assert.ok(document.querySelector('main').contains(document.querySelector('h1')));
  assert.ok(document.querySelector('main').contains(document.getElementById('askForm')));
  assert.ok(document.querySelector('main').contains(document.getElementById('status')), 'the answer is inside main too');
  assert.equal(document.querySelectorAll('[aria-live]').length, 1);
  const luminance = (hex) => {
    const part = (i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * part(0) + 0.7152 * part(1) + 0.0722 * part(2);
  };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const light = requestAccessHtml.match(/form input\[type=text\], form textarea \{[^}]*min-height:44px;[^}]*border:1px solid (#[0-9a-f]{6})/)[1];
  const dark = requestAccessHtml.match(/form input\[type=text\], form textarea\{[^}]*border-color:(#[0-9a-f]{6})/)[1];
  assert.ok(ratio(light, '#f6f7f9') >= 3, 'field edge on the light page');
  assert.ok(ratio(dark, '#14161a') >= 3, 'field edge on the dark page');
  assert.match(requestAccessHtml, /p\.ways a \{ display:inline-block; padding:\.7rem \.15rem;/, 'the two small links are real targets');
  assert.equal(document.querySelectorAll('p.ways a').length, 2);
  assert.match(requestAccessHtml, /label\.choice \{[^}]*min-height:44px/);
  assert.equal(document.getElementById('status').getAttribute('tabindex'), '-1');
  assert.ok(requestAccessHtml.includes("document.getElementById('askForm').style.display='none'; try{ statusEl.focus(); }catch(e){}"));
});

test('the sign-in eye button says password on a password box, and secret elsewhere', () => {
  const input = fs.readFileSync(path.join(__dirname, '../../../packages/client/src/components/SecretInput.tsx'), 'utf8');
  assert.match(input, /props\.autoComplete\.includes\('password'\)\s*\?\s*'password'\s*:\s*'secret'/);
  assert.ok(input.includes('aria-label={isVisible ? `Hide ${secretWord}` : `Show ${secretWord}`}'));
  for (const form of ['LoginForm.tsx', 'Registration.tsx']) {
    const text = fs.readFileSync(path.join(__dirname, '../../../client/src/components/Auth', form), 'utf8');
    assert.match(text, /autoComplete="(?:current|new)-password"/, form + ' marks its password box');
  }
});
