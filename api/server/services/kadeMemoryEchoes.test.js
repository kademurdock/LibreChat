'use strict';
/* Part 97 — the echo lane's pure pieces + wiring pins. Red-proof: drop the
 * once-a-day audit check, the kill switch, or the diary-only design and a
 * pin fails; break the year phrasing and the behavioral tests fail. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require.resolve('./kadeMemoryEchoes.js'), 'utf8');
function grab(name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start > -1, name);
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(grab('phraseAgo') + '\nthis.phraseAgo = phraseAgo;', ctx);

test('month phrasing: 1, 3, 12, 24', () => {
  assert.strictEqual(ctx.phraseAgo(1), 'a month ago today');
  assert.strictEqual(ctx.phraseAgo(3), '3 months ago today');
  assert.strictEqual(ctx.phraseAgo(12), 'a year ago today');
  assert.strictEqual(ctx.phraseAgo(24), '2 years ago today');
});

const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('diary-only: the card collection is never queried here', () => {
  assert.ok(!/memoryentries/.test(stripped), 'card echoes stay out by design');
});
test('the cap fails CLOSED: an unverifiable audit means stay quiet', () => {
  assert.match(src, /return true; \/\* cannot verify the cap — stay quiet/);
});
test('kill switch present and default-on', () => {
  assert.match(stripped, /KADE_ECHOES !== '0'/);
});

const recall = fs.readFileSync(require.resolve('./kadeCardRecall.js'), 'utf8');
const rstripped = recall.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('the echo block sits LAST — after cards, nudge, and diary', () => {
  const nudge = rstripped.indexOf("KADE_LOOP_NUDGE !== '0'");
  const diary = rstripped.indexOf('if (diaryN > 0) {');
  const echo = rstripped.indexOf("KADE_ECHOES !== '0'");
  assert.ok(nudge > -1 && diary > nudge && echo > diary, `${nudge} < ${diary} < ${echo}`);
});
test('an injected echo lands in the recall audit as echo:<date>', () => {
  assert.match(rstripped, /surfacedCards\.push\('echo:' \+ echo\.when\)/);
});
test('the manners ride BESIDE the memory, heavy handled explicitly', () => {
  assert.match(recall, /do NOT raise it unprompted/);
  assert.match(recall, /let it go silently/);
});
