'use strict';
/* ----------------------------------------------------------------------------
 * THE MEDIA LIBRARIAN'S ROUNDS (Part 270, Sep 23 2026)
 *
 * The timer and the writes for services/kadeMediaLibrarian.js, built the way
 * the book sorter next door is: a pass every few minutes, a batch at a time,
 * a daily spending cap, a kill switch, and every write guarded on the path
 * that was read, so a move that raced an upload or a hand edit is a no-op.
 *
 * Each pass takes, in order:
 *   1. New arrivals (created since KADE_MEDIA_SWEEP_SINCE) and anything in an
 *      intake folder (Needs Filing, Archive Intake, the "(Review)" folders).
 *      These are filed on Jev's word straight away: that is the point of a
 *      librarian, and a new upload has no older human choice to overrule.
 *   2. With room left, the rest of the library, oldest first, one item once.
 *      Here a move is only a PROPOSAL (meta.jevFiling.proposal) unless
 *      KADE_MEDIA_AUDIT_APPLY=1, so the accuracy pass over what "a dumb script"
 *      filed can be read and checked before anything old moves.
 *
 * Every item it has read carries meta.jevFiling = { v, at, zone, from, to or
 * proposal, why, confidence }. `from` makes each move undoable (see /undo),
 * and the presence of the field is what keeps an item from being read twice.
 * Flags go in meta.review ("Jev review: made outside the US (0.93).") and are
 * never moves or deletions; TubeVault shows them as review notes.
 *
 * Knobs: KADE_MEDIA_SWEEP=0 kills; KADE_MEDIA_SWEEP_INTERVAL_MIN (5);
 * KADE_MEDIA_SWEEP_BATCH (200); KADE_MEDIA_SWEEP_DAILY_USD (2.00);
 * KADE_MEDIA_AUDIT_APPLY (off); KADE_MEDIA_SWEEP_SINCE (the deploy day).
 * Cost measured on 1,269 of her items: $0.000106 an item, so the whole
 * 50,000-item library is about $5 once.
 * -------------------------------------------------------------------------- */
const { logger } = require('@librechat/data-schemas');
const { KadeBook } = require('~/models/kadeBook');
const { logKadeUsage } = require('~/models/kadeUsage');
const jev = require('~/server/services/kadeJev');
const librarian = require('~/server/services/kadeMediaLibrarian');

const ENABLED = () => process.env.KADE_MEDIA_SWEEP !== '0' && jev.enabled('KADE_JEV_LIBRARY');
const INTERVAL_MIN = () => Math.max(2, parseInt(process.env.KADE_MEDIA_SWEEP_INTERVAL_MIN, 10) || 5);
const BATCH = () => Math.min(2000, Math.max(1, parseInt(process.env.KADE_MEDIA_SWEEP_BATCH, 10) || 200));
const DAILY_USD = () => Math.max(0, parseFloat(process.env.KADE_MEDIA_SWEEP_DAILY_USD) || 2);
const AUDIT_APPLY = () => process.env.KADE_MEDIA_AUDIT_APPLY === '1';
const SINCE = () => {
  const d = new Date(process.env.KADE_MEDIA_SWEEP_SINCE || '2026-09-23T00:00:00Z');
  return Number.isFinite(d.getTime()) ? d : new Date('2026-09-23T00:00:00Z');
};
const INTAKE_RE = /(?:^|\/)(?:Needs Filing|Archive Intake|Found Media|Broadcast Presentation|Advertising)(?:\/|$)|\(Review\)/i;
const FIELDS = '_id kind title author path originalPath description meta tags createdAt tracks.bytes owner';
const UNREAD = { 'meta.jevFiling': { $exists: false }, 'meta.jevFilingTries': { $not: { $gte: 3 } } };

let spent = { day: '', usd: 0 };
let running = false;
let lastPass = null;
/* Where the accuracy pass is up to, so a pass does not walk past everything it
 * has already read. Lost on a restart, which costs one catch-up walk. */
let auditAfter = null;
let auditDone = false;

function today() {
  return new Date().toISOString().slice(0, 10);
}
function spentToday() {
  if (spent.day !== today()) spent = { day: today(), usd: 0 };
  return spent.usd;
}

async function deps() {
  try {
    const { broadcastShelf } = require('@librechat/api');
    return { broadcastShelf };
  } catch (_) {
    return {};
  }
}

