'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * /api/kade/voice-changer — the server half of the Voice Changer (Oct 22 2026).
 *
 * Kade's ask (Oct 21): record or upload speech, flick through thousands of
 * voices and effects, tweak, save, share, on the website and the iPhone. The
 * sound is made on the listener's own device (the engine in
 * ../kadeVoiceChanger/engine, served by ../kadeVoiceChanger/serve.js), so this
 * router never processes a voice. It only:
 *   GET  /config         where the engine lives, the recorded backgrounds, the sample
 *                        voices and the limits (no-store)
 *   POST /save           a finished take into My Creations: checked, measured with
 *                        ffprobe, made into an MP3 with ffmpeg, stored in B2, and written
 *                        as a KadeAsset DIRECTLY. Not logKadeAsset: that would copy the
 *                        file to B2 a second time and could start a paid describe call.
 *   GET/POST /presets, PATCH/DELETE /presets/:id   the person's own racks; shared ones
 *                        show to everyone with the owner's first name only
 *   GET/PUT  /prefs      favourites, recent list and preview settings, shared between
 *                        the website and the iPhone
 * Every route needs a signed-in person. Every refusal is a plain sentence,
 * because it is read aloud.
 *
 * createRouter(deps) takes everything it touches (sign-in, models, storage,
 * ffmpeg) so kadeVoiceChanger.nodetest.js runs it with no database, no network
 * and no B2. The module's own export builds the real one on first use;
 * index.js calls .build() at boot so the save limiter is made at startup.
 * ───────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const serve = require('../kadeVoiceChanger/serve');

const VC_DIR = path.join(__dirname, '..', 'kadeVoiceChanger');

const MAX_SECONDS = 180; /* what the pages promise: three minutes */
const HARD_SECONDS = 190; /* what a save may measure, with room for a tail */
const PREVIEW_SECONDS = 6;
const SAVE_MAX_BYTES = 40 * 1024 * 1024;
const SAVES_PER_DAY = 300;
const PRESETS_PER_PERSON = 1000;
const SHARED_LIST = 300;
const MAX_STAGES = 12;
const FAVORITES_MAX = 2000;
const RECENT_MAX = 100;
const TITLE_MAX = 80;
const PRESET_NAME_MAX = 60;
const PRESET_ABOUT_MAX = 160;
const MACROS_MAX_BYTES = 4 * 1024;
const CHAIN_MAX_BYTES = 16 * 1024;
const BED_MAX_BYTES = 4 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = 120000;

const AUDIO_EXTS = ['wav', 'mp3', 'm4a', 'aac', 'webm', 'ogg', 'flac'];
const MIME_EXT = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/aacp': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'application/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};
const KINDS_SENTENCE = 'WAV, MP3, M4A, AAC, WebM, Ogg and FLAC';

/* render.js opts.macros, with the ranges render.js clamps to */
const MACRO_RANGES = {
  pitch: [-24, 24, 'Pitch'],
  timbre: [-12, 12, 'Timbre'],
  speed: [0.25, 4, 'Speed'],
  amount: [0, 100, 'Effect strength'],
  width: [0, 200, 'Stereo width'],
  volume: [-24, 12, 'Volume'],
};
const SETTINGS_DEFAULTS = { autoPreview: true, previewSeconds: PREVIEW_SECONDS, previewDelayMs: 350, keepLevel: true };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/;
const BED_FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const SAMPLE_VOICES = [
  { id: 'sample-woman', name: 'Sample voice: a woman talking', file: 'samples/sample-woman.wav' },
  { id: 'sample-man', name: 'Sample voice: a man talking', file: 'samples/sample-man.wav' },
];

/* ── What the engine offers, read once at startup ───────────────────────── */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Module and background ids with their settings, from the engine's generated lists. */
function loadEngineMeta(dir = serve.ENGINE_DIR) {
  const modules = readJson(path.join(dir, 'modules.json'));
  const beds = readJson(path.join(dir, 'beds.json'));
  return {
    dir,
    version: serve.engineVersion(dir),
    modules: new Map(modules.map((m) => [m.id, m])),
    beds: new Map(beds.map((b) => [b.id, b])),
  };
}

/** The recorded backgrounds (soundBeds.json), every url a path from the site root. */
function loadSoundBeds(file = path.join(VC_DIR, 'soundBeds.json')) {
  const doc = readJson(file);
  const beds = (doc.beds || []).map((b) => ({
    id: String(b.id),
    name: String(b.name),
    group: String(b.group),
    about: String(b.about || ''),
    url: '/' + String(b.url || '').replace(/^\/+/, ''),
    seconds: typeof b.seconds === 'number' ? b.seconds : null,
    channels: typeof b.channels === 'number' ? b.channels : null,
  }));
  return { groups: (doc.groups || []).map((g) => ({ id: String(g.id), name: String(g.name) })), beds };
}

