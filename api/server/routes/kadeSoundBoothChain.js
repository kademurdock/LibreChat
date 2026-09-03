'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothChain.js — rendering a long script in parts, in order, and
 * handing back ONE recording (Part 122, Sep 3 2026).
 *
 * Her ask: "If files are too long, we need a thing that cuts them off or
 * something auto." Split cuts (kadeSoundBoothSplit), stitch joins
 * (kadeSoundBoothStitch); this is the bit in the middle that walks the parts.
 *
 * WHY SEQUENTIAL, NOT PARALLEL: the bridge enforces one in-flight render per
 * user (`one render at a time`), and the endpoint runs workersMax 1. Firing
 * five parts at once would have four refused. Sequential is not a compromise
 * here, it is the shape of the lane — and with idleTimeout at 300 s the card
 * stays warm between parts, so parts 2..N are ~25 s each rather than a fresh
 * six-minute wake apiece.
 *
 * WHY THE POLL DRIVES IT: there is no worker process in the fork. `/status` is
 * already polled every 15 s by both the website and the phone, so the chain
 * advances there. The cost is honest and worth writing down: IF SHE CLOSES THE
 * APP MID-CHAIN, THE CHAIN PAUSES. It does not break and it does not lose the
 * parts already paid for — it resumes the next time the project is opened.
 * Every step is idempotent for exactly that reason.
 *
 * MONEY: each part is its own bridge job and each is checked against her daily
 * cap separately, so a chain CAN die halfway. That is not swallowed — the
 * project keeps the finished parts, the state says which part stopped it and
 * why, and `resume` picks it up when the cap rolls over. Losing four paid parts
 * because the fifth was refused would be the worst possible failure here.
 * ───────────────────────────────────────────────────────────────────────── */

const axios = require('axios');
/* Tolerant on purpose: this module's decision logic is worth testing on its
 * own, and a hard require on the app's logger would mean booting LibreChat to
 * check that every part gets the same voice seed. */
let logger;
try {
  ({ logger } = require('@librechat/data-schemas'));
} catch (_) {
  logger = console;
}
const { stitchMp3Buffers, durationOf, sayStitched } = require('./kadeSoundBoothStitch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_PARTS = parseInt(process.env.SOUNDBOOTH_MAX_PARTS || '12', 10);
const bridgeBase = () =>
  (process.env.KADE_BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');

/** Submit one part to the bridge. Returns its jobId, or throws with her words. */
async function submitPart({ userId, script, opts, partIndex, total }) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) throw new Error('The render lane is not configured here.');
  const body = {
    secret,
    userId: String(userId),
    agentId: 'soundbooth',
    agentName: 'Sound Booth',
    prompt: script,
    /* A part is a slice, not a thing she made: no gallery row, no push. The
     * joined recording gets both, once. */
    suppressAsset: true,
    reference_voice_url: opts?.reference_voice_url,
    background_sfx: opts?.background_sfx,
    /* THE SAME SEED ON EVERY PART. Scenema picks a random voice per render off
     * the description unless pinned, so an unpinned five-part story is five
     * subtly different readers. This is the single most important line in the
     * file. */
    seed: Number.isInteger(opts?.seed) ? opts.seed : deterministicSeed(userId, script, partIndex),
    pace: opts?.pace,
    keep_wav: opts?.keep_wav,
  };
  const r = await axios.post(`${bridgeBase()}/audio/scenema/start`, body, {
    headers: { 'User-Agent': UA },
    timeout: 20000,
  });
  const jobId = r.data?.jobId;
  if (!jobId) throw new Error(r.data?.error || 'That part could not start.');
  logger.info(`[soundbooth/chain] part ${partIndex + 1}/${total} queued job=${jobId} user=${userId}`);
  return { jobId, estimate: r.data?.estimate || null };
}

/* A stable seed for a whole piece: same project, same voice on every part.
 * partIndex is deliberately NOT mixed in. */
