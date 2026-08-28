/* kadeRecallAudit.test.js — Aug 28 2026.
 * The one property that must never regress: NO FIELD OF AN AUDIT ROW CAN
 * CARRY A CARD VALUE. The row builder is pure so this is provable without a
 * database. Runs standalone: node --test api/models/kadeRecallAudit.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Extract buildAuditRow from the shipped file — never a transcription. */
const SRC = fs.readFileSync(path.join(__dirname, 'kadeRecallAudit.js'), 'utf8');
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  let i = SRC.indexOf('{', SRC.indexOf(')', start));
  let depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const ctx = { String, Number, Boolean, Array, Math };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(start, end) + `\nthis.fn = ${name};`, ctx);
  return ctx.fn;
}
const buildAuditRow = extract('buildAuditRow');

test('a row holds keys and dates, and there is nowhere a value could hide', () => {
  const row = buildAuditRow({
    userId: 'u1', agentId: 'a1',
    cards: ['kade_interests_concerts', 'kade_cats'],
    logbook: ['2026-08-25'],
    hit: true, ms: 300,
  });
  assert.deepStrictEqual(Object.keys(row).sort(),
    ['agentId', 'cards', 'hit', 'logbook', 'ms', 'userId'],
    'a new field on the audit row is a privacy decision, not a refactor');
});

test('a smuggled card VALUE is truncated to key length, never stored whole', () => {
  const secret = 'Saw Shinedown on July 28, 2026. ' + 'x'.repeat(400);
  const row = buildAuditRow({ userId: 'u', cards: [secret], logbook: [], hit: true, ms: 1 });
  assert.ok(row.cards[0].length <= 120, `stored ${row.cards[0].length} chars of a card-value-shaped string`);
});

test('array caps hold — an audit row cannot become an archive', () => {
  const row = buildAuditRow({
    userId: 'u',
    cards: Array.from({ length: 200 }, (_, i) => 'k' + i),
    logbook: Array.from({ length: 200 }, () => '2026-01-01'),
    hit: false, ms: 0,
  });
  assert.ok(row.cards.length <= 16 && row.logbook.length <= 16);
});

test('garbage in, bounded row out', () => {
  const row = buildAuditRow({ userId: null, agentId: undefined, cards: 'nope', logbook: null, hit: 'y', ms: NaN });
  assert.strictEqual(typeof row.userId, 'string');
  /* vm-extracted arrays are cross-realm: compare structure, not prototype. */
  assert.strictEqual(row.cards.length, 0);
  assert.strictEqual(row.logbook.length, 0);
  assert.strictEqual(row.ms, 0);
});

/* The kill switch is honoured at the STORE door, not the builder — assert the
 * shipped source checks it before any create. Comment-stripped (the Aug-23
 * scar: a guard that matches its own documentation proves nothing). */
test('the kill switch gates the store', () => {
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fn = stripped.slice(stripped.indexOf('function storeRecallAudit'), stripped.indexOf('async function readRecallAudits'));
  assert.match(fn, /KADE_RECALL_AUDIT_STORE.*===.*'0'/s);
  assert.ok(fn.indexOf("KADE_RECALL_AUDIT_STORE") < fn.indexOf('create'), 'the switch must be read before the write');
});