/** Seconds of a PCM WAV from its header, or null. */
function wavSeconds(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
    let off = 12;
    let byteRate = 0;
    while (off + 8 <= b.length) {
      const id = b.toString('latin1', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
      if (id === 'data') return byteRate ? Math.round((size / byteRate) * 100) / 100 : null;
      off += 8 + size + (size % 2);
    }
  } catch (_) {
    /* a missing sample is left out of /config */
  }
  return null;
}

function loadSamples(dir = serve.ENGINE_DIR) {
  return SAMPLE_VOICES.map((s) => ({ ...s, seconds: wavSeconds(path.join(dir, s.file)) })).filter((s) => s.seconds);
}

/* ── ffmpeg (execFile, never a shell; temp folder removed in finally) ───── */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args, timeout = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').slice(-1500);
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function withTemp(prefix, fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Seconds of sound in a file: ffprobe's header first, a full decode when the header has
 *  none (browser recordings in WebM often carry no duration). Null when it is not sound. */
async function probeSeconds(buffer, ext) {
  return withTemp('vc-probe-', async (dir) => {
    const f = path.join(dir, `in.${ext}`);
    await fs.promises.writeFile(f, buffer);
    try {
      const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', f], 60000);
      const info = JSON.parse(stdout || '{}');
      const streams = Array.isArray(info.streams) ? info.streams : [];
      if (!streams.length) return null; /* it opened, and there is no sound in it */
      for (const raw of [info.format && info.format.duration, streams[0].duration]) {
        const n = parseFloat(raw);
        if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
      }
    } catch (_) {
      /* fall through to a full decode */
    }
    const res = await run(FFMPEG, ['-nostdin', '-hide_banner', '-i', f, '-vn', '-f', 'null', '-'], FFMPEG_TIMEOUT_MS).catch((e) => ({ stderr: e.stderr || '' }));
    const m = String(res.stderr).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
    if (!m || !m.length) return null;
    const last = m[m.length - 1].replace('time=', '').split(':');
    const s = Number(last[0]) * 3600 + Number(last[1]) * 60 + Number(last[2]);
    return s > 0 ? Math.round(s * 100) / 100 : null;
  });
}

/** The take as an MP3: 192 kbps, stereo, 44.1 kHz, its title in the tags, no other tags. */
async function transcode(buffer, ext, { title } = {}) {
  return withTemp('vc-save-', async (dir) => {
    const inFile = path.join(dir, `in.${ext}`);
    const outFile = path.join(dir, 'out.mp3');
    await fs.promises.writeFile(inFile, buffer);
    await run(FFMPEG, [
      '-nostdin', '-hide_banner', '-v', 'error', '-y',
      '-i', inFile,
      '-vn', '-map_metadata', '-1', '-t', String(HARD_SECONDS),
      '-ac', '2', '-ar', '44100',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-id3v2_version', '3', '-metadata', `title=${String(title || '').slice(0, TITLE_MAX)}`,
      outFile,
    ]);
    const out = await fs.promises.readFile(outFile);
    if (!out.length) throw new Error('ffmpeg made an empty file');
    return out;
  });
}

/* ── Checking what a page sends ─────────────────────────────────────────── */

class Problem extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const clip = (s, n = 40) => {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v === undefined ? null : v), 'utf8');
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** One line of text a person typed: control characters out, spaces collapsed. */
function plainText(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkNumber(v, lo, hi, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Problem(`${label} must be a number.`);
  if (v < lo || v > hi) throw new Problem(`${label} is ${v}, outside its range of ${lo} to ${hi}.`);
  return v;
}

/** Settings for one effect or background, every name and value checked against its list. */
function checkParams(owner, p, where) {
  if (p === undefined || p === null) return undefined;
  if (!isPlainObject(p)) throw new Problem(`${where}: the settings must be a list of setting names and values.`);
  const byId = new Map((owner.params || []).map((x) => [x.id, x]));
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    const param = byId.get(k);
    if (!param) throw new Problem(`${where} has no setting called "${clip(k)}".`);
    if (param.type === 'number') {
      checkNumber(v, param.min, param.max, `${where}: "${param.name}"`);
    } else if (param.type === 'choice') {
      if (!(param.options || []).some((o) => o.v === v)) throw new Problem(`${where}: "${param.name}" cannot be "${clip(v)}".`);
    } else if (param.type === 'bool') {
      if (typeof v !== 'boolean') throw new Problem(`${where}: "${param.name}" must be on or off (true or false).`);
    } else {
      throw new Problem(`${where}: "${param.name}" cannot be set here.`);
    }
    out[k] = v;
  }
  return out;
}

