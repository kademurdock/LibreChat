/* Open voices' script writer (Nov 16 2026): Write it for me and Format my words for VoxCPM2, Ming,
 * Chatterbox and DramaBox, each in its own format. The desk call is a fake; nothing is called for real.
 *
 * Run: node --test api/server/routes/kadeSoundBoothOpenVoicesWriter.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ov = require('./kadeSoundBoothOpenVoices');
const w = require('./kadeSoundBoothOpenVoicesWriter');
const { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT } = require('./kadeSoundBoothOpenVoicesPage');

const READY = { voxcpm: true, ming: true, mingControls: true, chatterbox: true, dramabox: true };

async function boot(t, reply, ready = READY) {
  const asked = [];
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
  app.use(ov.createOpenVoicesRouter({
    auth: (_req, _res, next) => next(), http: {}, bridgeBase: () => 'https://bridge.test', readiness: async () => ready,
    KadeAsset: {}, fresh: async (u) => u, references: () => ({}),
    write: reply === undefined ? undefined : async (a) => { asked.push(a); return typeof reply === 'function' ? reply(a) : reply; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body) => {
    const r = await fetch(base + '/open-voices/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, asked };
}

test('each engine is told its own format', () => {
  const db = w.writerRequest({ engine: 'dramabox', mode: 'design', how: 'write', idea: 'a sailor in a storm', duration: '20' });
  assert.match(db.system, /double quotes/);
  assert.match(db.system, /background/);
  assert.match(db.system, /about 48 spoken words/);
  assert.doesNotMatch(db.system, /VOICE:/);
  const turbo = w.writerRequest({ engine: 'chatterbox', version: 'turbo', how: 'write', idea: 'a funny dog story' });
  assert.match(turbo.system, /\[laugh\]/);
  const multi = w.writerRequest({ engine: 'chatterbox', version: 'multilingual', languageName: 'French', how: 'write', idea: 'a weather report' });
  assert.match(multi.system, /never write square brackets/);
  assert.match(multi.system, /in French/);
  const vox = w.writerRequest({ engine: 'voxcpm', mode: 'design', how: 'write', idea: 'a bedtime story' });
  assert.match(vox.system, /VOICE:/);
  assert.equal(vox.askVoice, true);
  const voxHas = w.writerRequest({ engine: 'voxcpm', mode: 'design', how: 'write', idea: 'a bedtime story', description: 'an old man' });
  assert.equal(voxHas.askVoice, false);
  assert.match(voxHas.user, /THE VOICE: an old man/);
  const mingBuiltin = w.writerRequest({ engine: 'ming', mode: 'design', how: 'write', idea: 'hello', builtin: true, builtinName: 'Emma' });
  assert.equal(mingBuiltin.askVoice, false);
  const fmt = w.writerRequest({ engine: 'dramabox', how: 'format', words: 'Hello there. Storm is coming.' });
  assert.match(fmt.system, /Keep every one of their words/);
  assert.match(fmt.user, /THEIR WORDS:\nHello there/);
  assert.equal(w.writerRequest({ engine: 'voxcpm', how: 'write', idea: ' ' }).field, 'idea');
  assert.equal(w.writerRequest({ engine: 'voxcpm', how: 'format', words: '' }).field, 'text');
});

test('replies are cleaned for the engine that reads them', () => {
  const shape = (b) => w.engineShape(b);
  const db = w.parseWriterReply('```\nWORDS:\nAn old sailor leans on the rail. “Storm’s coming.” Rain drums on the roof.\n```', { engine: 'dramabox', shape: shape({ engine: 'dramabox' }) });
  assert.equal(db.text, 'An old sailor leans on the rail. "Storm’s coming." Rain drums on the roof.');
  assert.ok(w.parseWriterReply('WORDS:\nHe stands there quietly.', { engine: 'dramabox', shape: shape({ engine: 'dramabox' }) }).error);
  const turbo = w.parseWriterReply('WORDS:\nSo the dog [Laugh] ran off [applause] again.', { engine: 'chatterbox', version: 'turbo', shape: shape({ engine: 'chatterbox' }) });
  assert.equal(turbo.text, 'So the dog [laugh] ran off again.');
  const orig = w.parseWriterReply('WORDS:\nWell [sigh] here we go.', { engine: 'chatterbox', version: 'original', shape: shape({ engine: 'chatterbox', version: 'original' }) });
  assert.equal(orig.text, 'Well here we go.');
  const vox = w.parseWriterReply('VOICE: A warm grandmother, slow and soft.\nWORDS:\n*Smiles* Once upon a time...', { engine: 'voxcpm', how: 'write', askVoice: true, shape: shape({ engine: 'voxcpm', mode: 'design' }) });
  assert.equal(vox.text, 'Smiles Once upon a time...');
  assert.equal(vox.voice, 'A warm grandmother, slow and soft.');
  const noAsk = w.parseWriterReply('VOICE: x\nWORDS:\nHi.', { engine: 'voxcpm', askVoice: false, shape: shape({ engine: 'voxcpm' }) });
  assert.equal(noAsk.voice, '');
  assert.ok(w.parseWriterReply("I'm sorry, but I can't write that.", { engine: 'voxcpm', shape: shape({ engine: 'voxcpm' }) }).error);
  assert.ok(w.parseWriterReply('', { engine: 'voxcpm', shape: shape({ engine: 'voxcpm' }) }).error);
  const marked = w.parseWriterReply("WORDS:\n%%%cheerful friendly%%% Hi y'all, it's seven thirty.", { engine: 'ming', how: 'format', shape: shape({ engine: 'ming' }) });
  assert.equal(marked.text, "Hi y'all, it's seven thirty.");
  assert.match(w.writerRequest({ engine: 'voxcpm', how: 'write', idea: 'a story' }).system, /about 20 to 60 seconds/);
});

test('the route writes, formats and refuses in plain sentences', async (t) => {
  const { call, asked } = await boot(t, { text: 'VOICE: A cheerful young woman.\nWORDS:\nGood morning, everyone!' });
  const ok = await call({ engine: 'voxcpm', mode: 'design', how: 'write', idea: 'a radio host saying good morning' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.text, 'Good morning, everyone!');
  assert.equal(ok.body.voice, 'A cheerful young woman.');
  assert.match(ok.body.spoken, /Written for VoxCPM2\. It is in Words to say\. A voice description was added too/);
  assert.equal(asked[0].engine, 'voxcpm');
  const cb = await call({ engine: 'chatterbox', version: 'multilingual', language_id: 'fr', how: 'write', idea: 'a greeting' });
  assert.equal(cb.status, 200);
  assert.match(asked[1].system, /in French/);
  const ming = await call({ engine: 'ming', mode: 'design', voice: 'US_Emma', how: 'write', idea: 'a greeting' });
  assert.equal(ming.status, 200);
  assert.match(asked[2].user, /Emma, American English, woman/);
  const empty = await call({ engine: 'dramabox', how: 'write', idea: '' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.field, 'idea');
  const bad = await call({ engine: 'nope', how: 'write', idea: 'hello there' });
  assert.equal(bad.body.field, 'engine');
  assert.equal(asked.length, 3);
});

test('a hidden engine, a capped desk and a missing writer are refused', async (t) => {
  const off = await boot(t, { text: 'WORDS:\nHi.' }, { ...READY, dramabox: false });
  assert.equal((await off.call({ engine: 'dramabox', how: 'write', idea: 'a scene' })).status, 400);
  const capped = await boot(t, { status: 429, error: 'That is 40 scripts today.' });
  assert.equal((await capped.call({ engine: 'voxcpm', how: 'write', idea: 'a scene' })).status, 429);
  const none = await boot(t, undefined);
  assert.equal((await none.call({ engine: 'voxcpm', how: 'write', idea: 'a scene' })).status, 503);
  const boom = await boot(t, () => { throw new Error('gateway down'); });
  const b = await boom.call({ engine: 'voxcpm', how: 'write', idea: 'a scene' });
  assert.equal(b.status, 502);
  assert.match(b.body.error, /Your idea is kept/);
});

test('the page has the writer, labelled, with put-back', () => {
  for (const id of ['ovWriterBox', 'ovIdea', 'ovIdeaHint', 'ovWrite', 'ovFormat', 'ovUndoWrite']) assert.ok(OPEN_VOICES_HTML.includes(`id="${id}"`), id);
  assert.match(OPEN_VOICES_HTML, /<label class="field" for="ovIdea">/);
  assert.ok(OPEN_VOICES_HTML.indexOf('id="ovWriterBox"') < OPEN_VOICES_HTML.indexOf('id="ovText"'));
  assert.match(OPEN_VOICES_SCRIPT, /\/open-voices\/write/);
  assert.match(OPEN_VOICES_SCRIPT, /ovUndoWrite/);
  assert.doesNotMatch(OPEN_VOICES_SCRIPT, /\$\{/);
});

const ALL = READY;
function panel(engines, answer) {
  const { JSDOM } = require('jsdom');
  const sent = [];
  const dom = new JSDOM(`<!doctype html><body><p id="status" role="status"></p>${OPEN_VOICES_HTML}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.getToken = async () => 'tok';
  win.AbortSignal.timeout = () => undefined;
  const realSet = win.setTimeout.bind(win); win.setTimeout = (fn, ms) => realSet(fn, ms === 3000 ? 1 : ms);
  win.fetch = async (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    if (body) sent.push({ url, body });
    if (url.endsWith('/open-voices')) return { ok: true, status: 200, json: async () => ({ engines, voices: [{ id: '7b0000000000000000000001', name: 'Grandpa', seconds: 8 }], coldNote: 'cold' }) };
    const a = answer(url, body);
    return { ok: !a.error, status: a.error ? (a.status || 400) : 200, json: async () => a };
  };
  win.eval(OPEN_VOICES_SCRIPT.replace(/^\s*<script>|<\/script>\s*$/g, ''));
  const $ = (id) => win.document.getElementById(id);
  return { w: win, $, sent, close: () => win.close(), ready: async () => { for (let i = 0; i < 40 && $('openVoicesDrawer').hidden; i++) await new Promise((r) => setTimeout(r, 5)); } };
}

test('the panel by DOM: Write it for me fills the words in the engine\'s format, Put back restores them', async () => {
  let answer = { text: 'An old sailor leans on the rail. "Storm\'s coming."', voice: '', spoken: 'Written for DramaBox. It is in Scene. Read it over, then Make a take.' };
  const p = panel(ov.engineList(ALL), () => answer);
  const { $, w, sent } = p;
  await p.ready();
  $('ovEngine').value = 'dramabox'; $('ovEngine').onchange();
  assert.match($('ovIdeaHint').textContent, /quotes, and the acting and background sounds/);
  await $('ovWrite').onclick();
  assert.match($('status').textContent, /Type what it should say/);
  assert.equal(w.document.activeElement, $('ovIdea'));
  assert.equal(sent.filter((s) => s.url.endsWith('/write')).length, 0);
  $('ovIdea').value = 'a sailor saying goodbye in a storm';
  $('ovText').value = 'my old words';
  $('ovDuration').value = '20';
  $('ovWrite').onclick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.at(-1).body, { engine: 'dramabox', mode: 'design', how: 'write', idea: 'a sailor saying goodbye in a storm', words: 'my old words', duration: '20' });
  assert.equal($('ovText').value, answer.text);
  assert.equal($('status').textContent, answer.spoken);
  assert.equal(w.document.activeElement, $('ovText'));
  assert.equal($('ovUndoWrite').hidden, false);
  $('ovUndoWrite').onclick();
  assert.equal($('ovText').value, 'my old words');
  assert.equal($('ovUndoWrite').hidden, true);
  /* VoxCPM2 in Design a voice: an empty description is filled with the writer's; a typed one is kept. */
  $('ovEngine').value = 'voxcpm'; $('ovEngine').onchange();
  assert.match($('ovIdeaHint').textContent, /and a voice description if yours is empty/);
  answer = { text: 'Good morning!', voice: 'A cheerful young woman.', spoken: 'ok' };
  $('ovFormat').onclick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.at(-1).body.how, 'format');
  assert.equal(sent.at(-1).body.description, '');
  assert.equal($('ovDescription').value, 'A cheerful young woman.');
  $('ovDescription').value = 'mine';
  $('ovWrite').onclick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal($('ovDescription').value, 'mine');
  /* Chatterbox Multilingual sends its version and language; a refusal is said. */
  $('ovEngine').value = 'chatterbox'; $('ovEngine').onchange();
  $('ovVersion').value = 'multilingual'; $('ovVersion').onchange();
  $('ovCbLanguage').value = 'fr';
  answer = { error: "That's 40 scripts today. The writing desk reopens tomorrow.", status: 429 };
  $('ovWrite').onclick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.at(-1).body.version, 'multilingual');
  assert.equal(sent.at(-1).body.language_id, 'fr');
  assert.match($('status').textContent, /40 scripts today/);
  assert.equal($('ovWrite').getAttribute('aria-disabled'), null);
  p.close();
});

