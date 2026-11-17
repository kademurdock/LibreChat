/* Nov 16 2026: Quality and How closely it follows, for VoxCPM2 and DramaBox (her yes).
 * Run: NODE_PATH=<a node_modules with express and jsdom> node --test api/server/routes/kadeSoundBoothOpenVoicesSettings.nodetest.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ov = require('./kadeSoundBoothOpenVoices');
const { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT } = require('./kadeSoundBoothOpenVoicesPage');

const ALL = { voxcpm: true, ming: true, mingControls: true, chatterbox: true, dramabox: true };
const SCENE = 'An old sailor leans on the rail. "Storm is coming."';

test('the engine list carries settings only for VoxCPM2 and DramaBox, never under controls', () => {
  const list = ov.engineList(ALL);
  const by = Object.fromEntries(list.map((e) => [e.id, e]));
  assert.ok(by.voxcpm.settings.steps && by.voxcpm.settings.cfg);
  assert.ok(by.dramabox.settings.cfg && !by.dramabox.settings.steps);
  assert.equal(by.ming.settings, undefined);
  assert.equal(by.chatterbox.settings, undefined);
  assert.equal(by.voxcpm.controls, undefined, 'an iPhone build reads controls as Ming\'s');
  for (const e of [by.voxcpm, by.dramabox]) {
    for (const s of Object.values(e.settings)) {
      assert.equal(s.options.filter((o) => o.value === '').length, 1, 'one "the usual" choice');
      for (const o of s.options.filter((x) => x.value)) {
        const n = Number(o.value);
        assert.ok(n >= s.range[0] && n <= s.range[1], `${o.label} in range`);
      }
    }
  }
});

test('a take carries the settings its engine has, and refuses the rest plainly', () => {
  const v = ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'A warm voice', text: 'Hi', steps: '30', cfg: '2.5' }, ALL);
  assert.equal(v.body.steps, 30);
  assert.equal(v.body.cfg, 2.5);
  const vs = ov.checkTake({ engine: 'voxcpm', mode: 'speak', voiceId: '7b0000000000000000000001', text: 'Hi', steps: '20' }, ALL);
  assert.equal(vs.body.steps, 20);
  const d = ov.checkTake({ engine: 'dramabox', mode: 'design', text: SCENE, cfg: '3.5' }, ALL);
  assert.equal(d.body.cfg, 3.5);
  assert.equal(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'Hi', steps: '', cfg: '' }, ALL).body.steps, undefined, 'empty is the usual');
  const no = (b) => ov.checkTake(b, ALL);
  assert.deepEqual(no({ engine: 'dramabox', mode: 'design', text: SCENE, steps: '20' }), { error: 'Quality is not a setting DramaBox has. Set it back to the usual.', field: 'steps' });
  assert.equal(no({ engine: 'chatterbox', mode: 'design', text: 'Hi', cfg: '2' }).field, 'cfg');
  assert.equal(no({ engine: 'ming', mode: 'design', description: 'd', text: 'Hi', steps: '20' }).field, 'steps');
  assert.match(no({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'Hi', steps: '12.5' }).error, /Quality must be a whole number from 4 to 50/);
  assert.match(no({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'Hi', cfg: '9' }).error, /How closely it follows must be a number from 0.5 to 5/);
  assert.match(no({ engine: 'dramabox', mode: 'design', text: SCENE, cfg: '11' }).error, /from 1 to 10/);
});

function panel(engines) {
  const { JSDOM } = require('jsdom');
  const sent = [];
  const dom = new JSDOM(`<!doctype html><body><p id="status" role="status"></p>${OPEN_VOICES_HTML}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.getToken = async () => 'tok';
  win.AbortSignal.timeout = () => undefined;
  win.fetch = async (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    if (body) sent.push({ url, body });
    if (url.endsWith('/open-voices')) return { ok: true, status: 200, json: async () => ({ engines, voices: [], coldNote: 'cold' }) };
    return { ok: false, status: 400, json: async () => ({ error: 'Quality is not a setting DramaBox has. Set it back to the usual.', field: 'steps' }) };
  };
  win.eval(OPEN_VOICES_SCRIPT.replace(/^\s*<script>|<\/script>\s*$/g, ''));
  const $ = (id) => win.document.getElementById(id);
  return { w: win, $, sent, close: () => win.close(), ready: async () => { for (let i = 0; i < 40 && $('openVoicesDrawer').hidden; i++) await new Promise((r) => setTimeout(r, 5)); } };
}

test('the panel by DOM: the menus follow the engine, keep a shared choice, and send only what is shown', async () => {
  const p = panel(ov.engineList(ALL));
  const { $, sent } = p;
  await p.ready();
  $('ovEngine').value = 'voxcpm'; $('ovEngine').onchange();
  assert.match($('status').textContent, /VoxCPM2 picked\. Quality and How closely it follows menus are shown\./);
  assert.equal($('ovTuneBox').hidden, false);
  assert.equal($('ovStepsWrap').hidden, false);
  assert.equal($('ovStepsLabel').textContent, 'Quality');
  assert.equal($('ovSteps').value, '', 'starts at the usual');
  assert.deepEqual([...$('ovSteps').options].map((o) => o.textContent), ['The usual, quickest', 'Better, a little slower', 'Best, slower', 'Highest, slowest']);
  $('ovSteps').value = '30'; $('ovCfg').value = '2.5';
  $('ovDescription').value = 'A warm voice'; $('ovText').value = 'Hello.';
  await $('ovMake').onclick();
  const first = sent.filter((s) => s.url.endsWith('/open-voices/take')).at(-1).body;
  assert.equal(first.steps, '30');
  assert.equal(first.cfg, '2.5');
  /* DramaBox: no Quality; the shared "Closer" choice does not exist there, so it goes back to the usual. */
  $('ovEngine').value = 'dramabox'; $('ovEngine').onchange();
  assert.match($('status').textContent, /How closely it follows the scene menu is shown\./);
  assert.equal($('ovStepsWrap').hidden, true);
  assert.equal($('ovCfgLabel').textContent, 'How closely it follows the scene');
  assert.equal($('ovCfg').value, '');
  $('ovCfg').value = '3.5';
  $('ovText').value = SCENE;
  await $('ovMake').onclick();
  const db = sent.filter((s) => s.url.endsWith('/open-voices/take')).at(-1).body;
  assert.equal(db.cfg, '3.5');
  assert.equal(db.steps, undefined, 'a hidden menu is not sent');
  /* Chatterbox and Ming: the menus are hidden and nothing is sent. */
  for (const id of ['chatterbox', 'ming']) {
    $('ovEngine').value = id; $('ovEngine').onchange();
    assert.equal($('ovTuneBox').hidden, true, id);
  }
  $('ovText').value = 'Hi'; $('ovDescription').value = 'd';
  await $('ovMake').onclick();
  const mg = sent.filter((s) => s.url.endsWith('/open-voices/take')).at(-1).body;
  assert.equal(mg.cfg, undefined);
  assert.equal(mg.steps, undefined);
  /* Back to DramaBox: its choice was kept while away. */
  $('ovEngine').value = 'dramabox'; $('ovEngine').onchange();
  assert.equal($('ovCfg').value, '3.5');
  p.close();
});