/** A rack: 1 to 12 effects that all exist, with settings that all exist. */
function checkChain(chain, engine) {
  if (!Array.isArray(chain) || chain.length < 1) throw new Problem('A preset needs at least one effect.');
  if (chain.length > MAX_STAGES) throw new Problem(`A preset can hold up to ${MAX_STAGES} effects; this one has ${chain.length}.`);
  if (bytesOf(chain) > CHAIN_MAX_BYTES) throw new Problem('That list of effects is too long to save.');
  return chain.map((st, i) => {
    const where = `Effect ${i + 1}`;
    if (!isPlainObject(st) || typeof st.m !== 'string') throw new Problem(`${where} does not say which effect it is.`);
    for (const k of Object.keys(st)) if (!['m', 'p', 'off'].includes(k)) throw new Problem(`${where} has an unknown field "${clip(k)}".`);
    const mod = engine.modules.get(st.m);
    if (!mod) throw new Problem(`${where} uses "${clip(st.m)}", which is not an effect the Voice Changer has.`);
    if (st.off !== undefined && typeof st.off !== 'boolean') throw new Problem(`${where}: "off" must be true or false.`);
    const p = checkParams(mod, st.p, `${where} (${mod.name})`);
    return { m: st.m, ...(p && Object.keys(p).length ? { p } : {}), ...(st.off ? { off: true } : {}) };
  });
}

/** A background: a made one { b } from beds.json or a recorded one { file } from soundBeds.json. */
function checkBed(bed, engine, soundBeds, where = 'The background') {
  if (bed === undefined || bed === null) return null;
  if (!isPlainObject(bed)) throw new Problem(`${where} must look like {"b": "rain", "level": -20}.`);
  if (bytesOf(bed) > BED_MAX_BYTES) throw new Problem(`${where} has too many settings to save.`);
  for (const k of Object.keys(bed)) {
    if (!['b', 'file', 'level', 'p', 'duck', 'fade'].includes(k)) throw new Problem(`${where} has an unknown field "${clip(k)}".`);
  }
  const out = {};
  if (typeof bed.b === 'string') {
    const made = engine.beds.get(bed.b);
    if (!made) throw new Problem(`There is no background called "${clip(bed.b)}".`);
    out.b = bed.b;
    const p = checkParams(made, bed.p, `${where} (${made.name})`);
    if (p && Object.keys(p).length) out.p = p;
  } else if (typeof bed.file === 'string') {
    if (!BED_FILE_RE.test(bed.file) || !soundBeds.beds.some((s) => s.id === bed.file)) {
      throw new Problem(`There is no recorded background called "${clip(bed.file)}".`);
    }
    if (bed.p !== undefined) throw new Problem(`${where}: a recorded background has no settings.`);
    out.file = bed.file;
  } else {
    throw new Problem(`${where} needs a made background ("b") or a recorded one ("file").`);
  }
  if (bed.level !== undefined) out.level = checkNumber(bed.level, -60, 6, `${where} level`);
  if (bed.duck !== undefined) {
    if (typeof bed.duck === 'boolean') out.duck = bed.duck;
    else out.duck = checkNumber(bed.duck, 0, 40, `${where} ducking`);
  }
  if (bed.fade !== undefined) {
    const f = bed.fade;
    if (typeof f === 'boolean') out.fade = f;
    else if (typeof f === 'number') out.fade = checkNumber(f, 0, 10, `${where} fade`);
    else if (isPlainObject(f) && Object.keys(f).every((k) => k === 'in' || k === 'out')) {
      out.fade = {};
      if (f.in !== undefined) out.fade.in = checkNumber(f.in, 0, 10, `${where} fade in`);
      if (f.out !== undefined) out.fade.out = checkNumber(f.out, 0, 10, `${where} fade out`);
    } else throw new Problem(`${where} fade must be a number of seconds, or {"in": seconds, "out": seconds}.`);
  }
  return out;
}

/** The big knobs: pitch, timbre, speed, effect strength, width, volume and the background. */
function checkMacros(macros, engine, soundBeds) {
  if (macros === undefined || macros === null) return undefined;
  if (!isPlainObject(macros)) throw new Problem('The main controls must be a list of control names and values.');
  if (bytesOf(macros) > MACROS_MAX_BYTES) throw new Problem('The main controls are too long to save.');
  const out = {};
  for (const [k, v] of Object.entries(macros)) {
    if (k === 'bed') {
      out.bed = checkBed(v, engine, soundBeds, 'The background');
      continue;
    }
    const r = MACRO_RANGES[k];
    if (!r) throw new Problem(`There is no main control called "${clip(k)}".`);
    out[k] = checkNumber(v, r[0], r[1], r[2]);
  }
  return out;
}

function checkSeed(seed) {
  if (seed === undefined) return undefined;
  if (seed === null) return null;
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed;
  if (typeof seed === 'string' && seed.length <= 40) return seed;
  throw new Problem('The seed must be a number.');
}

function checkSide(side, soundBeds) {
  if (side === undefined || side === null || side === '') return null;
  if (typeof side !== 'string' || !soundBeds.beds.some((s) => s.id === side)) {
    throw new Problem(`There is no recorded sound called "${clip(side)}" to use as the other sound.`);
  }
  return side;
}

function checkPresetName(v) {
  const name = plainText(v);
  if (!name) throw new Problem('Give the preset a name.');
  if (name.length > PRESET_NAME_MAX) throw new Problem(`A preset name can be up to ${PRESET_NAME_MAX} characters.`);
  return name;
}

