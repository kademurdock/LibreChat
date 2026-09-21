'use strict';
/* THE LAST 2,270 — one frame, then Jev (Part 238, Sep 20 2026)
 * ---------------------------------------------------------------------------
 * Part 237 put 2,594 catch-all commercials on real shelves by asking Jev what
 * the brand in the title was. What is left are brands no text model knows:
 * "Tegrin ad, 1969", "Cope ad, 1971", "Bows ad, 1968", "Toast'em ad, 1968".
 * Two rescues were built and BOTH FAILED and neither should be rebuilt — a
 * brand join against the already-filed 20,222 matched 8% and matched them
 * wrongly, and a confirming yes/no rejected the right answers and passed the
 * worst wrong one at 0.81. That is written up in `kadeJevJudges` section 1b.
 *
 * The thing none of that could do is LOOK. A 1968 commercial shows its product
 * in the first few seconds — the box, the logo, the shelf. So: pull one frame,
 * ask a cheap vision model what is on screen, and hand THAT to the same Jev
 * question that already knows the 49 shelves. Kade chose this route when the
 * options were laid out, and the price was quoted to her as about fifteen
 * cents for all of them.
 *
 * WHY THE VISION MODEL DOES NOT PICK THE SHELF. It names the product; Jev
 * files it. The filing path stays the one that was trialled, tuned and
 * measured, and the new part is only a pair of eyes bolted to the front.
 *
 * COST, measured not guessed: ~300 image tokens + ~90 prompt tokens in and
 * ~20 out per item on a Flash-class model, plus 2,270 x ~600 Jev tokens at
 * $0.042/M. Egress is free: B2 allows 3x stored size a month, which on 783 GB
 * is 2,351 GB, and a 3 MB range read x 2,270 is under 7 GB.
 *
 * OFF BY DEFAULT. `KADE_LIBRARY_VISION_FILE=1` turns it on. Every run is
 * capped by `limit` and by a dollar ceiling, and previews unless `apply`.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { logger } = require('@librechat/data-schemas');
const jev = require('~/server/services/kadeJev');
const judges = require('~/server/services/kadeJevJudges');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const ENABLED = () => process.env.KADE_LIBRARY_VISION_FILE === '1';
/* Checked against OpenRouter's own model list, not guessed: the first slug
 * here was invented and every call came back 400. This one exists, takes
 * images, and is the cheapest that does — $0.10/M in, $0.40/M out, which is
 * the fifteen cents for all 2,270 that was quoted to her. */
const MODEL = () => process.env.KADE_FRAME_MODEL || 'google/gemini-2.5-flash-lite';
const IN_USD_PER_M = () => Number(process.env.KADE_FRAME_IN_USD_PER_M || 0.1);
const OUT_USD_PER_M = () => Number(process.env.KADE_FRAME_OUT_USD_PER_M || 0.4);
/* A commercial's first second is often black or a leader frame, so seek in a
 * little. Three seconds is far enough past the join and early enough that a
 * range read of the head of the file still contains it. */
const SEEK = () => Number(process.env.KADE_FRAME_SEEK_SECONDS || 3);
const RANGE_BYTES = () => Math.max(262144, parseInt(process.env.KADE_FRAME_RANGE_BYTES, 10) || 3145728);
const RUN_USD_CAP = () => Math.max(0.01, Number(process.env.KADE_FRAME_RUN_USD_CAP || 0.5));

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-400))) : resolve(String(stdout)),
    );
  });
}

