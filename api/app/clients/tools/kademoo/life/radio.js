/* REVERIE LIFE — the Band, on the air (Part 180, Sep 11 2026).
 *
 * Her words: "the radio, seed audio could make real skits and stuff, it
 * really needs to be a real life sim" and "seed audio does speech, sound and
 * everything in a single pass, 2 minutes or less."
 *
 * Until today `radio` printed one of twelve authored DJ lines and a song
 * title. Now the Band has a SCHEDULE (canon: the morning tide-and-weather
 * read, the classifieds read deadpan, the afternoon true-crime parody that
 * spends a whole episode on something trivial, the evening chart, and
 * Lorraine "Late" Vance's overnight block) and every block is a short
 * written-then-performed segment built from what the city is actually doing:
 * the real weather, the clock, the hot rumors, who is hosting a hangout, the
 * bowling board, which citizens are out and could phone in.
 *
 *   write   — one small model call through the reframe (the same door the
 *             resident conversations use); the script comes back as JSON.
 *   perform — Seed Audio 1.0 on fal renders voices, room tone and effects in
 *             ONE pass (her note); if Seed refuses or the day's allowance is
 *             spent, the inworld proxy's multi-voice scene lane performs it
 *             with a fixed cast, which costs a fraction of a cent.
 *   keep    — the recording is copied into the private Backblaze bucket next
 *             to the city's other sounds and presigned at serve time; the
 *             transcript rides beside it so text-only clients (the native
 *             World screen, the chat tool) read the same show.
 *
 * MONEY, stated plainly — and her word the same afternoon: "I don't like
 * the idea of seed audio having to spend money every day generating things
 * for the game … there could be a bunch of cycled recordings." So the
 * default engine is `library`: the Band plays from a SHELF of recorded
 * blocks, one per slot chosen by the day so it rotates, and NOTHING is
 * rendered on its own. A new recording is made only when a wizard says
 * `radio make <slot>` (about 30 cents on Seed, stated back before it runs)
 * or when REVERIE_RADIO_ENGINE is set to `seed` / `inworld`, which restores
 * the once-per-slot-per-day writer under the daily allowance
 * (REVERIE_RADIO_DAILY_USD, default 1.25; REVERIE_RADIO_DAILY_CAP, default
 * 5). REVERIE_RADIO=0 turns the whole lane off and `radio` falls back to the
 * authored lines it always had.
 *
 * VEIL AND KIDS: the writer is told the city's laws (nobody dies, the bell is
 * late, the freight is 11:40, never ask soul or synth) and that the audience
 * is mixed-age — no corner, no Ray, nothing a child should not hear on a
 * kitchen radio. Lorraine is authored forever (iron rule 1). */
const axios = require('axios');
const { MooRoom, MooChar, MooDistrict, logger, worldClock, pick } = require('./ctx');
const { MooRumor, MooBoard } = require('~/models/kadeMooLife');
const { MooRadio } = require('~/models/kadeMooRadio');
const reverie = require('../reverie');

const ENABLED = () => process.env.REVERIE_RADIO !== '0';
/* library (default) | seed | inworld — see the money note above */
const ENGINE = () => {
  const e = String(process.env.REVERIE_RADIO_ENGINE || 'library').toLowerCase();
  return e === 'seed' || e === 'inworld' ? e : 'library';
};
const AUTO_WRITES = () => ENGINE() !== 'library';
const DAILY_USD = () => Number(process.env.REVERIE_RADIO_DAILY_USD || 1.25);
const DAILY_CAP = () => Number(process.env.REVERIE_RADIO_DAILY_CAP || 5);
const SEED_USD_PER_MIN = 0.1875; // fal's listed price, same constant the Sound Booth carries
const SEED_MAX_CHARS = 2048; // Seed Audio's hard cap per clip
const INWORLD_USD_PER_CHAR = 5 / 1e6; // Inworld TTS list price, an estimate for the ledger
const BUDGET_ID = 'reverie_radio_budget_180';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* Rooms where the Band comes through on its own — a segment landing there is
 * an event the room hears live. Cars and home radios are per-person. */
