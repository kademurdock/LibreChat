'use strict';
/**
 * kadeSoundBoothScreenplay.js — THE SCRIPT AS A SCRIPT (Part 126, Sep 4 2026).
 *
 * Her words: "I hate that the user has to see that raw code in the script. I
 * wish we could teach the platform to act like it's an actual script, with
 * brackets and whatnot. Then just behind the scenes, code it into what the
 * scenema thing understands."
 *
 * So the person writes and reads a SCREENPLAY, and this file turns it into the
 * <speak> XML Scenema wants — and back again, so a project written by the
 * script desk as XML shows up on the page as a screenplay too. Dependency-free
 * on purpose (node --test with no install), like the splitter beside it.
 *
 * THE FORMAT, read aloud as it is written:
 *
 *   VOICE: Male, mid 60s. Deep baritone with gravel. Worn but warm.
 *   SEX: male
 *   SCENE: Fireside, night, crickets.          (optional)
 *   SHOT: closeup                              (optional: closeup | wide | scene)
 *   LANGUAGE: en                               (optional)
 *
 *   [Calm, almost casual. Staring at his hands.]
 *   I used to think I had all the time in the world.
 *
 *   [Voice tightens. Swallows. Fighting to stay composed.]
 *   Then one Tuesday morning, the doctor said three words.
 *
 *   ((Thunder cracks overhead))
 *   Move! I said move!
 *
 * Square brackets = a stage direction (what the actor is DOING and FEELING; not
 * spoken). Double parentheses = a sound in the room (only heard with SHOT wide
 * or scene). Everything else is spoken. A header line is KEY: value at the top;
 * any header the person leaves out is filled from the booth's settings. Blank
 * lines are just air. Nothing else is special, so nothing else can surprise a
 * screen reader.
 *
 * WHERE THE VOICE LIVES (Oct 2 2026, her report: "it writes things in the
 * wrong places like voice descriptions"). The booth has its own Describe a new
 * voice box, and a VOICE: header said the same thing a second time inside the
 * script, where the box silently won. So the script desk now hands back three
 * things apart: `performance` (only directions and spoken words, never a
 * header), `voice_description` (the one voice, which goes in the box) and the
 * <speak> XML. A VOICE: header is still read when someone types one, and a
 * screen that does not know the box yet (iPhone 2.2.2) still gets it in
 * `screenplay` when the box was empty, so the voice the writer chose reaches
 * the render. When the box has a voice, that voice wins, and the render says so
 * out loud if the script named a different one.
 */

const HEADER_KEYS = {
  voice: 'voice', who: 'voice', speaker: 'voice',
  sex: 'gender', gender: 'gender',
  scene: 'scene', where: 'scene', place: 'scene',
  shot: 'shot',
  language: 'language', lang: 'language',
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function unescapeXml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Is this text already Scenema XML? */
function isSpeakXml(text) {
  return /<speak[\s>]/i.test(String(text || ''));
}

/** The words people use for a voice's sex, read the way the <speak> tag wants them. */
function normalGender(value, fallback = 'female') {
  const g = String(value || '').toLowerCase().trim();
  if (/^(m|man|male|boy|he|him)$/.test(g)) return 'male';
  if (/^(f|w|woman|female|girl|she|her)$/.test(g)) return 'female';
  return fallback;
}

/** The <speak> tag's attributes, unescaped, keyed in lower case. Empty when there is no tag. */
function speakAttrs(xml) {
  const open = String(xml || '').match(/<speak\b([^>]*)>/i);
  const attrs = {};
  if (!open) return attrs;
  const attrRe = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = attrRe.exec(open[1])) !== null) attrs[a[1].toLowerCase()] = unescapeXml(a[2]);
  return attrs;
}