test('the panel by DOM: Takes per press makes takes one after another, and each take and saved voice downloads', async () => {
  let n = 0;
  const p = panel(ov.engineList(ALL), (url, body) => {
    if (url.endsWith('/open-voices/take')) { n += 1; return { ok: true, jobId: 'ov_queue0000' + n, coldLikely: false }; }
    const m = url.match(/take\/(ov_queue0000\d)/);
    if (m) return { state: 'done', engine: 'dramabox', url: 'https://b2.test/' + m[1] + '.mp3', seed: 100 + Number(m[1].slice(-1)), seconds: 9, assetId: '7b000000000000000000000' + m[1].slice(-1) };
    return {};
  });
  const { $, w, sent } = p;
  const got = [];
  const inner = w.fetch;
  w.fetch = async (url, o) => {
    if (url.includes('/asset-download/')) { got.push(url); return { ok: true, status: 200, blob: async () => ({ type: 'audio/mpeg' }) }; }
    return inner(url, o);
  };
  const clicked = [];
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { clicked.push(this.download); };
  await p.ready();
  $('ovEngine').value = 'dramabox'; $('ovEngine').onchange();
  $('ovText').value = 'She smiles. "Hello."';
  $('ovSeed').value = '50';
  $('ovCount').value = '3';
  await $('ovMake').onclick();
  for (let i = 0; i < 100 && $('ovTakes').children.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  const takes = sent.filter((s) => s.url.endsWith('/open-voices/take'));
  assert.deepEqual(takes.map((s) => s.body.seed), ['50', '51', '52']);
  assert.equal($('ovTakes').children.length, 3);
  assert.match($('status').textContent, /Take 3 is ready, the last of 3\. Play it, download it/);
  assert.equal($('ovStop').hidden, true);
  const btn = [...$('ovTakes').querySelectorAll('button')].find((b) => b.textContent === 'Download take 3');
  await btn.onclick();
  assert.match(got.at(-1), /asset-download\/7b0000000000000000000003$/);
  assert.equal(clicked.at(-1), 'DramaBox take 3 voice 103.mp3', $('status').textContent + ' ' + clicked.length);
  assert.match($('status').textContent, /Saved DramaBox take 3 voice 103\.mp3 to your downloads/);
  $('ovModeSpeak').onclick();
  assert.equal($('ovDownloadVoice').hidden, false);
  assert.equal($('ovDownloadVoice').textContent, 'Download Grandpa');
  await $('ovDownloadVoice').onclick();
  assert.match(got.at(-1), /asset-download\/7b0000000000000000000001$/);
  assert.equal(clicked.at(-1), 'Grandpa.mp3');
  p.close();
});