function checkPresetAbout(v) {
  const about = plainText(v);
  if (about.length > PRESET_ABOUT_MAX) throw new Problem(`A preset's description can be up to ${PRESET_ABOUT_MAX} characters.`);
  return about;
}

const PRESET_FIELDS = ['name', 'about', 'chain', 'macros', 'bed', 'side', 'seed', 'shared'];

/** Every field the body carries, checked. `whole` means a new preset: name and chain required. */
function checkPresetBody(body, engine, soundBeds, whole) {
  if (!isPlainObject(body)) throw new Problem('Send the preset as a list of fields.');
  for (const k of Object.keys(body)) {
    if (!PRESET_FIELDS.includes(k)) throw new Problem(`A preset has no field called "${clip(k)}".`);
  }
  const has = (k) => body[k] !== undefined;
  if (whole && !has('chain')) throw new Problem('A preset needs at least one effect.');
  if (!whole && !PRESET_FIELDS.some(has)) throw new Problem('Nothing in the preset was changed.');
  const out = {};
  if (whole || has('name')) out.name = checkPresetName(body.name);
  if (has('about')) out.about = checkPresetAbout(body.about);
  if (has('chain')) out.chain = checkChain(body.chain, engine);
  if (has('macros')) out.macros = checkMacros(body.macros, engine, soundBeds) || null;
  if (has('bed')) out.bed = checkBed(body.bed, engine, soundBeds);
  if (has('side')) out.side = checkSide(body.side, soundBeds);
  if (has('seed')) out.seed = checkSeed(body.seed);
  if (has('shared')) {
    if (typeof body.shared !== 'boolean') throw new Problem('Shared must be true or false.');
    out.shared = body.shared;
  }
  return out;
}

function checkIdList(list, max, label) {
  if (!Array.isArray(list)) throw new Problem(`Your ${label} must be a list of preset ids.`);
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Problem(`"${clip(id)}" is not a preset id, so your ${label} were not saved.`);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length > max) throw new Problem(`You can keep up to ${max.toLocaleString('en-US')} ${label}; this list has ${out.length.toLocaleString('en-US')}.`);
  return out;
}

function checkSettings(s) {
  if (!isPlainObject(s)) throw new Problem('The settings must be a list of setting names and values.');
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'autoPreview' || k === 'keepLevel') {
      if (typeof v !== 'boolean') throw new Problem(`${k === 'autoPreview' ? 'Preview as you move' : 'Keep the level even'} must be on or off (true or false).`);
      out[k] = v;
    } else if (k === 'previewSeconds') {
      out[k] = checkNumber(v, 2, 20, 'The preview length in seconds');
    } else if (k === 'previewDelayMs') {
      out[k] = Math.round(checkNumber(v, 0, 2000, 'The wait before a preview, in milliseconds'));
    } else {
      throw new Problem(`There is no Voice Changer setting called "${clip(k)}".`);
    }
  }
  return out;
}

/** A multipart text field holding JSON, at most `max` bytes. */
function jsonField(raw, max, label, isRightShape) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw);
  if (Buffer.byteLength(text, 'utf8') > max) throw new Problem(`The ${label} are too long to save with the recording.`);
  let v;
  try {
    v = JSON.parse(text);
  } catch (_) {
    throw new Problem(`The ${label} could not be read, so nothing was saved.`);
  }
  if (!isRightShape(v) || !storableKeys(v)) throw new Problem(`The ${label} are not in the right shape, so nothing was saved.`);
  return v;
}

