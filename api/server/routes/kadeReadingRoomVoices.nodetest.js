'use strict';
/* The web Reading Room's voice list (Oct 16 2026): a book saved under a voice's old
 * name shows that voice under its new name, through the catalog's renames.
 * Run: node --test api/server/routes/kadeReadingRoomVoices.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function pageScript() {
  const context = {
    require: () => ({ SHARED_HEAD: '', librarianGuide: { chatUrl: '/c/new' } }),
    module: { exports: {} },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomPage'), 'utf8'), context);
  const html = context.module.exports.readingRoomHtml;
  const start = html.indexOf('  async function loadVoices(){');
  const end = html.indexOf("  /* the library's eyes */", start);
  assert.ok(start > 0 && end > start, 'loadVoices is in the page');
  return html.slice(start, end);
}

/** Runs the page's loadVoices against a catalog with a stored voice; returns the select. */
async function load(voice, catalog) {
  const sel = {
    options: [],
    value: '',
    set innerHTML(_) {
      sel.options = [];
    },
    appendChild(group) {
      sel.options.push(...group.options);
    },
    insertBefore(option) {
      sel.options.unshift(option);
    },
  };
  const document = {
    createElement: (tag) =>
      tag === 'optgroup'
        ? {
            options: [],
            children: [],
            appendChild(o) {
              this.options.push(o);
              this.children.push(o);
            },
          }
        : { value: '', textContent: '' },
  };
  const context = {
    voice,
    document,
    TTS_BASE: 'https://tts.example.invalid',
    $: () => sel,
    fetch: async () => ({ json: async () => catalog }),
  };
  vm.runInNewContext(pageScript(), context);
  await vm.runInNewContext('loadVoices()', context);
  return sel;
}

const catalog = {
  categories: [{ name: 'Warm', voices: ['Ember Field', 'River Low'] }],
  hidden: ['Holly Hawkins'],
  renames: { 'Holly Hawkins': 'Ember Field' },
  describe: { 'Ember Field': 'warm and low' },
};

test('a voice saved under its old name is shown under its new one', async () => {
  const sel = await load('Holly Hawkins', catalog);
  assert.equal(sel.value, 'Ember Field');
  assert.deepEqual(
    sel.options.map((o) => o.value),
    ['Ember Field', 'River Low'],
    'no raw old name is added to the list',
  );
});

test('a listed voice, an unknown name and a missing catalog keep the old behaviour', async () => {
  assert.equal((await load('River Low', catalog)).value, 'River Low');
  const unknown = await load('Someone Else', catalog);
  assert.equal(unknown.value, 'Someone Else');
  assert.equal(unknown.options[0].value, 'Someone Else', 'still shown as written, at the top');
  const offline = await load('Holly Hawkins', null);
  assert.equal(offline.value, 'Holly Hawkins');
  assert.equal(offline.options.length, 1);
  const noRenames = await load('Holly Hawkins', { ...catalog, renames: undefined });
  assert.equal(noRenames.value, 'Holly Hawkins');
});