function bytesOf(item) {
  return (item.tracks || []).reduce((n, t) => n + (Number(t && t.bytes) || 0), 0);
}

/** An older ready item with the same title, kind and size: this one is the copy. */
async function identicalCopy(item) {
  const bytes = bytesOf(item);
  if (!bytes || !item.title || !(new Date(item.createdAt) >= SINCE())) return false;
  const other = await KadeBook.findOne({ _id: { $lt: item._id }, title: item.title, kind: item.kind, state: 'ready', 'tracks.bytes': (item.tracks || [])[0]?.bytes }, '_id tracks.bytes').lean();
  return !!other && bytesOf(other) === bytes;
}

async function pick(limit) {
  const base = { kind: { $in: ['video', 'audio'] }, state: 'ready', ...UNREAD };
  const fresh = await KadeBook.find({ ...base, $or: [{ createdAt: { $gte: SINCE() } }, { path: INTAKE_RE }] }, FIELDS).sort({ createdAt: -1 }).limit(limit).lean();
  const marked = fresh.map((i) => ({ ...i, _fresh: new Date(i.createdAt) >= SINCE() }));
  if (fresh.length >= limit || auditDone) return marked;
  const seen = new Set(fresh.map((i) => String(i._id)));
  const old = await KadeBook.find({ ...base, ...(auditAfter ? { _id: { $gt: auditAfter } } : {}) }, FIELDS).sort({ _id: 1 }).limit(limit).lean();
  if (!old.length) auditDone = true;
  else auditAfter = old[old.length - 1]._id;
  return [...marked, ...old.filter((i) => !seen.has(String(i._id))).slice(0, limit - fresh.length)];
}

/** One pass. Returns a summary; never throws. */
async function sweepOnce({ limit = BATCH(), userId = null } = {}) {
  if (!ENABLED() || running) return { ran: false, reason: running ? 'already running' : 'off' };
  if (spentToday() >= DAILY_USD()) return { ran: false, reason: 'daily cap reached' };
  running = true;
  const t0 = Date.now();
  try {
    const items = await pick(limit);
    if (!items.length) return (lastPass = { ran: true, read: 0, at: new Date() });
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const { decisions, costUSD } = await librarian.fileMedia(items.map((i) => ({ ...i, bytes: bytesOf(i) })), { deps: await deps() });
    spent.usd += costUSD;
    const ops = [];
    const tally = { read: items.length, moved: 0, proposed: 0, flagged: 0, errors: 0, byShelf: {} };
    for (const d of decisions) {
      const item = byId.get(String(d.item._id));
      const from = String(item.path || '');
      if (d.error) {
        tally.errors++;
        ops.push({ updateOne: { filter: { _id: item._id }, update: { $inc: { 'meta.jevFilingTries': 1 } } } });
        continue;
      }
      const flags = [...d.flags];
      if (item._fresh && (await identicalCopy(item))) flags.push('Space review: identical copy, another is kept.');
      const zone = librarian.zoneOf(item);
      const apply = !!d.to && (zone === 'intake' || item._fresh || AUDIT_APPLY() || d.why === 'folder says so');
      const record = { v: librarian.VERSION, at: new Date(), zone, from, why: d.why || '', confidence: Number((d.confidence || 0).toFixed(3)) };
      if (d.to) record[apply ? 'to' : 'proposal'] = d.to;
      const set = { 'meta.jevFiling': record };
      if (flags.length) set['meta.review'] = flags.join(' ');
      if (apply) {
        set.path = d.to;
        set.category = librarian.categoryOf(d.to, item.kind);
        tally.moved++;
        const shelf = d.to.split('/').slice(1, 3).join('/');
        tally.byShelf[shelf] = (tally.byShelf[shelf] || 0) + 1;
      } else if (d.to) tally.proposed++;
      if (flags.length) tally.flagged++;
      const update = { $set: set };
      if (d.tags && d.tags.length) update.$addToSet = { tags: { $each: d.tags } };
      ops.push({ updateOne: { filter: { _id: item._id, path: from, state: 'ready' }, update } });
    }
    const result = ops.length ? await KadeBook.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };
    lastPass = { ran: true, at: new Date(), ms: Date.now() - t0, costUSD: Number(costUSD.toFixed(4)), written: result.modifiedCount || 0, ...tally };
    logger.info(`[library/media-sweep] read ${tally.read}: moved ${tally.moved}, proposed ${tally.proposed}, flagged ${tally.flagged}, errors ${tally.errors}, $${costUSD.toFixed(4)} ${JSON.stringify(tally.byShelf).slice(0, 400)}`);
    if (costUSD > 0) {
      logKadeUsage({ userId: userId || items[0].owner, service: 'describe', quantity: tally.read, unit: 'items', costUSD, metadata: { source: 'media-librarian', moved: tally.moved, proposed: tally.proposed } }).catch?.(() => {});
    }
    return lastPass;
  } catch (e) {
    logger.warn(`[library/media-sweep] failed: ${e.message}`);
    return (lastPass = { ran: false, at: new Date(), error: e.message });
  } finally {
    running = false;
  }
}

