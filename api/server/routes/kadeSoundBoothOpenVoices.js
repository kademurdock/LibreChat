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
 *
 * Nov 16 2026: CHATTERBOX and DRAMABOX join (bridge open-voices.js; workers chatterbox_contract.py
 * and dramabox_contract.py). Each is offered only while the bridge health says it is configured
 * (CHATTERBOX_ENDPOINT_ID / DRAMABOX_ENDPOINT_ID set there); a bridge without them never lists them.
 *   Chatterbox: no description. Design a voice = its own built-in voice; Speak with a voice = a saved
 *     voice or clip. A Version (Turbo, Original, Multilingual) and only that version's controls:
 *     Turbo sound tags; Original and Multilingual Expressiveness (exaggeration) and Steadiness
 *     (cfg_weight); Multilingual a language; Variety (temperature) for all. Turbo clips must be over 5 s.
 *   DramaBox: no description and no style. Words to say becomes the Scene: words in double quotes
 *     are spoken, the rest is how they are acted. Optional Scene length (3-45 s). A clip of at least
 *     3 s sets the voice.
 * A clip's typed words go only to VoxCPM2 and Ming (the other two never read them). In /health the
 * two new engines are listed under openVoices.moreEngines, not openVoices.engines: an iPhone build
 * that shows every listed engine with a description box would only be refused.
 *
 * Nov 20 2026, her words: "it never clones the reference voice on chatterbox when I try. The voice
 * never sounds remotely the same as the ref I give." The logs: every Chatterbox take she ever made
 * was Design a voice (its built-in voice), and every clip she gave went to DramaBox. Measured on her
 * own clip (ECAPA speaker likeness, same person about 0.9, a stranger about 0.06): Chatterbox Turbo
 * and Original copy it at 0.83; DramaBox at 0.20 with the first 10 s of the clip, 0.35 with 20 s, no
 * matter what the scene says (upstream trains DramaBox to take only the clip's general sound). So a
 * DramaBox clip now sends 20 seconds (DRAMABOX_CONTROLS.referenceSeconds), Speak with a voice on
 * DramaBox says plainly that Chatterbox makes the close copy (speakNote), and a Chatterbox Design
 * take made while a clip is imported says it used the built-in voice.
 *
 * Nov 22 2026, her words: "I do want qwen for voice design for now on the booth at least". QWEN joins
 * (bridge open-voices.js; worker qwentts_contract.py on our own RunPod endpoint, QWEN_TTS_ENDPOINT_ID
 * on the bridge). Design a voice = a description and at most 1,500 characters (Qwen3-TTS VoiceDesign);
 * Speak with a voice = a saved voice or clip with its words (Qwen3-TTS Base, which copies the clip
 * closely when it has the clip's exact words, so a kept Qwen take speaks on in the same voice). No
 * style. Its own Language and Variety menus (QWEN_CONTROLS), sent as qwen_language / qwen_variety and
 * passed on as the worker's language / temperature. Listed in /health under moreEngines (`newer`).
 * -------------------------------------------------------------------------- */
const express = require('express');
const writer = require('./kadeSoundBoothOpenVoicesWriter');

const WORDS_HINT = 'For a voice you plan to keep, a sentence or two is best.';
const COLD_NOTE = 'The first take after a quiet spell can take a few minutes while the voice engine starts. After that, takes come back in seconds.';
const ENGINES = {
  voxcpm: { id: 'voxcpm', label: 'VoxCPM2', maxDescription: 400, maxText: 5000,
    about: 'Open voice model. Designs a voice from a description, or speaks in a saved voice or a clip.' },
  ming: { id: 'ming', label: 'Ming', maxDescription: 600, maxText: 2500,
    about: 'Open voice model from Ant Group. Designs a voice from a description, or speaks in a saved voice or a clip.' },
  chatterbox: { id: 'chatterbox', label: 'Chatterbox', maxDescription: 0, maxText: 5000, more: true,
    about: 'Quick, expressive voices. Turbo takes sound tags like laugh and sigh.',
    designNote: 'Chatterbox uses its own built-in voice here. To use your own voice, choose Speak with a voice.' },
  dramabox: { id: 'dramabox', label: 'DramaBox', maxDescription: 0, maxText: 4000, more: true,
    about: 'Write a scene. Words in quotes are spoken, the rest is how they are acted. English only.',
    designNote: 'DramaBox picks the voice from your scene. Describe the speaker in the scene, outside the quotes.',
    speakNote: 'DramaBox takes only the general sound of a clip, so its take will not sound much like the clip. For a close copy of a voice, choose Chatterbox.',
    textLabel: 'Scene',
    textHint: 'Words inside double quotes are spoken. Everything else is how they are acted, and is never said. For example: An old sailor, tired but kind, leans on the rail. "Storm\'s coming." He laughs softly. "Always is."', // "Up to N characters." is added below, from maxText (Nov 17 2026)
    coldNote: 'The first DramaBox take after a quiet spell can take several minutes while it loads. After that, takes come back much faster.' },
  qwen: { id: 'qwen', label: 'Qwen', maxDescription: 1000, maxText: 5000, maxDesignText: 1500, newer: true,
    about: 'Open voice model from Alibaba. Designs a voice from a description, and a kept take speaks anything in that same voice.',
    speakNote: 'Qwen copies a voice most closely from a saved voice made with Qwen, or from a clip of thirty seconds or less with its words typed in. Without the words it takes only the general sound.',
    coldNote: 'The first Qwen take after a quiet spell can take a few minutes while the voice engine starts. After that, takes come back in seconds.' },
};
for (const e of Object.values(ENGINES)) {
  e.textLabel = e.textLabel || 'Words to say';
  e.textHint = e.textHint ? `${e.textHint} Up to ${e.maxText.toLocaleString('en-US')} characters.` : `Up to ${e.maxText.toLocaleString('en-US')} characters. ${WORDS_HINT}`;
  e.coldNote = e.coldNote || COLD_NOTE;
}
ENGINES.qwen.textHint = `Up to ${ENGINES.qwen.maxDesignText.toLocaleString('en-US')} characters when designing a voice, and ${ENGINES.qwen.maxText.toLocaleString('en-US')} when speaking with one. ${WORDS_HINT}`;

/* Qwen's menus (worker qwentts_contract.py; the bridge checks the same rules). Language names are
 * the models' own (codec_language_id); empty = Auto, found from the words. Variety is the sampling
 * temperature, usual 0.9 (the models' generation_config.json), 0.1 to 2. */
const QWEN_CONTROLS = {
  languages: ['English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'].map((l) => ({ value: l, label: l })),
  variety: [0.1, 2],
  varietyOptions: [{ value: '0.6', label: 'Steadier, more even' }, { value: '0.75', label: 'A little steadier' }, { value: '', label: 'The usual' },
    { value: '1.1', label: 'Livelier' }, { value: '1.3', label: 'Wilder, less predictable' }],
  languageHint: 'The language of the words to say. Auto works it out from the words.',
  varietyHint: 'How much each take varies in delivery. Steadier is calmer and more even; livelier has more swing, and can slip.',
};
/* Qwen's own fields -> { fields } or { error, field }. */
function qwenRule(b, mode, text) {
  const no = (error, field) => ({ error, field });
  const fields = {};
  if (mode === 'design' && text.length > ENGINES.qwen.maxDesignText) {
    return no(`Qwen designs a voice from at most ${ENGINES.qwen.maxDesignText.toLocaleString('en-US')} characters. Keep a take, then speak longer words with the kept voice.`, 'text');
  }
  if (isSet(b.qwen_language)) {
    const lang = QWEN_CONTROLS.languages.find((l) => l.value.toLowerCase() === String(b.qwen_language).trim().toLowerCase());
    if (!lang) return no('Pick a language from the list, or Auto.', 'qwen_language');
    fields.language = lang.value;
  }
  if (isSet(b.qwen_variety)) {
    const t = numberOf(b.qwen_variety);
    const [lo, hi] = QWEN_CONTROLS.variety;
    if (!Number.isFinite(t) || t < lo || t > hi) return no(`Variety must be a number from ${lo} to ${hi}. Pick one from the list.`, 'qwen_variety');
    fields.temperature = t;
  }
  return { fields };
}

/* Chatterbox's controls (worker chatterbox_contract.py; the bridge checks the same rules). Each
 * option is { value, label }. Labels are what she hears; the values go to the worker. */
const CB_LANGUAGES = { ar: 'Arabic', zh: 'Chinese', da: 'Danish', nl: 'Dutch', en: 'English', fi: 'Finnish', fr: 'French', de: 'German',
  el: 'Greek', he: 'Hebrew', hi: 'Hindi', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ru: 'Russian', es: 'Spanish', sw: 'Swahili', sv: 'Swedish', tr: 'Turkish' };
const CHATTERBOX_CONTROLS = {
  versions: [
    { value: 'turbo', label: 'Turbo', about: 'Turbo: fast, English, and takes sound tags like laugh and sigh. In Speak with a voice, its clip must be over 5 seconds.', variety: [0.05, 2] },
    { value: 'original', label: 'Original', about: 'Original: English, with Expressiveness and Steadiness.', variety: [0.05, 5] },
    { value: 'multilingual', label: 'Multilingual', about: 'Multilingual: 23 languages, with Expressiveness and Steadiness. Pick the language below.', variety: [0.05, 5] },
  ],
  /* chatterbox-turbo's added tokens: nine sound events, then ten style tokens upstream does not document. */
  tags: [
    ...[['[laugh]', 'Laugh'], ['[chuckle]', 'Chuckle'], ['[sigh]', 'Sigh'], ['[gasp]', 'Gasp'], ['[cough]', 'Cough'], ['[clear throat]', 'Clear throat'],
      ['[sniff]', 'Sniff'], ['[groan]', 'Groan'], ['[shush]', 'Shush']].map(([value, label]) => ({ value, label })),
    ...[['[whispering]', 'Whispering'], ['[happy]', 'Happy'], ['[angry]', 'Angry'], ['[sarcastic]', 'Sarcastic'], ['[surprised]', 'Surprised'],
      ['[fear]', 'Fear'], ['[crying]', 'Crying'], ['[dramatic]', 'Dramatic'], ['[narration]', 'Narration'], ['[advertisement]', 'Advertisement']]
      .map(([value, label]) => ({ value, label: `${label}, a way of speaking` })),
  ],
  aliases: ['laughs', 'laughing', 'laughter', 'chuckles', 'giggle', 'giggles', 'sighs', 'sighing', 'coughs', 'coughing', 'gasps', 'groans',
    'sniffs', 'sniffle', 'throat clear', 'clears throat', 'clearing throat', 'shh', 'whisper', 'whispers', 'cries', 'crying', 'sarcasm', 'surprise', 'scared'],
  languages: Object.entries(CB_LANGUAGES).map(([value, label]) => ({ value, label })),
  exaggeration: [0.25, 2],
  tagNote: 'Puts the tag where your cursor was in Words to say. Sound tags work only with Turbo.',
  turboClipMinS: 5,
};
/* referenceSeconds: how much of a clip DramaBox hears (bridge and worker allow 3-30, worker default 10;
 * a shorter clip is used whole). 20 s raised likeness to her clip from 0.20 to 0.35 (Nov 20 2026). */
const DRAMABOX_CONTROLS = { duration: [3, 45], clipMinS: 3, referenceSeconds: 20 };
/* Nov 16 2026, her yes: the strength and quality knobs the workers already read, as menus.
 * VoxCPM2 (voxcpm_contract.py): inference_timesteps 4-50, usual 10 (its quickest); cfg_value 0.5-5,
 * usual 2. DramaBox (dramabox_contract.py): cfg_scale 1-10, usual 2.5. The page sends `steps` and
 * `cfg`; the bridge maps them to each worker's own names. They go out under `settings`, not
 * `controls`, so an iPhone build that reads `controls` as Ming's never sees them. Empty = the usual. */
const ENGINE_SETTINGS = {
  voxcpm: {
    steps: { range: [4, 50], label: 'Quality', hint: 'More steps usually sound cleaner. Each step up adds a few seconds of GPU time, still about 1 to 2 cents a take.',
      options: [{ value: '', label: 'The usual, quickest' }, { value: '20', label: 'Better, a little slower' }, { value: '30', label: 'Best, slower' }, { value: '50', label: 'Highest, slowest' }] },
    cfg: { range: [0.5, 5], label: 'How closely it follows', hint: 'How closely the voice keeps to your description or style. Very close can sound strained.',
      options: [{ value: '1.5', label: 'Loose, more freedom' }, { value: '', label: 'The usual' }, { value: '2.5', label: 'Closer' }, { value: '3', label: 'Very close' }] },
  },
  dramabox: {
    cfg: { range: [1, 10], label: 'How closely it follows the scene', hint: 'Closer keeps to the acting and sounds you wrote. Very close can sound strained.',
      options: [{ value: '1.5', label: 'Loose, more freedom' }, { value: '', label: 'The usual' }, { value: '3.5', label: 'Closer' }, { value: '5', label: 'Very close' }] },
  },
};
const SETTING_NAMES = { steps: 'Quality', cfg: 'How closely it follows' };
/* The strength and quality of a take request -> { fields } or { error, field }. */
function settingsRule(b, engine) {
  const own = ENGINE_SETTINGS[engine] || {};
  const fields = {};
  for (const k of ['steps', 'cfg']) {
    if (!isSet(b[k])) continue;
    const s = own[k];
    if (!s) return { error: `${SETTING_NAMES[k]} is not a setting ${ENGINES[engine].label} has. Set it back to the usual.`, field: k };
    const n = numberOf(b[k]);
    const [lo, hi] = s.range;
    if (!Number.isFinite(n) || n < lo || n > hi || (k === 'steps' && !Number.isInteger(n))) {
      return { error: `${s.label} must be ${k === 'steps' ? 'a whole number' : 'a number'} from ${lo} to ${hi}. Pick one from the list.`, field: k };
    }
    fields[k] = n;
  }
  return { fields };
}
const CB_TAG_RE = /\[([^\[\]]{1,40})\]/g; // the worker's own pattern: any bracketed words
const CB_KNOWN = new Set(CHATTERBOX_CONTROLS.tags.map((t) => t.value.slice(1, -1)).concat(CHATTERBOX_CONTROLS.aliases));
const CURLY_QUOTES = /[“”„‟«»]/g;
const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const numberOf = (v) => (typeof v === 'number' ? v : Number(String(v).trim()));
/* Words that are only tags, spaces and end marks say nothing. */
const SAYS_NOTHING = /^[\s.,!?]*$/;

/* Chatterbox's own fields -> { fields } or { error, field }. */
function chatterboxRule(b, text) {
  const no = (error, field) => ({ error, field });
  const version = isSet(b.version) ? String(b.version).trim().toLowerCase() : 'turbo';
  const v = CHATTERBOX_CONTROLS.versions.find((x) => x.value === version);
  if (!v) return no('Pick Turbo, Original or Multilingual for the version.', 'version');
  const fields = { version };
  let unknown = '';
  let tagged = false;
  for (const m of text.matchAll(CB_TAG_RE)) {
    if (CB_KNOWN.has(m[1].replace(/\s+/g, ' ').trim().toLowerCase())) tagged = true;
    else if (!unknown) unknown = m[0];
  }
  if (version === 'turbo') {
    if (unknown) return no(`Chatterbox Turbo does not know the sound tag ${unknown}. Pick one from Sound tags, or take it out.`, 'text');
    if (SAYS_NOTHING.test(text.replace(CB_TAG_RE, ''))) return no('Type some words to say, not only sound tags.', 'text');
  } else if (tagged) return no('Sound tags work only with Chatterbox Turbo. Take them out, or set the version to Turbo.', 'text');
  if (isSet(b.temperature)) {
    const t = numberOf(b.temperature);
    const [lo, hi] = v.variety;
    if (!Number.isFinite(t) || t < lo || t > hi) return no(`Variety must be a number from ${lo} to ${hi} for ${v.label}.`, 'temperature');
    fields.temperature = t;
  }
  if (version === 'turbo') {
    if (isSet(b.exaggeration)) return no('Expressiveness is for Original and Multilingual. Turbo does not use it.', 'exaggeration');
    if (isSet(b.cfg_weight)) return no('Steadiness is for Original and Multilingual. Turbo does not use it.', 'cfg_weight');
  } else {
    if (isSet(b.exaggeration)) {
      const x = numberOf(b.exaggeration);
      const [lo, hi] = CHATTERBOX_CONTROLS.exaggeration;
      if (!Number.isFinite(x) || x < lo || x > hi) return no(`Expressiveness must be a number from ${lo} to ${hi}.`, 'exaggeration');
      fields.exaggeration = x;
    }
    if (isSet(b.cfg_weight)) {
      const c = numberOf(b.cfg_weight);
      const zeroOk = version === 'multilingual';
      if (!Number.isFinite(c) || c > 1 || c < 0 || (c === 0 && !zeroOk)) {
        return no(zeroOk ? 'Steadiness must be a number from 0 to 1.' : 'Steadiness must be above 0 and at most 1 for Original.', 'cfg_weight');
      }
      fields.cfg_weight = c;
    }
  }
  const lang = isSet(b.language_id) ? String(b.language_id).trim().toLowerCase() : '';
  if (version === 'multilingual') {
    if (!CB_LANGUAGES[lang]) return no('Pick a language for Multilingual.', 'language_id');
    fields.language_id = lang;
  } else if (lang && lang !== 'en') return no(`${v.label} speaks English only. Set the version to Multilingual for other languages.`, 'version');
  return { fields };
}

/* DramaBox's scene and length -> { fields } or { error, field }. */
function dramaboxRule(b, text) {
  const no = (error, field) => ({ error, field });
  const scene = text.replace(CURLY_QUOTES, '"');
  if ((scene.match(/"/g) || []).length % 2) return no('A quote mark in the scene is not closed. Put every spoken line inside double quotes.', 'text');
  if (![...scene.matchAll(/"([^"]+)"/g)].some((m) => m[1].trim())) {
    return no('The scene needs at least one spoken line inside double quotes. Words outside the quotes are acted, not spoken.', 'text');
  }
  const fields = {};
  if (isSet(b.duration) && numberOf(b.duration) !== 0) {
    const d = numberOf(b.duration);
    const [lo, hi] = DRAMABOX_CONTROLS.duration;
    if (!Number.isFinite(d) || d < lo || d > hi) return no(`Scene length must be from ${lo} to ${hi} seconds, or empty to let DramaBox decide.`, 'duration');
    fields.duration = d;
  }
  return { fields };
}

/* The shortest clip each engine takes (null: no rule here). */
function clipFloor(body) {
  if (body.engine === 'chatterbox' && body.version === 'turbo') {
    return { over: CHATTERBOX_CONTROLS.turboClipMinS, error: 'Chatterbox Turbo needs a clip longer than 5 seconds. Pick a longer one, or set the version to Original.' };
  }
  if (body.engine === 'dramabox') return { atLeast: DRAMABOX_CONTROLS.clipMinS, error: 'DramaBox needs a clip of at least 3 seconds. Pick a longer one.' };
  return null;
}

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
  if (engine !== 'ming') return { error: 'Built-in voices, emotion, speed, pitch, volume and language work only with Ming.', field: given[0] };
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
const MAX_CLIP_WORDS = 1000; // the bridge refuses a clip's words past this (open-voices.js MAX_PROMPT_TEXT)
const PROMPT_CLIP_MAX_S = 29.5; // the workers take a clip's exact words only for a clip of 30 s or less
const HEALTH_TTL_MS = 60 * 1000;
const PROMPT_CLIP_SENTENCE = 'The exact words only work for a clip of thirty seconds or less. Clear the words, or use a shorter clip.';
const STILL_MAKING = 'Your last take is still being made. The page will say when it is ready.';

const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const isJobId = (v) => typeof v === 'string' && /^ov_[a-z0-9]{6,40}$/i.test(v);

/* mingControls: the bridge reads Ming's extra controls (its health says ming.controls). Until it does,
 * the controls are neither offered nor forwarded, so a fork deployed before its bridge never sends a
 * control the bridge would silently drop on paid GPU time. */
const NOTHING = Object.freeze({ voxcpm: false, ming: false, mingControls: false, chatterbox: false, dramabox: false, qwen: false });

/* Which engines the bridge can run. Read from its health (cached, one call in flight at a time).
 * When the bridge cannot be reached (a network error or a timeout) VoxCPM2, which has a default
 * endpoint, is offered and Ming stays hidden. When the bridge answers with an HTTP error (a 403
 * from a secret that does not match, a 404 from a bridge without the lane) nothing is offered. */
function createReadiness({ http, bridgeBase, secret, now = () => Date.now() }) {
  let cached = null;
  let inflight = null;
  async function ask() {
    let value = { voxcpm: true, ming: false, mingControls: false, chatterbox: false, dramabox: false, qwen: false };
    try {
      const r = await http.get(`${bridgeBase()}/audio/open-voices/health`, { params: { secret: secret() }, timeout: 4000 });
      const d = (r && r.data) || {};
      const e = d.engines || {};
      const ming = !!(d.enabled && e.ming && e.ming.configured);
      const on = (k) => !!(d.enabled && e[k] && e[k].configured);
      value = { voxcpm: on('voxcpm'), ming, mingControls: ming && e.ming.controls === true, chatterbox: on('chatterbox'), dramabox: on('dramabox'), qwen: on('qwen') };
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
    maxText: e.maxText, textLabel: e.textLabel, textHint: e.textHint, coldNote: e.coldNote, ...(e.designNote ? { designNote: e.designNote } : {}),
    ...(e.speakNote ? { speakNote: e.speakNote } : {}),
    ...(e.id === 'ming' && ready.mingControls ? { controls: MING_CONTROLS } : {}),
    ...(e.id === 'chatterbox' ? { controls: CHATTERBOX_CONTROLS } : {}), ...(e.id === 'dramabox' ? { controls: DRAMABOX_CONTROLS } : {}),
    ...(e.id === 'qwen' ? { controls: QWEN_CONTROLS, maxDesignText: e.maxDesignText } : {}),
    ...(ENGINE_SETTINGS[e.id] ? { settings: ENGINE_SETTINGS[e.id] } : {}) }));
}

function voiceView(row, url) {
  const v = (row.metadata && row.metadata.savedVoice) || {};
  return { id: String(row._id), name: v.name || 'Saved voice', engine: v.engine || null, description: v.description || '',
    seconds: typeof v.seconds === 'number' ? v.seconds : null, url, savedAt: v.savedAt || null };
}

/* The words of a saved voice's clip go to the worker only when they cover a short clip. */
function promptWordsFor(saved) {
  const words = oneLine(saved && saved.words);
  return words && typeof saved.seconds === 'number' && saved.seconds > 0 && saved.seconds <= PROMPT_CLIP_MAX_S ? words.slice(0, MAX_CLIP_WORDS) : '';
}

function seedOf(b) {
  if (b.seed !== undefined && b.seed !== null && String(b.seed).trim() !== '') {
    const seed = Number(String(b.seed).trim());
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) return { error: 'The voice number must be a whole number from 0 to 2147483647.', field: 'seed' };
    return { seed };
  }
  return {};
}

/* A take request -> the bridge body (without the reference), or { error }. */
function checkTake(b = {}, ready = {}) {
  const engine = String(b.engine || '');
  if (!ENGINES[engine]) return { error: 'Pick a voice engine from the list.', field: 'engine' };
  if (!ready[engine]) {
    return { error: engine === 'ming' ? 'Ming is not set up yet. Use VoxCPM2 for now.' : engine === 'voxcpm' ? 'VoxCPM2 is not available right now.'
      : `${ENGINES[engine].label} is not set up yet. Pick another voice engine.`, field: 'engine' };
  }
  const mode = b.mode === 'design' ? 'design' : b.mode === 'speak' ? 'speak' : '';
  if (!mode) return { error: 'Choose Design a voice or Speak with a voice.' };
  const scene = engine === 'dramabox';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return { error: scene ? 'Write the scene first.' : 'Type the words to say.', field: 'text' };
  const maxText = ENGINES[engine].maxText;
  if (text.length > maxText) return { error: `The ${scene ? 'scene is' : 'words are'} too long for ${ENGINES[engine].label}. The most is ${maxText} characters.`, field: 'text' };
  const body = { engine, mode: mode === 'design' ? 'design' : 'clone', text };
  const ming = mingFields(b, engine, mode);
  if (ming.error) return { error: ming.error, field: ming.field };
  const tuned = settingsRule(b, engine);
  if (tuned.error) return tuned;
  Object.assign(body, tuned.fields);
  if (ENGINES[engine].more) {
    /* Chatterbox and DramaBox: no description, no style; their own controls. */
    if (mode === 'design' && oneLine(b.description)) {
      return { error: scene ? 'DramaBox takes no description. Describe the speaker in the scene, outside the quotes.' : ENGINES.chatterbox.designNote, field: 'description' };
    }
    if (mode === 'speak' && oneLine(b.style)) {
      return { error: `${ENGINES[engine].label} takes no style. ${scene ? 'Write how it is said in the scene, outside the quotes.' : 'Clear the style.'}`, field: 'style' };
    }
    if (mode === 'speak' && !isId(b.voiceId) && !(typeof b.clipUrl === 'string' && b.clipUrl)) return { error: 'Pick a saved voice or import a clip first.', field: 'reference' };
    const own = scene ? dramaboxRule(b, text) : chatterboxRule(b, text);
    if (own.error) return own;
    Object.assign(body, own.fields);
    /* Nov 20 2026: DramaBox hears 20 s of the clip, not its own 10 (see the header). */
    if (scene && mode === 'speak') body.reference_seconds = DRAMABOX_CONTROLS.referenceSeconds;
    const seed = seedOf(b);
    if (seed.error) return seed;
    if (seed.seed !== undefined) body.seed = seed.seed;
    return { body };
  }
  if (engine === 'qwen') {
    if (mode === 'speak' && oneLine(b.style)) return { error: 'Qwen takes no style. Put how it sounds in the voice description when you design it.', field: 'style' };
    const own = qwenRule(b, mode, text);
    if (own.error) return own;
    Object.assign(body, own.fields);
  }
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
  const seed = seedOf(b);
  if (seed.error) return seed;
  if (seed.seed !== undefined) body.seed = seed.seed;
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
  async function referenceFor(user, b, useWords = true) {
    if (isId(b.voiceId)) {
      const row = await KadeAsset.findOne({ _id: b.voiceId, user, 'metadata.savedVoice': { $exists: true } }).select('url backupUrl metadata.savedVoice').lean();
      if (!row) return { error: 'That saved voice is gone. Pick another one.', field: 'reference' };
      const url = await fresh(row.backupUrl || row.url);
      const seconds = row.metadata.savedVoice.seconds;
      return { url, words: useWords ? promptWordsFor(row.metadata.savedVoice) : '', seconds: typeof seconds === 'number' ? seconds : null };
    }
    let url;
    try {
      url = await references(user).refresh(String(b.clipUrl));
    } catch (e) {
      return { error: 'That clip is not saved on your account. Import it again.', field: 'reference' };
    }
    const seconds = Number(b.clipSeconds);
    const known = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    if (!useWords) return { url, words: '', seconds: known };
    /* The workers take a clip's exact words only for a clip of thirty seconds or less. A clip known
     * to be longer is refused before any GPU time; a clip of unknown length goes without the words. */
    let words = oneLine(b.clipWords).slice(0, MAX_CLIP_WORDS);
    if (words) {
      if (Number.isFinite(seconds) && seconds > PROMPT_CLIP_MAX_S) return { error: PROMPT_CLIP_SENTENCE };
      if (!(Number.isFinite(seconds) && seconds > 0)) words = '';
    }
    return { url, words, seconds: known };
  }

  router.get('/open-voices', auth, async (req, res) => {
    try {
      const ready = await readiness();
      const voices = await savedVoices(String(req.user.id));
      return res.json({ engines: engineList(ready), voices, coldNote: COLD_NOTE,
        /* Nov 17 2026: the page's boxes take these as their maxlength and count (idea and clipWords added). */
        limits: { text: MAX_TEXT, style: MAX_STYLE, name: MAX_NAME, idea: writer.MAX_IDEA, clipWords: MAX_CLIP_WORDS } });
    } catch (e) {
      log.warn('[soundbooth/open-voices] list failed: ' + e.message);
      return res.status(500).json({ error: 'Could not load your voices. Try again.' });
    }
  });

  /* Nov 16 2026: the script writer for every engine (kadeSoundBoothOpenVoicesWriter.js). `deps.write`
   * is the booth desk's own call ({ system, user, req } -> { text, costUSD } or { error, status });
   * without it the route says the writer is not here. Nothing is rendered and no GPU time is used. */
  router.post('/open-voices/write', auth, json, async (req, res) => {
    const b = req.body || {};
    if (typeof deps.write !== 'function') return res.status(503).json({ error: 'The writer is not available here.' });
    const ready = await readiness();
    if (!ENGINES[b.engine] || !ready[b.engine]) return res.status(400).json({ error: 'Pick a voice engine first.', field: 'engine' });
    const language = typeof b.language_id === 'string' ? CB_LANGUAGES[b.language_id]
      : b.engine === 'qwen' && typeof b.qwen_language === 'string' ? ((QWEN_CONTROLS.languages.find((l) => l.value === b.qwen_language) || {}).label || '') : '';
    const builtin = b.engine === 'ming' && b.mode !== 'speak' && typeof b.voice === 'string' && b.voice
      ? (MING_CONTROLS.voices.find((v) => v.value === b.voice) || {}) : null;
    const ask = writer.writerRequest({ ...b, languageName: language || '', builtin: !!builtin, builtinName: builtin && builtin.label });
    if (ask.error) return res.status(400).json({ error: ask.error, field: ask.field });
    try {
      const out = await deps.write({ system: ask.system, user: ask.user, req, engine: b.engine, how: ask.how });
      if (out.error) return res.status(out.status || 502).json({ error: out.error });
      const got = writer.parseWriterReply(out.text, { engine: b.engine, version: b.version, how: ask.how, shape: ask.shape, askVoice: ask.askVoice });
      if (got.error) return res.status(502).json({ error: got.error });
      log.info(`[soundbooth/open-voices] wrote engine=${b.engine} how=${ask.how} chars=${got.text.length} voice=${got.voice ? 1 : 0}`);
      const where = b.engine === 'dramabox' ? 'Scene' : 'Words to say';
      const spoken = (ask.how === 'format' ? `Your words are formatted for ${ask.shape.name}, in ${where}.` : `Written for ${ask.shape.name}. It is in ${where}.`)
        + (got.cutTo ? ` Cut to the ${got.cutTo.toLocaleString('en-US')} characters ${ask.shape.name} takes.` : '')
        + (got.voice ? ' A voice description was added too.' : '') + ' Read it over, then Make a take.';
      return res.json({ text: got.text, voice: got.voice, spoken });
    } catch (e) {
      log.warn('[soundbooth/open-voices] write failed: ' + e.message);
      return res.status(502).json({ error: 'The writer had trouble. Your idea is kept. Try again.' });
    }
  });

  router.post('/open-voices/take', auth, json, async (req, res) => {
    try {
      const b = req.body || {};
      const checked = checkTake(b, await readiness());
      if (checked.error) log.info(`[soundbooth/open-voices] take refused engine=${String(b.engine || '').slice(0, 12)} mode=${String(b.mode || '').slice(0, 8)} field=${checked.field || '-'}`);
      if (checked.error) return res.status(400).json({ error: checked.error, ...(checked.field ? { field: checked.field } : {}) });
      const body = { ...checked.body, secret: secret(), userId: String(req.user.id) };
      if (body.mode === 'clone') {
        const more = !!ENGINES[body.engine].more;
        const ref = await referenceFor(String(req.user.id), b, !more);
        if (ref.error) return res.status(400).json({ error: ref.error, ...(ref.field ? { field: ref.field } : {}) });
        /* A clip known to be too short for the engine is refused before any GPU time. */
        const floor = clipFloor(body);
        if (floor && typeof ref.seconds === 'number' && (floor.over ? ref.seconds <= floor.over : ref.seconds < floor.atLeast)) {
          return res.status(400).json({ error: floor.error, field: 'reference' });
        }
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
      return res.json({ ok: true, jobId: d.jobId, engine: body.engine, ...(body.version ? { version: body.version } : {}), mode: b.mode, seed: d.seed,
        coldLikely: d.coldLikely !== false, coldNote: d.coldLikely !== false ? ENGINES[body.engine].coldNote : '' });
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
    const out = { state: j.state, engine: j.engine, ...(j.version ? { version: j.version } : {}), mode: j.mode, seed: j.seed, spoken: (j.wait && j.wait.spoken) || '' };
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
        words: oneLine(ov.words).slice(0, MAX_CLIP_WORDS), seconds: typeof ov.seconds === 'number' ? ov.seconds : null, savedAt: new Date().toISOString() };
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
        metadata: { savedVoice: { name, engine: null, description: '', words: oneLine(b.clipWords).slice(0, MAX_CLIP_WORDS), seconds, savedAt: new Date().toISOString() } } });
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
    const list = engineList(ready);
    const later = (e) => !!(ENGINES[e.id].more || ENGINES[e.id].newer);
    return { engines: list.filter((e) => !later(e)), moreEngines: list.filter(later), coldNote: COLD_NOTE };
  } catch (_) { return { engines: [], moreEngines: [], coldNote: COLD_NOTE }; }
}

module.exports = { createOpenVoicesRouter, createReadiness, checkTake, settingsRule, ENGINE_SETTINGS, mingRules, mingRule, soundTags, chatterboxRule, dramaboxRule, qwenRule, clipFloor,
  MING_CONTROLS, CHATTERBOX_CONTROLS, DRAMABOX_CONTROLS, QWEN_CONTROLS, promptWordsFor, voiceView, engineList, healthBlock, ENGINES, COLD_NOTE, MAX_TEXT, MAX_STYLE, MAX_NAME, MAX_CLIP_WORDS, PROMPT_CLIP_MAX_S, STILL_MAKING };
