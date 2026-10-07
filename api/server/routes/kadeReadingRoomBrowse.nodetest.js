const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function rig(api) {
  const context = {
    require: () => ({ SHARED_HEAD: '', librarianGuide: { chatUrl: '/c/new' } }),
    module: { exports: {} },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomPage'), 'utf8'), context);
  const dom = new JSDOM(context.module.exports.readingRoomHtml, {
    url: 'https://example.invalid/library',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.eval(
    fs.readFileSync(require.resolve('../../../client/public/assets/library/browse.js'), 'utf8'),
  );
  const said = [];
  window.setupLibraryBrowse(
    api,
    (text) => said.push(text),
    (item) => {
      const li = window.document.createElement('li');
      li.innerHTML =
        '<span class="t book"><strong></strong><span class="meta"></span></span><button type="button">Open</button>';
      li.querySelector('strong').textContent = item.title;
      return li;
    },
  );
  return { dom, window, document: window.document, said };
}
const answer = (title, next = null) => ({
  total: 2,
  items: [{ id: title, title, path: 'Books/Radio History', decade: '1930s' }],
  types: [{ _id: 'newspaper', count: 2 }],
  decades: [{ _id: '1930s', count: 2 }],
  next,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('an unavailable chosen filter stays selected so the next cursor retains its query', async () => {
  const r = rig(async (path) => {
    if (path.includes('scope=mine'))
      return { total: 0, items: [], types: [{ _id: 'book', count: 1 }], decades: [], next: null };
    return answer('Paper');
  });
  try {
    await tick();
    r.document.getElementById('browseType').value = 'newspaper';
    r.document.getElementById('browseDecade').value = '1930s';
    r.document.getElementById('libraryScope').value = 'mine';
    r.document.getElementById('libraryScope').dispatchEvent(new r.window.Event('change'));
    await tick();
    assert.equal(r.document.getElementById('browseType').value, 'newspaper');
    assert.equal(r.document.getElementById('browseDecade').value, '1930s');
    assert.equal(r.document.getElementById('browseMore').hidden, true);
  } finally {
    r.dom.window.close();
  }
});

test('default view loads one combined shelf with typed filters and optional folders', async () => {
  const requests = [];
  const r = rig(async (path) => {
    requests.push(path);
    return answer('An old broadcast');
  });
  try {
    await tick();
    assert.equal(r.document.querySelectorAll('#browseList').length, 1);
    assert.equal(r.document.getElementById('folderBrowse').open, false);
    assert.ok(requests[0].includes('/browse?'));
    assert.equal(r.document.getElementById('browseType').options[1].textContent, 'Newspapers (2)');
    assert.match(r.document.getElementById('browseList').textContent, /1930s/);
    const ids = [...r.document.querySelectorAll('[id]')].map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    r.dom.window.close();
  }
});

test('filter changes cancel the prior request and a late response cannot replace current results', async () => {
  const pending = [];
  const r = rig(
    (path, options) => new Promise((resolve) => pending.push({ path, options, resolve })),
  );
  try {
    r.document.getElementById('browseKind').value = 'audio';
    r.document.getElementById('browseKind').dispatchEvent(new r.window.Event('change'));
    assert.equal(pending[0].options.signal.aborted, true);
    pending[1].resolve(answer('Current recording'));
    await tick();
    pending[0].resolve(answer('Stale paper'));
    await tick();
    assert.match(r.document.getElementById('browseList').textContent, /Current recording/);
    assert.doesNotMatch(r.document.getElementById('browseList').textContent, /Stale paper/);
  } finally {
    r.dom.window.close();
  }
});

test('more keeps the same query and cursor, appends safely, and places focus on the new item', async () => {
  const requests = [];
  const r = rig(async (path) => {
    requests.push(path);
    return answer(
      requests.length === 1 ? '<First>' : 'Second',
      requests.length === 1 ? 'next-cursor' : null,
    );
  });
  try {
    await tick();
    r.document.getElementById('browseMore').click();
    await tick();
    assert.ok(requests[1].includes('after=next-cursor'));
    assert.equal(r.document.getElementById('browseList').children.length, 2);
    assert.equal(
      r.document.activeElement,
      r.document.getElementById('browseList').children[1].querySelector('button'),
    );
    assert.equal(r.document.querySelectorAll('#browseList first').length, 0);
    assert.equal(r.document.getElementById('browseMore').hidden, true);
  } finally {
    r.dom.window.close();
  }
});
