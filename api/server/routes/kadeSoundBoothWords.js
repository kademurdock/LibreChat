'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothWords.js — Change words in a recording, on AuK (Nov 14 2026).
 *
 * Her report: word edits never changed the words. The diagnosis (AUK_EDIT_DIAGNOSIS.md, Nov 14)
 * found three reasons on our side: free-form instructions went to the model verbatim (AuK only
 * follows its trained templates, one change each), the whole recording was cut into blind
 * windows that each got the same instruction, and every retry used the project's one seed.
 *
 * So a word change is now DATA, not prose:
 *   - three boxes: the words it says now, the new words, and roughly where (from/to seconds),
 *     spoken or sung. The bridge builds AuK's own template from them; nothing she types reaches
 *     the worker as an instruction.
 *   - ONE change per render. Several changes queue and run one after another, each on the last
 *     result. They run from the END of the recording backwards, so a change that makes the audio
 *     a little longer or shorter never moves the spot of a change still waiting.
 *   - fresh seeds on every attempt (three takes by default, four for sung words), never the project's voice seed.
 *   - the bridge listens to every take (MiMo) and keeps the one that says the new words. If none
 *     does, the change stops, says so, and her original recording stays as it was.
 *   - "Find the spot": the recording transcribed a few seconds at a time on MiMo (her rule for
 *     transcription), so she can hear and pick the range by ear. The times come from our own cuts,
 *     not from the model, so they are honest to within one window.
 *
 * Like the chain (kadeSoundBoothChain.js) the poll drives the queue: /status advances it, every
 * step is idempotent, and a closed app pauses the queue rather than breaking it.
 * Contract with the bridge and the worker: CONTRACT.md in the work folder (Nov 14 2026).
 * ───────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
