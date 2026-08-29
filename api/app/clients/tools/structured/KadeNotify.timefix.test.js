/* KADE Aug 29 2026 — the Amber hair-appointment scar, pinned.
 * Source-level in the house style (callinstant.test.js / caption.test.js):
 * the shipped file is read as text, comments stripped, and the guard's
 * existence AND ordering are asserted against the real source — plus the
 * pure date helper is extracted and exercised behaviorally.
 * Red-proof: remove the time→fire_time guard, or move it below the
 * needs-either validation, and tests fail. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'KadeNotify.js'), 'utf8');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('set_reminder accepts an HH:mm arriving in `time` as fire_time', () => {
  assert.match(stripped, /action === 'set_reminder' && !fire_time && !in_minutes && \/\^\\d\{1,2\}:\\d\{2\}\$\/\.test\(String\(data\.time/);
});

test('a fire_time with no date defaults to the next Central occurrence', () => {
  assert.match(stripped, /fire_date = KadeNotify\.nextOccurrenceCentral\(fire_time\)/);
});

test('the guard sits AHEAD of the needs-either validation', () => {
  const guard = stripped.indexOf("!fire_time && !in_minutes && /^\\d{1,2}:\\d{2}$/");
  const validation = stripped.indexOf("set_reminder needs either 'in_minutes'");
  assert.ok(guard > -1 && validation > -1 && guard < validation,
    `guard@${guard} must precede validation@${validation}`);
});

test('schedule_checkin mirror: fire_time accepted where time belongs', () => {
  const mirror = stripped.indexOf("!time && /^\\d{1,2}:\\d{2}$/.test(String(data.fire_time");
  const needsTime = stripped.indexOf('schedule_checkin needs a time');
  assert.ok(mirror > -1 && needsTime > -1 && mirror < needsTime);
});

// Extract the pure helper and run it for real.
const m = src.match(/static nextOccurrenceCentral\(hhmm, now = new Date\(\)\) \{[\s\S]*?\n  \}/);
assert.ok(m, 'nextOccurrenceCentral found in source');
// eslint-disable-next-line no-new-func
const body = m[0].slice(m[0].indexOf('{') + 1, m[0].lastIndexOf('}'));
const helper = new Function('hhmm', 'now', body);
const central = (d) => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of fmt.formatToParts(d)) o[p.type] = p.value; return o;
};

test('a time still ahead today resolves to today (Central)', () => {
  // 03:00Z is 22:00 Central the previous evening — 23:30 is still ahead.
  const now = new Date('2026-08-29T03:00:00Z');
  const c = central(now);
  assert.strictEqual(helper('23:30', now), `${c.year}-${c.month}-${c.day}`);
});

test('a time already past today rolls to tomorrow (Central)', () => {
  const now = new Date('2026-08-29T03:00:00Z'); // 22:00 Central Aug 28
  const c = central(new Date(now.getTime() + 24 * 3600 * 1000));
  assert.strictEqual(helper('08:40', now), `${c.year}-${c.month}-${c.day}`);
});

test('garbage times return null', () => {
  assert.strictEqual(helper('25:99', new Date()), null);
  assert.strictEqual(helper('soon', new Date()), null);
});