function deterministicSeed(userId, _script, _partIndex) {
  let h = 2166136261;
  const s = String(userId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100000;
}

/** Ask the bridge what a job is doing. Never throws — an unreadable bridge is
 *  'unknown', not 'failed', because failing a paid part on a network blip is
 *  how she loses money to a hiccup. */
async function readJob(jobId) {
  const secret = process.env.BRIDGE_SECRET;
  try {
    const r = await axios.get(
      `${bridgeBase()}/audio/scenema/status?jobId=${encodeURIComponent(jobId)}&secret=${encodeURIComponent(secret)}`,
      { headers: { 'User-Agent': UA }, timeout: 15000 },
    );
    return r.data || null;
  } catch (e) {
    if (e?.response?.status === 404) return { state: 'failed', error: 'that part is no longer on the board' };
    return null;
  }
}

/** Plain-English progress for a chain in flight. Said, not shown. */
function sayProgress(project, jobWait) {
  const parts = project.parts || [];
  const total = parts.length;
  const doneCount = parts.filter((p) => p.state === 'done').length;
  const current = parts.findIndex((p) => p.state === 'queued' || p.state === 'running');
  const at = current >= 0 ? current + 1 : Math.min(doneCount + 1, total);
  const tail = jobWait?.spoken ? ` ${jobWait.spoken}` : '';
  return `Part ${at} of ${total}.${tail}`;
}

/**
 * Move a multi-part project forward by one step. Idempotent: safe to call on
 * every poll, from either surface, as many times as it likes.
 * @returns {Promise<{changed:boolean, state:string, spoken:string, jobId?:string}>}
 */
async function advance(project, { onStitched } = {}) {
  const parts = project.parts || [];
  if (!parts.length) return { changed: false, state: project.state, spoken: '' };

  /* 1. Reconcile the part that is in flight. */
  const inFlight = parts.find((p) => p.jobId && (p.state === 'queued' || p.state === 'running'));
  let wait = null;
  if (inFlight) {
    const j = await readJob(inFlight.jobId);
    if (!j) return { changed: false, state: project.state, spoken: sayProgress(project, null) };
    wait = j.wait || null;
    if (j.state === 'done' && j.result?.url) {
      inFlight.state = 'done';
      inFlight.url = j.result.url;
      inFlight.durationS = j.result.durationS || null;
      inFlight.costUSD = typeof j.costUSD === 'number' ? j.costUSD : 0;
      project.costUSD = (project.costUSD || 0) + (inFlight.costUSD || 0);
    } else if (j.state === 'failed' || j.state === 'cancelled') {
      inFlight.state = 'failed';
      inFlight.error = String(j.error || j.state).slice(0, 300);
      project.state = 'failed';
      /* The finished parts are KEPT. She paid for them. */
      project.lastError = `Part ${inFlight.index + 1} of ${parts.length} stopped: ${inFlight.error} The ${parts.filter((p) => p.state === 'done').length} parts already made are kept — say render again to pick up where it stopped.`;
      await project.save();
      return { changed: true, state: 'failed', spoken: project.lastError };
    } else {
      /* still working */
      project.state = j.state === 'running' ? 'running' : 'queued';
      await project.save();
      return { changed: false, state: project.state, spoken: sayProgress(project, wait) };
    }
  }

  /* 2. Anything left to send? */
  const next = parts.find((p) => p.state === 'pending');
  if (next) {
    try {
      const { jobId } = await submitPart({
        userId: project.user,
        script: next.script,
        opts: project.options || {},
        partIndex: next.index,
        total: parts.length,
      });
      next.jobId = jobId;
      next.state = 'queued';
      project.state = 'queued';
      project.jobs = [...(project.jobs || []), jobId].slice(-40);
      await project.save();
      return { changed: true, state: 'queued', jobId, spoken: sayProgress(project, null) };
    } catch (e) {
      const msg = String(e?.response?.data?.error || e.message || 'that part could not start');
      next.state = 'failed';
      next.error = msg.slice(0, 300);
      project.state = 'failed';
      project.lastError = `Part ${next.index + 1} of ${parts.length} could not start: ${msg} The ${parts.filter((p) => p.state === 'done').length} parts already made are kept — say render again to pick up where it stopped.`;
      await project.save();
      return { changed: true, state: 'failed', spoken: project.lastError };
    }
  }

  /* 3. Every part is done — join them. */
  if (parts.every((p) => p.state === 'done')) {
    if (project.stitchedAssetId) {
      return { changed: false, state: 'done', spoken: 'Ready.' };
    }
    const result = await stitch(project, { onStitched });
    return { changed: true, state: project.state, spoken: result.spoken };
  }
  return { changed: false, state: project.state, spoken: sayProgress(project, wait) };
}

/** Download every part, join, store, and file ONE gallery row. */
async function stitch(project, { onStitched } = {}) {
  const parts = project.parts || [];
  try {
    const buffers = [];
    for (const p of parts) {
      const r = await axios.get(p.url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: { 'User-Agent': UA },
      });
      buffers.push(Buffer.from(r.data));
    }
    const { buffer, notes } = await stitchMp3Buffers(buffers);
    const seconds = (await durationOf(buffer)) || parts.reduce((a, p) => a + (p.durationS || 0), 0);

    const { saveBufferToS3 } = require('@librechat/api');
    const fileName = `soundbooth-${String(project._id)}-${Date.now()}.mp3`;
    const url = await saveBufferToS3({
      userId: String(project.user),
      buffer,
      fileName,
      /* 'audios', matching what kadeAsset's own mirror uses for audio — a
       * bucket path is not cosmetic, it is where /my-assets goes looking. */
      basePath: 'audios',
    });

    const { logKadeAsset } = require('~/models/kadeAsset');
    const asset = await logKadeAsset({
      userId: String(project.user),
      kind: 'audio',
      service: 'scenema_audio',
      url,
      prompt: project.script,
      model: 'scenema-audio',
      costUSD: project.costUSD || 0,
      metadata: {
        via: 'sound-booth',
        projectId: String(project._id),
        joinedFromParts: parts.length,
        durationS: seconds,
        engine: 'scenema-audio',
      },
    });
    project.stitchedAssetId = asset?._id ? String(asset._id) : 'filed';
    if (asset?._id) project.assets = [...(project.assets || []), String(asset._id)].slice(-40);
    project.state = 'done';
    project.lastError = undefined;
    await project.save();
    const spoken = sayStitched(parts.length, seconds, notes);
    logger.info(`[soundbooth/chain] stitched ${parts.length} parts, ${seconds}s, project=${project._id}`);
    if (typeof onStitched === 'function') {
      try {
        await onStitched({ project, seconds, spoken });
      } catch (_) {
        /* a push that fails must not un-make the recording */
      }
    }
    return { spoken };
  } catch (e) {
    /* The parts survive a failed join. Joining is cheap and repeatable; the
     * renders are not, and they are what cost money. */
    project.state = 'failed';
    project.lastError = `The parts all rendered, but joining them failed: ${String(e.message).slice(0, 160)} Nothing was lost — say render again to retry just the join.`;
    await project.save();
    logger.error('[soundbooth/chain] stitch failed:', e);
    return { spoken: project.lastError };
  }
}

module.exports = { advance, stitch, submitPart, sayProgress, deterministicSeed, MAX_PARTS };