let logger;
try {
  ({ logger } = require('@librechat/data-schemas'));
} catch (_) {
  logger = console;
}
const chain = require('./kadeSoundBoothChain');
const { providerError } = require('./kadeSoundBoothErrors');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_CHANGES = 6;
const MAX_TEXT = 200;
const MIN_RANGE_S = 0.5;
/* The worker refuses a crop over 30 s; the crop is the range plus 1 s each side. */
const MAX_RANGE_S = 28;
/* Each change regenerates its range plus 1 s each side, so two changes need twice that between them. */
const MIN_GAP_S = 2;
const MAX_TAKES = 4;
const DEFAULT_TAKES = 3;
/* Nov 14 2026: sung word changes are hit or miss in AuK (a model weakness), so they get one more take. */
const DEFAULT_SUNG_TAKES = 4;
const WINDOW_S = 4;
const MAX_TRANSCRIPT_S = 180;
const bridgeBase = () =>
  (process.env.KADE_BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');

const clean = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const num = (value) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
const quote = (s) => `"${String(s).slice(0, 80)}"`;
const secs = (n) => `${Math.round(n * 10) / 10}`;

/** 'sung', 'singing', 'vocal' -> 'vocal'; anything else is speech. */
function kindOf(value) {
  return /^(sung|singing|vocal|vocals|sing)$/i.test(String(value || '').trim()) ? 'vocal' : 'speech';
}

/** AuK's own templates (pe.config.yaml). The bridge builds the same line; this one is for her. */
function wordTemplate(kind, oldText, newText) {
  if (kind === 'vocal') {
    const q = (s) => s.replace(/"/g, '');
    return `Change "${q(oldText)}" to "${q(newText)}" in the vocal recording.`;
  }
  return `Replace '${oldText}' with '${newText}'.`;
}

/** An Edit instruction that is really a word change, so it can be sent to Change words instead. */
/* A word change written as free text (Nov 14 2026). Quoted pairs ("Replace 'a' with 'b'",
 * 'Sing "x" instead of "y"', '"a" -> "b"'), the same forms as the worker's _WORD_CHANGE; and the
 * unquoted forms the worker lets through: "Replace Tuesday with Thursday", "Swap Tuesday for
 * Thursday", "Make it say Thursday instead of Tuesday", "Change the word(s)/lyric(s) ...".
 * A clause about the sound (noise, voice, timbre, mood, pace ...) is a style edit and passes, so
 * "Change the mood to cheerful" and AuK's timbre template still go through. The fork, the bridge
 * and the tests in both keep this rule word for word the same. */
const WC_Q = '(?:(?<![A-Za-z])\'(?:[^\'\\n]|(?<=[A-Za-z])\'(?=[A-Za-z]))+\'(?![A-Za-z])|"[^"\\n]+"|\u2018[^\u2019\\n]+\u2019|\u201c[^\u201d\\n]+\u201d)';
const WC_QUOTED = [
  new RegExp(`\\b(?:replace|change|swap|switch|substitute)\\b[^.\\n]{0,40}?${WC_Q}[^.\\n]{0,20}?\\b(?:with|to|into|for|by)\\b\\s*${WC_Q}`, 'i'),
  new RegExp(`\\b(?:say|says|saying|sing|sings|singing)\\b[^.\\n]{0,40}?${WC_Q}\\s*,?\\s*instead\\s+of\\s+${WC_Q}`, 'i'),
  new RegExp(`${WC_Q}\\s*(?:->|\u2192|=>)\\s*${WC_Q}`),
];
const WC_NAMED = /\b(?:change|edit|fix|rewrite|alter|replace|swap)\s+(?:the\s+|a\s+|these\s+|this\s+|that\s+|some\s+|her\s+|his\s+|my\s+|one\s+)?(?:words?|lyrics?|lines?|phrase)\b/i;
const WC_STYLE = /\b(?:noise|music|background|reverb\w*|echo|hum|hiss|room|voice|timbre|accent|tone|emotion|mood|style|pitch|speed|pace|tempo|volume|soft\w*|loud\w*|quiet\w*|whisper\w*|breath\w*)\b/i;
const WC_PLAIN = [
  /\b(?:replace|swap|switch|substitute)\s+\S.{0,60}?\s(?:with|for|by)\s+\S/i,
  /\b(?:say|says|saying|sing|sings|singing)\s+\S.{0,60}?\binstead\s+of\s+\S/i,
];

function looksLikeWordChange(instruction) {
  const text = String(instruction || '');
  if (WC_QUOTED.some((r) => r.test(text)) || WC_NAMED.test(text)) return true;
  return text.split(/[.;!?\n]+/).some((clause) => !WC_STYLE.test(clause) && WC_PLAIN.some((r) => r.test(clause)));
}

/** Takes when none is set: 4 if any change is sung, else 3. */
function defaultTakes(changes) {
  return (changes || []).some((c) => c && kindOf(c.kind) === 'vocal') ? DEFAULT_SUNG_TAKES : DEFAULT_TAKES;
}

function takesFrom(value, changes) {
  const n = num(value);
  if (value == null || value === '' || Number.isNaN(n)) return defaultTakes(changes);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TAKES) throw new Error(`Takes to try must be a whole number from 1 to ${MAX_TAKES}.`);
  return n;
}

function freshSeeds(count) {
  const seeds = new Set();
  while (seeds.size < count) seeds.add(crypto.randomInt(1, 2147483647));
  return [...seeds];
}

/**
 * The changes asked for, checked, in the order they will run (latest spot first).
 * `b.changes` is the list the web page sends; a screen that only has the setting boxes sends one
 * change as words_kind / old_text / new_text / words_from / words_to.
 * @throws {Error} with a sentence for her.
 */
function planWordChanges(b, seconds) {
  const raw = Array.isArray(b.changes) && b.changes.length
    ? b.changes
    : [{ kind: b.words_kind, oldText: b.old_text, newText: b.new_text, rangeStart: b.words_from, rangeEnd: b.words_to }];
  if (raw.length > MAX_CHANGES) throw new Error(`Up to ${MAX_CHANGES} word changes at a time. Make these, then add the rest.`);
  const many = raw.length > 1;
  const changes = raw.map((c, i) => {
    const name = many ? `Change ${i + 1}: ` : '';
    if (!c || typeof c !== 'object') throw new Error(`${name}this change is empty.`);
    const kind = kindOf(c.kind);
    /* Sung words go inside the worker's "..." template, so their double quotes come out here. */
    const tidy = (v) => (kind === 'vocal' ? clean(clean(v).replace(/["\u201c\u201d]/g, '')) : clean(v));
    const oldText = tidy(c.oldText);
    const newText = tidy(c.newText);
    if (!oldText) throw new Error(`${name}type the words it says now.`);
    if (!newText) throw new Error(`${name}type the new words.`);
    if (oldText.length > MAX_TEXT || newText.length > MAX_TEXT) throw new Error(`${name}keep the words under ${MAX_TEXT} characters. Change one phrase at a time.`);
    if (oldText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === newText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')) throw new Error(`${name}the new words are the same as the old ones.`);
    const rangeStart = num(c.rangeStart);
    const rangeEnd = num(c.rangeEnd);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) throw new Error(`${name}say roughly where the words are, as From and To in seconds.`);
    if (rangeStart < 0 || rangeEnd <= rangeStart) throw new Error(`${name}the To second must come after the From second.`);
    if (Number.isFinite(seconds) && seconds > 0 && (rangeStart >= seconds || rangeEnd > seconds + 0.05)) {
      throw new Error(`${name}the recording is ${secs(seconds)} seconds long, so the spot has to be inside that.`);
    }
    const span = rangeEnd - rangeStart;
    if (span < MIN_RANGE_S) throw new Error(`${name}give it at least half a second around the words.`);
    if (span > MAX_RANGE_S) throw new Error(`${name}${secs(span)} seconds is too wide. Choose ${MAX_RANGE_S} seconds or less around the words; 3 to 12 works best.`);
    return { kind, oldText, newText, rangeStart: Math.round(rangeStart * 1000) / 1000, rangeEnd: Math.round(Math.min(rangeEnd, Number.isFinite(seconds) && seconds > 0 ? seconds : rangeEnd) * 1000) / 1000, asked: i };
  });
  const ordered = [...changes].sort((a, b2) => b2.rangeStart - a.rangeStart);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].rangeEnd > ordered[i - 1].rangeStart) {
      throw new Error(`Two changes overlap between ${secs(ordered[i - 1].rangeStart)} and ${secs(ordered[i].rangeEnd)} seconds. Make them one change, or move one of them.`);
    }
    /* The worker remakes a second either side of each range, so a change closer than that would
     * remake the start or end of its neighbour's new words. */
    if (ordered[i - 1].rangeStart - ordered[i].rangeEnd < MIN_GAP_S) {
      throw new Error(`Two changes are less than ${MIN_GAP_S} seconds apart (${secs(ordered[i].rangeEnd)} and ${secs(ordered[i - 1].rangeStart)} seconds). Each change remakes a second on either side, so they would garble each other. Make them one change, or leave ${MIN_GAP_S} seconds between them.`);
    }
  }
  return ordered.map(({ asked: _a, ...c }) => c);
}

/** What the project's Edit instructions show: every change, in the order they run. */
function summary(changes) {
  return changes.map((c) => `Change ${quote(c.oldText)} to ${quote(c.newText)} (${c.kind === 'vocal' ? 'sung' : 'spoken'}, ${secs(c.rangeStart)} to ${secs(c.rangeEnd)} seconds)`).join('; then ');
}

const key = (c) => [c.kind, c.oldText, c.newText, c.rangeStart, c.rangeEnd].join('\u0001');
function sameChanges(saved, asked) {
  return Array.isArray(saved) && saved.length === asked.length && saved.every((c, i) => key(c) === key(asked[i]));
}

function sayChange(c, index, total) {
  return `${total > 1 ? `Change ${index + 1} of ${total}` : 'The change'} (${quote(c.oldText)} to ${quote(c.newText)})`;
}

function sayProgress(project, wait) {
  const changes = project.wordChanges || [];
  const at = changes.findIndex((c) => c.state === 'queued' || c.state === 'running');
  const index = at >= 0 ? at : Math.max(0, changes.findIndex((c) => c.state === 'pending'));
  const c = changes[index];
  return c ? `${sayChange(c, index, changes.length)}. ${wait?.spoken || 'Waiting for the speech GPU.'}` : 'Checking the word changes.';
}

function sayDone(project) {
  const changes = project.wordChanges || [];
  const last = [...changes].reverse().find((c) => c.state === 'done');
  const report = last?.report?.spoken || '';
  if (changes.length === 1) return `${report} The new take is in your library and in My Creations.`.trim();
  return `All ${changes.length} changes are made. The newest take in your library has every one of them. ${report}`.trim();
}

/** Ask the bridge to run one change. Returns its job id, or throws with her words. */
async function submitChange({ userId, change, sourceUrl, seeds }) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) throw new Error('The render lane is not configured here.');
  const body = {
    secret,
    userId: String(userId),
    agentId: 'soundbooth',
    agentName: 'Sound Booth',
    /* The prompt is only the take's caption in her library; the worker reads the fields below. */
    prompt: wordTemplate(change.kind, change.oldText, change.newText),
    auk_task: 'edit',
    kind: change.kind,
    oldText: change.oldText,
    newText: change.newText,
    rangeStart: change.rangeStart,
    rangeEnd: change.rangeEnd,
    seeds,
    reference_voice_url: sourceUrl,
  };
  const r = await axios.post(`${bridgeBase()}/audio/scenema/start`, body, { headers: { 'User-Agent': UA }, timeout: 20000 });
  const jobId = r.data?.jobId;
  if (!jobId) throw new Error(r.data?.error || 'That change could not start.');
  return jobId;
}