const RADIO_ROOMS = ['the_band_station', 'dezs_bar', 'pats_diner', 'the_truck_stop', 'the_garages'];

/* THE CAST — authored, forever (Lorraine by iron rule; the other two so the
 * station sounds like the same station tomorrow). `voice` is the inworld
 * proxy label for the fallback lane; Seed reads the traits in prose. */
const HOSTS = {
  harlan: {
    name: 'Harlan Pike',
    traits: 'man in his fifties, dry, unhurried, a little gravel, the board op who has read the tide table every morning for twenty years',
    voice: 'gravelly low-ish middle-aged man · alcor',
  },
  junie: {
    name: 'Junie Baptiste',
    traits: 'woman in her thirties, deadpan, precise, reads the classifieds like a court record and the true-crime hour like it matters',
    voice: 'smooth low-ish woman · caliper',
  },
  lorraine: {
    name: 'Lorraine Vance',
    traits: 'older woman, Southern, low and warm, completely unhurried, been dead about forty years and entirely at peace with it, takes requests',
    voice: 'gravelly low-ish older woman, Southern US · fog',
  },
};
const CALLER_VOICES = [
  'warm low-ish woman, Black American · ferry',
  'warm low-ish middle-aged man · garnet',
  'gravelly low-ish older man, Southern US · hail',
  'smooth low-ish young woman · culvert',
];

/* THE SCHEDULE — canon's blocks on the world clock (Central). */
const SLOTS = [
  { key: 'morning', from: 5, to: 11, host: 'harlan', program: 'The Morning Tide', shape: 'the tide-and-weather read: the weather as it actually is, the bell (late again), what is open this morning, one thing overheard, a caller from the docks or the diner, a song to start the day' },
  { key: 'day', from: 11, to: 17, host: 'junie', program: 'Small Crimes and the Classifieds', shape: 'the classifieds read completely deadpan (three or four, each stranger than the last, one from Lost and Found), then a true-crime parody segment that spends its whole time on something trivial in the city today, with one witness phoned in' },
  { key: 'evening', from: 17, to: 23, host: 'harlan', program: 'The Evening Chart', shape: 'what is open tonight and who is hosting what, then the weekly chart argued about — three songs from the list, in a disputed order, with one caller who disagrees — and a dedication that does not leave a name' },
  { key: 'night', from: 23, to: 5, host: 'lorraine', program: 'The Overnight Block', shape: 'slow and kind: the freight (due 11:40, set your watch by it), the weather as felt from the Gravewalk, one request read out and honoured, one caller who cannot sleep, and a sign-off that makes the city feel safe' },
];

