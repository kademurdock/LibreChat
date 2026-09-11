'use strict';
/* ----------------------------------------------------------------------------
 * THE LIBRARY'S EYES — AI video description for anything with pictures in it
 * (Part 181 continued, Sep 11 2026). Her words: "any file that has video data
 * that is in the library would have a feature right there where you could get
 * an ai video description, like a blind VDS type thing that tells you what's
 * visually going on in the video, whether it's a commercial or whatever."
 *
 * The /describe tool already knows how to watch a video (kadeDescribe.js:
 * Gemini Flash Lite through OpenRouter, the whole file as a data URL, 30 MB
 * cap, prose out). A library video can be a 700 MB movie soundtrack with
 * pictures, so this file adds the two things that lane lacks:
 *
 *   1. SHRINK: ffmpeg (on the Railway image) re-encodes the track to a small
 *      360p, 6-fps, mono-audio MP4 that fits the model's window — a 15-minute
 *      segment lands well under 30 MB.
 *   2. SEGMENT: anything longer than one segment is described piece by piece,
 *      each piece's scene times offset into the whole, then joined.
 *
 * The model answers in JSON — a summary plus scenes [{t, text}] — so the
 * player can pause at each scene and speak it (extended audio description),
 * and so a screen reader can read it as a list. Gemini charges roughly 300
 * tokens a second of video, so a 30-second commercial is a tenth of a cent
 * and a two-hour movie about a quarter; the estimate is shown before a run
 * and the real cost is logged to kadeusage as `describe`.
 *
 * One job at a time per server (the queue is in memory), `KADE_DESCRIBE_MAX_MINUTES`
 * caps a single track (default 180), `KADE_DESCRIBE_DAILY_USD` caps the day
 * (default 2.00). Kill switch: `KADE_LIBRARY_DESCRIBE=0`.
 * -------------------------------------------------------------------------- */
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { logger } = require('@librechat/data-schemas');
const { logKadeUsage, KadeUsage } = require('~/models/kadeUsage');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
/** The library's own model knob. The platform's KADE_VISION_MODEL is Gemini Pro
 * (a minute of video cost $0.045 on the Sep 11 smoke); the library defaults to
 * Flash Lite so a two-hour film stays under a dollar. */