const touched = (project) => { if (typeof project.markModified === 'function') project.markModified('wordChanges'); };

/**
 * Move a word-change queue forward by one step. Idempotent: safe on every poll.
 * @returns {Promise<{changed:boolean, state:string, spoken:string, jobId?:string, report?:object, finished?:object}>}
 */
async function advanceLocked(project) {
  const changes = project.wordChanges || [];
  const total = changes.length;
  if (!total) return { changed: false, state: project.state, spoken: '' };
  if (['cancelled', 'failed', 'done'].includes(project.state)) {
    return { changed: false, state: project.state, spoken: project.state === 'cancelled' ? 'Stopped. Changes already made are kept as takes.' : project.state === 'done' ? sayDone(project) : project.lastError || 'Stopped.' };
  }
  let said = '';
  let finished = null;
  const inFlight = changes.find((c) => c.jobId && (c.state === 'queued' || c.state === 'running'));
  if (inFlight) {
    const index = changes.indexOf(inFlight);
    const j = await chain.readJob(inFlight.jobId);
    if (!j) return { changed: false, state: project.state, spoken: sayProgress(project, null) };
    if (j.state === 'done' && j.result?.url) {
      Object.assign(inFlight, { state: 'done', url: j.result.url, wavUrl: j.result.wavUrl, report: j.result.editReport || null,
        costUSD: typeof j.costUSD === 'number' ? j.costUSD : 0, pickedSeed: j.result.seed });
      project.costUSD = (project.costUSD || 0) + (inFlight.costUSD || 0);
      said = j.result.editReport?.spoken || `${sayChange(inFlight, index, total)} is made.`;
      finished = inFlight;
    } else if (j.state === 'failed' || j.state === 'cancelled') {
      const made = changes.filter((c) => c.state === 'done').length;
      Object.assign(inFlight, { state: j.noMatch ? 'no_match' : 'failed', report: j.result?.editReport || null,
        error: String(j.error || j.state).slice(0, 400), costUSD: typeof j.costUSD === 'number' ? j.costUSD : 0 });
      project.costUSD = (project.costUSD || 0) + (inFlight.costUSD || 0);
      project.state = j.state === 'cancelled' ? 'cancelled' : 'failed';
      project.lastError = (`${sayChange(inFlight, index, total)}: ${inFlight.error}` +
        (made ? ` The ${made} change${made === 1 ? '' : 's'} already made ${made === 1 ? 'is' : 'are'} kept as takes.` : '') +
        (total > 1 ? ' Render again to try this change with fresh takes and carry on from here.' : '')).slice(0, 600);
      touched(project);
      await project.save();
      return { changed: true, state: project.state, spoken: project.lastError, report: inFlight.report };
    } else {
      project.state = j.state === 'running' ? 'running' : 'queued';
      await project.save();
      return { changed: false, state: project.state, spoken: sayProgress(project, j.wait || null) };
    }
  }

  const next = changes.find((c) => c.state === 'pending');
  if (next) {
    const index = changes.indexOf(next);
    try {
      /* Each change works on the last result: the newest made change, else her imported recording. */
      const made = [...changes].reverse().find((c) => c.state === 'done' && c.url);
      let source = made ? made.wavUrl || made.url : project.options?.reference_voice_url;
      if (!source) throw new Error('The recording to change is missing. Import it again.');
      source = await chain.freshPartUrl(source);
      const seeds = freshSeeds(takesFrom(project.options?.takes, [next]));
      const jobId = await submitChange({ userId: project.user, change: next, sourceUrl: source, seeds });
      Object.assign(next, { jobId, seeds, state: 'queued', error: undefined, report: null });
      project.state = 'queued';
      project.jobs = [...(project.jobs || []), jobId].slice(-160);
      touched(project);
      await project.save();
      logger.info(`[soundbooth/words] change ${index + 1}/${total} queued job=${jobId} takes=${seeds.length} project=${project._id}`);
      const nextLine = `${sayChange(next, index, total)} is ${made || finished ? 'next' : 'queued'}. Asking for ${seeds.length} take${seeds.length === 1 ? '' : 's'}.`;
      return { changed: true, state: 'queued', jobId, spoken: [said, nextLine].filter(Boolean).join(' '), finished, report: finished?.report };
    } catch (e) {
      const why = providerError(e, { name: 'The render service' });
      logger.warn(`[soundbooth/words] change ${index + 1}/${total} could not start project=${project._id}: ${why.detail}`);
      next.state = 'failed';
      next.error = why.message.slice(0, 300);
      project.state = 'failed';
      project.lastError = `${sayChange(next, index, total)} could not start: ${why.message}`.slice(0, 600);
      touched(project);
      await project.save();
      return { changed: true, state: 'failed', spoken: [said, project.lastError].filter(Boolean).join(' '), finished };
    }
  }

  if (changes.every((c) => c.state === 'done')) {
    project.state = 'done';
    project.lastError = undefined;
    touched(project);
    await project.save();
    return { changed: true, state: 'done', spoken: sayDone(project), finished, report: finished?.report };
  }
  return { changed: !!finished, state: project.state, spoken: sayProgress(project, null), finished };
}

