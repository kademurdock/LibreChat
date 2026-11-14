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
 * (Those were Flash Lite's figures. Nov 13 2026: segments go to
 * google/gemini-3.8-flash on Google Vertex, about 91 tokens a second of video
 * plus each segment's thinking; see VIDEO_MODEL and `estimate` below.)
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
const { openRouterCost } = require('~/server/services/kadeRealCost');
const { limits, mediaModel, mediaProvider, pause, readReply, refusalTries, videoRates } = require('~/server/services/kadeMediaRoute');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
/** The library's own model setting, separately configurable from the image reader: MiMo Pro. */
const MODEL = () => process.env.KADE_LIBRARY_VISION_MODEL || 'xiaomi/mimo-v2.6-pro';
/**
 * The model a segment is really sent to. Everything this file sends is video, and on Nov 13 2026 no
 * zero-retention MiMo host hears a video's soundtrack any more (Novita stopped serving MiMo), so a
 * MiMo library sends its segments to the video model: KADE_VIDEO_MODEL, by default
 * google/gemini-3.8-flash on Google Vertex (kadeMediaRoute `mediaModel`). Every setting below is
 * this model's: the segment length, how it thinks, its deadline, its route, how its reply is read,
 * the estimate, the price of a reply that names no cost, and the model the description records.
 */
const VIDEO_MODEL = () => mediaModel(MODEL(), 'video', process.env);
const onMimo = () => VIDEO_MODEL().startsWith('xiaomi/mimo-');
const onGoogle = () => VIDEO_MODEL().startsWith('google/');
/* USD per million tokens, for the estimate and for a reply that names no cost. The KADE_LIBRARY_
 * rates are the library's own model's (MiMo Pro's by default); a segment that goes to the video
 * model instead is priced at that model's (kadeMediaRoute `videoRates`). */
const RATES = () =>
  VIDEO_MODEL() === MODEL()
    ? { in: Number(process.env.KADE_LIBRARY_IN_USD_PER_M || 0.435), out: Number(process.env.KADE_LIBRARY_OUT_USD_PER_M || 0.87) }
    : videoRates(process.env);
/* Prompt tokens a second of video, for the estimate only; the provider's actual receipt is booked.
 * Google counted 91 a second on Nov 13 2026 (a 15 s clip: 990 video tokens, one picture of 66 a
 * second, and 375 for its sound), so 100. The 400 for other models is the older, roomier guess. */
const TOKENS_PER_SECOND = () => (onGoogle() ? 100 : 400);
/**
 * How many tokens a Google look may spend thinking (OpenRouter's `reasoning.max_tokens`). The
 * described-video engine measured this model on Sep 26 2026 (providers.ts `closeReasoningTokens`):
 * looks that thought 1,125 to 1,786 tokens stretched their timeline 1.6 times, every look that
 * thought 3,282 or more kept time, and a budget of 8,000 thought 4,703 to 7,248 in 6 of 7 looks,
 * the cheapest setting that stayed in step. Scene times here are when the player pauses and speaks,
 * so the same budget, inside the same 24,000 output tokens the engine gives it: 16,000 are left
 * for the scenes.
 */
const GOOGLE_THINKING_TOKENS = 8000;
/**
 * Segment length. Oct 16 2026: Novita, then the zero-retention host that heard a MiMo video, looked
 * at about 150 frames of a clip whatever its length; a 15-minute segment had not answered after ten
 * minutes, a 5-minute one answered in 51 s. So MiMo segments are 5 minutes unless set.
 * Nov 13 2026: Google looks at one picture a second however long the clip is, so length costs it
 * no detail, but its segments are 5 minutes too. That is inside what the described-video engine has
 * proven on this route (clips of up to 480 s, thinking 8,000 tokens in 24,000, answered within 300
 * s). The scenes of five minutes of fast cuts fit the 16,000 tokens left for them, where fifteen
 * minutes of them might not, and a reply cut off mid-JSON cannot be read. And a look that fails or
 * is refused costs a listener five minutes of description, not fifteen. Other models keep 15.
 */
const SEGMENT_SECONDS = () => Math.max(60, parseInt(process.env.KADE_DESCRIBE_SEGMENT_SECONDS, 10) || (onMimo() || onGoogle() ? 300 : 900));
/**
 * How long one look may take. MiMo on Novita needed ten minutes for the upload, the look and its
 * thinking. Google Vertex writes about 140 tokens a second (providers.ts `planFor`), so a reply of
 * all 24,000 tokens takes about three minutes; the engine gives a look on this route 300 s, and
 * 420 s to its largest (48,000 tokens). 420 s here, since a look that times out fails the job.
 */
const REQUEST_MS = () => (onGoogle() ? 420000 : 600000);
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

/** What a run would cost, before anyone presses the button, on the model it will really run on. */
function estimate(seconds) {
  const s = Math.max(1, seconds || 0);
  const segments = Math.ceil(s / SEGMENT_SECONDS());
  const inTokens = s * TOKENS_PER_SECOND();
  /* ~4 tokens a second of description. On Google every segment's thinking is billed as output too,
   * at nearly five times MiMo's rate, so its estimate counts the whole budget and all the words. */
  const words = 40 + s * 4;
  const outTokens = onGoogle() ? words + segments * GOOGLE_THINKING_TOKENS : Math.min(6000, words);
  const rates = RATES();
  const usd = (inTokens * rates.in + outTokens * rates.out) / 1e6;
  return { seconds: s, segments, usd: Math.round(usd * 10000) / 10000, model: VIDEO_MODEL() };
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

/**
 * How a look thinks. MiMo thinks at medium effort, as it has since Oct 13 2026. Google gets a
 * budget (`GOOGLE_THINKING_TOKENS`): it cannot switch thinking off, and left to itself it may think
 * until the 24,000 output tokens are gone (the engine's high-effort looks at 24,000 were cut off
 * with no reply 2 of 3 times). Any other model is asked as before, with no reasoning setting.
 */
const thinking = () => {
  if (onMimo()) return { reasoning: { enabled: true, effort: 'medium' } };
  if (onGoogle()) return { reasoning: { max_tokens: GOOGLE_THINKING_TOKENS } };
  return {};
};

/**
 * One look at a shrunk segment, on the model it is really sent to (`VIDEO_MODEL`). Only
 * zero-retention hosts that hear the soundtrack (kadeMediaRoute: Google Vertex for the video model,
 * never Google AI Studio; a MiMo video only KADE_VIDEO_HOSTS, never DeepInfra, which drops the
 * sound and looks at a fixed handful of frames), so the description can leave out what the audio
 * already says. json_object, not json_schema: Novita refused a strict schema. `refused` (a declined
 * or filtered reply) and `unheard` (a host that cannot hear it answered) come back with no text;
 * their cost is still counted.
 */
async function askModel(fileBuf, mime, prompt) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not configured');
  const model = VIDEO_MODEL();
  const dataUrl = `data:${mime};base64,${fileBuf.toString('base64')}`;
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model, max_tokens: 24000, ...thinking(), messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: dataUrl } }] }], usage: { include: true }, response_format: { type: 'json_object' }, provider: mediaProvider(model, 'video', process.env) },
    /* A background job: time for the upload, the look and its thinking (`REQUEST_MS`). */
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: REQUEST_MS() },
  );
  const { text, refused, unheard } = readReply(r.data, model, 'video', process.env);
  const usage = r.data?.usage || {};
  const rates = RATES();
  const est = ((Number(usage.prompt_tokens) || 0) * rates.in + (Number(usage.completion_tokens) || 0) * rates.out) / 1e6;
  /* Part 295: OpenRouter's fee plus, with her Google key in OpenRouter (BYOK), Google's charge. */
  const costUSD = openRouterCost(usage) ?? est;
  return { text: text || '', costUSD, tokens: usage.prompt_tokens || 0, refused, unheard, provider: r.data?.provider || '' };
}

