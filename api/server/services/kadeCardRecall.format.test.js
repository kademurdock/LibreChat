/**
 * Tests formatList EXTRACTED FROM THE SHIPPED kadeCardRecall.js — not a copy of
 * it. A test that runs against a transcription proves the transcription works.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { describeStale } = require('./kadeOpenLoops.js');

function loadFormatList() {
  const src = fs.readFileSync(require.resolve('./kadeCardRecall.js'), 'utf8');
  const start = src.indexOf('function subjectsEnabled()');
  const endMark = src.indexOf('/**\n * Read one user');
  assert.ok(start > -1 && endMark > start, 'could not locate the format block');
  const block = src.slice(start, endMark);
  /* fmtDate is extracted from the same shipped file rather than stubbed — a
   * stricter stub made this suite report a crash the real code cannot have. */
  const fdStart = src.indexOf('function fmtDate(d) {');
  const fdEnd = src.indexOf('function describeReminderCompact');
  assert.ok(fdStart > -1 && fdEnd > fdStart, 'could not locate fmtDate');
  const ctx = { process, describeReminderCompact: () => '', describeStale, module: {}, exports: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(fdStart, fdEnd), ctx);
  vm.runInContext(block + '\nthis.fn = formatList;', ctx);
  return ctx.fn;
}
const formatList = loadFormatList();

const card = (key, value, day, extra = {}) => ({
  key, value, updated_at: `2026-08-${day}T10:00:00Z`, ...extra,
});

test('plain cards render as a numbered list, oldest first', () => {
  const out = formatList([card('b', 'Second.', '20'), card('a', 'First.', '18')]);
  assert.match(out, /^1\. \[2026-08-18\]\. First\./);
  assert.match(out, /2\. \[2026-08-20\]\. Second\./);
});

test('THE SEVEN-CARD CASE: one subject collapses into one heading with a count and a newest date', () => {
  const cards = [
    card('mom_foot_surgery_date', 'Surgery is Thursday August 27.', '18', { subject: 'mom_foot_surgery' }),
    card('mom_pre_op_appointment', 'Pre-op Monday August 24 at 2:15pm.', '21', { subject: 'mom_foot_surgery' }),
    card('mom_recovery', 'Off work 5 to 10 days.', '13', { subject: 'mom_foot_surgery' }),
    card('favorite_greys', 'Loves Bailey.', '19'),
  ];
  const out = formatList(cards);
  assert.match(out, /ABOUT "mom_foot_surgery" — 3 notes, nothing newer than 2026-08-21/);
  assert.strictEqual((out.match(/ABOUT "mom_foot_surgery"/g) || []).length, 1, 'the group appears once, not per card');
  assert.match(out, /Loves Bailey\./, 'unrelated cards still render');
  assert.match(out, /- \[2026-08-13\]\. Off work/, 'members listed under the heading with their own dates');
});

test('a lone card with a subject gets no heading — a group of one is just a card', () => {
  const out = formatList([card('a', 'Only one.', '18', { subject: 'solo_thing' })]);
  assert.ok(!out.includes('ABOUT'), out);
  assert.match(out, /^1\. \[2026-08-18\]\. Only one\./);
});

test('a DECLARED expired loop carries its warning inside the group', () => {
  const out = formatList([
    card('a', 'Surgery is Thursday August 27, 2026.', '18', { subject: 's', staleAfter: '2026-08-27T12:00:00Z' }),
    card('b', 'Pre-op August 24.', '21', { subject: 's', staleAfter: '2026-08-24T12:00:00Z' }),
  ]);
  assert.match(out, /ASK, don't assert/);
});

test('KADE_CARD_SUBJECTS=0 restores the flat list', () => {
  const cards = [
    card('a', 'One.', '18', { subject: 'g' }),
    card('b', 'Two.', '19', { subject: 'g' }),
  ];
  const prev = process.env.KADE_CARD_SUBJECTS;
  process.env.KADE_CARD_SUBJECTS = '0';
  const flat = formatList(cards);
  if (prev === undefined) delete process.env.KADE_CARD_SUBJECTS; else process.env.KADE_CARD_SUBJECTS = prev;
  assert.ok(!flat.includes('ABOUT'), flat);
  assert.match(flat, /1\. \[2026-08-18\]\. One\./);
  assert.match(formatList(cards), /ABOUT "g"/, 'and grouping comes back when the switch is removed');
});

test('empty and junk input never throw', () => {
  assert.strictEqual(formatList([]), '');
  assert.doesNotThrow(() => formatList([{ value: 'x' }]));
});
