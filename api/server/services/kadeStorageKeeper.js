'use strict';
/* THE STORAGE KEEPER (Sep 25 2026). Kade: "we do need a system on how long we keep SOME needless
 * stuff on backblaze. We shouldn't have to keep literally EVERYTHING."
 *
 * Once a day (after the 09:00 UTC backup) it lists every version in the bucket and every
 * unfinished upload, asks kadeStorageKeeperPlan.js what may go, and writes a report. The rules
 * live in that file. It never removes a visible Library file.
 *
 *   KADE_STORAGE_KEEPER          report (default): list what would go, remove nothing
 *                                on: remove it          off: do nothing
 *   KADE_STORAGE_KEEPER_UTC_HOUR hour of the daily pass (default 10)
 *
 * Admins: GET /api/kade/reading-room/storage-keeper for the latest report,
 * POST /api/kade/reading-room/storage-keeper/run to run a pass now in the current mode. */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { planStorage, RULES } = require('./kadeStorageKeeperPlan');

const HOUR = 3600000;
const MODE = () => {
  const mode = String(process.env.KADE_STORAGE_KEEPER || 'report').toLowerCase();
  return ['on', 'off'].includes(mode) ? mode : 'report';
};
const RUN_HOUR = () => {
  const hour = parseInt(process.env.KADE_STORAGE_KEEPER_UTC_HOUR, 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 10;
};
/** A pass that wants more than this is refused and reported, never done. */
const MOST = { versions: 25000, bytes: 300 * 1024 ** 3 };
const GB = 1024 ** 3;

const reportSchema = new mongoose.Schema(
  {
    at: { type: Date, index: true },
    mode: String,
    listed: { versions: Number, bytes: Number, uploads: Number },
    totals: mongoose.Schema.Types.Mixed,
    waiting: mongoose.Schema.Types.Mixed,
    sample: mongoose.Schema.Types.Mixed,
    done: { deleted: Number, aborted: Number, bytes: Number, failed: Number },
    refused: String,
    error: String,
    ms: Number,
  },
  { collection: 'kadestoragereports' },
);
const Report = mongoose.models.KadeStorageReport || mongoose.model('KadeStorageReport', reportSchema);

let running = false;

async function listVersions(client, bucket) {
  const { ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
  const versions = [];
  let KeyMarker;
  let VersionIdMarker;
  for (let page = 0; page < 1000; page++) {
    const out = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
    for (const v of out.Versions || []) {
      versions.push({ key: v.Key, versionId: v.VersionId, size: v.Size || 0, lastModified: v.LastModified, isLatest: !!v.IsLatest, deleteMarker: false });
    }
    for (const m of out.DeleteMarkers || []) {
      versions.push({ key: m.Key, versionId: m.VersionId, size: 0, lastModified: m.LastModified, isLatest: !!m.IsLatest, deleteMarker: true });
    }
    if (!out.IsTruncated) return versions;
    KeyMarker = out.NextKeyMarker;
    VersionIdMarker = out.NextVersionIdMarker;
  }
  throw new Error('the version listing did not end');
}

async function listUploads(client, bucket) {
  const { ListMultipartUploadsCommand } = require('@aws-sdk/client-s3');
  const uploads = [];
  let KeyMarker;
  let UploadIdMarker;
  for (let page = 0; page < 200; page++) {
    const out = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, KeyMarker, UploadIdMarker, MaxUploads: 1000 }));
    for (const u of out.Uploads || []) uploads.push({ key: u.Key, uploadId: u.UploadId, initiated: u.Initiated });
    if (!out.IsTruncated) return uploads;
    KeyMarker = out.NextKeyMarker;
    UploadIdMarker = out.NextUploadIdMarker;
  }
  throw new Error('the upload listing did not end');
}

/** Bytes an unfinished upload holds (its parts), so the report can say what aborting frees. */
async function uploadBytes(client, bucket, upload) {
  const { ListPartsCommand } = require('@aws-sdk/client-s3');
  let bytes = 0;
  let PartNumberMarker;
  for (let page = 0; page < 20; page++) {
    const out = await client.send(new ListPartsCommand({ Bucket: bucket, Key: upload.key, UploadId: upload.uploadId, PartNumberMarker, MaxParts: 1000 }));
    for (const p of out.Parts || []) bytes += p.Size || 0;
    if (!out.IsTruncated) break;
    PartNumberMarker = out.NextPartNumberMarker;
  }
  return bytes;
}

async function removeVersions(client, bucket, deletes) {
  const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  let deleted = 0;
  let failed = 0;
  let bytes = 0;
  for (let i = 0; i < deletes.length; i += 500) {
    const batch = deletes.slice(i, i + 500);
    const out = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((d) => ({ Key: d.key, VersionId: d.versionId })), Quiet: false },
    }));
    const gone = new Set((out.Deleted || []).map((d) => `${d.Key}\n${d.VersionId}`));
    for (const d of batch) if (gone.has(`${d.key}\n${d.versionId}`)) { deleted += 1; bytes += d.size; }
    failed += (out.Errors || []).length;
    if ((out.Errors || []).length) logger.warn(`[storage-keeper] ${out.Errors.length} removals failed, first: ${out.Errors[0].Key} ${out.Errors[0].Code}`);
  }
  return { deleted, failed, bytes };
}

async function abortUploads(client, bucket, aborts) {
  const { AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
  let aborted = 0;
  let failed = 0;
  let bytes = 0;
  for (const a of aborts) {
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: a.key, UploadId: a.uploadId }));
      aborted += 1;
      bytes += a.bytes;
    } catch (e) {
      failed += 1;
      logger.warn(`[storage-keeper] could not cancel the unfinished upload of ${a.key}: ${e.message}`);
    }
  }
  return { aborted, failed, bytes };
}