/**
 * Asks about one segment. MiMo is asked again after a refusal (Novita's filter refused a harmless
 * clip now and then, in bursts): up to three tries, 20 s apart (kadeMediaRoute `limits`). Google
 * declines the same clip again, so it is asked once (`refusalTries`). A segment still refused comes
 * back `refused` with no text, and the job carries on without it. An answer from a host that
 * cannot hear the soundtrack stops the job with a plain reason rather than saving it. `costUSD`
 * carries every call's cost either way.
 */
async function lookAt(fileBuf, mime, prompt) {
  let costUSD = 0;
  const tries = refusalTries(VIDEO_MODEL());
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await pause(limits.refusalMs);
    const r = await askModel(fileBuf, mime, prompt);
    costUSD += r.costUSD;
    if (r.unheard) {
      throw Object.assign(new Error(`The video went to ${r.provider}, which cannot hear its soundtrack, so that description was not used.`), { costUSD });
    }
    if (!r.refused) return { ...r, costUSD };
    logger.warn(`[library/describe] ${r.provider || 'the host'} refused a segment (content_filter), try ${attempt} of ${tries}`);
  }
  return { text: '', costUSD, refused: true };
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
    const out = { summary: '', scenes: [], costUSD: 0, frames: 0, model: VIDEO_MODEL(), segments, from: winStart, to: winEnd };
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
      let r;
      try {
        r = await lookAt(buf, 'video/mp4', INSTRUCTION(start, total, title, category) + (to > 0 ? ' This is a RECAP of the stretch a viewer just watched; be complete about what happened in it.' : ''));
      } catch (e) {
        /* What the job spent before it stopped, for the server log. */
        e.costUSD = out.costUSD + (e.costUSD || 0);
        throw e;
      }
      out.costUSD += r.costUSD;
      if (r.refused) {
        /* Said where it happens, so a listener knows the gap is there, not that nothing happened. */
        out.refused = (out.refused || 0) + 1;
        out.scenes.push({ t: Math.round(start * 10) / 10, text: `The describing service would not describe this part, from ${Math.round(start)} to ${Math.round(start + len)} seconds.` });
        await fs.rm(small, { force: true });
        continue;
      }
      const parsed = parseScenes(r.text);
      out.frames += Math.round(len * 6);
      if (parsed.summary) summaries.push(parsed.summary);
      for (const s of parsed.scenes) out.scenes.push({ t: Math.round((start + s.t) * 10) / 10, text: s.text });
      await fs.rm(small, { force: true });
    }
    if (out.refused && out.refused === segments) {
      throw Object.assign(new Error('The video service would not describe this video. Try again later.'), { costUSD: out.costUSD });
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
        logger.warn(`[library/describe] "${job.title}" track ${job.t} FAILED${e.costUSD > 0 ? ` after $${e.costUSD.toFixed(4)} of model calls` : ''}: ${e.message} ${String(e.stderr || '').slice(0, 300)}`);
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

module.exports = { enqueue, estimate, progressOf: (bookId, t) => progress[`${bookId}:${t}`] || '', queued: () => queue.length, ENABLED, _internals: { parseScenes, INSTRUCTION, askModel, lookAt, describeTrack } };
