/* ----------------------------------------------------------------------------
 * OPEN VOICES IN THE SOUND BOOTH: VoxCPM2 and Ming (Nov 15 2026)
 *
 * Her approval: two open voice engines with one job shape, each with two modes.
 *   Design a voice:     a description and the words to say. Every try is a new take (a new seed).
 *                       A take can be kept as a saved voice. No count cap.
 *   Speak with a voice: a saved voice or an imported clip, the words, and an optional style in
 *                       plain words ("slightly faster, cheerful tone").
 * The bridge runs the job (bridge open-voices.js: RunPod, polling, the take filed in My Creations
 * with metadata.openVoice). Here: the booth's routes, and the saved-voice list.
 *
 * SAVED VOICES are My Creations rows (KadeAsset) carrying metadata.savedVoice
 * { name, engine, description, words, seconds, savedAt }. A take's row comes from the asset lane;
 * an imported clip kept as a voice gets its own audio row. Forgetting a voice only removes the
 * mark; the recording stays in My Creations. Before a clip goes to a worker it is re-signed from
 * our own storage (freshAssetUrl / audioReferenceGuard, as the AuK path does), and the bridge
 * accepts only our B2 hosts.
 *
 * Ming is shown only while the bridge reports MING_ENDPOINT_ID set; otherwise it is hidden and a
 * request for it is refused in a plain sentence. The page says once, in a plain sentence, that the
 * first take after a quiet spell can take a few minutes.
 *
 * iPhone: /health gains a top-level `openVoices` block; `guide.engines` is unchanged, so an older
 * build that lists the guide's engines never sees these two.
 * -------------------------------------------------------------------------- */
const express = require('express');

const ENGINES = {
  voxcpm: { id: 'voxcpm', label: 'VoxCPM2', maxDescription: 400,
    about: 'Open voice model. Designs a voice from a description, or speaks in a saved voice or a clip.' },
  ming: { id: 'ming', label: 'Ming', maxDescription: 600,
    about: 'Open voice model from Ant Group. Designs a voice from a description, or speaks in a saved voice or a clip.' },
};

/* Ming's own controls (worker ming_contract.py; bridge open-voices.js checks the same rules).
 * Ming runs one task per take, so per take it takes ONE of: a style, an emotion, or speed, pitch
 * and volume. Sound tags and the languages past English and Chinese need the clip's typed words
 * (prompt_text) and none of those. Built-in voices replace the description in Design a voice:
 * upstream tts_tasks.EN_IP_VOICES at a39b806, plus the two Chinese voices its README recommends.
 * Each option is { value, label }; the label is what she hears. The list also goes to the iPhone
 * in /health openVoices.engines[ming].controls. */