async function advance(project) {
  const lease = await chain.acquire(project);
  if (!lease) return { changed: false, state: project.state, spoken: 'Updating this project. Checking again shortly.' };
  try {
    const current = await project.constructor.findById(project._id);
    if (current) project.set(current.toObject());
    return await advanceLocked(project);
  } finally { await chain.release(project, lease); }
}

/** The queue as a screen shows it. */
function changesView(changes) {
  return (changes || []).map((c, i) => ({
    index: i, kind: c.kind, oldText: c.oldText, newText: c.newText, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd, state: c.state,
    spoken: c.report?.spoken || c.error || '', heard: (c.report?.takes || []).map((t) => ({ seed: t.seed, heard: t.heard, matched: !!t.matched })),
  }));
}

/* ---------- Find the spot: a transcript with times, on MiMo ---------- */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.FFMPEG_PATH || 'ffmpeg', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed'), { ffmpeg: true }));
      else resolve();
    });
  });
}

/** Cut `from`..`to` into WINDOW_S mono 16 kHz WAV windows. Returns [{start, end, buffer}].
 * `source` is the recording's bytes, or { url } for one already checked as hers in our storage:
 * then ffmpeg seeks in the URL and reads only that stretch, so "List the next stretch" does not
 * download the whole recording again (https only). */