/** No key the database would refuse or read as an operator ($ first, or a dot), at any depth. */
function storableKeys(v, depth = 0) {
  if (depth > 8) return false;
  if (Array.isArray(v)) return v.every((x) => storableKeys(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.entries(v).every(([k, x]) => !k.startsWith('$') && !k.includes('.') && storableKeys(x, depth + 1));
  }
  return true;
}

/** The file's kind from its type or its name (either one may be missing or generic). */
function audioExt(file) {
  const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
  const fromName = path.extname(String(file.originalname || '')).toLowerCase().replace('.', '');
  if (AUDIO_EXTS.includes(fromName)) return fromName;
  return MIME_EXT[mime] || null;
}

function multerProblem(err) {
  switch (err && err.code) {
    case 'LIMIT_FILE_SIZE':
      return new Problem(`That file is too big: the Voice Changer saves files up to ${Math.round(SAVE_MAX_BYTES / 1024 / 1024)} megabytes. Nothing was saved.`, 413);
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return new Problem('Send one recording at a time, in the field named "audio". Nothing was saved.');
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_KEY':
      return new Problem('The details sent with the recording are too long. Nothing was saved.');
    default:
      return new Problem('The recording did not arrive whole. Nothing was saved; try again.');
  }
}

/* ── What the pages get back ────────────────────────────────────────────── */

/** The same fields GET /api/kade/my-assets gives for one item (kade.js assetView). */
function assetView(d) {
  let url = String(d.url || '');
  if (url && !/^https?:\/\//i.test(url) && !url.startsWith('/')) url = '/' + url;
  return {
    id: String(d._id),
    kind: d.kind,
    service: d.service,
    url,
    backupUrl: d.backupUrl || '',
    description: d.description || '',
    shared: !!d.shared,
    archived: !!d.archived,
    prompt: d.prompt || '',
    model: d.model || '',
    costUSD: typeof d.chargedUSD === 'number' ? d.chargedUSD : d.costUSD || 0,
    createdAt: d.createdAt,
  };
}

function firstName(user) {
  const name = (user && typeof user === 'object' && (user.name || user.username)) || 'Someone';
  return String(name).trim().split(/\s+/)[0] || 'Someone';
}

function presetView(d, { owner = false } = {}) {
  const view = {
    id: String(d._id),
    name: d.name || '',
    about: d.about || '',
    chain: Array.isArray(d.chain) ? d.chain : [],
    macros: d.macros || null,
    bed: d.bed || null,
    side: d.side || null,
    seed: d.seed === undefined ? null : d.seed,
    shared: !!d.shared,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
  if (owner) view.mine = true;
  else view.by = firstName(d.user);
  return view;
}

function prefsView(d) {
  const s = (d && d.settings) || {};
  const settings = { ...SETTINGS_DEFAULTS };
  for (const k of Object.keys(SETTINGS_DEFAULTS)) if (s[k] !== undefined && s[k] !== null) settings[k] = s[k];
  return {
    favorites: (d && Array.isArray(d.favorites) && d.favorites) || [],
    recent: (d && Array.isArray(d.recent) && d.recent) || [],
    settings,
    updatedAt: (d && d.updatedAt) || null,
  };
}

function describeSave(title, presetName, seconds) {
  const n = Math.max(1, Math.round(seconds));
  const voice = presetName ? `your voice as ${presetName}` : 'your voice, changed';
  return `${title}, ${voice}, ${n} second${n === 1 ? '' : 's'}`;
}

const userIdOf = (req) => String((req.user && (req.user.id || req.user._id)) || '');
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/* ── The router ─────────────────────────────────────────────────────────── */

/**
 * deps: { auth, KadeAsset, KadeVoicePreset, KadeVoicePrefs, saveBufferToS3, probeSeconds,
 *         transcode, limiterStore?, filterShared?(docs, user), logger?, engine?, soundBeds?,
 *         samples?, savesPerDay? }
 */
function createRouter(deps) {
  const d = {
    logger: quietLogger,
    engine: ENGINE,
    soundBeds: SOUND_BEDS,
    samples: SAMPLES,
    filterShared: async (docs) => docs,
    savesPerDay: SAVES_PER_DAY,
    uuid: () => crypto.randomUUID(),
    ...deps,
  };
  for (const k of ['auth', 'KadeAsset', 'KadeVoicePreset', 'KadeVoicePrefs', 'saveBufferToS3', 'probeSeconds', 'transcode']) {
    if (!d[k]) throw new Error(`The Voice Changer router needs ${k}.`);
  }
  const router = express.Router();
  const json = express.json({ limit: '1mb' });

  router.use(d.auth);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  /* The engine's lists could not be read at startup (see the wiring below): the rest of the
   * site still runs, and every Voice Changer request says so in a sentence. */
  if (!d.engine) {
    router.use((_req, res) =>
      res.status(503).json({ error: 'The Voice Changer is not ready on the server just now. Nothing was changed; please try again later.' }),
    );
    return router;
  }

  const fail = (res, err, what) => {
    if (err instanceof Problem) return res.status(err.status).json({ error: err.message });
    d.logger.error(`[voice-changer] ${what} failed: ${(err && err.message) || err}`);
    return res.status(500).json({ error: `Something went wrong ${what}. Nothing was changed; try again.` });
  };

  /* GET /config — where everything lives and what the limits are. */
  router.get('/config', (_req, res) => {
    const v = d.engine.version;
    const base = `/vc-engine/${v}/`;
    res.json({
      engineVersion: v,
      engineBase: base,
      catalogUrl: `${base}catalog.json`,
      modulesUrl: `${base}modules.json`,
      bedsUrl: `${base}beds.json`,
      clientUrl: `${base}host/client.js`,
      bridgeUrl: `${base}host/bridge.js`,
      soundBeds: d.soundBeds.beds,
      soundBedGroups: d.soundBeds.groups,
      samples: d.samples.map((s) => ({ id: s.id, name: s.name, url: `${base}${s.file}`, seconds: s.seconds })),
      maxSeconds: MAX_SECONDS,
      previewSeconds: PREVIEW_SECONDS,
      saveMaxBytes: SAVE_MAX_BYTES,
      saveKinds: AUDIO_EXTS,
      limits: {
        savesPerDay: d.savesPerDay,
        presetsPerPerson: PRESETS_PER_PERSON,
        presetStages: MAX_STAGES,
        presetName: PRESET_NAME_MAX,
        presetAbout: PRESET_ABOUT_MAX,
        title: TITLE_MAX,
        favorites: FAVORITES_MAX,
        recent: RECENT_MAX,
      },
      features: { save: true, presets: true, aiBeds: false },
    });
  });

  /* POST /save — one finished take into My Creations. */
  const saveLimit = rateLimit({
    windowMs: DAY_MS,
    limit: d.savesPerDay,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req) => userIdOf(req),
    store: d.limiterStore,
    handler: (_req, res) =>
      res.status(429).set('Cache-Control', 'no-store').json({
        error: `You have saved ${plural(d.savesPerDay, 'recording', 'recordings')} from the Voice Changer today, which is the most for one day. Saving opens again tomorrow.`,
      }),
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SAVE_MAX_BYTES, files: 1, fields: 16, fieldSize: 32 * 1024, parts: 20 },
  }).single('audio');
  const receive = (req, res) => new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));

  router.post('/save', saveLimit, async (req, res) => {
    try {
      await receive(req, res);
    } catch (err) {
      return fail(res, multerProblem(err), 'receiving the recording');
    }
    const uid = userIdOf(req);
    let fields;
    let ext;
    try {
      const file = req.file;
      if (!file || !file.buffer || !file.buffer.length) {
        throw new Problem('There was no recording to save. Send it in the field named "audio".');
      }
      ext = audioExt(file);
      if (!ext) throw new Problem(`That kind of file cannot be saved. The Voice Changer saves ${KINDS_SENTENCE} sound files.`, 415);
      const body = req.body || {};
      const title = plainText(body.title) || 'Voice Changer recording';
      if (title.length > TITLE_MAX) throw new Problem(`The title can be up to ${TITLE_MAX} characters.`);
      const presetId = plainText(body.presetId);
      if (presetId && !ID_RE.test(presetId)) throw new Problem('That preset id could not be read, so nothing was saved.');
      const presetName = plainText(body.presetName);
      if (presetName.length > TITLE_MAX) throw new Problem(`The preset name can be up to ${TITLE_MAX} characters.`);
      const macros = jsonField(body.macros, MACROS_MAX_BYTES, 'main control settings', isPlainObject);
      const chain = jsonField(body.chain, CHAIN_MAX_BYTES, 'effect settings', (v) => Array.isArray(v) && v.length <= 16 && v.every(isPlainObject));
      if (body.seconds !== undefined && body.seconds !== '') {
        const said = Number(body.seconds);
        if (!Number.isFinite(said) || said < 0) throw new Problem('The length sent with the recording is not a number of seconds.');
        if (said > HARD_SECONDS) throw new Problem('That file is too long: the Voice Changer keeps up to 3 minutes.', 413);
      }
      fields = { title, presetId, presetName, macros, chain };
    } catch (err) {
      return fail(res, err, 'checking the recording');
    }

    let seconds = null;
    try {
      seconds = await d.probeSeconds(req.file.buffer, ext);
    } catch (err) {
      d.logger.warn(`[voice-changer] probe failed: ${(err && err.message) || err}`);
    }
    if (!(seconds > 0)) {
      return res.status(422).json({ error: 'That file could not be read as sound, so nothing was saved.' });
    }
    if (seconds > HARD_SECONDS) {
      return res.status(413).json({ error: 'That file is too long: the Voice Changer keeps up to 3 minutes.' });
    }

    let mp3;
    try {
      mp3 = await d.transcode(req.file.buffer, ext, { title: fields.title });
    } catch (err) {
      d.logger.error(`[voice-changer] transcode failed: ${(err && err.message) || err} ${(err && err.stderr) || ''}`);
      return res.status(500).json({ error: 'The recording could not be made into an MP3, so nothing was saved. Try again.' });
    }

    let url;
    try {
      url = await d.saveBufferToS3({ userId: uid, buffer: mp3, fileName: `voicechanger-${d.uuid()}.mp3`, basePath: 'audios' });
      if (!url) throw new Error('storage gave no address');
    } catch (err) {
      d.logger.error(`[voice-changer] storage failed: ${(err && err.message) || err}`);
      return res.status(502).json({ error: 'The recording could not be stored just now, so nothing was saved. Try again in a minute.' });
    }

    try {
      const rounded = Math.round(seconds * 100) / 100;
      const doc = await d.KadeAsset.create({
        user: uid,
        kind: 'audio',
        service: 'voice_changer',
        url: String(url).slice(0, 2048),
        prompt: '',
        costUSD: 0,
        chargedUSD: 0,
        description: describeSave(fields.title, fields.presetName, rounded),
        metadata: {
          title: fields.title,
          presetId: fields.presetId || null,
          presetName: fields.presetName || null,
          macros: fields.macros || null,
          chain: fields.chain || null,
          seconds: rounded,
          source: 'voice_changer',
          engineVersion: d.engine.version,
          bytes: mp3.length,
        },
      });
      return res.status(201).json(assetView(doc));
    } catch (err) {
      d.logger.error(`[voice-changer] My Creations entry failed after storing ${url}: ${(err && err.message) || err}`);
      return res.status(500).json({ error: 'The recording was stored but could not be added to My Creations. Try saving again.' });
    }
  });

  /* Presets: the person's own racks, and everyone's shared ones. */
  router.get('/presets', async (req, res) => {
    try {
      const uid = userIdOf(req);
      const mine = await d.KadeVoicePreset.find({ user: uid }).sort({ updatedAt: -1 }).limit(PRESETS_PER_PERSON).lean();
      const others = await d.KadeVoicePreset.find({ shared: true, user: { $ne: uid } })
        .sort({ createdAt: -1 })
        .limit(SHARED_LIST)
        .populate('user', 'name username')
        .lean();
      const visible = await d.filterShared(others, req.user);
      return res.json({
        mine: mine.map((p) => presetView(p, { owner: true })),
        shared: visible.map((p) => presetView(p)),
      });
    } catch (err) {
      return fail(res, err, 'loading presets');
    }
  });

  router.post('/presets', json, async (req, res) => {
    try {
      const uid = userIdOf(req);
      const fields = checkPresetBody(req.body, d.engine, d.soundBeds, true);
      const count = await d.KadeVoicePreset.countDocuments({ user: uid });
      if (count >= PRESETS_PER_PERSON) {
        throw new Problem(`You have ${PRESETS_PER_PERSON.toLocaleString('en-US')} presets saved, which is the most one person can keep. Delete one to make room.`, 409);
      }
      const doc = await d.KadeVoicePreset.create({
        user: uid,
        about: '',
        macros: null,
        bed: null,
        side: null,
        shared: false,
        ...fields,
        engineVersion: d.engine.version,
      });
      return res.status(201).json(presetView(typeof doc.toObject === 'function' ? doc.toObject() : doc, { owner: true }));
    } catch (err) {
      return fail(res, err, 'saving the preset');
    }
  });

  router.patch('/presets/:id', json, async (req, res) => {
    try {
      const uid = userIdOf(req);
      if (!OBJECT_ID_RE.test(String(req.params.id))) throw new Problem('That preset was not found.', 404);
      const fields = checkPresetBody(req.body, d.engine, d.soundBeds, false);
      const doc = await d.KadeVoicePreset.findOneAndUpdate(
        { _id: req.params.id, user: uid },
        { $set: { ...fields, engineVersion: d.engine.version } },
        { returnDocument: 'after' },
      ).lean();
      if (!doc) throw new Problem('That preset was not found.', 404);
      return res.json(presetView(doc, { owner: true }));
    } catch (err) {
      return fail(res, err, 'changing the preset');
    }
  });

  router.delete('/presets/:id', async (req, res) => {
    try {
      const uid = userIdOf(req);
      if (!OBJECT_ID_RE.test(String(req.params.id))) throw new Problem('That preset was not found.', 404);
      const r = await d.KadeVoicePreset.deleteOne({ _id: req.params.id, user: uid });
      if (!r || !r.deletedCount) throw new Problem('That preset was not found.', 404);
      return res.json({ ok: true, id: String(req.params.id) });
    } catch (err) {
      return fail(res, err, 'deleting the preset');
    }
  });

  /* Prefs: favourites, recent and preview settings, the same on every device. */
  router.get('/prefs', async (req, res) => {
    try {
      const doc = await d.KadeVoicePrefs.findOne({ user: userIdOf(req) }).lean();
      return res.json(prefsView(doc));
    } catch (err) {
      return fail(res, err, 'loading your Voice Changer settings');
    }
  });

  router.put('/prefs', json, async (req, res) => {
    try {
      const body = req.body;
      if (!isPlainObject(body)) throw new Problem('Send your favourites and settings as a list of fields.');
      for (const k of Object.keys(body)) {
        if (!['favorites', 'recent', 'settings'].includes(k)) throw new Problem(`There is no Voice Changer setting called "${clip(k)}".`);
      }
      const set = {};
      if (body.favorites !== undefined) set.favorites = checkIdList(body.favorites, FAVORITES_MAX, 'favorites');
      if (body.recent !== undefined) set.recent = checkIdList(body.recent, RECENT_MAX, 'recent presets');
      if (body.settings !== undefined) {
        for (const [k, v] of Object.entries(checkSettings(body.settings))) set[`settings.${k}`] = v;
      }
      if (!Object.keys(set).length) throw new Problem('Nothing was sent to save.');
      const doc = await d.KadeVoicePrefs.findOneAndUpdate(
        { user: userIdOf(req) },
        { $set: set },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean();
      return res.json(prefsView(doc));
    } catch (err) {
      return fail(res, err, 'saving your Voice Changer settings');
    }
  });

  return router;
}