function slotFor(clock) {
  const h = clock.h;
  return SLOTS.find((s) => (s.from < s.to ? h >= s.from && h < s.to : h >= s.from || h < s.to)) || SLOTS[0];
}
function slotKey(clock, slot) {
  /* the night block that starts at 23:00 belongs to the day it started on */
  const day = slot.key === 'night' && clock.h < 5 ? shiftDay(clock.dayKey, -1) : clock.dayKey;
  return `${day}_${slot.key}`;
}
function shiftDay(dayKey, delta) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/* ── INGREDIENTS — what the city is actually doing right now ──────────── */
async function ingredients() {
  const clock = worldClock();
  const wx = reverie.weatherNow();
  const out = { clock, weather: wx.line, weekday: clock.weekday, rumors: [], hangouts: [], boards: [], citizens: [], players: [], songs: [] };
  try {
    out.rumors = (await MooRumor.find({ at: { $gte: new Date(Date.now() - 3 * 86400000) }, kind: { $ne: 'vice' } }).sort({ heat: -1, at: -1 }).limit(3).lean()).map((r) => r.text);
  } catch (_) { /* gossip is never load-bearing */ }
  try {
    const rooms = await MooRoom.find({ 'props.hangout': { $exists: true, $ne: null } }).select('name props.hangout').lean();
    out.hangouts = rooms.slice(0, 3).map((r) => `${(r.props.hangout.kind || r.props.hangout.type || 'a gathering')} at ${r.name}${r.props.hangout.hostName ? ` (${r.props.hangout.hostName} hosting)` : ''}`);
  } catch (_) { /* a hangout is never load-bearing */ }
  try {
    for (const b of ['bowling', 'darts']) {
      const top = await MooBoard.findOne({ board: b }).sort({ score: -1 }).lean();
      if (top) out.boards.push(`${b}: ${top.name} holds it with ${top.score}`);
    }
  } catch (_) { /* boards are never load-bearing */ }
  try {
    const npcs = await MooChar.find({ userId: /^npc:/ }).select('userId name roomId').lean();
    const roomNames = Object.fromEntries((await MooRoom.find({ roomId: { $in: npcs.map((n) => n.roomId) } }).select('roomId name props.home').lean()).map((r) => [r.roomId, r]));
    const publicNpcs = npcs.filter((n) => roomNames[n.roomId] && !roomNames[n.roomId].props?.home);
    for (let i = publicNpcs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [publicNpcs[i], publicNpcs[j]] = [publicNpcs[j], publicNpcs[i]]; }
    out.citizens = publicNpcs.slice(0, 4).map((n) => {
      const def = reverie.CENSUS_BY_ID[n.userId] || {};
      const doing = reverie.npcDoingNow(n.userId);
      return `${n.name} — at ${roomNames[n.roomId].name}${doing && doing.doing ? `, ${doing.doing}` : ''}${def.voice ? `; ${def.voice}` : def.desc ? `; ${String(def.desc).slice(0, 90)}` : ''}`;
    });
  } catch (_) { /* the census is never load-bearing */ }
  try {
    const players = await MooChar.find({ userId: { $not: /^(npc|stray|kid|pet):/ }, active: true, lastActiveAt: { $gte: new Date(Date.now() - 6 * 3600000) } }).select('name roomId').limit(3).lean();
    const names = Object.fromEntries((await MooRoom.find({ roomId: { $in: players.map((p) => p.roomId) } }).select('roomId name').lean()).map((r) => [r.roomId, r.name]));
    out.players = players.map((p) => `${p.name}, last seen at ${names[p.roomId] || 'somewhere in the city'}`);
  } catch (_) { /* presence is never load-bearing */ }
  try {
    const { SONGS } = require('./activities');
    out.songs = [...SONGS].sort(() => Math.random() - 0.5).slice(0, 4);
  } catch (_) { out.songs = ['a slow one about the ferry', 'the one everybody knows the chorus to', 'a work song from the docks']; }
  return out;
}

