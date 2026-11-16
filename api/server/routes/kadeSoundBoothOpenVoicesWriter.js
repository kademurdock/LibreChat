/* ----------------------------------------------------------------------------
 * OPEN VOICES SCRIPT WRITER (Nov 16 2026)
 *
 * Her words: "with something like auk, you can have the desk write you a script. That needs to be a
 * thing with all the voice things ... we would naturally wanna write things for them to say in
 * whatever format that model accepted. Just like we do with seed audio, we would want scripts for
 * drama box."
 *
 * One writer for every Open voices engine. It takes an idea ("write it") or her own words ("format
 * it", her words kept and only shaped for the engine) and answers in the shape that engine reads:
 *   VoxCPM2, Ming, Chatterbox Original/Multilingual: plain words to be spoken, nothing else.
 *   Chatterbox Turbo: plain words, with its sound tags ([laugh], [sigh] ...) where a sound happens.
 *   DramaBox: a prose scene. Spoken words in double quotes; the rest is how they are acted and the
 *     sounds around them (DramaBox makes background sound from those directions), never spoken.
 * In Design a voice for VoxCPM2 and Ming (no built-in voice), the writer may also suggest the voice
 * description, used only when her description box is empty.
 *
 * The call is the booth's own script desk call (kadeSoundBooth.js passes `write`), so it shares the
 * desk's daily cap, writer model, zero-retention lane and usage ledger.
 * -------------------------------------------------------------------------- */

const MAX_IDEA = 3000;

const CB_TAGS = ['[laugh]', '[chuckle]', '[sigh]', '[gasp]', '[cough]', '[clear throat]', '[sniff]', '[groan]', '[shush]'];

const PLAIN_RULES = [
  'Write only the words to be spoken aloud, as one speaker. The engine reads every character you write.',
  'No stage directions, no brackets, no asterisks, no speaker names, no headings, no emoji, no markdown.',
  'Spell numbers, dates, money, symbols and abbreviations the way they are said ("twenty twenty-six", "three dollars", "doctor").',
  'Let punctuation carry the pauses and the feeling: commas, full stops, question marks, an ellipsis or a dash where the speaker would breathe.',
  'Write the way people talk, not the way essays read: short sentences, contractions, a little rhythm.',
  'No markers or codes of any kind (no %%%, no <tags>, no (directions)): every character is spoken.',
  'Unless they ask for a length, keep it to about 20 to 60 seconds of speech (roughly 50 to 150 words). A voice you plan to keep needs only a sentence or two.',
];

/* What each engine reads -> { name, rules[], voiceLine, maxText } */
function engineShape(b) {
  const engine = b.engine;
  const design = b.mode !== 'speak';
  if (engine === 'dramabox') {
    const secs = Number(b.duration);
    const len = Number.isFinite(secs) && secs >= 3 && secs <= 45
      ? `The take is ${Math.round(secs)} seconds long, so the spoken words must fit: about ${Math.max(4, Math.round(secs * 2.4))} spoken words at most, fewer if the scene has pauses or sounds.`
      : 'Keep it to a short scene, about 10 to 30 seconds of speech (roughly 25 to 70 spoken words). DramaBox makes up to about 45 seconds at a time.';
    return {
      name: 'DramaBox',
      maxText: 4000,
      voiceLine: false,
      rules: [
        'DramaBox reads a short prose scene, like a page of a novel. Words inside double quotes are SPOKEN. Everything outside the quotes is never spoken: it tells the engine who is speaking, how they say it, and what can be heard around them.',
        'Use straight double quotes (") around every spoken line, and never put quote marks around anything that is not spoken.',
        design
          ? 'Open with one sentence that sets the speaker: age, sex, voice and manner (for example: An old sailor, tired but kind, his voice low and rough, leans on the rail.). The engine picks the voice from that sentence.'
          : 'A recording sets the voice, so describe how they speak and act, not what their voice sounds like.',
        'Between spoken lines, write short directions for delivery (He laughs softly. She drops to a whisper. A long pause.) and for the sounds of the place when it helps (Rain drums on the tin roof. The crowd roars.). The engine makes those sounds in the background, so name them plainly and concretely.',
        'One speaker unless they ask for more. Present tense. No headings, no speaker labels, no markdown, no lists.',
        'Spell numbers and symbols inside the quotes the way they are said.',
        'English only.',
        len,
      ],
    };
  }
  if (engine === 'chatterbox') {
    const version = ['turbo', 'original', 'multilingual'].includes(b.version) ? b.version : 'turbo';
    const lang = typeof b.languageName === 'string' && b.languageName ? b.languageName : 'English';
    const rules = [...PLAIN_RULES];
    if (version === 'turbo') {
      rules[1] = 'No stage directions, no asterisks, no speaker names, no headings, no emoji, no markdown. The only brackets allowed are the sound tags below.';
      rules.push(`Chatterbox Turbo makes a sound where one of these tags sits in the words: ${CB_TAGS.join(' ')}. Use them exactly as written, only where that sound would really happen, and sparingly: at most one tag for every two or three sentences. Never invent other tags.`);
      rules.push('English only.');
    } else {
      rules.push('This version reads no tags at all: never write square brackets.');
      rules.push(version === 'multilingual' ? `Write the words in ${lang}.` : 'English only.');
    }
    return { name: `Chatterbox ${version === 'turbo' ? 'Turbo' : version === 'original' ? 'Original' : 'Multilingual'}`, maxText: 5000, voiceLine: false, rules };
  }
  if (engine === 'ming') {
    const rules = [...PLAIN_RULES, 'Ming reads English and Chinese best. Write in the language they ask for, or English.'];
    return { name: 'Ming', maxText: 2500, voiceLine: design && !b.builtin, voiceMax: 600, rules };
  }
  return { name: 'VoxCPM2', maxText: 5000, voiceLine: design, voiceMax: 400, rules: [...PLAIN_RULES, 'Write in the language they ask for, or English.'] };
}

