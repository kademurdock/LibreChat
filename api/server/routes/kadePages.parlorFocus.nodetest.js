'use strict';
/* WEB-6: at a Parlor party table the 2.5 second poll called renderTable, which always moved focus to
 * the status line, so a screen-reader player typing table talk lost the box whenever someone else
 * moved. The status line was also a live region while the narrator voice said the same events.
 *
 * The SHIPPED page script is pulled out of parlorHtml and run against a small fake DOM.
 * Run: node --test api/server/routes/kadePages.parlorFocus.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parlorHtml } = require('./kadePages');

class El {
  constructor(doc, tag) {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.text = '';
  }
  set textContent(v) {
    this.children = [];
    this.text = String(v);
  }
  get textContent() {
    return this.text;
  }
  set innerHTML(html) {
    this.children = [];
    const re = /<button[^>]*?(?: data-move="([^"]*)")?>/g;
    let m;
    while ((m = re.exec(html))) {
      const b = new El(this.doc, 'button');
      if (m[1] != null) b.attrs['data-move'] = m[1];
      b.parent = this;
      this.children.push(b);
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  contains(n) {
    return n === this || this.children.includes(n);
  }
  querySelectorAll() {
    return this.children.slice();
  }
  querySelector() {
    return this.children[0] || null;
  }
  focus() {
    this.doc.activeElement = this;
  }
}

function slice(from, to) {
  const a = parlorHtml.indexOf(from);
  const b = parlorHtml.indexOf(to, a);
  assert.ok(a > 0 && b > a, 'the Parlor script still has: ' + from);
  return parlorHtml.slice(a, b);
}
const SPEECH = slice('const speaker = new Audio();', 'function stopSpeech()');
const TABLE = slice('function narrate(logLines){', "$('tmoves').addEventListener('click'");

function harness({ mode = 'events', play = async () => {} } = {}) {
  const doc = { activeElement: null, listeners: {} };
  const byId = {};
  for (const id of [
    'tstatus',
    'tsay',
    'tlines',
    'moves-h',
    'tmoves',
    'talk-input',
    'ttitle',
    'talk-card',
    'status',
  ])
    byId[id] = new El(doc, 'div');
  doc.getElementById = (id) => byId[id] || null;
  doc.createElement = () => new El(doc, 'div');
  doc.addEventListener = (t, fn) => {
    doc.listeners[t] = fn;
  };
  doc.removeEventListener = (t) => {
    delete doc.listeners[t];
  };
  const fetches = [];
  const speaker = { play, pause() {} };
  const context = {
    document: doc,
    Audio: function () {
      return speaker;
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    fetch: async (url, opts) => {
      fetches.push(JSON.parse(opts.body).input);
      return { ok: true, blob: async () => ({}) };
    },
    JSON,
    Array,
    Object,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(
    "const $ = (id) => document.getElementById(id); const status = $('status'); const token = 't';\n" +
      'let table = null; let historyCursor = 0; let narrator = { voice: "Voice 466", mode: ' +
      JSON.stringify(mode) +
      ' };\n' +
      'function esc(s){ return String(s == null ? "" : s); } function show(){} function playCues(){}\n' +
      'function startPartyPolling(){} function stopPartyPolling(){}\n' +
      SPEECH +
      '\n' +
      TABLE +
      '\nthis.renderTable = renderTable; this.openTable = openTable; this.speak = speak;',
    context,
  );
  return { doc, byId, fetches, context };
}

const payload = (extra) =>
  Object.assign(
    {
      gameId: 'g1',
      name: 'Hearts',
      party: true,
      yourTurn: false,
      over: false,
      names: ['Kade', 'Holly'],
      turnSeat: 1,
      lines: ['Hearts.'],
      legal: [],
      log: [],
    },
    extra,
  );
const settle = () => new Promise((r) => setTimeout(r, 5));

test('a poll never pulls focus out of the table-talk box', () => {
  const h = harness();
  h.byId['talk-input'].focus();
  h.context.renderTable(
    payload({
      log: ['Holly plays the two of clubs.'],
      yourTurn: true,
      legal: [{ token: 'c3', label: 'Three of clubs' }],
    }),
    null,
    false,
  );
  assert.equal(h.doc.activeElement, h.byId['talk-input']);
});

test('a poll puts focus back on the same move button after the buttons are rebuilt', () => {
  const h = harness();
  const legal = [
    { token: 'c3', label: 'Three of clubs' },
    { token: 'c9', label: 'Nine of clubs' },
  ];
  h.context.renderTable(payload({ yourTurn: true, legal }), null, false);
  const old = h.byId.tmoves.children[1];
  old.focus();
  h.context.renderTable(
    payload({ yourTurn: true, legal, log: ['Holly says: nice one'] }),
    null,
    false,
  );
  assert.notEqual(h.doc.activeElement, old);
  assert.equal(h.doc.activeElement.getAttribute('data-move'), 'c9');
  assert.equal(h.byId.tmoves.contains(h.doc.activeElement), true);
});

test('her own move moves focus: the moves heading with the narrator on, the status line with it off', () => {
  const on = harness();
  on.context.renderTable(payload({ log: ['You play the three of clubs.'] }), null, true);
  assert.equal(on.doc.activeElement, on.byId['moves-h']);
  const off = harness({ mode: 'off' });
  off.context.renderTable(payload({ log: ['You play the three of clubs.'] }), null, true);
  assert.equal(off.doc.activeElement, off.byId.tstatus);
});

test('narrator on: the status line is not live, and only what the voice skips reaches the screen reader', async () => {
  const h = harness();
  h.context.openTable(
    payload({ log: ['Holly plays the two of clubs.', 'Holly says: your turn, slowpoke'] }),
    false,
  );
  await settle();
  assert.equal(h.byId.tstatus.getAttribute('aria-live'), 'off');
  assert.deepEqual(h.fetches, ['Holly plays the two of clubs.']);
  assert.equal(h.byId.tsay.textContent, 'Holly says: your turn, slowpoke');
  h.context.renderTable(payload({ over: true }), [''], false);
  assert.equal(h.byId.tsay.textContent, 'Game over.');
});

test('narrator off: the status line stays a live region and nothing is voiced', async () => {
  const h = harness({ mode: 'off' });
  h.context.openTable(payload({ log: ['Holly plays the two of clubs.'] }), false);
  await settle();
  assert.equal(h.byId.tstatus.getAttribute('aria-live'), 'polite');
  assert.equal(h.byId.tstatus.textContent, 'Holly plays the two of clubs.');
  assert.deepEqual(h.fetches, []);
  assert.equal(h.byId.tsay.textContent, '');
});

test('a blocked narrator is said so once, the words go to the screen reader, and no more clips are bought until a gesture', async () => {
  const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
  let allow = false;
  const h = harness({
    play: async () => {
      if (!allow) throw blocked;
    },
  });
  h.context.speak('Holly plays the two of clubs.');
  await settle();
  assert.match(h.byId.status.textContent, /blocked the narrator voice/);
  assert.equal(h.byId.tsay.textContent, 'Holly plays the two of clubs.');
  h.context.speak('Kade takes the trick.');
  await settle();
  assert.equal(h.fetches.length, 1, 'no clip is fetched while the browser is refusing the voice');
  assert.equal(h.byId.tsay.textContent, 'Kade takes the trick.');
  allow = true;
  assert.equal(typeof h.doc.listeners.click, 'function', 'a screen-reader click re-arms the voice');
  h.doc.listeners.click();
  await settle();
  h.context.speak('Holly leads a heart.');
  await settle();
  assert.equal(h.fetches.length, 2);
  assert.equal(h.doc.listeners.click, undefined, 'disarmed once a clip really played');
});

test('the whole Parlor page script parses (a bare backslash-n in the template once broke it)', () => {
  const a = parlorHtml.indexOf('<script>', parlorHtml.indexOf('<section id="table"'));
  const b = parlorHtml.indexOf('</script>', a);
  assert.ok(a > 0 && b > a);
  assert.doesNotThrow(() => new vm.Script(parlorHtml.slice(a + 8, b)));
});

test('the page has the hooks the script needs', () => {
  assert.match(parlorHtml, /id="moves-h" tabindex="-1"/);
  assert.match(parlorHtml, /<div id="tsay" role="status" aria-live="polite"/);
});