/* ── THE WRITER ───────────────────────────────────────────────────────── */
function writerPrompt(slot, ing) {
  const host = HOSTS[slot.host];
  const c = ing.clock;
  const hh = c.h % 12 === 0 ? 12 : c.h % 12;
  const when = `${c.weekday}, ${hh}:${String(c.m).padStart(2, '0')} ${c.h < 12 ? 'in the morning' : c.h < 17 ? 'in the afternoon' : c.h < 21 ? 'in the evening' : 'at night'}`;
  return [
    `You write ${slot.program}, a short segment for the Band, the only radio station in Reverie — a small fictional city with nine wards (the Hook, Bellward, Tanglefoot, Fairlawn, Millrace, Sweetwater, the Patch, the Gravewalk, Long Acre). The station is one room over Hock's pawnshop in Tanglefoot, one microphone with a sock on it, the ON AIR bulb honest and the coffee not.`,
    `Host: ${host.name} — ${host.traits}.`,
    `The block's shape: ${slot.shape}.`,
    `Laws of the city you must respect: nobody dies; the bell in Bellward always rings the wrong hour; the night freight is due at 11:40 and everyone sets their watch by it; nobody ever asks whether a person is a soul or a synth and nobody tells (the Veil); nothing you say names a real-world place, brand, or person. The audience is mixed-age, kitchen-radio listening: no drugs, no Little Ray, no violence, romance no warmer than a dedication. Warm, dry, funny, specific. Never explain the joke. Never mention games, apps, models, or software.`,
    `Right now it is ${when}. Weather: ${ing.weather}`,
    ing.rumors.length ? `Word around town (use one or two, lightly, as things people are saying): ${ing.rumors.join(' | ')}` : 'Word around town: a quiet week, suspiciously.',
    ing.hangouts.length ? `Open right now: ${ing.hangouts.join('; ')}.` : 'Nothing organised is open right now.',
    ing.boards.length ? `The boards at the Lanes and at Dez's: ${ing.boards.join('; ')}.` : '',
    ing.citizens.length ? `Citizens out in the city who could phone in (use at most two, as callers, with their own voices): ${ing.citizens.join(' | ')}` : '',
    ing.players.length ? `People out in the city tonight who might get a shout-out by first name only: ${ing.players.join(' | ')}` : '',
    `Songs the station plays (use titles from this list only): ${ing.songs.join('; ')}.`,
    `Write 60 to 90 seconds of air time: between 7 and 12 spoken lines, each under 40 words, at least five by the host. Every line is something said aloud on the radio.`,
    `Answer with ONE JSON object and nothing else: {"title": "a short on-air title", "setting": "one paragraph for the sound designer — the studio, the continuous sound bed, the music mood, spelled-out sounds like a chair creak or a coffee pour", "lines": [{"speaker": "name", "traits": "sex, age, accent, voice texture, personality", "manner": "how this line is delivered", "text": "the exact words"}], "outro": "one sentence: how it ends in sound"}. Callers get traits of their own. Speaker names are plain names only.`,
  ].filter(Boolean).join('\n');
}