/** The same XML with voice= set to `voice`; every other attribute and the body stay as they were. */
function withSpeakVoice(xml, voice) {
  const v = escapeXml(String(voice || '').trim());
  return String(xml || '').replace(/<speak\b[^>]*>/i, (tag) =>
    tag.replace(/\svoice\s*=\s*(["'])[\s\S]*?\1/i, '').replace(/<speak\b/i, `<speak voice="${v}"`));
}

/**
 * Header lines (VOICE:, SEX:, SCENE:...) a writer put INSIDE the <speak> body,
 * before the first spoken word. Inside the XML they would be read aloud, so
 * they move up into the tag: an attribute the tag already has stays, and the
 * header fills only what is missing. Returns { xml, lifted } with `lifted` the
 * header values found (empty when nothing moved).
 */
function liftBodyHeaders(xml) {
  const s = String(xml || '');
  const open = s.match(/<speak\b[^>]*>/i);
  if (!open) return { xml: s, lifted: {} };
  const bodyStart = open.index + open[0].length;
  const lines = s.slice(bodyStart).split('\n');
  const lifted = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z]{3,10})\s*:\s*(.+?)\s*$/);
    if (!m || !HEADER_KEYS[m[1].toLowerCase()] || m[2].includes('<')) break;
    lifted[HEADER_KEYS[m[1].toLowerCase()]] = unescapeXml(m[2]);
  }
  if (!Object.keys(lifted).length) return { xml: s, lifted };
  const had = speakAttrs(s);
  const voice = had.voice || lifted.voice || 'A warm, clear adult voice.';
  const gender = normalGender(had.gender || lifted.gender);
  const scene = had.scene || lifted.scene || '';
  let shot = String(had.shot || lifted.shot || '').toLowerCase().trim();
  if (/^close/.test(shot)) shot = 'closeup';
  if (!['closeup', 'wide', 'scene'].includes(shot)) shot = '';
  const language = had.language || lifted.language || '';
  const attrs = [`voice="${escapeXml(voice)}"`, `gender="${gender}"`];
  if (scene) attrs.push(`scene="${escapeXml(scene)}"`);
  if (shot) attrs.push(`shot="${shot}"`);
  if (language && language.toLowerCase() !== 'en') attrs.push(`language="${escapeXml(language)}"`);
  const rest = lines.slice(i).join('\n');
  return { xml: `${s.slice(0, open.index)}<speak ${attrs.join(' ')}>\n${rest.replace(/^\n+/, '')}`, lifted };
}

/* ---- who a voice is, in the two ways a listener notices first ----------------
 * A child or a grown-up, and female or male. Read only when the words say so
 * plainly; anything unclear is left unknown, so the check below can only ever
 * speak up about a plain contradiction ("a woman in her early thirties" telling
 * a story in a voice described as a little girl around five). A bare "girl" or
 * "boy" says nothing about age: grown women are called girls all the time. */
const AGE_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const NOT_AN_AGE = '(?![- ]?(?:minute|min|second|sec|hour|day|week|month|year|time|feet|foot|inch|word|sentence|line|verse|percent|o\'clock))';
const CHILD_RE = new RegExp(
  `\\b(?:little (?:girl|boy|kid|child|one)s?|young (?:girl|boy|child)|child|children|kids?|kiddo|toddler|preschool\\w*|kindergart\\w*|schoolgirl|schoolboy|grade-schooler|(?:[1-9]|1[0-2]|${AGE_WORDS})[- ]years?[- ]old|(?:age|aged|around|about|maybe|roughly) (?:[1-9]|1[0-2]|${AGE_WORDS})\\b${NOT_AN_AGE})\\b`,
  'i',
);
const ADULT_RE = /\b(?:woman|women|man|men|lady|ladies|gentleman|gentlemen|adult|grown[- ]up|grown|mother|father|mom|mum|dad|grandmother|grandfather|grandma|grandpa|granny|grandad|husband|wife|elderly|retired|retiree|middle[- ]aged|in (?:his|her|their) (?:early |mid[- ]?|late )?(?:twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties|[2-9]0s)|(?:1[89]|[2-9]\d)[- ]years?[- ]old)\b/i;
const FEMALE_RE = /\b(?:she|her|hers|herself|woman|women|girls?|lady|ladies|female|feminine|mother|mom|mum|grandmother|grandma|granny|wife|daughter|sister|aunt|queen|princess|actress|waitress|heroine|matriarch|gal)\b/i;
const MALE_RE = /\b(?:he|him|his|himself|man|men|boys?|gentleman|gentlemen|male|masculine|father|dad|grandfather|grandpa|grandad|husband|son|brother|uncle|king|prince|actor|waiter|hero|patriarch|guy|dude|fella|fellow)\b/i;

/** { age: 'child'|'adult'|null, sex: 'female'|'male'|null } for a voice description or a speaker clause. */
function voiceTraits(text) {
  const t = String(text || '');
  const child = CHILD_RE.test(t);
  const adult = ADULT_RE.test(t);
  const female = FEMALE_RE.test(t);
  const male = MALE_RE.test(t);
  return {
    age: child === adult ? null : child ? 'child' : 'adult',
    sex: female === male ? null : female ? 'female' : 'male',
  };
}