const MODEL = () => process.env.KADE_LIBRARY_VISION_MODEL || 'google/gemini-3.1-flash'; // her word: Flash is fine as long as the descriptions are not cost-cut
const IN_USD_PER_M = () => Number(process.env.KADE_LIBRARY_IN_USD_PER_M || 0.3); // Gemini 3.1 Flash list price, for the estimate shown before a run
const OUT_USD_PER_M = () => Number(process.env.KADE_LIBRARY_OUT_USD_PER_M || 2.5);
const TOKENS_PER_SECOND = 300; // Gemini video (+ audio) tokens per second of media, roughly
const SEGMENT_SECONDS = () => Math.max(60, parseInt(process.env.KADE_DESCRIBE_SEGMENT_SECONDS, 10) || 900);
const MAX_MINUTES = () => Math.max(1, parseFloat(process.env.KADE_DESCRIBE_MAX_MINUTES) || 180);
const DAILY_USD = () => Math.max(0, parseFloat(process.env.KADE_DESCRIBE_DAILY_USD) || 2.0);
const ENABLED = () => process.env.KADE_LIBRARY_DESCRIBE !== '0';
const MODEL_BYTES_CAP = 28 * 1024 * 1024;

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(-1500); return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function probeDuration(file) {
  try {
    const r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 60000);
    const d = parseFloat(r.stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch (e) {
    return 0;
  }
}

/** What a run would cost, before anyone presses the button. */
function estimate(seconds) {
  const s = Math.max(1, seconds || 0);
  const inTokens = s * TOKENS_PER_SECOND;
  const outTokens = Math.min(6000, 40 + s * 4); // ~4 tokens a second of description
  const usd = (inTokens * IN_USD_PER_M() + outTokens * OUT_USD_PER_M()) / 1e6;
  return { seconds: s, segments: Math.ceil(s / SEGMENT_SECONDS()), usd: Math.round(usd * 10000) / 10000, model: MODEL() };
}

async function spentToday() {
  try {
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const rows = await KadeUsage.aggregate([{ $match: { service: 'describe', createdAt: { $gte: since }, 'metadata.source': 'library' } }, { $group: { _id: null, usd: { $sum: '$costUSD' } } }]);
    return rows.length ? rows[0].usd || 0 : 0;
  } catch (_) { return 0; }
}

const INSTRUCTION = (offsetSeconds, totalSeconds, title, category) =>
  `You are the eyes of a blind viewer. This is ${offsetSeconds > 0 ? `a segment (starting at ${Math.round(offsetSeconds)} seconds) of ` : ''}a ${category || 'video'} titled "${title}"${totalSeconds ? ` that runs about ${Math.round(totalSeconds / 60)} minutes in total` : ''}. ` +
  'Write audio description in the style of a described-video track: present tense, concrete, visual facts only (what is on screen, who is there and what they look like, what they do, camera moves, on-screen text read word for word, logos, prices, phone numbers, dates). Say what kind of thing it is when that is visible (a commercial for what, a station ID, a news segment, a show). Do not repeat what the audio already says unless it is written on screen. ' +
  'Answer ONLY with JSON: {"summary": "two or three sentences about the whole segment", "scenes": [{"t": <seconds from the START OF THIS SEGMENT, a number>, "text": "one or two sentences"}]}. ' +
  'Make a scene at every cut or new shot that matters — commercials and montages get a scene every few seconds, a talking-head show every half minute or so. Keep each scene short enough to be spoken in under ten seconds.';

async function askModel(fileBuf, mime, prompt) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not configured');
  const dataUrl = `data:${mime};base64,${fileBuf.toString('base64')}`;
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model: MODEL(), max_tokens: 6000, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: dataUrl } }] }], usage: { include: true }, response_format: { type: 'json_object' } },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 300000 },
  );
  const text = r.data?.choices?.[0]?.message?.content;
  const usage = r.data?.usage || {};
  const est = ((Number(usage.prompt_tokens) || 0) * IN_USD_PER_M() + (Number(usage.completion_tokens) || 0) * OUT_USD_PER_M()) / 1e6;
  const costUSD = typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : est;
  return { text: typeof text === 'string' ? text.trim() : '', costUSD, tokens: usage.prompt_tokens || 0 };
}

function parseScenes(text) {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j = null;
  try { j = JSON.parse(clean); } catch (_) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { j = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!j) return { summary: clean.slice(0, 2000), scenes: [] };
  const scenes = Array.isArray(j.scenes) ? j.scenes.map((s) => ({ t: Math.max(0, parseFloat(s.t) || 0), text: String(s.text || '').trim().slice(0, 600) })).filter((s) => s.text) : [];
  return { summary: String(j.summary || '').trim().slice(0, 2000), scenes };
}

