'use strict';
/* THE ONE-FILE RULE, as pure functions (Sep 25 2026). Kade: "I need this to be a safeguard
 * for dupes on all library media, where like, it HAS to be the exact same file for a dupe flag, and
 * then it only keeps one of them. If there was some reason a file needed to be in multiple
 * collections, it can be a shortcut to the same file."
 *
 * No database or storage calls here, so every rule is held still by kadeLibraryFilesPlan.nodetest.js;
 * kadeLibraryFiles.js reads the rows, asks this file what to do, and does it.
 *
 * SAME FILE means the same byte count AND the same SHA-256, computed by the server from the stored
 * bytes. Never a title, never a length, never a client's word, never an ETag on its own.
 *
 * Three ways two rows can hold one file:
 *   merge     the extra row goes (hidden and forwarded for 30 days, then deleted); its readers,
 *             bookmarks, lists, requests and links move to the keeper.
 *   shortcut  the extra row stays where it was filed, under its own name, and reads the keeper's
 *             file (`shortcutOf`). Same owner only: a shortcut is Kade's "reason a file needed to be
 *             in multiple collections".
 *   link      the extra row stays fully its own (another person's item); only the stored bytes are
 *             shared. Nothing about either row is shown to the other person.
 */

const { createHash } = require('node:crypto');

const SHA256 = /^[a-f0-9]{64}$/;
/** A single-part upload's ETag: the MD5 of the bytes. A multipart ETag carries "-<parts>". */
const SINGLE_PART_ETAG = /^[a-f0-9]{32}$/;
const DAY = 86400000;
/* The media sweep's intake folders (kadeReadingRoomMediaSweep.js INTAKE_RE), plus a bare root. */
const INTAKE = /(?:^|\/)(?:Needs Filing|Archive Intake|Found Media|Broadcast Presentation|Advertising)(?:\/|$)|\(Review\)/i;
/* "- Copy", "- Copy (2)", " (2)", " copy"; never a year such as " (2020)". */
const COPY_TITLE = /(?:\s*-\s*copy(?:\s*\(\d{1,2}\))?|\s+\(\d{1,2}\)|\s+copy)\s*$/i;

/** Same file: same byte count and the same server-computed SHA-256. */
function sameFile(a, b) {
  return !!a && !!b && SHA256.test(String(a.sha256 || '')) && a.sha256 === b.sha256
    && Number(a.bytes) > 0 && Number(a.bytes) === Number(b.bytes);
}

/** What two same-size objects' B2 ETags already prove, before anything is read. A single-part ETag
 * is the MD5 of the bytes (checked Sep 25 2026 on a 1.5 MB pair: ETag == MD5, SHA-256 equal), so two
 * different single-part ETags are two different files. Everything else is decided by the hash. */