function parseScript(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || !Array.isArray(obj.lines)) return null;
  const lines = obj.lines
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({
      speaker: String(l.speaker || 'the Band').replace(/[^\w .'’-]/g, '').trim().slice(0, 40) || 'the Band',
      traits: String(l.traits || '').replace(/["\n]/g, ' ').trim().slice(0, 140),
      manner: String(l.manner || '').replace(/["\n]/g, ' ').trim().slice(0, 80),
      text: String(l.text).replace(/\s+/g, ' ').replace(/"/g, '“').trim().slice(0, 400),
    }));
  if (lines.length < 3) return null;
  return {
    title: String(obj.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'On the air',
    setting: String(obj.setting || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    outro: String(obj.outro || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    lines,
  };
}

async function writeScript(slot, ing) {
  const secret = process.env.REFRAME_PROXY_SECRET;
  if (!secret) throw new Error('REFRAME_PROXY_SECRET not set — the Band has no writer');
  const base = (process.env.REFRAME_PROXY_URL || 'https://reframe-proxy-production.up.railway.app').replace(/\/$/, '');
  const r = await axios.post(`${base}/chat/completions`, {
    model: process.env.REVERIE_RADIO_MODEL || 'z-ai/glm-5.3-flash',
    max_tokens: 1500,
    temperature: 0.9,
    reasoning: { enabled: false },
    messages: [
      { role: 'system', content: writerPrompt(slot, ing) },
      { role: 'user', content: `Write today's ${slot.program}. JSON only.` },
    ],
  }, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA }, timeout: 40000 });
  const text = r.data?.choices?.[0]?.message?.content || '';
  const script = parseScript(text.replace(/%%%[\s\S]*?%%%/g, ''));
  if (!script) throw new Error('the writer did not hand back a usable script');
  /* the host's traits are canon; the writer's guess is replaced */
  const host = HOSTS[slot.host];
  for (const l of script.lines) if (sameName(l.speaker, host.name)) { l.speaker = host.name; l.traits = host.traits; }
  script.host = host.name;
  return script;
}
function sameName(a, b) {
  const x = String(a).toLowerCase().replace(/[^a-z]/g, ''), y = String(b).toLowerCase().replace(/[^a-z]/g, '');
  return x === y || (x.length > 3 && y.includes(x)) || (y.length > 3 && x.includes(y));
}

/* ── THE PERFORMANCES ─────────────────────────────────────────────────── */
/** Seed Audio's script shape, trimmed to its 2048-character cap from the end. */
function seedScript(script) {
  const head = [`[Setting: a small radio studio in a 2040s city, one microphone close and warm, ${script.setting || 'a low hum of the board, a coffee cup set down now and then'}]`];
  const tail = script.outro ? [`[${script.outro}]`] : [];
  const lines = script.lines.map((l) => `${l.speaker}${l.traits ? ` (${l.traits})` : ''} says${l.manner ? `, ${l.manner}` : ''}: "${l.text.replace(/[“”"]/g, '’')}"`);
  let kept = lines.slice();
  const build = () => [...head, ...kept, ...tail].join('\n');
  while (build().length > SEED_MAX_CHARS && kept.length > 3) kept.pop();
  if (build().length > SEED_MAX_CHARS) head[0] = head[0].slice(0, Math.max(60, SEED_MAX_CHARS - (build().length - head[0].length) - 1)) + ']';
  return { text: build().slice(0, SEED_MAX_CHARS), linesUsed: kept.length };
}

/** The inworld proxy's scene shape: [[voice label]] before every speaker's run. */
function sceneScript(script, slot) {
  const host = HOSTS[slot.host];
  const cast = new Map([[host.name.toLowerCase(), host.voice]]);
  let next = 0;
  const parts = [];
  for (const l of script.lines) {
    const key = l.speaker.toLowerCase();
    if (!cast.has(key)) cast.set(key, CALLER_VOICES[next++ % CALLER_VOICES.length]);
    const manner = l.manner ? `%%%${l.manner.replace(/%/g, '')}%%% ` : '';
    parts.push(`[[${cast.get(key)}]] ${manner}${l.text}`);
  }
  return { text: parts.join('\n\n'), baseVoice: host.voice };
}

async function performSeed(script) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error('FAL_KEY not set');
  const { text, linesUsed } = seedScript(script);
  /* Part 180.4: 48 kHz (the engine's best rate); MP3 because the block
   * streams to phones from the bucket and a two-minute WAV is eleven MB. */
  const r = await axios.post('https://fal.run/bytedance/seed-audio-1.0', { prompt: text, output_format: 'mp3', sample_rate: 48000 }, {
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    timeout: 180000,
  });
  const audio = r.data?.audio;
  if (!audio?.url) throw new Error('Seed Audio returned no clip');
  const seconds = Math.max(1, Math.round(Number(audio.duration) || 0));
  const costUSD = Math.round((seconds / 60) * SEED_USD_PER_MIN * 1000) / 1000;
  const file = await axios.get(audio.url, { responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': UA } });
  return { engine: 'seed', buffer: Buffer.from(file.data), mime: 'audio/mpeg', ext: 'mp3', seconds, costUSD, sourceUrl: audio.url, script: text, linesUsed };
}

async function performInworld(script, slot) {
  const base = (process.env.KADE_TTS_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app').replace(/\/$/, '');
  const { text, baseVoice } = sceneScript(script, slot);
  const r = await axios.post(`${base}/v1/audio/speech`, { input: text, voice: baseVoice, model: 'tts-1' }, {
    headers: { Authorization: 'Bearer placeholder', 'Content-Type': 'application/json', 'User-Agent': UA },
    responseType: 'arraybuffer',
    timeout: 120000,
  });
  const mime = String(r.headers['content-type'] || 'audio/mpeg').split(';')[0];
  const ext = /wav/.test(mime) ? 'wav' : /ogg/.test(mime) ? 'ogg' : 'mp3';
  const buffer = Buffer.from(r.data);
  if (buffer.length < 4000) throw new Error('the proxy returned an empty performance');
  const seconds = ext === 'wav' ? Math.max(1, Math.round((buffer.length - 44) / (24000 * 2))) : Math.max(1, Math.round(buffer.length / 4000));
  const chars = text.replace(/\[\[[^\]]+\]\]|%%%[^%]*%%%/g, '').length;
  const costUSD = Math.round(chars * INWORLD_USD_PER_CHAR * 10000) / 10000;
  return { engine: 'inworld', buffer, mime, ext, seconds, costUSD, sourceUrl: null, script: text, linesUsed: script.lines.length };
}

/* ── KEEPING IT — the private bucket, presigned at serve time ─────────── */
async function keep(slotKeyStr, perf) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET || 'Kademurdockchat';
  const key = `reverie-radio/${slotKeyStr}-${Date.now().toString(36)}.${perf.ext}`;
  const s3 = new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL || process.env.AWS_S3_ENDPOINT,
    region: process.env.AWS_REGION || process.env.AWS_S3_REGION || 'us-east-005',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: perf.buffer, ContentType: perf.mime }));
  const endpoint = (process.env.AWS_ENDPOINT_URL || process.env.AWS_S3_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com').replace(/\/$/, '');
  return `${endpoint}/${bucket}/${key}`;
}

/* ── THE ALLOWANCE ────────────────────────────────────────────────────── */
async function budgetDoc() {
  const day = worldClock().dayKey;
  await MooDistrict.updateOne({ districtId: BUDGET_ID }, { $setOnInsert: { name: 'The Band, daily allowance', props: { day, spentUSD: 0, renders: 0, generating: 0 } } }, { upsert: true });
  const doc = await MooDistrict.findOne({ districtId: BUDGET_ID }).lean();
  if (doc.props.day !== day) {
    await MooDistrict.updateOne({ districtId: BUDGET_ID }, { $set: { 'props.day': day, 'props.spentUSD': 0, 'props.renders': 0, 'props.generating': 0 } });
    return { day, spentUSD: 0, renders: 0, generating: 0 };
  }
  return doc.props;
}
function seedAllowed(props, estimateUSD) {
  return props.renders < DAILY_CAP() && props.spentUSD + estimateUSD <= DAILY_USD() + 1e-9;
}

/* ── THE LOOP — is there a block for this slot? make one, in the background ── */
let _inflight = null;
/** The shelf: every finished block for a slot, oldest first. */
async function shelf(slotName) {
  return MooRadio.find(slotName ? { state: 'done', slot: slotName } : { state: 'done' }).sort({ at: 1 }).lean();
}
function dayIndex(dayKey) {
  let h = 0;
  for (const ch of String(dayKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
async function current() {
  const clock = worldClock();
  const slot = slotFor(clock);
  const key = slotKey(clock, slot);
  const seg = await MooRadio.findOne({ slotKey: key, state: 'done' }).lean();
  if (seg) return { seg, slot, key, fresh: true };
  if (ENGINE() === 'library') {
    /* the shelf for this slot, one block per day so it rotates; any slot's
     * shelf if this one is still empty */
    let rows = await shelf(slot.key);
    let own = true;
    if (!rows.length) { rows = await shelf(null); own = false; }
    if (!rows.length) return { seg: null, slot, key, fresh: false, library: true };
    const pickIx = dayIndex(clock.dayKey) % rows.length;
    return { seg: rows[pickIx], slot, key, fresh: own, library: true, shelfSize: rows.length };
  }
  /* the most recent block of any slot, so the dial is never dead */
  const prev = await MooRadio.findOne({ state: 'done' }).sort({ at: -1 }).lean();
  return { seg: prev, slot, key, fresh: false };
}

/** Called from the world tick and from `radio`; never awaited by a turn.
 *  In library mode this does nothing — a block is made only by makeBlock(). */
function ensureCurrent(reason = 'tick') {
  if (!ENABLED() || !AUTO_WRITES()) return null;
  return makeBlock(null, reason);
}

/** Write and perform one block. `slotName` null = the slot on the clock now.
 *  Returns the shared promise; the caller never has to await it. A wizard's
 *  `@radio make` lands here with reason 'wizard' and may add a second block
 *  to a slot that already has one today (the shelf is the point). */
function makeBlock(slotName, reason = 'tick') {
  if (!ENABLED()) return null;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const clock = worldClock();
      const slot = slotName ? SLOTS.find((s) => s.key === slotName) || slotFor(clock) : slotFor(clock);
      const key = reason === 'wizard' ? `${slotKey(clock, slot)}_${Date.now().toString(36)}` : slotKey(clock, slot);
      if (reason !== 'wizard' && await MooRadio.exists({ slotKey: key, state: { $in: ['done', 'writing'] }, at: { $gte: new Date(Date.now() - 20 * 60000) } })) return;
      if (reason !== 'wizard' && await MooRadio.exists({ slotKey: key, state: 'done' })) return;
      const props = await budgetDoc();
      if (props.renders >= DAILY_CAP()) { logger.info(`[radio] daily cap reached (${props.renders}/${DAILY_CAP()}), no new block`); return; }
      const claimed = await MooRadio.updateOne({ slotKey: key }, { $setOnInsert: { slotKey: key, slot: slot.key, program: slot.program, host: HOSTS[slot.host].name, state: 'writing', at: new Date(), dayKey: clock.dayKey } }, { upsert: true });
      if (!claimed.upsertedCount) {
        /* a stale 'writing' row from a crashed attempt is retried after 20 minutes */
        const stale = await MooRadio.findOneAndUpdate({ slotKey: key, state: { $ne: 'done' }, at: { $lt: new Date(Date.now() - 20 * 60000) } }, { $set: { state: 'writing', at: new Date() } });
        if (!stale) return;
      }
      logger.info(`[radio] writing ${slot.program} (${key}) — ${reason}`);
      const ing = await ingredients();
      const script = await writeScript(slot, ing);
      await MooRadio.updateOne({ slotKey: key }, { $set: { title: script.title, script, transcript: script.lines.map((l) => ({ speaker: l.speaker, text: l.text })), state: 'performing' } });
      let perf = null;
      let firstError = null;
      const estimate = 0.3;
      if (ENGINE() !== 'inworld' && seedAllowed(props, estimate)) {
        try { perf = await performSeed(script); } catch (e) { firstError = e; logger.warn(`[radio] Seed Audio failed for ${key}: ${e?.response?.data?.detail || e.message}`); }
      } else if (ENGINE() !== 'inworld') {
        logger.info(`[radio] Seed allowance spent for today ($${props.spentUSD.toFixed(2)} of $${DAILY_USD()}), the proxy performs ${key}`);
      }
      if (!perf) {
        try { perf = await performInworld(script, slot); } catch (e) {
          logger.error(`[radio] both performances failed for ${key}: ${firstError ? firstError.message + ' / ' : ''}${e.message}`);
          await MooRadio.updateOne({ slotKey: key }, { $set: { state: 'failed', lastError: String(e.message).slice(0, 300) } });
          return;
        }
      }
      let url = perf.sourceUrl;
      try { url = await keep(key, perf); } catch (e) { logger.warn(`[radio] could not copy ${key} into the bucket (${e.message}); serving the source url`); }
      if (!url) { await MooRadio.updateOne({ slotKey: key }, { $set: { state: 'failed', lastError: 'no url to keep' } }); return; }
      await MooRadio.updateOne({ slotKey: key }, { $set: { state: 'done', url, backupUrl: perf.sourceUrl, engine: perf.engine, seconds: perf.seconds, bytes: perf.buffer.length, costUSD: perf.costUSD, performed: perf.script, linesUsed: perf.linesUsed, at: new Date() } });
      await MooDistrict.updateOne({ districtId: BUDGET_ID }, { $inc: { 'props.spentUSD': perf.costUSD, 'props.renders': 1 } });
      try {
        const { logKadeUsage } = require('~/models/kadeUsage');
        logKadeUsage({ userId: null, service: perf.engine === 'seed' ? 'fal_audio' : 'inworld_tts', quantity: perf.seconds, unit: 'seconds', costUSD: perf.costUSD, metadata: { via: 'reverie-radio', slot: key, engine: perf.engine } }).catch(() => {});
      } catch (_) { /* the ledger is never load-bearing */ }
      logger.info(`[radio] on the air: ${slot.program} "${script.title}" ${perf.seconds}s via ${perf.engine} $${perf.costUSD} (${key})`);
      await announce(key, slot, script, perf);
    } catch (e) {
      logger.error('[radio] block failed (non-fatal): ' + (e && (e.stack || e.message)));
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** The rooms with a radio on hear the block start — one live line, one cue. */
async function announce(key, slot, script, perf) {
  try {
    const { emit } = require('./ctx');
    const active = await MooChar.find({ userId: { $not: /^(npc|stray|kid|pet):/ }, roomId: { $in: RADIO_ROOMS }, lastActiveAt: { $gte: new Date(Date.now() - 3600000) } }).select('roomId').lean();
    const rooms = [...new Set(active.map((c) => c.roomId))];
    const first = script.lines.find((l) => sameName(l.speaker, HOSTS[slot.host].name)) || script.lines[0];
    for (const roomId of rooms) {
      await emit(roomId, null, 'the Band', 'radio', `On the radio, ${HOSTS[slot.host].name} opens ${slot.program}: “${first.text}” (say "radio" to hear the whole block, about ${perf.seconds} seconds.)`, 'radio');
    }
  } catch (_) { /* a missed announcement is not a failure */ }
}

/* ── WHAT THE VERB HANDS BACK ─────────────────────────────────────────── */
async function presign(url) {
  try {
    const { presignReverieUrl } = require('../seedSounds');
    const fresh = await presignReverieUrl(url);
    if (fresh) return fresh;
  } catch (_) { /* fall through to the stored url */ }
  return url;
}

/** { intro, transcriptLines, radio } or null when the lane is off/empty. */
async function tuneIn() {
  if (!ENABLED()) return null;
  const { seg, slot, fresh, library, shelfSize } = await current();
  if (!fresh && !library) ensureCurrent('tune-in');
  if (!seg) return null;
  const secs = Math.round(seg.seconds || 0);
  const when = library
    ? (fresh ? '' : ` (a ${SLOTS.find((s) => s.key === seg.slot)?.program || 'block'} recording, playing in this slot until the shelf has one of its own)`)
    : (fresh ? '' : ' (from earlier — a new block is being written now)');
  const intro = `The dial warms. On the Band, ${seg.program} with ${seg.host}: “${seg.title}”${when}, about ${secs} seconds. Say "radio words" to read it, "radio off" to turn it down.`;
  const transcriptLines = (seg.transcript || []).map((l) => `${l.speaker}: ${l.text}`);
  return {
    intro,
    transcriptLines,
    radio: { url: await presign(seg.url), title: seg.title, program: seg.program, host: seg.host, seconds: secs, engine: seg.engine, transcript: seg.transcript || [], slotKey: seg.slotKey, fresh: !!fresh, library: !!library, shelfSize: shelfSize || null },
  };
}

/** What the shelf holds, for `radio bank` and the wizard. */
async function bankStatus() {
  const rows = await shelf(null);
  const bySlot = {};
  for (const s of SLOTS) bySlot[s.key] = rows.filter((r) => r.slot === s.key).length;
  let spent = 0;
  for (const r of rows) spent += Number(r.costUSD) || 0;
  const props = await budgetDoc();
  return { total: rows.length, bySlot, spentUSD: Math.round(spent * 1000) / 1000, today: { spentUSD: props.spentUSD, renders: props.renders }, engine: ENGINE(), making: !!_inflight };
}

module.exports = { HOSTS, SLOTS, RADIO_ROOMS, slotFor, slotKey, shiftDay, dayIndex, writerPrompt, parseScript, seedScript, sceneScript, seedAllowed, ingredients, writeScript, ensureCurrent, makeBlock, current, tuneIn, bankStatus, ENABLED, ENGINE, AUTO_WRITES };
