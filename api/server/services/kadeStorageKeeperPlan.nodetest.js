'use strict';
/* node --test api/server/services/kadeStorageKeeperPlan.nodetest.js
 * The storage keeper's rules, held still (Sep 25 2026). Shapes follow the Sep 25 bucket survey. */
const test = require('node:test');
const assert = require('node:assert');
const { planStorage } = require('./kadeStorageKeeperPlan');

const NOW = Date.parse('2026-10-30T10:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
let serial = 0;
const version = (key, age, extra = {}) => ({ key, versionId: `v${++serial}`, size: 1000, lastModified: daysAgo(age), isLatest: false, ...extra });
const plan = (versions, uploads = []) => planStorage({ versions, uploads, now: NOW });
const reasons = (result) => result.deletes.map((d) => `${d.key}:${d.reason}`).sort();

test('a visible Library file is never removed, however old', () => {
  const result = plan([version('media-library/abc/tape.mp4', 900, { isLatest: true })]);
  assert.deepStrictEqual(result.deletes, []);
});

test('a deleted Library file goes 30 days after it was hidden, with its marker; not at 29', () => {
  const kept = plan([
    version('media-library/a/x.mp4', 29, { isLatest: true, deleteMarker: true }),
    version('media-library/a/x.mp4', 60),
  ]);
  assert.deepStrictEqual(kept.deletes, []);
  assert.strictEqual(kept.waiting.hiddenLibraryCount, 1);
  const gone = plan([
    version('media-library/a/x.mp4', 31, { isLatest: true, deleteMarker: true }),
    version('media-library/a/x.mp4', 60),
  ]);
  assert.deepStrictEqual(reasons(gone), ['media-library/a/x.mp4:hidden-library', 'media-library/a/x.mp4:marker']);
});

test('a hide marker stays while anything younger than the window is behind it, or the file would come back', () => {
  const result = plan([
    version('media-library/b/y.mp4', 40, { isLatest: true, deleteMarker: true }),
    version('media-library/b/y.mp4', 41),
    version('media-library/b/y.mp4', 50, { deleteMarker: true }),
    version('media-library/b/y.mp4', 51),
  ]);
  // Everything behind the top marker was hidden more than 30 days ago, so all of it goes.
  assert.strictEqual(result.deletes.length, 4);
  const partial = plan([
    version('other/z.txt', 10, { isLatest: true, deleteMarker: true }),
    version('other/z.txt', 11),
  ]);
  assert.deepStrictEqual(reasons(partial), ['other/z.txt:hidden', 'other/z.txt:marker']);
  const young = plan([
    version('other/z2.txt', 3, { isLatest: true, deleteMarker: true }),
    version('other/z2.txt', 11),
  ]);
  assert.deepStrictEqual(young.deletes, [], 'hidden 3 days: inside the 7-day window');
});

test('a replaced copy is hidden from when the newer copy arrived, and the newer copy stays', () => {
  const result = plan([
    version('avatars/u/me.png', 20, { isLatest: true }),
    version('avatars/u/me.png', 25),
    version('avatars/u/me.png', 26),
  ]);
  assert.deepStrictEqual(reasons(result), ['avatars/u/me.png:hidden', 'avatars/u/me.png:hidden']);
  assert.ok(!result.deletes.some((d) => d.versionId === 'v' + (serial - 2)), 'the visible copy is not listed');
  const fresh = plan([
    version('avatars/u/me2.png', 2, { isLatest: true }),
    version('avatars/u/me2.png', 25),
  ]);
  assert.deepStrictEqual(fresh.deletes, [], 'replaced 2 days ago: kept');
});

test('book-import scratch goes 14 days after upload, every version of it', () => {
  const result = plan([
    version('book-imports/u/job1', 15, { isLatest: true }),
    version('book-imports/u/job1', 16),
    version('book-imports/u/job2', 13, { isLatest: true }),
  ]);
  assert.deepStrictEqual(reasons(result), ['book-imports/u/job1:scratch', 'book-imports/u/job1:scratch']);
});

test('backups: every one for 35 days, Sundays for 13 weeks, each month\'s first for 400 days', () => {
  const backup = (date) => {
    const at = Date.parse(date + 'T09:00:00Z');
    return { key: `backup-mongodb-${date}T09-00-00-101Z.json.gz`, versionId: `b${date}`, size: 160e6, lastModified: new Date(at).toISOString(), isLatest: true };
  };
  const result = plan([
    backup('2026-10-29'), // a day old
    backup('2026-09-26'), // Saturday, 34 days
    backup('2026-09-15'), // Tuesday, 45 days: goes
    backup('2026-09-13'), // Sunday, 47 days: kept as a weekly
    backup('2026-08-01'), // Saturday, but September... August's first: kept as a monthly
    backup('2026-08-02'), // Sunday, 89 days: kept as a weekly
    backup('2026-07-01'), // July's first, 121 days: kept as a monthly
    backup('2026-07-26'), // Sunday, 96 days: past the weekly window, not a first: goes
    backup('2025-08-01'), // a first, but 455 days: goes
  ]);
  assert.deepStrictEqual(result.deletes.map((d) => d.key.slice(15, 25)).sort(), ['2025-08-01', '2026-07-26', '2026-09-15']);
  assert.ok(result.deletes.every((d) => d.reason === 'backup'));
});

test('unfinished uploads are cancelled a week after they started', () => {
  const result = plan([], [
    { key: 'media-library/c/part.mp4', uploadId: 'u1', initiated: daysAgo(8), bytes: 5 },
    { key: 'media-library/c/new.mp4', uploadId: 'u2', initiated: daysAgo(1), bytes: 5 },
  ]);
  assert.deepStrictEqual(result.aborts.map((a) => a.uploadId), ['u1']);
  assert.deepStrictEqual(result.totals['unfinished-upload'], { count: 1, bytes: 5 });
});

test('a whole mixed bucket never lists a visible Library copy', () => {
  const versions = [];
  for (let i = 0; i < 200; i++) {
    const key = `media-library/${i}/f.mp4`;
    versions.push(version(key, i, { isLatest: i % 3 !== 0, deleteMarker: false }));
    if (i % 3 === 0) versions.push(version(key, i - 0.5 < 0 ? 0 : i / 2, { isLatest: true, deleteMarker: i % 2 === 0 }));
    versions.push(version(key, i + 40));
  }
  const result = plan(versions);
  const latest = new Set(versions.filter((v) => v.isLatest && !v.deleteMarker).map((v) => v.versionId));
  assert.ok(result.deletes.length > 0);
  assert.ok(result.deletes.every((d) => !latest.has(d.versionId)));
});
