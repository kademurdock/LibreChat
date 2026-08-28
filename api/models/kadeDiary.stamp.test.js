/* kadeDiary.stamp.test.js — Aug 28 2026. The date-strip, now that it is ONE
 * function serving every machine door. The Aug-26 lesson was "one regex at
 * the door beats three prompts"; today's addendum is that it is only a
 * guarantee when every machine door is the same door — the voice-repair pass
 * wrote through updateOne and re-stamped 88 entries the same day the strip
 * was guarding logDiaryEntry. Extracted from the shipped file, standalone:
 *   node --test api/models/kadeDiary.stamp.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'kadeDiary.js'), 'utf8');
const start = SRC.indexOf('function stripLeadingDateStamp(');
assert.ok(start > -1);
let i = SRC.indexOf('{', SRC.indexOf(')', start)), depth = 0, end = -1;
for (; i < SRC.length; i++) {
  if (SRC[i] === '{') depth++;
  else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const ctx = { String, process: { env: {} } };
vm.createContext(ctx);
vm.runInContext(SRC.slice(start, end) + '\nthis.fn = stripLeadingDateStamp;', ctx);
const strip = ctx.fn;

test('the three machine-stamp shapes are stripped', () => {
  assert.strictEqual(strip('[2026-08-20] Got curious about Don Wildman.'), 'Got curious about Don Wildman.');
  assert.strictEqual(strip('On August 25, we talked about the trip.'), 'We talked about the trip.');
  assert.strictEqual(strip('2026-08-24 — the pre-op went fine.'), 'The pre-op went fine.');
});

test('a date the person actually said is content, never touched', () => {
  const t = "She's had that limp since 2018 and it never slowed her down.";
  assert.strictEqual(strip(t), t);
});

test('the strip never eats a whole entry', () => {
  assert.strictEqual(strip('[2026-08-20]'), '[2026-08-20]');
});

test('BOTH machine doors call the one function — the two-door bug stays dead', () => {
  const stripped = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const diary = stripped(SRC);
  assert.match(diary, /cleanText = stripLeadingDateStamp\(/, 'logDiaryEntry must use the shared strip');
  const repair = stripped(fs.readFileSync(path.join(__dirname, '../server/services/Memory/diaryVoiceRepair.js'), 'utf8'));
  assert.match(repair, /stripLeadingDateStamp\(/, 'the voice repair must use the shared strip');
});
