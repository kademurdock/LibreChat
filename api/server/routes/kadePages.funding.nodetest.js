'use strict';
/* Part 291 review F29: on the dashboard's Funding card, Remove and Put it back rebuild the list of
 * repayments, which destroyed the button Kade had just pressed and dropped her screen reader to the
 * top of the page. Focus now lands on the rebuilt button for the same entry (which reads the other
 * way round), or on the status line, and the result is said in the status region.
 *
 * The SHIPPED page script is pulled out of dashboardHtml and run against a small fake DOM.
 * Run: node --test api/server/routes/kadePages.funding.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { dashboardHtml } = require('./kadePages');

class El {
  constructor(doc, tag, text = '') {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.own = text;
  }
  set textContent(v) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.own = String(v);
  }
  get textContent() {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  focus() {
    this.doc.activeElement = this;
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n === this.doc.body;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.tagName === sel.toUpperCase()) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function fakeDocument() {
  const doc = { activeElement: null };
  doc.body = new El(doc, 'body');
  doc.activeElement = doc.body;
  const byId = {};
  for (const [id, tag] of [
    ['rp_list', 'ul'],
    ['rp_empty', 'p'],
    ['rp_status', 'p'],
    ['fund_line', 'p'],
    ['fund_people', 'dl'],
  ]) {
    byId[id] = doc.body.appendChild(new El(doc, tag));
    byId[id].id = id;
  }
  doc.getElementById = (id) => byId[id] || null;
  doc.createElement = (tag) => new El(doc, tag);
  doc.createTextNode = (text) => new El(doc, '#text', text);
  return doc;
}

const SRC = (() => {
  const a = dashboardHtml.indexOf('function fundKey()');
  const b = dashboardHtml.indexOf("(function(){\n        var sel = document.getElementById('rp_user');");
  assert.ok(a > 0 && b > a, 'the Funding card script is still in dashboardHtml');
  return dashboardHtml.slice(a, b);
})();

const entry = (id, voided) => ({ id, usd: 30, name: 'Holly', at: '2026-09-25T17:00:00Z', note: '', voidedAt: voided ? '2026-09-25T18:00:00Z' : null });

function harness({ ledgers, post = { ok: true, body: { spoken: 'Holly is even.' } } }) {
  const document = fakeDocument();
  const posts = [];
  let ledgerCall = 0;
  const context = {
    document,
    window: { confirm: () => true },
    token: 't',
    money: (n) => '$' + Number(n || 0).toFixed(2),
    apiGet: async (url) => {
      if (url.endsWith('/funding/people')) return { ok: true, json: async () => ({ spoken: 'People.', people: [] }) };
      const next = ledgers[Math.min(ledgerCall++, ledgers.length - 1)];
      return next ? { ok: true, json: async () => ({ entries: next }) } : { ok: false, json: async () => ({}) };
    },
    apiPost: async (url) => {
      posts.push(url);
      return { ok: post.ok, json: async () => post.body };
    },
    Date,
    Math,
    String,
    encodeURIComponent,
  };
  vm.createContext(context);
  vm.runInContext(`${SRC}\nthis.loadFunding = loadFunding;`, context);
  const buttons = () => document.getElementById('rp_list').querySelectorAll('button');
  const press = async (b) => {
    b.focus();
    for (const fn of b.listeners.click) await fn();
  };
  return { context, document, posts, buttons, press };
}

test('Remove: focus lands on the rebuilt "Put it back" button for the same entry, and the result is announced', async () => {
  const h = harness({ ledgers: [[entry('e1'), entry('e2')], [entry('e1', true), entry('e2')]] });
  await h.context.loadFunding();
  const [remove] = h.buttons();
  assert.equal(remove.textContent, 'Remove');
  await h.press(remove);
  assert.equal(h.posts[0], '/api/kade/funding/repayments/e1/void');
  assert.equal(remove.isConnected, false, 'the pressed button was rebuilt away');
  const focused = h.document.activeElement;
  assert.equal(focused.isConnected, true, 'focus is on the page, not lost with the old button');
  assert.equal(focused.dataset.id, 'e1');
  assert.equal(focused.textContent, 'Put it back');
  assert.match(focused.getAttribute('aria-label'), /^Put back \$30\.00 from Holly/);
  assert.equal(h.document.getElementById('rp_status').textContent, 'Removed. Holly is even.');
});

test('Put it back: focus lands on the rebuilt "Remove" button for the same entry', async () => {
  const h = harness({ ledgers: [[entry('e1'), entry('e2', true)], [entry('e1'), entry('e2')]], post: { ok: true, body: { spoken: '' } } });
  await h.context.loadFunding();
  const putBack = h.buttons()[1];
  assert.equal(putBack.textContent, 'Put it back');
  await h.press(putBack);
  assert.equal(h.posts[0], '/api/kade/funding/repayments/e2/restore');
  assert.equal(h.document.activeElement.dataset.id, 'e2');
  assert.equal(h.document.activeElement.textContent, 'Remove');
  assert.equal(h.document.activeElement.isConnected, true);
  assert.equal(h.document.getElementById('rp_status').textContent, 'Put back. ');
});

test('if the list does not come back, focus goes to the status line, which says what happened', async () => {
  const h = harness({ ledgers: [[entry('e1')], null], post: { ok: false, body: { error: 'That entry is gone.' } } });
  await h.context.loadFunding();
  await h.press(h.buttons()[0]);
  const status = h.document.getElementById('rp_status');
  assert.equal(h.document.activeElement, status);
  assert.equal(status.textContent, 'That entry is gone.');
});

test('the status line can take focus without joining the Tab order', () => {
  assert.match(dashboardHtml, /<p id="rp_status" role="status" aria-live="polite" tabindex="-1"/);
});