/* ── The page routes (the pages themselves are api/server/routes/VoiceChanger/) ── */

function lazyLogger() {
  try {
    return require('@librechat/data-schemas').logger;
  } catch (_) {
    return console;
  }
}

/**
 * A page from ./VoiceChanger/pages (a string of HTML or a handler). When that module is
 * missing or broken the site still boots, and the address answers 503 with a sentence.
 */
function pageRoute(exportName, { cacheControl = 'no-cache', load = () => require('./VoiceChanger/pages'), logger } = {}) {
  let warned = false;
  return (req, res, next) => {
    let page;
    try {
      page = load()[exportName];
    } catch (err) {
      if (!warned) {
        warned = true;
        (logger || lazyLogger()).warn(`[voice-changer] page module could not load: ${(err && err.message) || err}`);
      }
    }
    if (typeof page === 'function') {
      res.set('Cache-Control', cacheControl);
      return page(req, res, next);
    }
    if (typeof page === 'string' && page) {
      return res.set('Cache-Control', cacheControl).type('html').send(page);
    }
    return res
      .status(503)
      .set('Cache-Control', 'no-store')
      .type('text/plain')
      .send('The Voice Changer page is not ready yet. Please try again a little later.');
  };
}

/* ── The real wiring ────────────────────────────────────────────────────── */