async function status() {
  const base = { kind: { $in: ['video', 'audio'] }, state: 'ready' };
  const [unread, intake, proposals, flagged] = await Promise.all([
    KadeBook.countDocuments({ ...base, ...UNREAD }),
    KadeBook.countDocuments({ ...base, path: INTAKE_RE }),
    KadeBook.countDocuments({ ...base, 'meta.jevFiling.proposal': { $exists: true } }),
    KadeBook.countDocuments({ ...base, 'meta.review': { $exists: true, $ne: '' } }),
  ]);
  return { enabled: ENABLED(), auditApply: AUDIT_APPLY(), auditDone, intervalMin: INTERVAL_MIN(), batch: BATCH(), dailyUSD: DAILY_USD(), spentTodayUSD: Number(spentToday().toFixed(4)), unread, intake, proposals, flagged, lastPass };
}

/** Put back every sweep move made since `since` whose item still sits where the sweep put it. */
async function undo(since) {
  const when = new Date(since || 0);
  const items = await KadeBook.find({ 'meta.jevFiling.to': { $exists: true }, 'meta.jevFiling.at': { $gte: when } }, '_id kind path meta.jevFiling').lean();
  const ops = items
    .filter((i) => i.meta.jevFiling.to === i.path && typeof i.meta.jevFiling.from === 'string')
    .map((i) => ({ updateOne: { filter: { _id: i._id, path: i.path }, update: { $set: { path: i.meta.jevFiling.from, category: librarian.categoryOf(i.meta.jevFiling.from, i.kind), 'meta.jevFiling.undone': new Date() } } } }));
  const r = ops.length ? await KadeBook.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };
  logger.info(`[library/media-sweep] undo since ${when.toISOString()}: ${r.modifiedCount || 0} of ${items.length}`);
  return { considered: items.length, restored: r.modifiedCount || 0 };
}

function mount(router, { requireJwtAuth, isAdmin, express }) {
  router.get('/librarian/media-sweep', requireJwtAuth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    try { res.json({ ok: true, ...(await status()) }); } catch (e) { res.status(500).json({ error: 'Could not count.' }); }
  });
  router.post('/librarian/media-sweep', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const limit = Math.min(2000, Math.max(1, parseInt((req.body || {}).limit, 10) || BATCH()));
    res.json({ ok: true, pass: await sweepOnce({ limit, userId: req.user.id }) });
  });
  router.post('/librarian/media-sweep/undo', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const since = (req.body || {}).since;
    if (!since || !Number.isFinite(new Date(since).getTime())) return res.status(400).json({ error: 'Say since when.' });
    try { res.json({ ok: true, ...(await undo(since)) }); } catch (e) { res.status(500).json({ error: 'Could not undo.' }); }
  });
}

let timer = null;
function start() {
  if (timer || !ENABLED()) return;
  timer = setInterval(() => { sweepOnce().catch(() => {}); }, INTERVAL_MIN() * 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(() => { sweepOnce().catch(() => {}); }, 2 * 60 * 1000).unref?.();
  logger.info(`[library/media-sweep] every ${INTERVAL_MIN()} min, ${BATCH()} items a pass, $${DAILY_USD().toFixed(2)} a day, audit ${AUDIT_APPLY() ? 'APPLIES' : 'proposes'}`);
}

module.exports = { sweepOnce, status, undo, mount, start, ENABLED, INTAKE_RE };