async function cutWindows(source, from, to) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-words-'));
  try {
    let input;
    const fromUrl = !Buffer.isBuffer(source) && typeof source?.url === 'string' && /^https:\/\/\S+$/i.test(source.url);
    if (fromUrl) input = source.url;
    else if (Buffer.isBuffer(source)) { input = path.join(dir, 'in.audio'); await fs.writeFile(input, source); }
    else throw new Error('No recording to listen to.');
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', ...(fromUrl ? ['-protocol_whitelist', 'https,tls,tcp'] : []), '-ss', String(from), '-t', String(to - from), '-i', input,
      '-ac', '1', '-ar', '16000', '-f', 'segment', '-segment_time', String(WINDOW_S), '-reset_timestamps', '1', path.join(dir, 'w%04d.wav')]);
    const names = (await fs.readdir(dir)).filter((n) => /^w\d{4}\.wav$/.test(n)).sort();
    const windows = [];
    for (const [i, name] of names.entries()) {
      const start = from + i * WINDOW_S;
      windows.push({ start, end: Math.min(to, start + WINDOW_S), buffer: await fs.readFile(path.join(dir, name)) });
    }
    return windows;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const LISTEN_PROMPT = 'Transcribe every word spoken or sung in this audio exactly as heard, in order. Reply with the words only. If there are no words, reply with nothing.';