/* The verb a readback uses right after naming its speaker ("A woman in her thirties recounts..."). */
const SPEAKING_VERB = /\b(?:tells|says|speaks|speaking|talks|talking|recounts|recounting|describes|describing|shares|sharing|narrates|narrating|reads|explains|remembers|recalls|reflects|reminisces|whispers|sings|asks|announces|introduces|greets|delivers|confides|reveals|invites|welcomes|offers|chats|muses|wonders|admits|confesses|pleads|warns|promises|boasts|complains|jokes|giggles|exclaims|shouts|calls|presents|performs|hosts|addresses|thanks|urges|encourages|apologizes)\b/i;

/** Who a readback says is speaking: its first sentence up to the speaking verb, within the first
 *  twenty words. Empty when it never names a speaker that way ("A bedtime story about a boy and
 *  his puppy, told warmly." names a character, not the voice). */
function speakerClause(readback) {
  const first = String(readback || '').split(/(?<=[.!?])\s/)[0].split(/\s+/).slice(0, 20).join(' ');
  const verb = first.match(SPEAKING_VERB);
  return verb ? first.slice(0, verb.index).trim() : '';
}

/**
 * Does `other` (a writer's own voice= line, or a readback's speaker clause)
 * describe a plainly different person from `chosen`? Returns who `other` is,
 * in plain words for the person ("a woman", "a grown-up", "a male voice"), or
 * null when nothing plainly differs.
 */
function voicesDisagree(chosen, other) {
  const want = voiceTraits(chosen);
  const got = voiceTraits(other);
  const age = !!(want.age && got.age && want.age !== got.age);
  const sex = !!(want.sex && got.sex && want.sex !== got.sex);
  if (!age && !sex) return null;
  if (got.age && got.sex) {
    return got.age === 'adult' ? (got.sex === 'male' ? 'a man' : 'a woman') : (got.sex === 'male' ? 'a boy' : 'a girl');
  }
  if (got.age) return got.age === 'adult' ? 'a grown-up' : 'a child';
  return got.sex === 'male' ? 'a male voice' : 'a female voice';
}

/**
 * Parse a screenplay into { headers, blocks, notes }.
 * blocks: [{ type: 'action'|'sound'|'speech', text }]
 */
function parseScreenplay(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const headers = {};
  const blocks = [];
  const notes = [];
  let i = 0;
  // Headers: leading KEY: value lines (blank lines allowed between them)
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const m = line.match(/^\s*([A-Za-z]{3,10})\s*:\s*(.+?)\s*$/);
    if (!m || !HEADER_KEYS[m[1].toLowerCase()]) break;
    headers[HEADER_KEYS[m[1].toLowerCase()]] = m[2].trim();
    i++;
  }
  let speechBuf = [];
  const flushSpeech = () => {
    const t = speechBuf.join(' ').replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ type: 'speech', text: t });
    speechBuf = [];
  };
  for (; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) { flushSpeech(); continue; }
    // Pull cues out of the line in order, leaving speech between them.
    const re = /\(\(([^()]*?)\)\)|\[([^\[\]]*?)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(last, m.index);
      if (before.trim()) speechBuf.push(before.trim());
      flushSpeech();
      if (m[1] !== undefined) {
        const t = m[1].trim();
        if (t) blocks.push({ type: 'sound', text: t });
      } else {
        const t = m[2].trim();
        if (t) blocks.push({ type: 'action', text: t });
      }
      last = m.index + m[0].length;
    }
    const rest = line.slice(last);
    if (rest.trim()) speechBuf.push(rest.trim());
    // an unclosed bracket is spoken, and we say so
    if (/\[[^\]]*$/.test(rest) || /\(\([^)]*$/.test(rest)) {
      notes.push('A direction was missing its closing bracket, so those words will be spoken. Close it with ] (or )) for a sound).');
    }
  }
  flushSpeech();
  return { headers, blocks, notes };
}

/**
 * Screenplay → <speak> XML. `defaults` fill any header the screenplay left out:
 * { voice, gender, scene, shot, language }.
 */