const MING_CONTROLS = {
  voices: [
    { value: 'US_Emma', label: 'Emma, American English, woman' },
    { value: 'UK_George', label: 'George, British English, man' },
    { value: 'UK_Charlotte', label: 'Charlotte, British English, woman' },
    { value: '\u7075\u5c0f\u67d4', label: 'Ling Xiaorou, Chinese, young woman' },
    { value: '\u7075\u6977', label: 'Ling Kai, Chinese, young man' },
  ],
  emotions: ['happy', 'sad', 'angry', 'neutral', 'surprised', 'fearful', 'disgusted'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
  speeds: [{ value: 'slow', label: 'Slow' }, { value: 'medium', label: 'Medium' }, { value: 'fast', label: 'Fast' }],
  levels: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
  languages: [
    { value: 'en', label: 'English' }, { value: 'zh', label: 'Chinese' }, { value: 'de', label: 'German' }, { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' }, { value: 'ko', label: 'Korean' }, { value: 'ja', label: 'Japanese' },
  ],
  /* Ming's 14 sound tags (ming_tiny.task_protocol.PARALINGUISTIC_TAGS). */
  tags: [
    { value: '[Breathing]', label: 'Breathing' }, { value: '[Cough]', label: 'Cough' }, { value: '[Sigh]', label: 'Sigh' },
    { value: '[Laughter]', label: 'Laughter' }, { value: '[Surprise-ah]', label: 'Surprise, ah' }, { value: '[Surprise-oh]', label: 'Surprise, oh' },
    { value: '[Dissatisfaction-hnn]', label: 'Dissatisfied, hnn' }, { value: '[Uhm]', label: 'Uhm' }, { value: '[Confirmation-en]', label: 'Agreeing, en' },
    { value: '[Question-ei]', label: 'Question, ei' }, { value: '[Question-ah]', label: 'Question, ah' }, { value: '[Question-en]', label: 'Question, en' },
    { value: '[Question-oh]', label: 'Question, oh' }, { value: '[Question-huh]', label: 'Question, huh' },
  ],
  /* Said after the engine's `about` by a client that shows these controls. `about` itself stays
   * the plain sentence, so an iPhone build without the controls is never told about them. */
  about: 'Ming also has built-in voices, and a choice of emotion, speed, pitch, volume, language and sound tags.',
  tagNote: 'Sound tags work only in Speak with a voice, with a clip of thirty seconds or less whose words are typed in, and no style, emotion, speed, pitch or volume.',
};
const MING_FIELDS = ['voice', 'emotion', 'speed', 'pitch', 'volume', 'language'];
const LANGUAGE_NAMES = Object.fromEntries(MING_CONTROLS.languages.map((l) => [l.value, l.label]));
/* The worker's tag pattern, and the other spellings it rewrites to its own tags. */
const TAG_RE = /\[([A-Za-z][A-Za-z -]{0,30})\]/g;
const KNOWN_TAG = new Set([...MING_CONTROLS.tags.map((t) => t.value.slice(1, -1).toLowerCase()),
  'laugh', 'laughs', 'laughing', 'chuckle', 'chuckles', 'giggle', 'giggles', 'sighs', 'sighing', 'coughs', 'coughing',
  'breath', 'breathes', 'breathe', 'inhale', 'inhales', 'exhale', 'exhales', 'um', 'uh', 'umm', 'hmm', 'huh']);
const NO_MIX = 'no style, emotion, speed, pitch or volume';
const WORDS_CLIP = 'a clip of thirty seconds or less whose words are typed in';

function soundTags(text) {
  const tags = [];
  let unknown = '';
  for (const m of String(text || '').matchAll(TAG_RE)) {
    if (KNOWN_TAG.has(m[1].trim().toLowerCase())) tags.push(m[0]);
    else if (!unknown) unknown = m[0];
  }
  return { tags, unknown };
}

/* Ming's one-task rules on a bridge body -> { error, field } or null. `field` names the control to
 * change (text, language, clipWords, emotion, style), so the page and the iPhone move focus there.
 * `hasWords` says whether the clip's words go along (undefined before the reference is known: the
 * two rules that need them wait for it). */
function mingRule(body, hasWords) {
  if (body.engine !== 'ming') return null;
  const no = (error, field) => ({ error, field });
  const { tags, unknown } = soundTags(body.text);
  if (unknown) return no(`Ming does not know the sound tag ${unknown}. Pick one from Sound tags, or take it out.`, 'text');
  const level = !!(body.speed || body.pitch || body.volume);
  const controls = !!(body.emotion || level);
  if (body.mode === 'design') return tags.length ? no(`Sound tags need Speak with a voice, with ${WORDS_CLIP}.`, 'text') : null;
  if ([body.emotion, level, body.style].filter(Boolean).length > 1) {
    return no('Ming takes one of these per take: a style, an emotion, or speed, pitch and volume. Clear the others.', body.emotion ? 'emotion' : 'style');
  }
  if (tags.length && (controls || body.style)) return no(`Sound tags work only with ${NO_MIX}. Clear those, or take the tags out.`, 'text');
  const far = body.language && !['en', 'zh'].includes(body.language) ? LANGUAGE_NAMES[body.language] : '';
  if (far && (controls || body.style)) return no(`${far} works only with ${NO_MIX}. Clear those, or set the language back.`, 'language');
  if (hasWords === false) {
    if (tags.length) return no(`Sound tags need ${WORDS_CLIP}. Take the tags out, or use such a clip.`, 'clipWords');
    if (far) return no(`${far} needs ${WORDS_CLIP}. Use such a clip, or set the language back.`, 'clipWords');
  }
  return null;
}
/* The sentence alone (older callers and tests). */
function mingRules(body, hasWords) {
  const r = mingRule(body, hasWords);
  return r ? r.error : null;
}

/* Ming's controls from a take request -> { fields } or { error }. Empty values are "not set". */
function mingFields(b, engine, mode) {
  const fields = {};
  const pick = (k) => (typeof b[k] === 'string' ? b[k].trim() : b[k]);
  const given = MING_FIELDS.filter((k) => { const v = pick(k); return v !== undefined && v !== null && v !== ''; });
  if (!given.length) return { fields };
  if (engine !== 'ming') return { error: 'Built-in voices, emotion, speed, pitch, volume and language work only with Ming.' };
  const lists = { voice: [MING_CONTROLS.voices, 'Pick a built-in voice from the list.'], emotion: [MING_CONTROLS.emotions, 'Pick an emotion from the list.'],
    speed: [MING_CONTROLS.speeds, 'Pick slow, medium or fast for the speed.'], pitch: [MING_CONTROLS.levels, 'Pick low, medium or high for the pitch.'],
    volume: [MING_CONTROLS.levels, 'Pick low, medium or high for the volume.'], language: [MING_CONTROLS.languages, 'Pick a language from the list.'] };
  for (const k of given) {
    const v = pick(k);
    const [list, said] = lists[k];
    if (typeof v !== 'string' || !list.some((o) => o.value === v)) return { error: said, field: k };
    fields[k] = v;
  }
  if (mode === 'design' && given.some((k) => k !== 'voice')) return { error: 'Emotion, speed, pitch, volume and language are for Speak with a voice.', field: given.find((k) => k !== 'voice') };
  if (mode === 'speak' && fields.voice) return { error: 'Built-in voices are for Design a voice.', field: 'voice' };
  return { fields };
}
const MAX_TEXT = 5000;
const MAX_STYLE = 400;
const MAX_NAME = 80;
const PROMPT_CLIP_MAX_S = 29.5; // the workers take a clip's exact words only for a clip of 30 s or less
const COLD_NOTE = 'The first take after a quiet spell can take a few minutes while the voice engine starts. After that, takes come back in seconds.';
const HEALTH_TTL_MS = 60 * 1000;
const PROMPT_CLIP_SENTENCE = 'The exact words only work for a clip of thirty seconds or less. Clear the words, or use a shorter clip.';
const STILL_MAKING = 'Your last take is still being made. The page will say when it is ready.';

const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const isJobId = (v) => typeof v === 'string' && /^ov_[a-z0-9]{6,40}$/i.test(v);

/* mingControls: the bridge reads Ming's extra controls (its health says ming.controls). Until it does,
 * the controls are neither offered nor forwarded, so a fork deployed before its bridge never sends a
 * control the bridge would silently drop on paid GPU time. */
const NOTHING = Object.freeze({ voxcpm: false, ming: false, mingControls: false });

/* Which engines the bridge can run. Read from its health (cached, one call in flight at a time).
 * When the bridge cannot be reached (a network error or a timeout) VoxCPM2, which has a default
 * endpoint, is offered and Ming stays hidden. When the bridge answers with an HTTP error (a 403
 * from a secret that does not match, a 404 from a bridge without the lane) nothing is offered. */
function createReadiness({ http, bridgeBase, secret, now = () => Date.now() }) {
  let cached = null;
  let inflight = null;
  async function ask() {
    let value = { voxcpm: true, ming: false, mingControls: false };
    try {
      const r = await http.get(`${bridgeBase()}/audio/open-voices/health`, { params: { secret: secret() }, timeout: 4000 });
      const d = (r && r.data) || {};
      const e = d.engines || {};
      const ming = !!(d.enabled && e.ming && e.ming.configured);
      value = { voxcpm: !!(d.enabled && e.voxcpm && e.voxcpm.configured), ming, mingControls: ming && e.ming.controls === true };
    } catch (err) {
      if (err && err.response) value = { ...NOTHING };
    }
    cached = { at: now(), value };
    return value;
  }
  async function readiness() {
    /* No bridge secret: no bridge to ask, and nothing is offered. */
    if (!secret()) return { ...NOTHING };
    if (cached && now() - cached.at < HEALTH_TTL_MS) return cached.value;
    if (!inflight) inflight = ask().finally(() => { inflight = null; });
    return inflight;
  }
  /* The last answer, however old, or null before the first one. Never calls the bridge. */
  readiness.last = () => (secret() ? (cached ? cached.value : null) : { ...NOTHING });
  return readiness;
}

function engineList(ready) {
  return Object.values(ENGINES).filter((e) => ready[e.id]).map((e) => ({ id: e.id, label: e.label, about: e.about, maxDescription: e.maxDescription,
    ...(e.id === 'ming' && ready.mingControls ? { controls: MING_CONTROLS } : {}) }));
}

function voiceView(row, url) {
  const v = (row.metadata && row.metadata.savedVoice) || {};
  return { id: String(row._id), name: v.name || 'Saved voice', engine: v.engine || null, description: v.description || '',
    seconds: typeof v.seconds === 'number' ? v.seconds : null, url, savedAt: v.savedAt || null };
}

/* The words of a saved voice's clip go to the worker only when they cover a short clip. */
function promptWordsFor(saved) {
  const words = oneLine(saved && saved.words);
  return words && typeof saved.seconds === 'number' && saved.seconds > 0 && saved.seconds <= PROMPT_CLIP_MAX_S ? words.slice(0, 1000) : '';
}

/* A take request -> the bridge body (without the reference), or { error }. */
function checkTake(b = {}, ready = {}) {
  const engine = String(b.engine || '');
  if (!ENGINES[engine]) return { error: 'Pick VoxCPM2 or Ming.' };
  if (!ready[engine]) return { error: engine === 'ming' ? 'Ming is not set up yet. Use VoxCPM2 for now.' : 'VoxCPM2 is not available right now.' };
  const mode = b.mode === 'design' ? 'design' : b.mode === 'speak' ? 'speak' : '';
  if (!mode) return { error: 'Choose Design a voice or Speak with a voice.' };
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return { error: 'Type the words to say.' };
  if (text.length > MAX_TEXT) return { error: `The words are too long. The most is ${MAX_TEXT} characters.` };
  const body = { engine, mode: mode === 'design' ? 'design' : 'clone', text };
  const ming = mingFields(b, engine, mode);
  if (ming.error) return { error: ming.error, field: ming.field };
  const controlsReady = engine === 'ming' && !!ready.mingControls;
  if (Object.keys(ming.fields).length && !controlsReady) {
    return { error: 'Ming\'s extra controls are not ready yet. Set them back to Not set, or try again later.', field: Object.keys(ming.fields)[0] };
  }
  if (mode === 'design') {
    const description = oneLine(b.description);
    if (description && ming.fields.voice) return { error: 'Use a built-in voice or a description, not both. Clear one of them.', field: 'description' };
    if (!description && !ming.fields.voice) return { error: controlsReady ? 'Describe the voice first, or pick a built-in voice.' : 'Describe the voice first.', field: 'description' };
    if (description.length > ENGINES[engine].maxDescription) return { error: `The description is too long. The most is ${ENGINES[engine].maxDescription} characters.`, field: 'description' };
    if (description) body.description = description;
  } else {
    const style = oneLine(b.style);
    if (style.length > MAX_STYLE) return { error: `The style is too long. The most is ${MAX_STYLE} characters.` };
    if (style) body.style = style;
    if (!isId(b.voiceId) && !(typeof b.clipUrl === 'string' && b.clipUrl)) return { error: 'Pick a saved voice or import a clip first.' };
  }
  if (b.seed !== undefined && b.seed !== null && String(b.seed).trim() !== '') {
    const seed = Number(String(b.seed).trim());
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) return { error: 'The voice number must be a whole number from 0 to 2147483647.' };
    body.seed = seed;
  }
  Object.assign(body, ming.fields);
  const rule = mingRule(body);
  if (rule) return rule;
  return { body };
}

function createOpenVoicesRouter(deps) {
  const { auth, http, bridgeBase, KadeAsset, fresh, references, logger } = deps;
  const secret = deps.secret || (() => process.env.BRIDGE_SECRET || '');
  const readiness = deps.readiness || createReadiness({ http, bridgeBase, secret });
  const log = logger || { info() {}, warn() {} };
  const router = express.Router();
  const json = express.json({ limit: '64kb' });

  async function savedVoices(user) {
    const rows = await KadeAsset.find({ user, kind: 'audio', 'metadata.savedVoice': { $exists: true } })
      .sort({ createdAt: -1 }).select('_id url backupUrl metadata.savedVoice createdAt').lean();
    return Promise.all(rows.map(async (row) => voiceView(row, await fresh(row.backupUrl || row.url))));
  }

  /* The clip and its words for Speak with a voice, re-signed from our storage. */
  async function referenceFor(user, b) {
    if (isId(b.voiceId)) {
      const row = await KadeAsset.findOne({ _id: b.voiceId, user, 'metadata.savedVoice': { $exists: true } }).select('url backupUrl metadata.savedVoice').lean();
      if (!row) return { error: 'That saved voice is gone. Pick another one.' };
      const url = await fresh(row.backupUrl || row.url);
      return { url, words: promptWordsFor(row.metadata.savedVoice) };
    }
    let url;
    try {
      url = await references(user).refresh(String(b.clipUrl));
    } catch (e) {
      return { error: 'That clip is not saved on your account. Import it again.' };
    }
    /* The workers take a clip's exact words only for a clip of thirty seconds or less. A clip known
     * to be longer is refused before any GPU time; a clip of unknown length goes without the words. */
    let words = oneLine(b.clipWords).slice(0, 1000);
    const seconds = Number(b.clipSeconds);
    if (words) {
      if (Number.isFinite(seconds) && seconds > PROMPT_CLIP_MAX_S) return { error: PROMPT_CLIP_SENTENCE };
      if (!(Number.isFinite(seconds) && seconds > 0)) words = '';
    }
    return { url, words };
  }

  router.get('/open-voices', auth, async (req, res) => {
    try {
      const ready = await readiness();
      const voices = await savedVoices(String(req.user.id));
      return res.json({ engines: engineList(ready), voices, coldNote: COLD_NOTE, limits: { text: MAX_TEXT, style: MAX_STYLE, name: MAX_NAME } });
    } catch (e) {
      log.warn('[soundbooth/open-voices] list failed: ' + e.message);
      return res.status(500).json({ error: 'Could not load your voices. Try again.' });
    }
  });

  router.post('/open-voices/take', auth, json, async (req, res) => {
    try {
      const b = req.body || {};
      const checked = checkTake(b, await readiness());
      if (checked.error) return res.status(400).json({ error: checked.error, ...(checked.field ? { field: checked.field } : {}) });
      const body = { ...checked.body, secret: secret(), userId: String(req.user.id) };
      if (body.mode === 'clone') {
        const ref = await referenceFor(String(req.user.id), b);
        if (ref.error) return res.status(400).json({ error: ref.error });
        body.reference_voice_url = ref.url;
        if (ref.words) body.prompt_text = ref.words;
        const rule = mingRule(body, !!ref.words);
        if (rule) return res.status(400).json(rule);
      }
      let r;
      try {
        r = await http.post(`${bridgeBase()}/audio/open-voices/start`, body, { timeout: 45000 });
      } catch (e) {
        const d = (e.response && e.response.data) || {};
        /* Her last take is still running: hand its job back so the page picks it up again (with Stop). */
        if (isJobId(d.jobId)) return res.status(409).json({ error: STILL_MAKING, jobId: d.jobId, stillMaking: true });
        const said = typeof d.error === 'string' && d.error ? d.error : 'The voice engine could not be reached. Nothing was made.';
        return res.status(e.response ? 400 : 502).json({ error: said });
      }
      const d = r.data || {};
      if (!d.jobId) return res.status(502).json({ error: 'The voice engine did not start a take. Nothing was made.' });
      log.info(`[soundbooth/open-voices] take job=${d.jobId} engine=${body.engine} mode=${body.mode} user=${req.user.id}`);
      return res.json({ ok: true, jobId: d.jobId, engine: body.engine, mode: b.mode, seed: d.seed, coldLikely: d.coldLikely !== false,
        coldNote: d.coldLikely !== false ? COLD_NOTE : '' });
    } catch (e) {
      log.warn('[soundbooth/open-voices] take failed: ' + e.message);
      return res.status(500).json({ error: 'The take could not start. Try again.' });
    }
  });

  router.get('/open-voices/take/:jobId', auth, async (req, res) => {
    const jobId = req.params.jobId;
    if (!isJobId(jobId)) return res.status(400).json({ error: 'Unknown take.' });
    res.setHeader('Cache-Control', 'no-store');
    let j;
    try {
      const r = await http.get(`${bridgeBase()}/audio/open-voices/status`, { params: { secret: secret(), jobId, userId: String(req.user.id) }, timeout: 15000 });
      j = r.data || {};
    } catch (e) {
      if (e.response && e.response.status === 404) return res.status(404).json({ error: 'That take is no longer listed.' });
      return res.json({ state: 'unknown', spoken: 'Still checking on the take.' });
    }
    const out = { state: j.state, engine: j.engine, mode: j.mode, seed: j.seed, spoken: (j.wait && j.wait.spoken) || '' };
    if (j.state === 'done' && j.result) {
      Object.assign(out, { url: j.result.url, seconds: j.result.seconds, seed: j.result.seed });
      const row = await KadeAsset.findOne({ user: String(req.user.id), 'metadata.jobId': jobId }).select('_id').lean();
      if (row) out.assetId = String(row._id);
    }
    if (j.state === 'failed' || j.state === 'cancelled') out.error = j.error || (j.state === 'cancelled' ? 'Stopped.' : 'The take did not finish.');
    return res.json(out);
  });

  router.post('/open-voices/stop', auth, json, async (req, res) => {
    const jobId = (req.body || {}).jobId;
    if (!isJobId(jobId)) return res.status(400).json({ error: 'Unknown take.' });
    try {
      const r = await http.post(`${bridgeBase()}/audio/open-voices/cancel`, { secret: secret(), jobId, userId: String(req.user.id) }, { timeout: 20000 });
      return res.json({ ok: true, state: r.data && r.data.state });
    } catch (e) {
      return res.status(502).json({ error: 'Stop was not confirmed. Try Stop again.' });
    }
  });

  /* Keep a take as a saved voice: the take's own My Creations row gets the mark. No cap. */
  router.post('/open-voices/keep', auth, json, async (req, res) => {
    try {
      const b = req.body || {};
      const user = String(req.user.id);
      const name = oneLine(b.name).slice(0, MAX_NAME);
      if (!name) return res.status(400).json({ error: 'Give the voice a name first.' });
      if (!isJobId(b.jobId)) return res.status(400).json({ error: 'Unknown take.' });
      const row = await KadeAsset.findOne({ user, 'metadata.jobId': b.jobId, 'metadata.openVoice': { $exists: true } }).select('_id metadata').lean();
      if (!row) return res.status(404).json({ error: 'That take is still being saved. Try Keep again in a moment.' });
      const ov = row.metadata.openVoice || {};
      const savedVoice = { name, engine: ov.engine || null, description: oneLine(ov.description).slice(0, 600),
        words: oneLine(ov.words).slice(0, 1000), seconds: typeof ov.seconds === 'number' ? ov.seconds : null, savedAt: new Date().toISOString() };
      await KadeAsset.updateOne({ _id: row._id, user }, { $set: { 'metadata.savedVoice': savedVoice } });
      log.info(`[soundbooth/open-voices] kept voice asset=${row._id} user=${user}`);
      return res.json({ ok: true, voice: { id: String(row._id), name }, spoken: `Saved ${name} to your voices.` });
    } catch (e) {
      log.warn('[soundbooth/open-voices] keep failed: ' + e.message);
      return res.status(500).json({ error: 'The voice did not save. Try again.' });
    }
  });

  /* Keep an imported clip as a saved voice: a new audio row in My Creations with the mark. */
  router.post('/open-voices/keep-clip', auth, json, async (req, res) => {
    try {
      const b = req.body || {};
      const user = String(req.user.id);
      const name = oneLine(b.name).slice(0, MAX_NAME);
      if (!name) return res.status(400).json({ error: 'Give the voice a name first.' });
      const clip = String(b.clipUrl || '');
      try { await references(user).authorize(clip); } catch (_) { return res.status(400).json({ error: 'That clip is not saved on your account. Import it again.' }); }
      const seconds = Number.isFinite(Number(b.seconds)) && Number(b.seconds) > 0 ? Math.round(Number(b.seconds) * 10) / 10 : null;
      const row = await KadeAsset.create({ user, kind: 'audio', service: 'soundbooth_voice', url: clip, prompt: name, model: 'imported clip', costUSD: 0,
        description: `A voice clip saved as ${name}.`,
        metadata: { savedVoice: { name, engine: null, description: '', words: oneLine(b.clipWords).slice(0, 1000), seconds, savedAt: new Date().toISOString() } } });
      return res.json({ ok: true, voice: { id: String(row._id), name }, spoken: `Saved ${name} to your voices.` });
    } catch (e) {
      log.warn('[soundbooth/open-voices] keep-clip failed: ' + e.message);
      return res.status(500).json({ error: 'The voice did not save. Try again.' });
    }
  });

  /* Forget a saved voice: the mark goes; the recording stays in My Creations. */
  router.post('/open-voices/forget', auth, json, async (req, res) => {
    const id = (req.body || {}).voiceId;
    if (!isId(id)) return res.status(400).json({ error: 'Unknown voice.' });
    try {
      const r = await KadeAsset.updateOne({ _id: id, user: String(req.user.id), 'metadata.savedVoice': { $exists: true } }, { $unset: { 'metadata.savedVoice': '' } });
      if (!r || !(r.modifiedCount || r.nModified)) return res.status(404).json({ error: 'That voice is already gone.' });
      return res.json({ ok: true, spoken: 'Removed from your voices. The recording stays in My Creations.' });
    } catch (e) {
      return res.status(500).json({ error: 'Could not remove it. Try again.' });
    }
  });

  return router;
}

/* The /health block. Never inside guide.engines (older iPhone builds list those).
 * /health opens the booth for every engine, so it never waits on the bridge for long: it takes the
 * live answer if it comes within `waitMs`, otherwise the last known one (or nothing yet), and the
 * bridge call carries on in the background to fill the cache. The panel's own GET /open-voices
 * still waits for the live answer. */
async function healthBlock(readiness, waitMs = 300) {
  const fallback = () => (typeof readiness.last === 'function' && readiness.last()) || NOTHING;
  try {
    let timer;
    const live = Promise.resolve().then(() => readiness()).catch(() => fallback());
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback()), waitMs); if (timer.unref) timer.unref(); });
    const ready = await Promise.race([live, late]);
    clearTimeout(timer);
    return { engines: engineList(ready), coldNote: COLD_NOTE };
  } catch (_) { return { engines: [], coldNote: COLD_NOTE }; }
}

module.exports = { createOpenVoicesRouter, createReadiness, checkTake, mingRules, mingRule, soundTags, MING_CONTROLS, promptWordsFor, voiceView, engineList, healthBlock, ENGINES, COLD_NOTE, MAX_TEXT, PROMPT_CLIP_MAX_S, STILL_MAKING };