/** Restricted viewers (the child account, the App Review seat) never see a shared preset
 *  whose name or description carries an explicit word, as on the Wall of Fame. */
async function filterSharedForViewer(docs, user) {
  const { wallViewerRestricted, filterWallAssets } = require('~/server/utils/kadeSongAudience');
  if (!(await wallViewerRestricted(user))) return docs;
  const keep = new Set(
    filterWallAssets(
      docs.map((p) => ({ _id: p._id, title: p.name, description: p.about })),
      true,
    ).map((p) => String(p._id)),
  );
  return docs.filter((p) => keep.has(String(p._id)));
}

function realDeps() {
  const { logger } = require('@librechat/data-schemas');
  const { saveBufferToS3, limiterCache } = require('@librechat/api');
  const { requireJwtAuth } = require('~/server/middleware');
  const { KadeAsset } = require('~/models/kadeAsset');
  const { KadeVoicePreset } = require('~/models/kadeVoicePreset');
  const { KadeVoicePrefs } = require('~/models/kadeVoicePrefs');
  let limiterStore;
  try {
    limiterStore = typeof limiterCache === 'function' ? limiterCache('kade_voice_changer_save_limiter') : undefined;
  } catch (err) {
    logger.warn(`[voice-changer] shared save limiter unavailable, counting in memory: ${err && err.message}`);
    limiterStore = undefined;
  }
  if (ENGINE_PROBLEM) logger.error(`[voice-changer] engine lists could not be read, so the API answers 503: ${ENGINE_PROBLEM.message}`);
  if (SOUND_BEDS_PROBLEM) logger.warn(`[voice-changer] soundBeds.json could not be read, so no recorded backgrounds are offered: ${SOUND_BEDS_PROBLEM.message}`);
  return {
    auth: requireJwtAuth,
    logger,
    saveBufferToS3,
    KadeAsset,
    KadeVoicePreset,
    KadeVoicePrefs,
    limiterStore,
    probeSeconds,
    transcode,
    filterShared: filterSharedForViewer,
  };
}

