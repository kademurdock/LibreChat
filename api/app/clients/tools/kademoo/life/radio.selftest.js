'use strict';
/* Part 180 (Sep 11 2026) — the Band on the air, the pure half.
 *
 * Loads life/radio.js and life/index.js's child-gate table with every
 * dependency stubbed (no Mongo, no network) and proves the parts that do not
 * need either: the schedule on the world clock, the writer's JSON → script,
 * Seed Audio's 2048-character cap, the proxy's [[voice]] scene shape, the
 * daily allowance arithmetic, and that a child seat's verbs answer with an
 * in-world line that never says the word "restricted".
 *
 *   node --test api/app/clients/tools/kademoo/life/radio.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadRadio() {
  const module = { exports: {} };
  const file = path.join(__dirname, 'radio.js');
  const localRequire = (name) => {
    if (name === 'axios') return { post: async () => { throw new Error('no network in the test'); }, get: async () => { throw new Error('no network in the test'); } };
    if (name === './ctx') return {
      MooRoom: {}, MooChar: {}, MooDistrict: {}, logger: { info() {}, warn() {}, error() {} },
      worldClock: () => ({ h: 20, m: 15, dayKey: '2026-09-11', weekday: 'Fri', dark: true, bucket: 'evening' }),
      pick: (a) => a[0],
    };
    if (name === '~/models/kadeMooLife') return { MooRumor: {}, MooBoard: {} };
    if (name === '~/models/kadeMooRadio') return { MooRadio: {} };
    if (name === '../reverie') return { weatherNow: () => ({ line: 'Clear and cool.' }), CENSUS_BY_ID: {}, npcDoingNow: () => null };
    throw new Error('unexpected require in test: ' + name);
  };
  const code = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(`(function (require, module, exports, __dirname, process, Buffer) {${code}\n})`, { console, Date, Math, JSON, String, Number, Array, Object, RegExp, Set, Map, Error, Promise, setTimeout, clearTimeout })(localRequire, module, module.exports, __dirname, { env: {} }, Buffer);
  return module.exports;
}

/** The child gate table lives in index.js; lift it out with a regex so the
 *  whole engine (Mongo, forty verbs) is not loaded to read eight lines. */
function loadKidQuiet() {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const m = /const KID_QUIET = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(m, 'KID_QUIET table present in index.js');
  const table = vm.runInNewContext('({' + m[1] + '\n})');
  const fnSrc = /function kidQuietLine\(verbName\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fnSrc, 'kidQuietLine present');
  const kidQuietLine = vm.runInNewContext('(' + fnSrc[0] + ')', { KID_QUIET: table, String });
  return { KID_QUIET: table, kidQuietLine };
}