/** The whole job: download → probe → shrink+segment → describe → join. */
async function describeTrack({ signedUrl, mime, title, category, onProgress, from = 0, to = 0 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-desc-'));
  const inFile = path.join(dir, 'in.bin');
  try {
    onProgress && onProgress('downloading');
    const resp = await axios.get(signedUrl, { responseType: 'stream', timeout: 600000 });
    await new Promise((res, rej) => { const w = fsSync.createWriteStream(inFile); resp.data.pipe(w); w.on('finish', res); w.on('error', rej); resp.data.on('error', rej); });
    const total = await probeDuration(inFile);
    if (!total) throw new Error('Could not read the video (ffprobe found no duration).');
    // a RANGE ("what happened in the last five minutes") describes only that window
    const winStart = Math.max(0, Math.min(from || 0, total));
    const winEnd = to > 0 ? Math.max(winStart, Math.min(to, total)) : total;
    const span = winEnd - winStart;
    if (!(to > 0) && total > MAX_MINUTES() * 60) throw new Error(`That runs ${Math.round(total / 60)} minutes; the cap is ${MAX_MINUTES()} minutes a track.`);
    if (to > 0 && span > 30 * 60) throw new Error('A recap covers at most thirty minutes at a time.');
    const seg = SEGMENT_SECONDS();
    const segments = Math.max(1, Math.ceil(span / seg));
    const out = { summary: '', scenes: [], costUSD: 0, frames: 0, model: MODEL(), segments, from: winStart, to: winEnd };
    const summaries = [];
    for (let i = 0; i < segments; i++) {
      const start = winStart + i * seg;
      const len = Math.min(seg, winEnd - start);
      if (len <= 0) break;
      onProgress && onProgress(`segment ${i + 1} of ${segments}`);
      const small = path.join(dir, `seg${i}.mp4`);
      // 360p, 6 fps, mono 32 kbps AAC: a 15-minute piece is ~15-25 MB.
      const args = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', String(start), '-t', String(len), '-i', inFile,
        '-vf', 'scale=-2:360,fps=6', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '1', '-b:a', '32k', '-movflags', '+faststart', small];
      await run(FFMPEG, args, 15 * 60 * 1000);
      let buf = await fs.readFile(small);
      if (buf.length > MODEL_BYTES_CAP) {
        // still too big (busy picture): drop to 240p / 4 fps
        const smaller = path.join(dir, `seg${i}b.mp4`);
        await run(FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', small, '-vf', 'scale=-2:240,fps=4', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-b:a', '24k', '-movflags', '+faststart', smaller], 10 * 60 * 1000);
        buf = await fs.readFile(smaller);
        if (buf.length > MODEL_BYTES_CAP) throw new Error('Even shrunk, a segment is too big for the model. Lower KADE_DESCRIBE_SEGMENT_SECONDS.');
      }
      const r = await askModel(buf, 'video/mp4', INSTRUCTION(start, total, title, category) + (to > 0 ? ' This is a RECAP of the stretch a viewer just watched; be complete about what happened in it.' : ''));
      const parsed = parseScenes(r.text);
      out.costUSD += r.costUSD;
      out.frames += Math.round(len * 6);
      if (parsed.summary) summaries.push(parsed.summary);
      for (const s of parsed.scenes) out.scenes.push({ t: Math.round((start + s.t) * 10) / 10, text: s.text });
      await fs.rm(small, { force: true });
    }
    out.scenes.sort((a, b) => a.t - b.t);
    out.summary = summaries.join(' ').slice(0, 4000);
    out.seconds = total;
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── the queue: one at a time, in memory ─────────────────────────────────── */
const queue = [];
let running = false;
const progress = {}; // `${bookId}:${t}` -> text

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const k = `${job.bookId}:${job.t}`;
      try {
        const spent = await spentToday();
        if (spent >= DAILY_USD()) throw new Error(`Today's description allowance ($${DAILY_USD().toFixed(2)}) is used up; it resets at midnight UTC.`);
        const result = await describeTrack({ ...job, onProgress: (p) => { progress[k] = p; } });
        await job.onDone(null, result);
        logKadeUsage({ userId: job.userId, service: 'describe', quantity: 1, unit: 'items', costUSD: result.costUSD, metadata: { source: 'library', book: job.bookId, track: job.t, model: result.model, seconds: result.seconds, segments: result.segments, recap: job.to > 0 ? `${Math.round(job.from)}-${Math.round(job.to)}` : '' } });
        logger.info(`[library/describe] "${job.title}" track ${job.t}${job.to > 0 ? ` recap ${Math.round(job.from)}-${Math.round(job.to)}s` : ''}: ${result.scenes.length} scenes, ${Math.round(result.seconds)} s, ${result.segments} segment(s), $${result.costUSD.toFixed(4)}`);
      } catch (e) {
        logger.warn(`[library/describe] "${job.title}" track ${job.t} FAILED: ${e.message} ${String(e.stderr || '').slice(0, 300)}`);
        await job.onDone(e, null).catch(() => {});
      } finally {
        delete progress[k];
      }
    }
  } finally {
    running = false;
  }
}

function enqueue(job) {
  if (!ENABLED()) throw new Error('Video descriptions are switched off on this server.');
  if (queue.some((j) => j.bookId === job.bookId && j.t === job.t && (j.to || 0) === (job.to || 0) && (j.from || 0) === (job.from || 0))) return queue.length;
  queue.push(job);
  progress[`${job.bookId}:${job.t}`] = `waiting (${queue.length} ahead)`;
  setImmediate(drain);
  return queue.length;
}

module.exports = { enqueue, estimate, progressOf: (bookId, t) => progress[`${bookId}:${t}`] || '', queued: () => queue.length, ENABLED, _internals: { parseScenes, INSTRUCTION } };