function etagVerdict(a, b) {
  const x = String((a && a.etag) || '').replace(/"/g, '');
  const y = String((b && b.etag) || '').replace(/"/g, '');
  if (!x || !y) return 'hash';
  if (!x.includes('-') && !y.includes('-') && x !== y) return 'different';
  return 'hash';
}

/** 'intake' (waiting to be filed), 'shelf' (a text book on its owner's shelf) or 'filed'. */
function zone(item) {
  const p = String((item && item.path) || '');
  if (!p) return item && item.kind === 'text' ? 'shelf' : 'intake';
  if (/^(?:Videos?|Audio|Books)\/?$/i.test(p) || INTAKE.test(p)) return 'intake';
  return 'filed';
}

const bareTitle = (t) => String(t || '').replace(COPY_TITLE, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
const described = (item) => (item.tracks || []).some((t) => t && t.description && t.description.state === 'done');

/** Higher is better, compared left to right. */
function score(item, usage, zoneOf) {
  const u = usage[String(item._id)] || {};
  return [
    u.shortcuts ? 1 : 0, // already the file other rows point at
    item.shared ? 1 : 0, // in the family library
    zoneOf(item) === 'intake' ? 0 : 1, // on a real shelf, not waiting in Needs Filing
    described(item) ? 1 : 0, // a paid description stays with its file
    item.librarian && item.librarian.state === 'done' ? 1 : 0,
    COPY_TITLE.test(String(item.title || '')) ? 0 : 1, // "One World (2020)" over "One World (2020) - Copy"
    (u.readers || 0) + (u.bookmarks || 0) + (u.lists || 0),
  ];
}

/** The copy that stays. Ties go to the older row (ObjectIds sort by creation time). */
function chooseKeeper(items, usage = {}, zoneOf = zone) {
  return [...items].sort((a, b) => {
    const x = score(a, usage, zoneOf);
    const y = score(b, usage, zoneOf);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0;
  })[0];
}

/**
 * One group of rows that hold the same file (the caller has proven it with sameFile).
 * @param {object[]} items
 * @param {{ usage?: object, zoneOf?: Function, keeperId?: string, actions?: Record<string, 'merge'|'shortcut'> }} [options]
 *   keeperId: Kade's own choice of keeper for a held group (it must be one of the items).
 *   actions:  Kade's own choice for an extra of a held group: 'merge' (the copy goes) or
 *             'shortcut' (the copy stays in its own folder and reads the keeper's file). Another
 *             person's row is always a link, whatever is asked.
 * @returns {{ keeper: string, extras: Array<{ id: string, action: 'merge'|'shortcut'|'link', why: string }>,
 *            hold: string, keeperSet: object } | null}
 *   hold: non-empty when the group must wait for Kade (the same bytes under different titles means
 *         one of them is probably mislabeled, e.g. Black-ish 6.01 and 6.02 on Sep 24).
 *   keeperSet: what the keeper takes from the others (the stricter grown-ups flag).
 */
function planGroup(items, { usage = {}, zoneOf = zone, keeperId = null, actions = null } = {}) {
  if (!Array.isArray(items) || items.length < 2) return null;
  const chosen = keeperId ? items.find((i) => String(i._id) === String(keeperId)) : null;
  if (keeperId && !chosen) return null;
  const keeper = chosen || chooseKeeper(items, usage, zoneOf);
  const folder = (i) => String(i.path || '');
  const extras = items.filter((i) => i !== keeper).map((i) => {
    const id = String(i._id);
    if (String(i.owner) !== String(keeper.owner)) {
      return { id, action: 'link', why: "another person's own item: it stays theirs and shares the stored file" };
    }
    const asked = actions && actions[id];
    if (asked === 'merge') return { id, action: 'merge', why: 'Kade chose to keep one copy' };
    if (asked === 'shortcut') return { id, action: 'shortcut', why: 'Kade chose to keep it in its own folder as a shortcut to the same file' };
    if (folder(i) !== folder(keeper) && zoneOf(i) === 'filed' && zoneOf(keeper) === 'filed') {
      return { id, action: 'shortcut', why: 'filed in another folder: it stays there as a shortcut to the same file' };
    }
    return { id, action: 'merge', why: zoneOf(i) === 'intake' ? 'a second copy waiting in an intake folder' : 'a second copy in the same place' };
  });
  const sameOwner = items.filter((i) => String(i.owner) === String(keeper.owner));
  const titles = new Set(sameOwner.map((i) => bareTitle(i.title)));
  const keeperSet = {};
  if (!keeper.grownUpsOnly && sameOwner.some((i) => i.grownUpsOnly)) keeperSet.grownUpsOnly = true;
  /* A copy in the family library never merges into a private keeper: its readers, lists and old links
   * would move onto a row the family cannot open. The group waits, and a plan that still does it is
   * refused (keep the shared copy, or make the other a shortcut: a shortcut keeps its own sharing). */
  const byId = new Map(items.map((i) => [String(i._id), i]));
  const unsafe = !keeper.shared && extras.some((e) => e.action === 'merge' && byId.get(e.id) && byId.get(e.id).shared)
    ? 'a copy in the family library would fold into a private copy; keep the shared one, or make it a shortcut' : '';
  return {
    keeper: String(keeper._id),
    extras,
    hold: [titles.size > 1 ? 'the same file carries different titles, so one of them is probably mislabeled' : '', unsafe].filter(Boolean).join('; '),
    keeperSet,
    unsafe,
  };
}

/**
 * A NEW upload turned out to be a file the library already stores in `twin`.
 * `canOpen`: could the uploader already open `twin` (their own, or shared with a family member and not
 * kept from a child), judged the way the library judges it for everyone (never the admin's override)?
 * When they could not, the answer is a silent link and `tell` is null: never a word, a title or a
 * folder of someone else's private copy.
 * Only one owner's own copies ever fold (merge or shortcut). Another person's row is always a link,
 * exactly as in planGroup: both rows stay and only the stored bytes are shared, so neither person's
 * withdrawal can take the other's item with it.
 */
function uploadDecision({ item, twin, canOpen, zoneOf = zone }) {
  if (!canOpen) return { action: 'link', tell: null };
  if (String(item.owner) !== String(twin.owner)) return { action: 'link', tell: null };
  /* The uploader marked it grown-ups only and the stored copy is open to children: folding would drop
   * their judgement, so both rows stay (sharing the bytes) and the pair waits in Kade's report. */
  if (item.grownUpsOnly && !twin.grownUpsOnly) return { action: 'link', tell: null, hold: 'the new copy is marked grown-ups only and the stored one is not' };
  /* The new copy is in the family library and the stored one is private: folding would take it out
   * of the family's reach, so both rows stay. */
  if (item.shared && !twin.shared) return { action: 'link', tell: null, hold: 'the new copy is shared and the stored one is private' };
  if (String(item.path || '') !== String(twin.path || '') && zoneOf(item) === 'filed' && zoneOf(twin) === 'filed') {
    return { action: 'shortcut', tell: 'shortcut' };
  }
  return { action: 'merge', tell: 'already' };
}

/** A row the verifier (report mode) already marked as the extra copy of another. */
const flaggedCopy = (row) => !!(row && row.fileCheck && row.fileCheck.state === 'duplicate');

/**
 * What report mode writes on a NEW upload (fileCheck.state), for the stored copy `twin`:
 *   duplicate      the whole item is the same file, track for track (`whole`), and 'on' mode would fold
 *                  it (same owner, a copy they can open that is at least as open as this one): only
 *                  this state becomes the space-review note "identical copy, another is kept"
 *   kept           the same file is stored elsewhere, but this row is the one that stays (someone
 *                  else's copy, a less open copy, or the other copy is the flagged one)
 *   shares-tracks  only some of its tracks are files stored elsewhere (a cassette whose side A is also
 *                  on another tape): never a duplicate
 */
function reportState({ item, twin, canOpen, whole, zoneOf = zone }) {
  if (!whole) return 'shares-tracks';
  if (!twin || twin.state !== 'ready' || flaggedCopy(twin)) return 'kept';
  const d = uploadDecision({ item, twin, canOpen, zoneOf });
  return d.action === 'merge' || d.action === 'shortcut' ? 'duplicate' : 'kept';
}

/** The receipt line an uploader hears. Only ever called for a twin they can open. */
function alreadyLine(twin, where, { own = false } = {}) {
  const title = String(twin.title || 'Untitled');
  return own
    ? `Already on your shelf: "${title}". It is exactly the same file, so it is kept once.`
    : `Already in the library: "${title}"${where ? ` (${where})` : ''}. It is exactly the same file, so it is kept once.`;
}

/** The folded upload carried words of its own: a title other than the stored copy's, or notes. */
function ownWords(mine, twin) {
  if (!mine) return false;
  if (!twin) return true;
  const notes = String(mine.description || '').trim();
  return bareTitle(mine.title) !== bareTitle(twin.title) || (!!notes && notes !== String(twin.description || '').trim());
}

/** What an uploader hears after the verifier kept their new upload once (their own copies only).
 * "Nothing was lost" is never said when the upload had its own title or notes: those stay on the
 * folded row and its receipt for 30 days, so the copy can be put back. */
function foldedLine(twin, where, { own = false, mine = null } = {}) {
  if (!ownWords(mine, twin)) return alreadyLine(twin, where, { own });
  const place = own ? 'already on your shelf' : `already in the library${where ? ` (${where})` : ''}`;
  return `Your upload "${String(mine.title || 'Untitled')}" is exactly the same file as "${String(twin.title || 'Untitled')}", ${place}, so it is kept once and now opens that one. The title and notes you gave it are saved for 30 days, so your copy can be put back.`;
}
/** The same for several uploads in one pass. */
function foldedSummary(count, anyOwnWords) {
  return `${count} of your new uploads were exactly the same files as ones already in the library, so each is kept once.`
    + (anyOwnWords ? ' The titles and notes you gave them are saved for 30 days, so your copies can be put back.' : ' Nothing was lost.');
}

/** A brand-new, empty donation whose one file is already stored: nothing was sent, the empty item
 * went, and she hears where the copy is (only ever for a copy she can open). */
function nothingUploadedLine(twin, where, { own = false, started = '' } = {}) {
  const title = String(twin.title || 'Untitled');
  const place = own ? `already on your shelf as "${title}"` : `already in the library as "${title}"${where ? `, in ${where}` : ''}`;
  return `Nothing was uploaded: this exact file is ${place}. The new item${started ? ` "${String(started)}"` : ''} you started was removed.`;
}

/** Every track of `extra` is a file `keeper` holds, one for one: the whole item is a copy, so the row
 * itself may merge or become a shortcut. Anything less (a cassette whose side A is also on another
 * tape) shares only those tracks' bytes and both rows stay. */
function wholeCopy(extra, keeper) {
  const a = (extra && extra.tracks) || [];
  const b = (keeper && keeper.tracks) || [];
  if (a.length && a.length === b.length) return a.every((t, i) => sameFile(t, b[i]));
  return !a.length && !b.length && !!extra.fileSha256 && sameFile({ sha256: extra.fileSha256, bytes: extra.fileBytes }, { sha256: keeper.fileSha256, bytes: keeper.fileBytes });
}

/** Could this reader open this row on their own? The same test as openBook (kadeReadingRoom.js:352)
 * and libraryAccess (packages/api/src/library/catalog.ts:201), for a reader shaped like
 * requestReader() in kadeLibraryRequests.js: { id, admin, child, hidden }. */
function canOpen(reader, row) {
  if (!reader || !row || row.state !== 'ready') return false;
  if (String(row.owner) === String(reader.id) || reader.admin) return true;
  return !!row.shared && !reader.hidden && !(reader.child && row.grownUpsOnly);
}

/** A place in one cut of a text, carried to another cut by its flat chunk index (the reparse rule). */
function remapPosition(fromCounts, toCounts, s, c) {
  const flat = fromCounts.slice(0, s).reduce((n, k) => n + k, 0) + c;
  let left = Math.max(0, flat);
  for (let i = 0; i < toCounts.length; i++) {
    if (left < toCounts[i]) return { s: i, c: left };
    left -= toCounts[i];
  }
  const last = Math.max(0, toCounts.length - 1);
  return { s: last, c: Math.max(0, (toCounts[last] || 1) - 1) };
}

/** The words of a text book, without the spoken jacket (it carries the title, which uploads may
 * differ on). Two books with the same digest and the same section count read identically. */
function bookTextDigest(sections, kinds) {
  const hash = createHash('sha256');
  (sections || []).forEach((section, i) => {
    if ((kinds || [])[i] === 'jacket') return;
    hash.update(JSON.stringify((section && section.chunks) || [])).update('\n');
  });
  return hash.digest('hex');
}

/** One duplicate group's name: the file itself. */
const groupId = (sha256, bytes) => `${sha256}:${Number(bytes) || 0}`;
function parseGroupId(id) {
  const m = /^([a-f0-9]{64}):(\d{1,15})$/.exec(String(id || ''));
  return m ? { sha256: m[1], bytes: Number(m[2]) } : null;
}

const cleanEtag = (etag) => String(etag || '').replace(/"/g, '');
/** media-library/<itemId>/<name> -> itemId ('' for anything else). */
function itemOfKey(key) {
  const m = /^[^/]+\/([a-f0-9]{24})\/[^/]+$/i.exec(String(key || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Objects under media-library/<itemId>/ that no row lists (retried pushes leave these: a retry reuses
 * the pending row but mints a new key, and "done" records only the last one; 152 items on Sep 25).
 * An object may go only when it is byte-identical to a key the SAME item does list (same size and
 * the same single-part ETag, or the same SHA-256) and is older than a day, so an upload still in
 * flight is never touched. Everything else is only reported.
 * @param {Array<{ key: string, size: number, etag?: string, sha256?: string, lastModified: string|Date }>} objects
 * @param {{ referenced: Set<string>, itemKeys: Map<string, Array<{ key: string, size: number, etag?: string, sha256?: string }>>, now?: number, minAgeMs?: number }} known
 */
function classifyUnreferenced(objects, { referenced, itemKeys, now = Date.now(), minAgeMs = DAY } = {}) {
  const out = [];
  for (const o of objects || []) {
    if (!o || !o.key || (referenced && referenced.has(o.key))) continue;
    const itemId = itemOfKey(o.key);
    const size = Number(o.size) || 0;
    const etag = cleanEtag(o.etag);
    const listed = ((itemKeys && itemKeys.get(itemId)) || []).filter((k) => k && k.key && k.key !== o.key);
    const twin = size > 0 ? listed.find((k) => Number(k.size) === size && (
      (SINGLE_PART_ETAG.test(etag) && etag === cleanEtag(k.etag))
      || (SHA256.test(String(o.sha256 || '')) && o.sha256 === k.sha256))) : null;
    const old = now - new Date(o.lastModified).getTime() > minAgeMs;
    const why = !itemId ? 'not under an item folder'
      : !listed.length ? 'the item lists no other file to compare it with'
        : !twin ? 'not byte-identical to a file the item lists'
          : !old ? 'less than a day old (an upload may still be finishing)'
            : 'byte-identical to a file the same item lists';
    out.push({ key: o.key, size, itemId, lastModified: o.lastModified, twin: twin ? twin.key : '', deletable: !!twin && old, why });
  }
  return out;
}

module.exports = {
  sameFile, etagVerdict, zone, chooseKeeper, planGroup, uploadDecision, reportState, flaggedCopy, alreadyLine, ownWords,
  foldedLine, foldedSummary, nothingUploadedLine, wholeCopy, canOpen, remapPosition,
  bookTextDigest, groupId, parseGroupId, itemOfKey, classifyUnreferenced, cleanEtag, SHA256, SINGLE_PART_ETAG, INTAKE,
};