const gb = (bytes) => Math.round((bytes / GB) * 100) / 100;

/** One pass in the current mode. Never throws; the report says what happened. */
async function runOnce({ s3, bucket, reason = 'daily' }) {
  const mode = MODE();
  if (mode === 'off') return { skipped: 'off' };
  if (running) return { skipped: 'running' };
  running = true;
  const started = Date.now();
  const report = { at: new Date(), mode, done: { deleted: 0, aborted: 0, bytes: 0, failed: 0 } };
  try {
    const client = s3();
    const name = bucket();
    if (!client || !name) throw new Error('storage is not configured');
    const versions = await listVersions(client, name);
    const uploads = await listUploads(client, name);
    const plan = planStorage({ versions, uploads, now: Date.now() });
    for (const a of plan.aborts.slice(0, 300)) a.bytes = await uploadBytes(client, name, a).catch(() => 0);
    const totals = { ...plan.totals };
    if (plan.aborts.length) totals['unfinished-upload'] = { count: plan.aborts.length, bytes: plan.aborts.reduce((n, a) => n + a.bytes, 0) };
    const planned = plan.deletes.reduce((n, d) => n + d.size, 0) + plan.aborts.reduce((n, a) => n + a.bytes, 0);
    report.listed = { versions: versions.length, bytes: versions.reduce((n, v) => n + (v.size || 0), 0), uploads: uploads.length };
    report.totals = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { count: v.count, gb: gb(v.bytes) }]));
    report.waiting = { hiddenLibraryCount: plan.waiting.hiddenLibraryCount, hiddenLibraryGb: gb(plan.waiting.hiddenLibraryBytes) };
    report.sample = [...plan.aborts.slice(0, 10).map((a) => ({ reason: 'unfinished-upload', key: a.key, gb: gb(a.bytes) })), ...plan.deletes.slice(0, 40).map((d) => ({ reason: d.reason, key: d.key, gb: gb(d.size) }))];
    if (plan.deletes.length > MOST.versions || planned > MOST.bytes) {
      report.refused = `the pass wanted ${plan.deletes.length} versions and ${gb(planned)} GB, over the ${MOST.versions} / ${gb(MOST.bytes)} GB limit; nothing was removed`;
    } else if (mode === 'on') {
      const removed = await removeVersions(client, name, plan.deletes);
      const cancelled = await abortUploads(client, name, plan.aborts);
      report.done = { deleted: removed.deleted, aborted: cancelled.aborted, bytes: removed.bytes + cancelled.bytes, failed: removed.failed + cancelled.failed };
    }
    // Short lines: the log service cuts long ones, and these are what a session without an admin sign-in can read.
    logger.info(`[storage-keeper] ${reason} pass (${mode}): ${versions.length} versions, ${uploads.length} unfinished uploads, ${gb(report.listed.bytes)} GB`);
    for (const [kind, total] of Object.entries(report.totals)) {
      logger.info(`[storage-keeper] ${mode === 'on' ? 'removed' : 'would remove'} ${kind}: ${total.count}, ${total.gb} GB`);
    }
    logger.info(`[storage-keeper] waiting out 30 days: ${report.waiting.hiddenLibraryCount} deleted Library files, ${report.waiting.hiddenLibraryGb} GB`);
    if (mode === 'on') logger.info(`[storage-keeper] done: ${report.done.deleted} removed, ${report.done.aborted} uploads cancelled, ${gb(report.done.bytes)} GB, ${report.done.failed} failed`);
    if (report.refused) logger.warn(`[storage-keeper] REFUSED: ${report.refused}`);
  } catch (e) {
    report.error = String(e && e.message ? e.message : e).slice(0, 400);
    logger.warn(`[storage-keeper] ${reason} pass failed: ${report.error}`);
  } finally {
    report.ms = Date.now() - started;
    running = false;
  }
  try {
    await Report.create(report);
    const old = await Report.find({}, '_id').sort({ at: -1 }).skip(60).lean();
    if (old.length) await Report.deleteMany({ _id: { $in: old.map((r) => r._id) } });
  } catch (e) {
    logger.warn(`[storage-keeper] report not saved: ${e.message}`);
  }
  return report;
}

function mount(router, { requireJwtAuth, isAdmin, express, s3, bucket }) {
  router.get('/storage-keeper', requireJwtAuth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the library owner.' });
    try {
      const latest = await Report.findOne({}).sort({ at: -1 }).lean();
      res.json({ mode: MODE(), hourUTC: RUN_HOUR(), rules: RULES, running, latest });
    } catch (e) {
      res.status(500).json({ error: 'The storage report could not be read.' });
    }
  });
  router.post('/storage-keeper/run', requireJwtAuth, express.json({ limit: '1kb' }), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the library owner.' });
    if (running) return res.status(409).json({ error: 'A pass is already running.' });
    void runOnce({ s3, bucket, reason: 'requested' });
    res.status(202).json({ ok: true, mode: MODE() });
  });
}

/** Hourly check; runs once per UTC day at the set hour, and once soon after the first boot. */
function start({ s3, bucket }) {
  const due = async () => {
    if (MODE() === 'off') return;
    const latest = await Report.findOne({}, 'at').sort({ at: -1 }).lean().catch(() => null);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const ranToday = latest && new Date(latest.at).toISOString().slice(0, 10) === today;
    if (!latest || (!ranToday && now.getUTCHours() >= RUN_HOUR())) await runOnce({ s3, bucket, reason: latest ? 'daily' : 'first' });
  };
  setTimeout(() => void due().catch(() => {}), 10 * 60 * 1000).unref();
  setInterval(() => void due().catch(() => {}), HOUR).unref();
}

module.exports = { runOnce, mount, start, MODE };