function screenplayToSpeak(text, defaults = {}) {
  const { headers, blocks, notes } = parseScreenplay(text);
  const voice = (headers.voice || defaults.voice || 'A warm, clear adult voice.').trim();
  const gender = normalGender(headers.gender || defaults.gender);
  const scene = (headers.scene || defaults.scene || '').trim();
  let shot = String(headers.shot || defaults.shot || '').toLowerCase().trim();
  if (/^close/.test(shot)) shot = 'closeup';
  if (!['closeup', 'wide', 'scene'].includes(shot)) shot = '';
  const language = (headers.language || defaults.language || '').trim();

  const attrs = [`voice="${escapeXml(voice)}"`, `gender="${gender}"`];
  if (scene) attrs.push(`scene="${escapeXml(scene)}"`);
  if (shot) attrs.push(`shot="${shot}"`);
  if (language && language.toLowerCase() !== 'en') attrs.push(`language="${escapeXml(language)}"`);

  const body = blocks
    .map((b) => {
      if (b.type === 'action') return `<action>${escapeXml(b.text)}</action>`;
      if (b.type === 'sound') return `<sound>${escapeXml(b.text)}</sound>`;
      return escapeXml(b.text);
    })
    .join('\n');
  const hasSound = blocks.some((b) => b.type === 'sound');
  if (hasSound && shot === '') notes.push('There is a sound cue but the shot is close-up, so the engine will strip it. Set SHOT: wide or SHOT: scene to hear it.');
  const speech = blocks.filter((b) => b.type === 'speech').map((b) => b.text).join(' ');
  return { xml: `<speak ${attrs.join(' ')}>\n${body}\n</speak>`, headers: { voice, gender, scene, shot, language }, notes, words: speech.split(/\s+/).filter(Boolean).length, hasSound };
}

/**
 * <speak> XML → screenplay. Tolerant: a stray tag or an unclosed one is left
 * as text rather than lost. Headers are written only when the attribute is
 * present, so a booth-supplied voice does not get baked into the page text
 * twice.
 */
function speakToScreenplay(xml, { includeHeaders = true } = {}) {
  const s = String(xml || '');
  const open = s.match(/<speak\b([^>]*)>/i);
  if (!open) return s.trim();
  const attrs = speakAttrs(s);
  let inner = s.slice(open.index + open[0].length);
  inner = inner.replace(/<\/speak>\s*$/i, '');
  const out = [];
  if (includeHeaders) {
    if (attrs.voice) out.push(`VOICE: ${attrs.voice}`);
    if (attrs.gender) out.push(`SEX: ${attrs.gender}`);
    if (attrs.scene) out.push(`SCENE: ${attrs.scene}`);
    if (attrs.shot) out.push(`SHOT: ${attrs.shot}`);
    if (attrs.language && attrs.language !== 'en') out.push(`LANGUAGE: ${attrs.language}`);
    if (out.length) out.push('');
  }
  const re = /<action>([\s\S]*?)<\/action>|<sound>([\s\S]*?)<\/sound>/gi;
  let last = 0;
  let m;
  const pushSpeech = (t) => {
    const clean = unescapeXml(t).replace(/\s+/g, ' ').trim();
    if (clean) out.push(clean, '');
  };
  while ((m = re.exec(inner)) !== null) {
    pushSpeech(inner.slice(last, m.index));
    if (m[1] !== undefined) out.push(`[${unescapeXml(m[1]).replace(/\s+/g, ' ').trim()}]`);
    else out.push(`((${unescapeXml(m[2]).replace(/\s+/g, ' ').trim()}))`);
    last = m.index + m[0].length;
  }
  pushSpeech(inner.slice(last));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The format, said once, for the page and the help. */
const SCREENPLAY_HELP =
  'Write it like a script. Square brackets are a direction for the actor, what they are doing and feeling, and are never spoken: [Voice tightens. Swallows.] ' +
  'Double parentheses are a sound in the room: ((Thunder cracks overhead)). Everything else is spoken. ' +
  'The voice belongs in Describe a new voice. A header line like VOICE:, SEX:, SCENE: or SHOT: at the top still works, and anything left out comes from the settings.';

module.exports = {
  parseScreenplay, screenplayToSpeak, speakToScreenplay, isSpeakXml, escapeXml, unescapeXml, SCREENPLAY_HELP,
  normalGender, speakAttrs, withSpeakVoice, liftBodyHeaders, voiceTraits, speakerClause, voicesDisagree,
};