/** MiMo Flash hears one window. Her recording is a user's audio: zero-retention hosts only. */
async function mimoHear(buffer, env = process.env) {
  const key = env.OPENROUTER_KEY || env.OPENROUTER_API_KEY || '';
  if (!key) throw new Error('The listener is not configured here.');
  const hosts = String(env.KADE_WORDS_HOSTS || 'Makora,Novita').split(',').map((h) => h.trim()).filter(Boolean);
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: env.KADE_WORDS_LISTENER_MODEL || 'xiaomi/mimo-v2.6-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: LISTEN_PROMPT },
      { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: 'wav' } },
    ] }],
    max_tokens: 200,
    temperature: 0,
    reasoning: { enabled: false },
    usage: { include: true },
    provider: { order: hosts, only: hosts, allow_fallbacks: false, zdr: true, data_collection: 'deny' },
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA, 'HTTP-Referer': 'https://kademurdock.com', 'X-Title': 'Kade-AI Sound Booth' },
    timeout: 45000,
  });
  const data = r.data || {};
  const promptTokens = data.usage?.prompt_tokens;
  if (Number.isFinite(promptTokens) && promptTokens < Math.ceil(LISTEN_PROMPT.length / 4) + 8) throw new Error('The listener did not hear the audio.');
  return { text: clean(data.choices?.[0]?.message?.content || ''), costUSD: typeof data.usage?.cost === 'number' ? data.usage.cost : 0 };
}

const clock = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

/**
 * The recording's words, a few seconds at a time, with the times of each window.
 * @returns {Promise<{lines:{start:number,end:number,text:string}[], from:number, to:number, costUSD:number, spoken:string}>}
 */
async function timedTranscript(buffer, seconds, { from = 0, to } = {}, deps = {}) {
  const cut = deps.cut || cutWindows;
  const hear = deps.hear || ((b) => mimoHear(b));
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  const start = Math.max(0, Number.isFinite(from) ? from : 0);
  let end = Number.isFinite(to) && to > start ? to : (total || start + MAX_TRANSCRIPT_S);
  if (total) end = Math.min(end, total);
  if (end - start > MAX_TRANSCRIPT_S) end = start + MAX_TRANSCRIPT_S;
  if (!(end > start)) throw new Error('Choose a stretch of the recording that has length.');
  const windows = await cut(buffer, start, end);
  const lines = new Array(windows.length);
  let costUSD = 0;
  let missed = 0;
  let cursor = 0;
  /* Four at a time: a three-minute stretch is 45 short calls. */
  await Promise.all(Array.from({ length: Math.min(4, windows.length) }, async () => {
    while (cursor < windows.length) {
      const i = cursor++;
      const w = windows[i];
      try {
        const heard = await hear(w.buffer);
        costUSD += heard.costUSD || 0;
        lines[i] = { start: w.start, end: w.end, text: heard.text };
      } catch (e) {
        missed += 1;
        lines[i] = { start: w.start, end: w.end, text: '', missed: true };
      }
    }
  }));
  if (windows.length && missed === windows.length) throw new Error('The listener could not hear this recording just now. Try again in a minute, or set the spot by ear.');
  const said = lines.filter((l) => l.text).length;
  const more = total && end < total - 0.05 ? ` This covers ${clock(start)} to ${clock(end)}; ask again from ${clock(end)} for the rest.` : '';
  const spoken = `Transcribed ${clock(start)} to ${clock(end)} in ${lines.length} stretches of ${WINDOW_S} seconds; ${said} have words.${missed ? ` ${missed} could not be heard.` : ''} Times are close, not exact, so leave a second of room either side.${more}`;
  return { lines, from: start, to: end, costUSD: Math.round(costUSD * 1e6) / 1e6, spoken };
}

module.exports = {
  MAX_CHANGES, MAX_TEXT, MAX_TAKES, DEFAULT_TAKES, DEFAULT_SUNG_TAKES, defaultTakes, MIN_RANGE_S, MAX_RANGE_S, MIN_GAP_S, WINDOW_S, MAX_TRANSCRIPT_S,
  kindOf, wordTemplate, looksLikeWordChange, takesFrom, freshSeeds, planWordChanges, summary, sameChanges,
  submitChange, advance, advanceLocked, changesView, sayProgress, sayDone, timedTranscript, cutWindows, mimoHear,
};
