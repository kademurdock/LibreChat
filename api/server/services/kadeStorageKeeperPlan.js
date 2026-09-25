'use strict';
/* The storage keeper's rules as one pure function (Sep 25 2026). No storage calls here, so every
 * rule is held still by kadeStorageKeeperPlan.nodetest.js; kadeStorageKeeper.js lists the bucket,
 * asks this what may go, and does it.
 *
 * What may go, and only this:
 *  - an upload that was started and never finished, a week after it started (retried pushes
 *    leave these behind, 41 GB of them on Sep 25);
 *  - a hidden copy: B2 keeps the bytes of a deleted or replaced file as a hidden version. A
 *    Library file's hidden copy goes 30 days after it was hidden, so a mistaken delete can be
 *    recovered for a month; anything else's after 7 days;
 *  - a hide marker, once nothing is left behind it (removing one earlier would bring the file back);
 *  - scratch that should never have outlived its job (book-imports/), 14 days after upload;
 *  - an old database backup, keeping every backup for 35 days, Sunday's for 13 weeks and each
 *    month's first for 400 days.
 * A visible file anywhere else, above all in media-library/, is never on the list: the plan
 * throws rather than return one. */

const DAY = 86400000;
const RULES = Object.freeze({
  unfinishedUploadDays: 7,
  hiddenLibraryDays: 30,
  hiddenOtherDays: 7,
  scratchDays: 14,
  backupDailyDays: 35,
  backupWeeklyDays: 91,
  backupMonthlyDays: 400,
});
const LIBRARY = 'media-library/';
const SCRATCH = ['book-imports/'];
const BACKUP = /^backup-mongodb-(\d{4})-(\d{2})-(\d{2})T[\d-]+Z\.json\.gz$/;

const time = (value) => new Date(value).getTime();
const ageDays = (now, value) => (now - time(value)) / DAY;

/** Backups to keep: every one for 35 days, Sundays for 13 weeks, each month's first for 400 days. */
function keptBackups(backups, now, rules) {
  const firstOfMonth = new Map();
  for (const b of backups) {
    const month = b.date.slice(0, 7);
    const earlier = firstOfMonth.get(month);
    if (!earlier || b.date < earlier.date) firstOfMonth.set(month, b);
  }
  const keep = new Set();
  for (const b of backups) {
    const age = ageDays(now, b.lastModified);
    const sunday = new Date(b.date + 'T12:00:00Z').getUTCDay() === 0;
    if (age <= rules.backupDailyDays) keep.add(b.key);
    else if (sunday && age <= rules.backupWeeklyDays) keep.add(b.key);
    else if (firstOfMonth.get(b.date.slice(0, 7)) === b && age <= rules.backupMonthlyDays) keep.add(b.key);
  }
  return keep;
}

/**
 * @param {{ versions: Array<{ key: string, versionId: string, size?: number, lastModified: string|Date, isLatest: boolean, deleteMarker?: boolean }>,
 *           uploads?: Array<{ key: string, uploadId: string, initiated: string|Date, bytes?: number }>,
 *           now?: number, rules?: object }} input
 * @returns {{ deletes: Array<{ key: string, versionId: string, size: number, reason: string }>,
 *             aborts: Array<{ key: string, uploadId: string, bytes: number }>,
 *             totals: Record<string, { count: number, bytes: number }>,
 *             waiting: { hiddenLibraryBytes: number, hiddenLibraryCount: number } }}
 */
function planStorage({ versions, uploads = [], now = Date.now(), rules = RULES }) {
  const byKey = new Map();
  for (const v of versions) {
    if (!v || typeof v.key !== 'string' || !v.versionId) continue;
    if (!byKey.has(v.key)) byKey.set(v.key, []);
    byKey.get(v.key).push(v);
  }
  const deletes = [];
  const waiting = { hiddenLibraryBytes: 0, hiddenLibraryCount: 0 };
  const push = (v, reason) => deletes.push({ key: v.key, versionId: v.versionId, size: Number(v.size) || 0, reason });
  const backups = [];

  for (const [key, list] of byKey) {
    // Newest first; on a tie the latest version leads.
    list.sort((a, b) => time(b.lastModified) - time(a.lastModified) || Number(b.isLatest) - Number(a.isLatest));
    const top = list[0];
    const visible = top.isLatest && !top.deleteMarker;
    const library = key.startsWith(LIBRARY);

    if (visible && SCRATCH.some((prefix) => key.startsWith(prefix)) && ageDays(now, top.lastModified) > rules.scratchDays) {
      for (const v of list) push(v, 'scratch');
      continue;
    }
    const backup = visible && BACKUP.exec(key);
    if (backup) {
      backups.push({ key, list, date: `${backup[1]}-${backup[2]}-${backup[3]}`, lastModified: top.lastModified });
      continue;
    }

    const hiddenDays = library ? rules.hiddenLibraryDays : rules.hiddenOtherDays;
    let allOlderGo = true;
    for (let i = 1; i < list.length; i++) {
      const v = list[i];
      // A version is hidden from the moment the next one (a newer copy or a hide marker) arrived.
      const hiddenFor = ageDays(now, list[i - 1].lastModified);
      if (hiddenFor > hiddenDays) push(v, v.deleteMarker ? 'marker' : library ? 'hidden-library' : 'hidden');
      else {
        allOlderGo = false;
        if (library && !v.deleteMarker) {
          waiting.hiddenLibraryBytes += Number(v.size) || 0;
          waiting.hiddenLibraryCount += 1;
        }
      }
    }
    // A hide marker on top goes only with everything behind it, or the file would come back.
    if (top.deleteMarker && allOlderGo && ageDays(now, top.lastModified) > hiddenDays) push(top, 'marker');
  }

  const keep = keptBackups(backups, now, rules);
  for (const b of backups) if (!keep.has(b.key)) for (const v of b.list) push(v, 'backup');

  // The one promise: nothing visible outside scratch and backups is ever on the list.
  for (const d of deletes) {
    if (d.reason === 'scratch' || d.reason === 'backup') continue;
    const list = byKey.get(d.key);
    if (list[0].versionId === d.versionId && list[0].isLatest && !list[0].deleteMarker) {
      throw new Error(`storage keeper plan tried to remove the visible copy of ${d.key}`);
    }
  }

  const aborts = uploads
    .filter((u) => u && u.key && u.uploadId && ageDays(now, u.initiated) > rules.unfinishedUploadDays)
    .map((u) => ({ key: u.key, uploadId: u.uploadId, bytes: Number(u.bytes) || 0 }));

  const totals = {};
  const add = (reason, bytes) => {
    totals[reason] = totals[reason] || { count: 0, bytes: 0 };
    totals[reason].count += 1;
    totals[reason].bytes += bytes;
  };
  for (const d of deletes) add(d.reason, d.size);
  for (const a of aborts) add('unfinished-upload', a.bytes);
  return { deletes, aborts, totals, waiting };
}

module.exports = { planStorage, RULES, LIBRARY, SCRATCH, BACKUP };
