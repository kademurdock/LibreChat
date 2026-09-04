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
  let gender = String(headers.gender || defaults.gender || 'female').toLowerCase().trim();
  if (/^(m|man|male|boy|he|him)$/.test(gender)) gender = 'male';
  else if (/^(f|w|woman|female|girl|she|her)$/.test(gender)) gender = 'female';
  else gender = 'female';
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
  const attrs = {};
  const attrRe = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = attrRe.exec(open[1])) !== null) attrs[a[1].toLowerCase()] = unescapeXml(a[2]);
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
  'You can start with header lines like VOICE:, SEX:, SCENE:, SHOT:, or leave them out and the settings fill them in.';

module.exports = { parseScreenplay, screenplayToSpeak, speakToScreenplay, isSpeakXml, escapeXml, unescapeXml, SCREENPLAY_HELP };