/* The system and user messages for one write. Returns { system, user, shape } or { error }. */
function writerRequest(b = {}) {
  const how = b.how === 'format' ? 'format' : 'write';
  const shape = engineShape(b);
  const idea = String(b.idea || '').trim().slice(0, MAX_IDEA);
  const words = String(b.words || '').trim().slice(0, shape.maxText);
  if (how === 'write' && idea.length < 3) return { error: 'Say what it should be about first. One sentence is enough.', field: 'idea' };
  if (how === 'format' && words.length < 2) return { error: `Type the words in ${b.engine === 'dramabox' ? 'Scene' : 'Words to say'} first, then press Format my words.`, field: 'text' };
  const description = String(b.description || '').trim().slice(0, 600);
  const askVoice = shape.voiceLine && !description;
  const system = [
    `You write what the ${shape.name} voice engine will perform. Its rules:`,
    ...shape.rules.map((r) => `- ${r}`),
    how === 'format'
      ? '- You are given their own words. Keep every one of their words and their order. Only shape them for this engine (quotes and directions for a scene, tags where a sound happens, numbers spelled out). Add no new spoken lines.'
      : '- Write something worth hearing: specific, human and in a real voice, never generic filler or a summary of the idea.',
    `- The whole answer is at most ${shape.maxText} characters.`,
    '',
    'Answer in exactly this shape and nothing else:',
    ...(askVoice ? [`VOICE: one sentence describing the voice that suits it (age, sex, accent, tone, pace), under ${shape.voiceMax} characters`] : []),
    'WORDS:',
    `(the ${b.engine === 'dramabox' ? 'scene' : 'words'}, ready to paste)`,
  ].join('\n');
  const lines = [];
  if (how === 'format') lines.push(`THEIR WORDS:\n${words}`);
  else lines.push(`WHAT THEY WANT:\n${idea}`);
  if (how === 'write' && words) lines.push(`WHAT IS IN THE BOX NOW (replace it; use it only if the idea says to):\n${words}`);
  if (description) lines.push(`THE VOICE: ${description}\nWrite for this speaker.`);
  else if (b.builtinName) lines.push(`THE VOICE: Ming's built-in voice ${String(b.builtinName).slice(0, 60)}.`);
  if (b.mode === 'speak') lines.push('A recording of the speaker supplies the voice.');
  return { system, user: lines.join('\n\n'), shape, how, askVoice };
}

const REFUSAL = /^(?:i(?:'|’)?m sorry|sorry,? (?:but )?i (?:can(?:'|’)?t|cannot)|i (?:can(?:'|’)?t|cannot|won(?:'|’)?t) (?:help|write|assist|create|do))/i;

/* The writer's answer -> { text, voice } or { error }. */
function parseWriterReply(raw, req) {
  let t = String(raw || '').replace(/\r\n/g, '\n').trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  if (!t) return { error: 'The writer came back empty. Your idea is kept. Try again.' };
  let voice = '';
  const vm = t.match(/^\s*VOICE\s*:\s*(.+)$/im);
  if (vm) voice = vm[1].trim().replace(/^["“]|["”]$/g, '');
  const at = t.search(/^\s*WORDS\s*:/im);
  let text = at === -1 ? t.replace(/^\s*VOICE\s*:.*$/im, '') : t.slice(at).replace(/^\s*WORDS\s*:[ \t]*/i, '');
  text = text.replace(/^\s*READBACK\s*:.*$/gim, '').trim();
  /* Seen live Nov 16 on Ming: the writer opened with "%%%cheerful friendly%%%", which the engine would read out. */
  text = text.replace(/%{2,}[^%
]{0,80}%{2,}/g, '').replace(/^[ 	]+/gm, '').trim();
  if (!text || (at === -1 && REFUSAL.test(text))) return { error: 'The writer would not write that one. Your idea is kept. Try saying it another way.' };
  const engine = req.engine;
  if (engine !== 'dramabox') text = text.replace(/^\s*[-*]\s+/gm, '');
  if (engine === 'dramabox') {
    text = text.replace(/[“”„‟]/g, '"');
    if (!/"[^"]+"/.test(text)) return { error: 'The writer left no spoken words in quotes. Try again.' };
  }
  if (engine === 'chatterbox' && req.version && req.version !== 'turbo') text = text.replace(/\s*\[[^\]]{1,40}\]\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (engine === 'chatterbox' && (!req.version || req.version === 'turbo')) {
    text = text.replace(/\[([^\[\]]{1,40})\]/g, (m, inner) => (CB_TAGS.includes(`[${inner.trim().toLowerCase()}]`) ? `[${inner.trim().toLowerCase()}]` : ''))
      .replace(/ {2,}/g, ' ').trim();
  }
  if (engine === 'voxcpm' || (engine === 'ming' && req.how === 'write')) text = text.replace(/\*([^*\n]+)\*/g, '$1').replace(/\[[^\]\n]{1,40}\]/g, '').replace(/ {2,}/g, ' ').trim();
  const max = req.shape.maxText;
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, '');
  return { text, voice: req.askVoice ? voice.slice(0, req.shape.voiceMax || 400) : '' };
}

module.exports = { writerRequest, parseWriterReply, engineShape, CB_TAGS, MAX_IDEA };