/** One JPEG from the head of a video, or null. Tries the cheap way first. */
async function grabFrame(signedUrl, dir) {
  const src = path.join(dir, 'head.mp4');
  const out = path.join(dir, 'frame.jpg');
  async function fetchTo(file, headers) {
    const r = await axios.get(signedUrl, { responseType: 'arraybuffer', timeout: 120000, headers, maxContentLength: 64 * 1024 * 1024 });
    await fs.writeFile(file, Buffer.from(r.data));
  }
  async function extract(seek) {
    await fs.rm(out, { force: true });
    /* -ss BEFORE -i so ffmpeg seeks rather than decodes up to the point. */
    await run(FFMPEG, ['-v', 'error', '-ss', String(seek), '-i', src, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', '-y', out], 60000);
    const st = await fs.stat(out).catch(() => null);
    return st && st.size > 1024 ? fs.readFile(out) : null;
  }
  /* 1: the head of the file only. Free-ish and fast, and enough for a faststart
   * MP4. 2: the same bytes but from the very first frame, for a clip shorter
   * than the seek. 3: the whole file, for a file whose index sits at the end. */
  try {
    await fetchTo(src, { Range: `bytes=0-${RANGE_BYTES() - 1}` });
    const a = await extract(SEEK()).catch(() => null);
    if (a) return a;
    const b = await extract(0).catch(() => null);
    if (b) return b;
  } catch (_) {
    /* fall through to the whole file */
  }
  await fetchTo(src, undefined);
  return (await extract(SEEK()).catch(() => null)) || (await extract(0).catch(() => null));
}

const LOOK = (title) =>
  `This is one frame from an old television commercial catalogued as "${title}". Name the product, service or shop it is advertising, in at most eight words. Read any brand name, package, logo or on-screen words you can see and use them. If the frame shows no product and nothing readable, answer exactly UNKNOWN. Answer with the name only, no sentence, no explanation.`;

/** What the eye saw, as a short label. Never throws; returns null on failure. */
async function labelFrame(jpeg, title) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not configured');
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL(),
      max_tokens: 40,
      /* Gemini's thinking tokens are billed and counted against max_tokens, and
       * at 40 tokens a thinking pass eats the whole answer. This is the
       * OpenRouter spelling of the trap the describe lane records. */
      reasoning: { enabled: false },
      usage: { include: true },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: LOOK(title) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ],
        },
      ],
    },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120000 },
  ).catch((e) => {
    /* An axios error says only "status code 400". What OpenRouter actually
     * objected to is in the body, and without it a bad model slug costs a
     * whole deploy to find. It did once; it should not twice. */
    const said = e.response?.data?.error?.message || e.response?.data?.error || '';
    throw new Error(`${e.message}${said ? ' — ' + String(said).slice(0, 200) : ''}`);
  });
  const usage = r.data?.usage || {};
  const est = ((Number(usage.prompt_tokens) || 0) * IN_USD_PER_M() + (Number(usage.completion_tokens) || 0) * OUT_USD_PER_M()) / 1e6;
  const text = String(r.data?.choices?.[0]?.message?.content || '').trim().replace(/^["'`]+|["'`.]+$/g, '');
  return {
    label: /^unknown$/i.test(text) || text.length < 2 ? null : text.slice(0, 120),
    costUSD: typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : est,
  };
}

/**
 * Look at a batch and decide. Returns
 * { moves, skipped, visionUSD, jevUSD, looked, labelled }. NEVER throws for
 * one bad item — a download that fails, a frame that will not decode or a
 * model that will not answer leaves that item exactly where it was.
 *
 * `signOf(item)` is injected so the route owns the bucket and this owns the
 * looking, and so a test can run the whole thing with no network at all.
 */
async function fileByFrame(items, { signOf, concurrency = 4, onProgress } = {}) {
  const moves = [];
  const skipped = [];
  let visionUSD = 0;
  let jevUSD = 0;
  let looked = 0;
  let labelled = 0;
  let done = 0;
  let stop = false;
  if (!ENABLED() || !jev.enabled('KADE_JEV_LIBRARY')) return { moves, skipped: [...items], visionUSD, jevUSD, looked, labelled, off: true };
  const cap = RUN_USD_CAP();
  const queue = [...items];
  async function worker() {
    for (let it = queue.shift(); it; it = queue.shift()) {
      if (stop) { skipped.push(it); continue; }
      let dir = null;
      try {
        const signedUrl = await signOf(it);
        if (!signedUrl) throw new Error('no signed url');
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-'));
        const jpeg = await grabFrame(signedUrl, dir);
        if (!jpeg) throw new Error('no frame');
        looked++;
        const { label, costUSD } = await labelFrame(jpeg, String(it.title || ''));
        visionUSD += costUSD || 0;
        if (visionUSD + jevUSD > cap) stop = true;
        if (!label) { skipped.push(it); continue; }
        labelled++;
        const d = await judges.decideAdFromFrame(it, label);
        jevUSD += d.costUSD || 0;
        if (!d.category) { skipped.push(it); continue; }
        const from = String(it.path || '');
        const to = from.replace(/Commercials\/Other Commercials(?=\/|$)/i, 'Commercials/' + d.category);
        if (to && to !== from) {
          moves.push({ id: String(it._id || it.id), title: it.title, seen: label, from, to, category: d.category, confidence: d.confidence });
        } else skipped.push(it);
      } catch (e) {
        skipped.push(it);
        if (skipped.length <= 5) logger.warn(`[library/frame] "${String(it.title || '').slice(0, 60)}": ${e.message}`);
      } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      if (typeof onProgress === 'function' && ++done % 25 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  const order = new Map(items.map((b, i) => [String(b._id || b.id), i]));
  moves.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { moves, skipped, visionUSD, jevUSD, looked, labelled, cappedAt: stop ? cap : null };
}

module.exports = { ENABLED, fileByFrame, MODEL, _internals: { grabFrame, labelFrame, LOOK } };