/* Read once at startup. A missing or broken generated list must never stop the whole site
 * from booting: the Voice Changer answers 503 instead, and the reason goes to the log. */
let ENGINE = null;
let ENGINE_PROBLEM = null;
try {
  ENGINE = loadEngineMeta();
} catch (err) {
  ENGINE_PROBLEM = err;
}
let SOUND_BEDS = { groups: [], beds: [] };
let SOUND_BEDS_PROBLEM = null;
try {
  SOUND_BEDS = loadSoundBeds();
} catch (err) {
  SOUND_BEDS_PROBLEM = err;
}
const SAMPLES = loadSamples();

let built = null;
/** The real router, made once (index.js calls this at boot). */
function build() {
  if (!built) built = createRouter(realDeps());
  return built;
}

/** Mounting the module itself also works: the real router is made on the first request. */
function voiceChangerApi(req, res, next) {
  return build()(req, res, next);
}

module.exports = voiceChangerApi;
Object.assign(module.exports, {
  build,
  createRouter,
  pageRoute,
  voiceChangerPage: pageRoute('voiceChangerHtml'),
  enginePage: pageRoute('engineHostHtml', { cacheControl: 'no-store' }),
  _internals: {
    Problem,
    checkChain,
    checkBed,
    checkMacros,
    checkPresetBody,
    checkIdList,
    checkSettings,
    audioExt,
    assetView,
    presetView,
    prefsView,
    describeSave,
    loadEngineMeta,
    loadSoundBeds,
    loadSamples,
    wavSeconds,
    probeSeconds,
    transcode,
    ENGINE,
    SOUND_BEDS,
    SAMPLES,
    LIMITS: { MAX_SECONDS, HARD_SECONDS, SAVE_MAX_BYTES, SAVES_PER_DAY, PRESETS_PER_PERSON, SHARED_LIST, MAX_STAGES, FAVORITES_MAX, RECENT_MAX },
  },
});