test('the schedule follows the world clock, and the night block belongs to the day it started', () => {
  const r = loadRadio();
  assert.equal(r.slotFor({ h: 6 }).key, 'morning');
  assert.equal(r.slotFor({ h: 12 }).key, 'day');
  assert.equal(r.slotFor({ h: 19 }).key, 'evening');
  assert.equal(r.slotFor({ h: 23 }).key, 'night');
  assert.equal(r.slotFor({ h: 2 }).key, 'night');
  assert.equal(r.slotFor({ h: 5 }).key, 'morning');
  assert.equal(r.slotKey({ h: 2, dayKey: '2026-09-12' }, r.slotFor({ h: 2 })), '2026-09-11_night');
  assert.equal(r.slotKey({ h: 23, dayKey: '2026-09-11' }, r.slotFor({ h: 23 })), '2026-09-11_night');
  assert.equal(r.slotKey({ h: 9, dayKey: '2026-09-11' }, r.slotFor({ h: 9 })), '2026-09-11_morning');
  assert.equal(r.shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(r.HOSTS[r.slotFor({ h: 1 }).host].name, 'Lorraine Vance');
});

test('the writer prompt carries the city laws, the schedule shape, and today\'s ingredients', () => {
  const r = loadRadio();
  const p = r.writerPrompt(r.SLOTS[0], { clock: { h: 7, m: 5, weekday: 'Sat' }, weather: 'Rain, steady.', rumors: ['somebody left a whole ham'], hangouts: ['a cookout at the Pier'], boards: ['bowling: Sky holds it with 212'], citizens: ['Pat — at Pat’s Diner, pouring coffee'], players: ['Sky, last seen at the Pier'], songs: ['a slow one about the ferry'] });
  for (const must of ['Harlan Pike', 'nobody dies', '11:40', 'the Veil', 'mixed-age', 'Rain, steady.', 'whole ham', 'cookout at the Pier', 'Sky holds it', 'Pat —', 'a slow one about the ferry', 'JSON']) assert.ok(p.includes(must), 'prompt mentions ' + must);
  assert.ok(!/Little Ray sells/.test(p));
});

test('parseScript takes the writer\'s JSON, fenced or bare, and refuses junk', () => {
  const r = loadRadio();
  const good = '```json\n{"title":"Rain on the Tide","setting":"a small studio","lines":[{"speaker":"Harlan Pike","traits":"x","manner":"dry","text":"Good morning, Reverie. It is raining, which the harbor already knew."},{"speaker":"Pat","traits":"woman, sixties","manner":"over the phone","text":"Coffee is on. It is bad. Come anyway."},{"speaker":"Harlan Pike","traits":"x","manner":"","text":"That was Pat. Here is something slow."}],"outro":"the needle drops"}\n```';
  const s = r.parseScript(good);
  assert.ok(s);
  assert.equal(s.title, 'Rain on the Tide');
  assert.equal(s.lines.length, 3);
  assert.equal(s.lines[1].speaker, 'Pat');
  assert.equal(r.parseScript('not json at all'), null);
  assert.equal(r.parseScript('{"title":"x","lines":[{"speaker":"a","text":"one"}]}'), null, 'fewer than three lines is not a block');
  assert.equal(r.parseScript('{"lines":"nope"}'), null);
});

test('the Seed script stays under the engine\'s 2048-character cap by dropping lines from the end', () => {
  const r = loadRadio();
  const lines = [];
  for (let i = 0; i < 14; i++) lines.push({ speaker: i % 2 ? 'Pat' : 'Harlan Pike', traits: 'a voice with a lot of description in it, the kind the writer likes', manner: 'evenly', text: 'This is a line of radio that runs on for a while so that the block is longer than the engine allows, line number ' + i + '.' });
  const { text, linesUsed } = r.seedScript({ setting: 'a studio, rain on the roof "pat-pat", a coffee pour', outro: 'the jingle, fading', lines });
  assert.ok(text.length <= 2048, 'under cap: ' + text.length);
  assert.ok(linesUsed < 14 && linesUsed >= 3, 'dropped from the end: ' + linesUsed);
  assert.ok(text.startsWith('[Setting:'));
  assert.ok(text.includes('Harlan Pike (a voice'));
  assert.ok(text.trim().endsWith('[the jingle, fading]'));
});

test('the proxy scene script tags every speaker with a voice label, the host first, callers from the fixed cast', () => {
  const r = loadRadio();
  const slot = r.SLOTS[3]; // night — Lorraine
  const { text, baseVoice } = r.sceneScript({ lines: [
    { speaker: 'Lorraine Vance', manner: 'slow', text: 'It is late, and that is fine.' },
    { speaker: 'Merle', manner: 'over the phone', text: 'Cannot sleep, Lorraine.' },
    { speaker: 'Lorraine Vance', manner: '', text: 'Nobody can. Here is a song.' },
  ] }, slot);
  assert.equal(baseVoice, r.HOSTS.lorraine.voice);
  assert.ok(text.startsWith('[[' + r.HOSTS.lorraine.voice + ']] %%%slow%%% It is late'));
  assert.ok(text.includes('[[warm low-ish woman, Black American · ferry]] %%%over the phone%%% Cannot sleep'));
  assert.equal((text.match(/\[\[/g) || []).length, 3);
});

test('the daily allowance: dollars and renders both cap Seed, and defaults are what the record says', () => {
  const r = loadRadio();
  assert.equal(r.seedAllowed({ renders: 0, spentUSD: 0 }, 0.3), true);
  assert.equal(r.seedAllowed({ renders: 5, spentUSD: 0 }, 0.3), false, 'render cap 5');
  assert.equal(r.seedAllowed({ renders: 2, spentUSD: 1.0 }, 0.3), false, '$1.25 a day');
  assert.equal(r.seedAllowed({ renders: 2, spentUSD: 0.95 }, 0.3), true);
});

test('a child seat\'s corner, fists and romance answer in-world and never say restricted', () => {
  const { KID_QUIET, kidQuietLine } = loadKidQuiet();
  for (const v of ['corner', 'use', 'pickpocket', 'fight', 'flirt', 'kiss', 'date', 'propose']) {
    const line = kidQuietLine(v);
    assert.ok(line && line.length > 20, v + ' has a line');
    assert.ok(!/restrict|filter|child|kid|age|allowed|permission|not able|cannot/i.test(line), v + ' never explains itself: ' + line);
  }
  assert.equal(kidQuietLine('look'), null);
  assert.equal(kidQuietLine('hug'), null);
  assert.equal(kidQuietLine('argue'), null, 'words are the whole ladder — argue stays');
  assert.equal(Object.keys(KID_QUIET).length, 8);
});
