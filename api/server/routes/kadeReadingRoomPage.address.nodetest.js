'use strict';
/* Nov 10 2026 (redesign): the place you are in lives in the address.
 * What these hold: a search, each filter, the subject, the folder and the page number are query
 * parameters; Back and Forward redraw from them; a reload or a shared link opens the same list;
 * focus and the one spoken status line are right after each move; and "Back to the shelf"
 * returns to the very list and page an item was opened from.
 * Run: node --test api/server/routes/kadeReadingRoomPage.address.nodetest.js   (needs jsdom) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { source, row, answers, open, settle } = require('./kadeReadingRoomPage.rig');

const SEARCH = 'https://example.invalid/library';
const many = (url) => {
  const at = new URL(url, 'https://x.invalid').searchParams;
  const page = Number(at.get('page')) || 0;
  return { total: 150, items: [row(page * 60 + 1), row(page * 60 + 2)], types: [], decades: [], next: null };
};

test('a search, a filter and a page turn are each in the address; defaults are left out', async () => {
  const kept = answers.browse;
  try {
    answers.browse = many;
    const page = open(SEARCH);
    await settle();
    assert.equal(page.window.location.search, '', 'a plain address is the plain first page');
    assert.equal(page.$('browsePager').hidden, false);
    assert.equal(page.$('browsePageInfo').textContent, 'Page 1 of 3');
    assert.equal(page.$('browsePrev').disabled, true);
    assert.equal(page.$('browsePager').tagName, 'NAV');
    assert.ok(page.$('browsePager').getAttribute('aria-label'));
    assert.equal(page.$('browseMore'), null, 'no growing list: real pages');
    page.$('searchBox').value = 'meeks lumber';
    page.$('searchBox').focus();
    page.$('browseForm').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(page.window.location.search, '?q=meeks+lumber');
    assert.equal(page.document.activeElement.id, 'searchBox', 'a search leaves focus in the box');
    assert.equal(page.$('live').textContent, '150 items match. Page 1 of 3.');
    assert.match(page.document.title, /^Search: meeks lumber — /);
    const next = page.$('browseNext');
    next.focus();
    next.click();
    await settle();
    assert.equal(page.window.location.search, '?q=meeks+lumber&page=2');
    assert.ok(page.calls.some((call) => /browse\?.*page=1(&|$)/.test(call)), 'the server is asked for its page 1, the second page');
    assert.equal(page.document.activeElement.id, 'h-results', 'a page turn lands on the Results heading, above the new list');
    assert.equal(page.$('live').textContent, '150 items match. Page 2 of 3.');
    assert.equal(page.$('browseCount').textContent, '150 items · page 2 of 3 · showing 61 to 62');
    assert.match(page.$('browseList').textContent, /Clip 61/);
    assert.match(page.document.title, /^Search: meeks lumber — page 2 — /);
    page.dom.window.close();
  } finally {
    answers.browse = kept;
  }
});

test('an address with a search, filters and a page opens that very list, so reload and a shared link work', async () => {
  const kept = answers.browse;
  try {
    answers.browse = () => ({ total: 400, items: [row(5)], types: [{ _id: 'commercials', count: 9 }], decades: [{ _id: '1990s', count: 9 }], next: null });
    const page = open(SEARCH + '?q=smitty&kind=video&type=commercials&decade=1990s&sort=title&scope=mine&under=Videos%2FMissouri&page=3');
    await settle();
    assert.equal(page.$('searchBox').value, 'smitty');
    assert.equal(page.$('browseKind').value, 'video');
    assert.equal(page.$('browseType').value, 'commercials');
    assert.equal(page.$('browseDecade').value, '1990s');
    assert.equal(page.$('browseSort').value, 'title');
    assert.equal(page.$('libraryScope').value, 'mine');
    assert.equal(page.$('browsePath').value, 'Videos/Missouri');
    assert.equal(page.$('browseLocation').hidden, false);
    const asked = page.calls.find((call) => call.includes('/browse?'));
    for (const part of ['q=smitty', 'kind=video', 'type=commercials', 'decade=1990s', 'sort=title', 'scope=mine', 'path=Videos%2FMissouri', 'page=2'])
      assert.ok(asked.includes(part), part);
    assert.equal(page.$('browsePageInfo').textContent, 'Page 3 of 7');
    assert.equal(page.document.activeElement, page.document.body, 'opening a link never moves focus');
    page.dom.window.close();
    const junk = open(SEARCH + '?kind=nonsense&scope=everyone&page=-4');
    await settle();
    assert.equal(junk.$('browseKind').value, '');
    assert.equal(junk.$('libraryScope').value, 'public');
    assert.ok(!junk.calls.find((call) => call.includes('/browse?')).includes('page='));
    junk.dom.window.close();
  } finally {
    answers.browse = kept;
  }
});

test('a link to a page past the end shows the last real page and corrects the address', async () => {
  const kept = answers.browse;
  try {
    answers.browse = (url) => {
      const page = Number(new URL(url, 'https://x.invalid').searchParams.get('page')) || 0;
      return { total: 150, items: page > 2 ? [] : [row(page * 60 + 1)], types: [], decades: [], next: null };
    };
    const page = open(SEARCH + '?page=9');
    await settle(120);
    assert.equal(page.window.location.search, '?page=3');
    assert.equal(page.$('browsePageInfo').textContent, 'Page 3 of 3');
    assert.match(page.$('browseList').textContent, /Clip 121/);
    page.dom.window.close();
  } finally {
    answers.browse = kept;
  }
});

test('Back and Forward redraw the list from the address, focus the Results heading and say the count', async () => {
  const page = open(SEARCH);
  await settle();
  page.$('searchBox').value = 'ky3';
  page.$('browseForm').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(page.window.location.search, '?q=ky3');
  page.$('searchBox').focus();
  const calls = page.calls.filter((call) => call.includes('/browse?')).length;
  page.window.history.back();
  await settle(150);
  assert.equal(page.window.location.search, '');
  assert.equal(page.$('searchBox').value, '', 'the form follows the address');
  assert.equal(page.calls.filter((call) => call.includes('/browse?')).length, calls + 1, 'one new list, loaded once');
  assert.equal(page.document.activeElement.id, 'h-results');
  assert.equal(page.$('h-results').textContent, 'Results');
  assert.equal(page.$('live').textContent, '3 items match.');
  page.window.history.forward();
  await settle(150);
  assert.equal(page.$('searchBox').value, 'ky3');
  assert.equal(page.$('h-results').textContent, 'Results: ky3');
  page.dom.window.close();
});

test('arrowing through a filter menu is one step for Back, not one per choice', async () => {
  const page = open(SEARCH);
  await settle();
  const before = page.window.history.length;
  for (const value of ['text', 'audio', 'video']) {
    page.$('browseKind').value = value;
    page.$('browseKind').dispatchEvent(new page.window.Event('change'));
    await settle(20);
  }
  await settle();
  assert.equal(page.window.location.search, '?kind=video');
  assert.equal(page.window.history.length, before + 1);
  page.dom.window.close();
});

test('Back to the shelf returns to the very list and page the item was opened from', async () => {
  const kept = answers.browse;
  try {
    answers.browse = () => ({ total: 150, items: [row(61), row(62)], types: [], decades: [], next: null });
    const list = open(SEARCH + '?q=meeks&page=2');
    await settle();
    const button = list.$('browseList').querySelector('button');
    assert.equal(button.getAttribute('aria-label'), 'Open Clip 61');
    button.dispatchEvent(new list.window.MouseEvent('click', { bubbles: true }));
    const note = JSON.parse(list.window.sessionStorage.getItem('library-return'));
    assert.equal(note.from, new URL(SEARCH).pathname + '?q=meeks&page=2');
    list.dom.window.close();
    assert.match(source, /\$\('backToShelf'\)\.onclick = function\(\)\{ pause\(\); leave\(\); \};/);
    assert.match(source, /location\.href = inside \? from : /);
    const back = open('https://example.invalid' + note.from, { 'library-return': JSON.stringify(note) });
    await settle();
    assert.equal(back.document.activeElement.getAttribute('aria-label'), 'Open Clip 61', 'the row is on that page, so focus finds it');
    back.dom.window.close();
  } finally {
    answers.browse = kept;
  }
});

const FOLDERS = 'https://example.invalid/library';
const openFolders = async (page) => {
  const box = page.$('folderBrowse');
  if (box && !box.open) {
    box.open = true;
    box.dispatchEvent(new page.window.Event('toggle'));
  }
  await settle();
};

test('folders: opening one, turning its page and Back are in the address, and Back lands on the crumb', async () => {
  const kept = answers.archive;
  try {
    answers.archive = (url) => {
      const at = new URL(url, 'https://x.invalid').searchParams;
      const where = at.get('path') || '';
      return where
        ? { crumbs: where.split('/').map((name) => ({ name })), folders: [], items: [row(1), row(2)], total: 150, limit: 60, page: Number(at.get('page')) || 0 }
        : { crumbs: [], folders: [{ name: 'Video', path: 'Video', count: 150 }], items: [], total: 0, limit: 60, page: 0 };
    };
    const page = open(FOLDERS);
    await settle();
    await openFolders(page);
    page.$('archiveList').querySelector('button').click();
    await settle();
    assert.equal(page.window.location.search, '?folder=Video');
    page.$('pageNext').click();
    await settle();
    assert.equal(page.window.location.search, '?folder=Video&fpage=2');
    page.window.history.back();
    await settle(150);
    assert.equal(page.window.location.search, '?folder=Video');
    assert.equal(page.$('pageInfo').textContent, 'Page 1 of 3 (150 items here)');
    page.window.history.back();
    await settle(150);
    assert.equal(page.window.location.search, '');
    assert.equal(page.document.activeElement.textContent, 'Library', 'focus is on the crumb for where you now are');
    assert.match(page.$('archiveList').textContent, /Video/);
    page.dom.window.close();
    const deep = open(FOLDERS + '?folder=Video&fpage=3');
    await settle(120);
    assert.ok(deep.calls.some((call) => call.includes('/archive?path=Video&page=2')), 'a link to a folder opens that folder and page');
    assert.equal(deep.document.activeElement, deep.document.body, 'and does not move focus');
    deep.dom.window.close();
  } finally {
    answers.archive = kept;
  }
});

test('a return address outside the Library is never followed', () => {
  const body = source.match(/function leave\(\)\{([\s\S]*?)\n {2}\}/)[1];
  assert.match(body, /from\.indexOf\('\/library'\) === 0/);
  assert.match(body, /from\.indexOf\('\/\/'\) === -1/, 'no //host address');
  assert.match(body, /from\.indexOf\('book='\) === -1/, 'never back onto an item');
});
