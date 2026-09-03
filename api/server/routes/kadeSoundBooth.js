/* ----------------------------------------------------------------------------
 * THE SOUND BOOTH (Part 120, Sep 3 2026)
 *
 * Her ask, Part 119.10: "I'm hoping the next session can be building a native
 * playground on my platform where I can use Scenema." Then, in her own words,
 * the interface: "all the settings and import and all that, but you write the
 * stuff in the textbox right? And there's some button that will either
 * generate your text idea into a full scenema script based on its formatting,
 * or it can write a new one based on a description. Like, if I said, generate
 * a blah blah blah, it could write something for me, but if I wanna write
 * myself, I can, and can have enhanced formatting. Maybe even an easy and
 * advanced mode."
 *
 * She named it the Sound Booth (Part 120) and asked for Seed Audio in here too,
 * so this lane carries BOTH engines behind one screen:
 *
 *   engine 'scenema' -> her own rented GPU through the bridge's job lane.
 *                       ONE actor performing a script with stage directions.
 *                       Queued: ~1.4x the audio length, ~2 cents a minute,
 *                       nothing leaves her boxes.
 *   engine 'seed'    -> Seed Audio 1.0 on fal, synchronous. A whole SCENE:
 *                       several voices, music, effects, ambience, in one pass.
 *                       Seconds, ~19 cents a minute, audio leaves the estate.
 *
 * THE DOORS (law 17 -- production knocks on the same door the bench does):
 *   - the model call rides the reframe proxy, like every other machine lane
 *   - the Scenema render rides the bridge's /audio/scenema/start, the same lane
 *     Cadence's generate_narration uses -- this route does NOT talk to RunPod
 *   - the Seed render posts to fal exactly as FalAI._genOneAudio does, at the
 *     CORRECTED price ($0.1875/min, Part 119.2), and logs usage + gallery the
 *     same way, so a Sound Booth clip is indistinguishable from a chat one
 *   - the phone never holds BRIDGE_SECRET or FAL_KEY. It holds a user JWT.
 *
 * ROUTES (all requireJwtAuth, mounted at /api/kade/sound-booth):
 *   POST /script          {engine, mode:'format'|'write', text, ...}  -> {script, readback}
 *   POST /render          {engine, script, title, ...}                -> {jobId|asset, estimate}
 *   GET  /projects                                                    -> newest 50
 *   GET  /projects/:id                                                -> one, job state refreshed
 *   PATCH/DELETE /projects/:id                                        -> rename / remove
 *   GET  /status/:jobId   (scenema)                                   -> bridge state, proxied
 *   POST /cancel/:jobId   (scenema)
 *   GET  /health                                                      -> what is configured, and the caps
 * -------------------------------------------------------------------------- */
const axios = require('axios');
const multer = require('multer');
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { needsRefresh, getNewS3URL, saveBufferToS3 } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage } = require('~/models/kadeUsage');
const { logKadeAsset, KadeAsset } = require('~/models/kadeAsset');
const { KadeSoundBoothProject } = require('~/models/kadeSoundBoothProject');

const router = express.Router();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MODEL = process.env.KADE_SOUNDBOOTH_MODEL || 'z-ai/glm-5.3-flash';
const SCRIPT_DAILY_CAP = Number(process.env.KADE_SOUNDBOOTH_SCRIPT_CAP || 40);
const MAX_SCENEMA_CHARS = 4000; // the bridge's own cap; mirrored so we fail early and kindly
const MAX_SEED_CHARS = 2048; // Seed Audio's hard cap per clip
const SEED_USD_PER_MIN = 0.1875; // fal's listed price, read Sep 2 2026 (Part 119.2)
const SCENEMA_USD_PER_MIN = 0.02; // measured Part 119.9/119.10; the bridge returns the real estimate

function bridgeBase() {
  return (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(
    /\/$/,
    '',
  );
}

/* ---------- a small daily cap on the WRITING desk, not the rendering ---------
 * Rendering is capped in dollars by the bridge (Scenema) and the wallet (fal).
 * The script button is cheap but not free, and a stuck client could hammer it,
 * so it gets the same shape of cap the character builder uses. */
let scriptDayStamp = '';
const scriptCounts = new Map();
function scriptCapHit(userId) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  if (scriptDayStamp !== today) {
    scriptDayStamp = today;
    scriptCounts.clear();
  }
  const used = scriptCounts.get(userId) || 0;
  if (used >= SCRIPT_DAILY_CAP) return true;
  scriptCounts.set(userId, used + 1);
  return false;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Spoken words -> rough seconds of audio, at 2.6 words a second.
 *
 * ⚠️ The first live render caught this being wrong: stripping only the TAGS
 * left the words INSIDE a direction in the count, so a two-line script with a
 * long <action> was quoted at 12 seconds and came back 5.3. A direction is
 * never spoken, so the whole block goes before anything is counted -- same for
 * a <sound> line and for Seed Audio's [bracketed] cues. The bridge still
 * counts the old way, which is why the fork's audioSeconds is the one that
 * reaches her. */
function spokenSeconds(script) {
  const words = String(script || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, ' ')
    .replace(/<sound>[\s\S]*?<\/sound>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return { words, seconds: Math.max(1, Math.round(words / 2.6)) };
}

/* ---------- the moods, in her words ----------------------------------------
 * A mood is not a knob on the audio -- it is a note to the ACTOR. Scenema's
 * own rule (and the tool description's) is that a direction says what the
 * speaker is DOING and FEELING, never how the recording should sound, so each
 * mood below is written as a person, not as an EQ setting. */
const MOODS = {
  tender: {
    label: 'Tender',
    scenema: 'softening, speaking to someone they love',
    seed: 'warm, unhurried, affectionate',
  },
  wry: {
    label: 'Wry',
    scenema: 'holding back a smile, enjoying the joke they are not telling',
    seed: 'dry, amused, understated',
  },
  urgent: {
    label: 'Urgent',
    scenema: 'leaning in, needing to be understood right now',
    seed: 'fast, pressing, tightly controlled',
  },
  bedtime: {
    label: 'Sleepy bedtime',
    scenema: 'winding down, letting the pace fall away, nearly whispering',
    seed: 'hushed, slow, drowsy',
  },
  matter_of_fact: {
    label: 'Matter of fact',
    scenema: 'plain and level, telling it straight',
    seed: 'even, plain, unhurried',
  },
};

/* ---------- the two grammars, rebuilt from the engines' own documentation ----
 * Part 121 (Sep 3 2026), her ask: "look up everything you can about prompting
 * both, make sure the settings align." Scenema: github.com/ScenemaAI/
 * scenema-audio README. Seed Audio: fal's llms.txt + the Morphic guide (the
 * SCENE checklist, the `Name (traits) says manner: "line."` shape, spelled-out
 * sounds, @Audio tagging, [start:end] timestamps). Every rule below is one
 * the docs state, not one guessed. */
const SCENEMA_GRAMMAR = `SCENEMA AUDIO SCRIPT FORMAT (the only format you may output):

<speak voice="WHO IS SPEAKING, in one specific theatrical sentence" gender="male|female" scene="optional place" shot="closeup|wide|scene" language="en">
<action>what the speaker is DOING and FEELING right now</action>
The spoken words, as natural prose.
<action>the next shift — a physical cue plus an emotional one</action>
More spoken words.
<sound>an environmental event, only if shot is wide or scene</sound>
</speak>

HOW THIS ENGINE WORKS, so you write for it:
- ONE speaker. It performs a single voice with real acting — emotion that shifts mid-take, breath, pauses, a voice that cracks on a word. It cannot do two characters or music.
- The voice= description is the PRIMARY control. Weak: "a man speaking". Strong: "Male, mid 60s. Deep baritone with gravel. Slight Southern American inflection. Worn but warm. Nostalgic, firelight cadence. The voice of someone who has seen too much and chosen kindness anyway." Give sex, age, register, accent, texture, manner, and one line of character.
- <action> tags are the primary tool for emotional performance. Put them BETWEEN speech segments. Describe what the speaker is DOING and FEELING — "Voice tightens. Swallows. Fighting to stay composed." / "Long pause. Deep breath. When he speaks again, his voice is raw but steady." Combine a physical cue with an emotional one. NEVER describe the audio ("add reverb", "louder", "echo") — that is not what the tag is for and it degrades the take.
- Nothing outside a tag is a note; it is SPOKEN ALOUD. No headings, labels, speaker names, or markdown outside a tag.
- <sound> only lands when shot="wide" or shot="scene". With shot="closeup" (the default) the environment is stripped.
- Each segment is at most about 15 seconds; sentences are split there automatically. Keep sentences a natural length.
- Difficult proper nouns get garbled; spell a hard word phonetically inside the spoken text if it matters.
- NEVER use %%%…%%% markers — that is a different engine's syntax and this one would read it out loud. Never leave a cue in parentheses or square brackets on its own line; convert it to an <action>.
- Output the XML and nothing else. No code fence, no preamble.`;

const SEED_GRAMMAR = `SEED AUDIO 1.0 SCRIPT FORMAT (the only format you may output):

[Setting: the place, weather, acoustics, and a continuous sound bed — spelled out, e.g. rain "pat-pat" on a tin roof, distant traffic, room reverb]
[Music, if any: a MOOD, not a genre label — "soft piano that swells", "low brass and war drums"]
Name (sex, age, accent, voice texture, personality) says, manner and emotion: "the exact line."
[A sound effect at this moment — spell it out: a screen door "slap", a zipper "zzzip"]
Other Name (traits) answers softly, flustered: "the reply."
[How it ends: footsteps fading, music fading out]

HOW THIS ENGINE WORKS, so you write for it:
- It makes a WHOLE SCENE in one pass: several voices, music, sound effects, and ambience, mixed. Write it like a short scene brief, not a text-to-speech line.
- The SCENE checklist — include all five: Setting (weather, location, acoustics), Cast (what each person is doing), Effects (music mood + sound effects), Notes on voice (sex, age, accent, emotion, tone, speed), Exact lines in quotes.
- Every spoken line uses the shape:  Name (traits) says, manner: "words."  The manner goes before the colon — "lowers her voice, flustered:", "coaxes, dragging his words:", "can't help laughing:". Emotion words in parentheses after the name also work: Emma (whispering): "...".
- Write LONG. Description is not padding: the environment, the score, and each delivery are all things this engine renders. Every sentence you leave out is a decision handed back to the model.
- SPELL THE SOUNDS OUT. Onomatopoeia is more reliable than naming: a bell "ring-a-ling" fading from near to far; a blade's "whoom, whoom".
- Music by MOOD, never by music-theory terms.
- Match the language: write the whole prompt in the language the lines are spoken in.
- Up to three named voices. If reference clips are given they are @Audio1, @Audio2, @Audio3 — tag a clip to a speaker inline: Marcus (warm broadcaster, the actor is @Audio1) says: "...".
- Optional exact timing: put [start:end] at the front of a line, e.g. "[5.5s:8.0s] Maya! Wait." and that line is fitted to that window.
- Hard cap: under 1900 characters and about two minutes of audio. Longer pieces are made scene by scene with the same voices.
- NEVER use %%%…%%% markers. That is a different engine's syntax. A delivery note goes in parentheses after the name, or as the manner before the colon — nowhere else.
- Output the script and nothing else. No code fence, no preamble.`;

function systemPrompt({ engine, mode }) {
  const grammar = engine === 'seed' ? SEED_GRAMMAR : SCENEMA_GRAMMAR;
  const job =
    mode === 'write'
      ? `The user has given you a DESCRIPTION of something they want made. Write it for them: invent the words, keep it the length they asked for (if they did not say, aim for 30 to 60 seconds of speech, which is roughly 80 to 160 words), and shape it into the format below.`
      : `The user has written THEIR OWN WORDS and wants them formatted. THEIR WORDS ARE THE SCRIPT. Keep every sentence they wrote, in their order, in their wording -- do not rewrite, tighten, improve, correct, or add sentences of your own. Your entire job is to wrap their words in the format below and add the structural tags BETWEEN their sentences. If they left cues in parentheses or brackets ("(whispering)", "[thunder]"), convert those into proper tags and remove the prose cue.`;

  return `You are the script desk in Kade-AI's Sound Booth. You turn what a person typed into a script an audio engine can perform.

${job}

${grammar}

AFTER the script, on a new line, output exactly:
READBACK: one or two plain sentences saying what a listener will hear -- who is speaking, roughly how long, and where the mood turns. Write it for someone who is blind and will hear this read aloud before they spend money on a render. No markdown, no lists, no jargon, no restating the format.`;
}

function splitScriptAndReadback(raw) {
  const text = String(raw || '').trim();
  const idx = text.lastIndexOf('READBACK:');
  if (idx === -1) return { script: stripFence(text), readback: '' };
  return {
    script: stripFence(text.slice(0, idx).trim()),
    readback: text
      .slice(idx + 'READBACK:'.length)
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 600),
  };
}

/** Models fence things even when told not to. Take the fence off rather than
 * hand a `\`\`\`xml` line to an engine that will read it out loud. */
function stripFence(s) {
  let t = String(s || '').trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  return t;
}

async function callModel({ system, user, maxTokens = 2200 }) {
  const gatewayUrl =
    process.env.KADE_LLM_GATEWAY_URL ||
    'https://reframe-proxy-production.up.railway.app/chat/completions';
  const key = process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY;
  if (!key) {
    const e = new Error('The script desk is not configured on this server.');
    e.status = 503;
    throw e;
  }
  const r = await axios.post(
    gatewayUrl,
    {
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      timeout: 90000,
    },
  );
  const out = r.data?.choices?.[0]?.message?.content;
  const usage = r.data?.usage || {};
  return { text: String(out || ''), usage };
}

/* ---------- Scenema XML: build one, and check one ------------------------- */
function wrapSpeak({ body, voice_description, gender, scene, shot, pace, language }) {
  const raw = String(body || '').trim();
  if (/<speak[\s>]/i.test(raw)) return raw;
  const voice = String(
    voice_description || 'Warm, clear adult woman with a natural American accent. Unhurried and kind.',
  )
    .trim()
    .slice(0, 600);
  const attrs = [`voice="${escapeXml(voice)}"`, `gender="${gender === 'male' ? 'male' : 'female'}"`];
  if (scene) attrs.push(`scene="${escapeXml(String(scene).slice(0, 200))}"`);
  if (['closeup', 'wide', 'scene'].includes(shot)) attrs.push(`shot="${shot}"`);
  if (typeof pace === 'number' && pace >= 0.5 && pace <= 3) attrs.push(`pace="${pace}"`);
  if (language) attrs.push(`language="${escapeXml(String(language).slice(0, 40))}"`);
  return `<speak ${attrs.join(' ')}>\n${raw}\n</speak>`;
}

/* ---------- the %%% scar ----------------------------------------------------
 * FOUND IN THE FIRST LIVE SMOKE (Part 120). Asked to format her words, the
 * model wrote `%%%gentle and low like she is talking to someone half asleep%%%`
 * between the lines -- Inworld's paragraph-tag syntax, which is all over this
 * estate's prompts and personas and which the model has plainly learned.
 *
 * Scenema has never heard of it. Anything not inside a tag is SPOKEN, so that
 * line would have been read ALOUD in the finished audio, in the middle of her
 * sentence, and the only way to find that out is to listen to a render she
 * paid for. The structural check could not see it either: `%%%` is not an XML
 * tag, so every bracket balanced and the script "passed".
 *
 * So it is converted, not refused: `%%%…%%%` says exactly what an <action>
 * says, and the model's instinct was right about the CONTENT. Same for a
 * bare parenthetical or bracketed cue sitting alone on its own line, which is
 * how a person writes a stage direction when they are not thinking about tags
 * -- her own probe text had "(softly)" in it.
 *
 * Only ever applied to Scenema. Seed Audio's format IS bracketed cues on
 * their own lines, and rewriting those would break the engine that wants them.
 */
function sanitizeScenema(script) {
  let s = String(script || '');
  const notes = [];
  // %%%anything%%% -> <action>anything</action>
  s = s.replace(/%%%\s*([^%]+?)\s*%%%/g, (_m, inner) => {
    notes.push('turned a %%% tag into a stage direction');
    return `<action>${inner.trim()}</action>`;
  });
  // A line that is ONLY (a parenthetical) or [a bracket] -> a direction.
  s = s
    .split('\n')
    .map((line) => {
      const t = line.trim();
      const paren = t.match(/^\((.+)\)$/);
      const brack = t.match(/^\[(.+)\]$/);
      if (paren) {
        notes.push('turned a written cue into a stage direction');
        return `<action>${paren[1].trim()}</action>`;
      }
      if (brack) {
        notes.push('turned a written cue into a stage direction');
        return `<action>${brack[1].trim()}</action>`;
      }
      return line;
    })
    .join('\n');
  // Any stray %%% left over (an unpaired one) is deleted rather than spoken.
  if (s.includes('%%%')) {
    s = s.replace(/%%%/g, '');
    notes.push('removed a stray tag marker');
  }
  return { script: s, notes: [...new Set(notes)] };
}

/* Seed Audio's own delivery notes are parentheticals after the speaker and
 * the manner before the colon — so a stray %%%note%%% becomes (note) in place,
 * which Seed reads, instead of being spoken or dropped. Found in the first
 * Seed smoke (Part 121): the model wrote %%%easygoing morning pace%%% between
 * "says, warmly:" and the quoted line. */
function sanitizeSeed(script) {
  let s = String(script || '');
  const notes = [];
  s = s.replace(/%%%\s*([^%]+?)\s*%%%/g, (_m, inner) => {
    notes.push('turned a %%% tag into a delivery note');
    return `(${inner.trim()})`;
  });
  if (s.includes('%%%')) {
    s = s.replace(/%%%/g, '');
    notes.push('removed a stray tag marker');
  }
  return { script: s, notes: [...new Set(notes)] };
}

/** Cheap structural checks so a bad script is refused HERE, in a sentence she
 * can act on, instead of failing on the GPU two minutes and a wake-up later. */
function checkScenema(script) {
  const s = String(script || '').trim();
  if (!/^<speak[\s>]/i.test(s)) return 'A Scenema script has to start with a <speak> tag.';
  if (!/<\/speak>\s*$/i.test(s)) return 'A Scenema script has to end with </speak>.';
  if (!/voice="/i.test(s)) return 'The <speak> tag needs a voice="..." description.';
  if (s.includes('%%%')) {
    return 'That script still has %%% tag markers in it. Scenema would read them out loud — use <action> directions instead.';
  }
  const opens = (s.match(/<action>/gi) || []).length;
  const closes = (s.match(/<\/action>/gi) || []).length;
  if (opens !== closes) return 'One of the <action> directions is missing its closing tag.';
  const sOpens = (s.match(/<sound>/gi) || []).length;
  const sCloses = (s.match(/<\/sound>/gi) || []).length;
  if (sOpens !== sCloses) return 'One of the <sound> lines is missing its closing tag.';
  const spoken = s
    .replace(/<speak[^>]*>/i, '')
    .replace(/<\/speak>/i, '')
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<sound>[\s\S]*?<\/sound>/gi, '')
    .trim();
  if (!spoken) return 'There are no spoken words in that script — only directions.';
  if (s.length > MAX_SCENEMA_CHARS) {
    return `That script is ${s.length} characters; one render tops out at ${MAX_SCENEMA_CHARS} (about 600 spoken words). Split it into parts.`;
  }
  return null;
}

function checkSeed(script) {
  const s = String(script || '').trim();
  if (!s) return 'There is nothing to render.';
  if (s.includes('%%%')) {
    return 'That script still has %%% tag markers in it. Seed Audio does not know them — put delivery notes in parentheses after the name instead.';
  }
  if (s.length > MAX_SEED_CHARS) {
    return `That script is ${s.length} characters; Seed Audio tops out at ${MAX_SEED_CHARS} (about two minutes). Shorten it, or render it in parts.`;
  }
  return null;
}

/* ---------- THE GUIDE — one explainer, served to both screens -----------------
 * Her ask (Part 121): "I don't think people will know the difference between
 * seedaudio and scenema, much less how to use the settings and prompt it."
 * So the explanation lives HERE, once, and the phone and the web both render
 * it — a wording fix is one deploy, not two builds. Every line is written to
 * be read aloud. Sources: the Scenema README and Seed Audio's own guide. */
const GUIDE = {
  /* What the box is holding, and therefore which button exists. The screens
   * render this ABOVE the text box so there is only ever one button. */
  input: {
    question: 'What are you putting in the box?',
    modes: [
      {
        key: 'words',
        label: 'I am writing the words',
        boxLabel: 'The words to perform',
        boxHint: 'Type what you want said, exactly as you want to hear it. Every word here gets spoken.',
        button: 'Turn my words into a script',
        buttonHint: 'Keeps every word you wrote, in your order, and only adds the directions around them.',
      },
      {
        key: 'brief',
        label: 'I am describing what I want',
        boxLabel: 'Describe what you want made',
        boxHint: 'Say what the piece is — "a two minute bedtime story about a fox who is scared of the dark". None of this gets spoken; it is the brief.',
        button: 'Write me one',
        buttonHint: 'Writes the whole piece from your description, then you can edit it.',
      },
    ],
  },
  chooser: {
    question: 'Which engine should I use?',
    answer:
      'Ask yourself one thing: is this ONE PERSON talking, or a SCENE? One person reading a story, a letter, a monologue, a bedtime tale — with real acting — is Scenema. Two people talking, or anything with music, sound effects or a place you can hear, is Seed Audio.',
    rules: [
      { pick: 'scenema', when: 'one voice, any length, and the acting matters — the feeling shifts mid-sentence, it breathes, it pauses' },
      { pick: 'scenema', when: 'you want to clone a specific person from a short clip and keep the audio in the house' },
      { pick: 'scenema', when: 'it is long — a chapter, a whole story. There is no length limit' },
      { pick: 'seed', when: 'two or more people talk to each other' },
      { pick: 'seed', when: 'you want music, sound effects, or a place you can hear around the voices' },
      { pick: 'seed', when: 'you need it back in seconds, and it is under two minutes' },
    ],
  },
  engines: {
    scenema: {
      name: 'Scenema',
      tagline: 'One actor, really acting.',
      where: "Runs on Kade's own graphics card. Nothing leaves the house.",
      cost: 'About two cents a minute of finished audio. Queued: a minute of audio takes about a minute and a half to make, plus a minute or two if the card was asleep.',
      bestFor: ['one voice reading, telling, confessing, performing', 'a bedtime story, a letter read aloud, a monologue, an audiobook chapter', 'cloning a specific person from ten to twenty seconds of them talking', 'anything long — there is no length limit'],
      notFor: ['two people talking to each other', 'music', 'a scene you can hear around the voice — it can add some, but that is not its job'],
      howToWrite: [
        'Describe WHO is speaking in one specific, theatrical sentence: sex, age, register, accent, texture, manner, and a line of character. "A man speaking" gets you nothing. "Male, mid sixties, deep baritone with gravel, slight Southern inflection, worn but warm" gets you a person.',
        'Between your sentences, tell the actor what they are DOING and FEELING — "voice tightens, swallows, fighting to stay composed", "long pause, deep breath". Pair a physical cue with a feeling. Never describe the sound you want; describe the person.',
        'Write natural sentences of normal length. Anything over about fifteen seconds is split automatically.',
        'Hard names get garbled. Spell a difficult word the way it sounds.',
        'A clip beats a description for a specific person. The clip gives the identity; your description and directions give the performance. Any voice can perform any emotion, even one the clip never contained.',
      ],
      settings: [
        { key: 'voice_description', label: 'Describe the voice', hint: 'Sex, age, register, accent, texture, manner, one line of character. This is the main control.', kind: 'text' },
        { key: 'gender', label: 'Voice sex', hint: 'Male or female. The engine needs it for the pronouns in its own notes.', kind: 'choice', options: ['female', 'male'], default: 'female' },
        { key: 'reference_voice_url', label: 'Import a clip to clone', hint: 'Ten to twenty seconds of one person, clean, with some feeling in it — a flat monotone clip clones badly. Compressed, noisy recordings drag the result down.', kind: 'clip', max: 1 },
        { key: 'scene', label: 'Scene', hint: 'Where this happens: "a kitchen at dawn, rain outside". Only heard if Shot is Wide or Scene and Scene sound is on.', kind: 'text' },
        { key: 'shot', label: 'Shot', hint: 'How far away the listener is. Close up is the voice at your ear, environment stripped. Wide puts the voice in a room. Scene turns the room up.', kind: 'choice', options: ['closeup', 'wide', 'scene'], default: 'closeup' },
        { key: 'background_sfx', label: 'Scene sound', hint: 'Keeps the room and weather around the voice instead of a clean voice on its own. Only does anything with Wide or Scene.', kind: 'toggle', default: false },
        { key: 'pace', label: 'Pace', hint: 'How much time the actor is given. One point five is the engine’s normal. Higher is slower and more deliberate; lower is faster. Between zero point five and three.', kind: 'number', min: 0.5, max: 3, default: 1.5 },
        { key: 'seed', label: 'Seed', hint: 'The same seed with the same script gives the same take again. Leave it empty for a new take each time.', kind: 'number', min: 0 },
        { key: 'keep_wav', label: 'Keep the studio file', hint: 'Also keeps the forty-eight kilohertz stereo WAV master alongside the MP3. Same price, bigger file.', kind: 'toggle', default: false },
      ],
    },
    seed: {
      name: 'Seed Audio',
      tagline: 'A whole scene in one pass.',
      where: "Made on fal's servers, not here. Your words and any clips you import leave the house for this one.",
      cost: 'About nineteen cents a minute. Back in seconds. Up to two minutes a pass.',
      bestFor: ['two or three people talking', 'music, sound effects, and a place you can hear', 'a radio play, an ad, a scene from a story with the room around it', 'anything you need back right now'],
      notFor: ['a long piece — two minutes a pass, made scene by scene after that', 'the finest acting from one voice — Scenema is the stronger instrument for that', 'keeping the audio in the house'],
      howToWrite: [
        'Write it like a short scene brief, not a line to read. Five things, every time: the Setting, who is in it and what they are doing, the music and sound effects, notes on each voice, and the exact lines in quotes.',
        'Every line has the same shape: the name, the voice in parentheses, how they say it, a colon, then the words in quotes. "Emma (teenage, soft, shy) lowers her voice, flustered: “I still haven’t finished.”"',
        'Write long. The environment, the music and every delivery are things it makes, so every sentence you leave out is a decision handed back to it.',
        'Spell the sounds out. A door "slap", a zipper "zzzip", a bell "ring-a-ling fading". Spelling a sound is more reliable than naming it.',
        'Music by mood, not by genre: "soft piano that swells", not "C major ballad".',
        'Write the prompt in the same language the lines are spoken in.',
        'Up to three clips can be imported, and each one is tagged to a speaker: "the actor is @Audio1".',
      ],
      settings: [
        { key: 'voice', label: 'Preset voice', hint: 'One of the engine’s twenty built-in voices, for a single narrator. Leave it off when your prompt describes the voices, or when clips are imported.', kind: 'choice', options: ['', 'vivi_mixed_en_zh_ja_es_id', 'mindy_en_es_id_pt_zh', 'kian_en_zh', 'cedric_en_zh', 'sophie_en_zh', 'jean_en_zh', 'magnus_en_zh', 'mabel_en_zh', 'nadia_en_zh', 'opal_en_zh', 'pearl_en_zh', 'quentin_en_zh', 'corinne_mixed_en_zh', 'esther_mixed_en_zh', 'lyla_mixed_en_zh', 'tracy_es_zh', 'sandy_es_mixed_en_zh', 'felix_zh', 'celeste_zh', 'monkey_king_zh'], default: '' },
        { key: 'audio_urls', label: 'Import clips to clone', hint: 'Up to three, each under thirty seconds, clean, one person each. They become @Audio1, @Audio2 and @Audio3 — name them in the script.', kind: 'clip', max: 3 },
        { key: 'speed', label: 'Speed', hint: 'One is normal. Half is half speed, two is double.', kind: 'number', min: 0.5, max: 2, default: 1 },
        { key: 'pitch', label: 'Pitch', hint: 'In semitones. Zero is normal. Minus twelve is an octave down, twelve an octave up.', kind: 'number', min: -12, max: 12, default: 0 },
        { key: 'volume', label: 'Volume', hint: 'One is normal. Half to double.', kind: 'number', min: 0.5, max: 2, default: 1 },
        { key: 'multilingual', label: 'Multilingual', hint: 'Turn on for anything not in English, or mixed languages. Twenty languages.', kind: 'toggle', default: false },
        { key: 'audio_quality', label: 'Studio quality', hint: 'Forty-eight kilohertz WAV instead of the usual MP3. Same price, bigger file.', kind: 'toggle', default: false },
      ],
    },
  },
};

/* ---------- "is this the WORDS, or a DESCRIPTION of them?" -------------------
 * Part 121.1, her question: "do you think users will get confused between
 * write one for me and turn my words into a script?"
 *
 * The buttons are not really the problem. ONE TEXT BOX MEANS TWO DIFFERENT
 * THINGS depending on which one you press, and the box cannot say which it is
 * holding. Type "a bedtime story about a fox who is scared of the dark" and
 * press "Turn my words into a script", and the engine performs those twelve
 * words, out loud, exactly as typed. It succeeds. It costs money. It is not
 * remotely what anyone meant — and for someone listening rather than looking,
 * a plausible script and a plausible read-back come back, so nothing about
 * the result announces the mistake.
 *
 * A silent wrong answer is the failure this platform's record hates most, so:
 * the screens put the choice ABOVE the box (one button at a time, and the box
 * says what it wants), and this is the backstop for a wrong pick — asked as a
 * question, never as a refusal, because the classifier can be wrong and she
 * is allowed to mean it. */
function looksLikeDescription(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const reasons = [];
  let score = 0;
  if (/^(write|make|generate|create|do|give)\b/.test(lower)) { score += 3; reasons.push('it starts with an instruction'); }
  if (/\b(write|make|generate|create) me\b/.test(lower)) { score += 3; reasons.push('it asks for something to be made'); }
  if (/^(a|an|the)\s+[\w\s-]{2,40}\b(story|ad|advert|commercial|scene|poem|song|monologue|letter|speech|intro|trailer|jingle|piece|clip|narration)\b/.test(lower)) {
    score += 3; reasons.push('it names a kind of piece rather than saying anything');
  }
  if (/\b\d+\s*(second|sec|minute|min)\b/.test(lower)) { score += 2; reasons.push('it gives a length'); }
  if (/\b(about|for|where|in which|that says)\b/.test(lower) && words < 60) { score += 1; }
  // Signals it IS the words: real sentences, quoted speech, someone addressed.
  const sentences = (t.match(/[.!?]["')\]]?(\s|$)/g) || []).length;
  if (sentences >= 2) { score -= 3; reasons.push('it reads as finished sentences'); }
  if (/["“”]/.test(t)) { score -= 2; }
  if (/\b(i|you|we|my|your)\b/i.test(lower) && sentences >= 1) score -= 1;
  if (words > 80) { score -= 2; }
  if (score < 3) return null;
  return {
    /* Said, not shown — and phrased as a question, because being told you
     * pressed the wrong button is worse than being asked. */
    question:
      `That reads like a description of what you want, not the words themselves — ${reasons.slice(0, 2).join(' and ')}. ` +
      'Pressed this way it will perform that sentence out loud, word for word. Did you mean "Write me one"?',
    reasons,
  };
}

/* A free, instant, explainable answer to "which one?" — read off the text she
 * typed, so the screen can suggest before she spends anything. Not a model
 * call: the reasons have to be sayable, and the same text must always get
 * the same answer. */
function suggestEngine(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const reasons = [];
  let seed = 0;
  let scenema = 0;
  const speakerLines = (t.match(/^\s*[A-Z][a-zA-Z' ]{1,30}\s*(\([^)]*\))?\s*:/gm) || []).length;
  const quotedSpeakers = (t.match(/\b[A-Z][a-z]+ (says|said|asks|asked|replies|replied|answers|whispers|shouts)\b/g) || []).length;
  if (speakerLines >= 2 || quotedSpeakers >= 2) { seed += 3; reasons.push('more than one person talks'); }
  if (/\b(music|soundtrack|song|jingle|theme|beat|piano|guitar|drums|orchestra|strings)\b/.test(lower)) { seed += 2; reasons.push('you asked for music'); }
  if (/\b(sound effects?|sfx|thunder|rain|traffic|crowd|footsteps|door|wind|birds|ambience|ambient|background sounds?)\b/.test(lower)) { seed += 1; reasons.push('there are sounds in it'); }
  if (/\b(radio play|radio drama|commercial|advert|ad spot|podcast intro|trailer)\b/.test(lower)) { seed += 2; reasons.push('it is a produced scene'); }
  if (/\b(story|bedtime|chapter|monologue|letter|poem|narrat|read (this|it|me)|audiobook|speech|eulogy|confession|diary)\b/.test(lower)) { scenema += 2; reasons.push('one voice telling or reading'); }
  if (/\b(clone|sounds? like (my|her|his)|in (my|her|his) voice|my (mom|dad|grandma|grandpa|sister|brother)'?s voice)\b/.test(lower)) { scenema += 2; reasons.push('you want a specific person\'s voice'); }
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 320) { scenema += 2; reasons.push('it is long — over two minutes'); }
  if (/\b(whisper|breath|pause|voice (breaks|cracks)|tearful|choking up|trembl)\b/.test(lower)) { scenema += 1; reasons.push('the acting matters'); }
  if (seed === 0 && scenema === 0) {
    return { engine: 'scenema', sure: false, reason: 'One voice is the usual case, so Scenema. If two people talk, or you want music or a place you can hear, switch to Seed Audio.' };
  }
  const engine = seed > scenema ? 'seed' : 'scenema';
  const why = reasons.filter((r) => (engine === 'seed'
    ? /person talks|music|sounds|produced/.test(r)
    : /telling|specific person|long|acting/.test(r)));
  return {
    engine,
    sure: Math.abs(seed - scenema) >= 2,
    reason: `${engine === 'seed' ? 'Seed Audio' : 'Scenema'}, because ${why.join(' and ') || reasons.join(' and ')}.`,
  };
}

/* ---------- estimates, said out loud before anything is spent ------------- */
function estimateFor(engine, script) {
  const { words, seconds } = spokenSeconds(script);
  if (engine === 'seed') {
    const costUSD = Math.round((seconds / 60) * SEED_USD_PER_MIN * 1000) / 1000;
    return {
      engine,
      words,
      audioSeconds: seconds,
      renderSeconds: Math.max(10, Math.round(seconds * 0.5)),
      costUSD,
      spoken: sayEstimate(seconds, Math.max(10, Math.round(seconds * 0.5)), costUSD, false),
    };
  }
  const renderSeconds = Math.round(seconds * 1.4) + 90;
  const costUSD = Math.round((seconds / 60) * SCENEMA_USD_PER_MIN * 1000 + 20) / 1000;
  return {
    engine: 'scenema',
    words,
    audioSeconds: seconds,
    renderSeconds,
    costUSD,
    spoken: sayEstimate(seconds, renderSeconds, costUSD, true),
  };
}

/** The estimate as a sentence, because it is read aloud. Her standing rule:
 * the cost is SAID before the render runs, not shown in a corner. */
function sayEstimate(audioS, renderS, costUSD, queued) {
  const len =
    audioS >= 60
      ? `${Math.floor(audioS / 60)} minute${Math.floor(audioS / 60) === 1 ? '' : 's'} ${audioS % 60} seconds`
      : `${audioS} seconds`;
  const wait =
    renderS >= 90
      ? `roughly ${Math.max(1, Math.round(renderS / 60))} minute${Math.round(renderS / 60) === 1 ? '' : 's'}`
      : `about ${renderS} seconds`;
  const cents = Math.round(costUSD * 100);
  const money = cents >= 100 ? `about $${costUSD.toFixed(2)}` : `about ${Math.max(1, cents)} cent${cents === 1 ? '' : 's'}`;
  return `About ${len} of audio, ${wait} to make, ${money}.${queued ? ' Longer if the graphics card has to wake up.' : ''}`;
}

/* ---------- projects ------------------------------------------------------ *
 * A project's TAKES are the finished recordings hanging off it. They are read
 * from the same KadeAsset rows My Creations shows -- not copied -- so a clip
 * has one home and one description. The URL is re-signed at read time exactly
 * as /my-assets does it, which is what lets a phone play a stored link that
 * was signed days ago. */
async function freshAssetUrl(url) {
  let u = String(url || '');
  if (u && !/^https?:\/\//i.test(u) && !u.startsWith('/')) u = '/' + u;
  try {
    if (/[?&]X-Amz-/.test(u) && typeof needsRefresh === 'function' && needsRefresh(u, 3600)) {
      u = await getNewS3URL(u);
    }
  } catch (e) {
    logger.warn('[soundbooth] URL re-sign failed (serving stored URL): ' + e.message);
  }
  return u;
}

/* ---------- linking a Scenema take back to its project ----------------------
 * A queued render finishes on the BRIDGE, which posts the MP3 to the fork's
 * /asset-event lane. That lane knows the user and the job, but not the project
 * -- so the asset arrives with `metadata.jobId` and nothing else to hang it
 * on. Rather than teach the bridge about projects (a second service that would
 * then have to be kept in step), the join happens HERE, on read, by job id.
 * Idempotent: an id already on the row is not added twice. */
async function linkJobAssets(projects, userId) {
  const jobIds = [];
  for (const p of projects) for (const j of p.jobs || []) jobIds.push(j);
  if (!jobIds.length) return 0;
  const docs = await KadeAsset.find({ user: userId, 'metadata.jobId': { $in: jobIds } })
    .select('_id metadata')
    .lean();
  if (!docs.length) return 0;
  const byJob = new Map();
  for (const d of docs) byJob.set(String(d.metadata.jobId), String(d._id));
  let linked = 0;
  for (const p of projects) {
    const have = new Set((p.assets || []).map(String));
    const add = [];
    for (const j of p.jobs || []) {
      const id = byJob.get(String(j));
      if (id && !have.has(id)) {
        add.push(id);
        have.add(id);
      }
    }
    if (add.length) {
      p.assets = [...(p.assets || []), ...add];
      linked += add.length;
      try {
        await KadeSoundBoothProject.updateOne({ _id: p._id }, { $set: { assets: p.assets } });
      } catch (e) {
        logger.warn('[soundbooth] take link save failed: ' + e.message);
      }
    }
  }
  return linked;
}

async function takesFor(projects, userId) {
  const ids = [];
  for (const p of projects) for (const a of p.assets || []) ids.push(a);
  if (!ids.length) return new Map();
  const valid = ids.filter((i) => mongoose.Types.ObjectId.isValid(String(i)));
  if (!valid.length) return new Map();
  const docs = await KadeAsset.find({ _id: { $in: valid }, user: userId })
    .select('_id kind url backupUrl description createdAt costUSD metadata')
    .lean();
  const map = new Map();
  for (const d of docs) {
    map.set(String(d._id), {
      id: String(d._id),
      url: await freshAssetUrl(d.url),
      backupUrl: d.backupUrl ? await freshAssetUrl(d.backupUrl) : '',
      /* The blind-friendly description the gallery writes, when it has landed
       * yet -- enrichment runs detached, so a brand-new take often has none. */
      description: d.description || '',
      seconds: (d.metadata && (d.metadata.seconds || d.metadata.durationS)) || null,
      costUSD: d.costUSD || 0,
      createdAt: d.createdAt,
    });
  }
  return map;
}

function projectView(p) {
  return {
    id: String(p._id),
    title: p.title,
    engine: p.engine,
    mode: p.mode,
    sourceText: p.sourceText,
    script: p.script,
    readback: p.readback,
    options: p.options || {},
    jobs: p.jobs || [],
    assets: p.assets || [],
    state: p.state,
    lastError: p.lastError || null,
    costUSD: p.costUSD || 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastRenderAt: p.lastRenderAt || null,
  };
}

function titleFrom(script, fallback) {
  const words = String(script || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 7)
    .join(' ');
  return (words || fallback || 'Untitled').slice(0, 80);
}

/* ============================ POST /script ================================ */
router.post('/script', requireJwtAuth, express.json({ limit: '128kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const engine = b.engine === 'seed' ? 'seed' : 'scenema';
    const mode = b.mode === 'write' ? 'write' : 'format';
    const text = String(b.text || '').trim().slice(0, 6000);
    if (text.length < 3) {
      return res.status(400).json({
        error:
          mode === 'write'
            ? 'Say what you want made — even one sentence is enough.'
            : 'Type the words you want performed first.',
      });
    }
    if (scriptCapHit(req.user.id)) {
      return res
        .status(429)
        .json({ error: `That's ${SCRIPT_DAILY_CAP} scripts today — the writing desk reopens tomorrow.` });
    }

    /* The backstop: formatting a brief performs the brief. Ask, do not refuse. */
    const mismatch = mode === 'format' ? looksLikeDescription(text) : null;

    const mood = MOODS[b.mood] || null;
    const lines = [];
    lines.push(mode === 'write' ? `WHAT THEY WANT MADE:\n${text}` : `THEIR WORDS:\n${text}`);
    if (b.voice_description) {
      lines.push(`WHO IS SPEAKING: ${String(b.voice_description).slice(0, 600)}`);
    }
    if (b.gender === 'male' || b.gender === 'female') lines.push(`VOICE SEX: ${b.gender}`);
    if (mood) {
      lines.push(
        `MOOD THEY PICKED: ${mood.label} — ${engine === 'seed' ? mood.seed : mood.scenema}. Work this into the directions.`,
      );
    }
    if (b.scene) lines.push(`SCENE: ${String(b.scene).slice(0, 200)}`);
    if (['closeup', 'wide', 'scene'].includes(b.shot)) lines.push(`SHOT: ${b.shot}`);
    if (engine === 'seed') {
      const n = Array.isArray(b.audio_urls) ? Math.min(3, b.audio_urls.filter((u) => /^https?:\/\//i.test(String(u))).length) : 0;
      if (n > 0) {
        lines.push(`REFERENCE CLIPS IMPORTED: ${n}. Tag them to speakers in the script as @Audio1${n > 1 ? ', @Audio2' : ''}${n > 2 ? ', @Audio3' : ''} ("the actor is @Audio1").`);
      }
      if (b.language && b.language !== 'en') lines.push(`LANGUAGE: ${String(b.language).slice(0, 40)} — write the whole prompt in it.`);
    } else if (b.reference_voice_url) {
      lines.push('A REFERENCE CLIP WILL BE CLONED: the clip supplies the identity, so spend the voice= description on the CHARACTER and the emotional archetype rather than on physical timbre.');
    }

    const started = Date.now();
    const { text: raw, usage } = await callModel({
      system: systemPrompt({ engine, mode }),
      user: lines.join('\n\n'),
      maxTokens: engine === 'seed' ? 1200 : 2200,
    });
    let { script, readback } = splitScriptAndReadback(raw);
    if (!script) {
      return res.status(502).json({ error: 'The script desk came back empty. Try again.' });
    }
    let repairs = [];
    if (engine === 'seed') {
      const cleaned = sanitizeSeed(script);
      script = cleaned.script;
      repairs = cleaned.notes;
    }
    if (engine === 'scenema') {
      const cleaned = sanitizeScenema(script);
      script = cleaned.script;
      repairs = cleaned.notes;
      script = wrapSpeak({
        body: script,
        voice_description: b.voice_description,
        gender: b.gender,
        scene: b.scene,
        shot: b.shot,
        pace: typeof b.pace === 'number' ? b.pace : undefined,
        language: b.language,
      });
    }
    const problem = engine === 'seed' ? checkSeed(script) : checkScenema(script);
    const estimate = estimateFor(engine, script);
    logKadeUsage({
      userId: req.user.id,
      service: 'soundbooth_script',
      quantity: 1,
      unit: 'calls',
      costUSD: 0.0006,
      metadata: {
        engine,
        mode,
        model: MODEL,
        ms: Date.now() - started,
        inTok: usage.prompt_tokens,
        outTok: usage.completion_tokens,
      },
    }).catch(() => {});
    logger.info(
      `[soundbooth/script] ${engine}/${mode} user=${req.user.id} ${script.length}ch ${Date.now() - started}ms${problem ? ' PROBLEM: ' + problem : ''}`,
    );
    return res.json({
      engine,
      mode,
      script,
      readback,
      estimate,
      problem: problem || null,
      repairs,
      mismatch: mismatch ? mismatch.question : null,
    });
  } catch (error) {
    const status = error.status || 500;
    logger.error('[soundbooth/script] failed:', error);
    return res
      .status(status)
      .json({ error: status === 503 ? error.message : 'The script desk had trouble. Try again.' });
  }
});

/* ============================ POST /render ================================ */
router.post('/render', requireJwtAuth, express.json({ limit: '128kb' }), async (req, res) => {
  const b = req.body || {};
  const engine = b.engine === 'seed' ? 'seed' : 'scenema';
  let script = String(b.script || '').trim();
  const mode = b.mode === 'advanced' ? 'advanced' : 'easy';
  if (!script) return res.status(400).json({ error: 'There is nothing to render yet.' });
  /* The same repair runs on the way to the GPU, because a script can reach
   * here without passing the script desk at all -- she can type one by hand in
   * Advanced, or paste one in. A %%% line is never legitimate Scenema, so
   * converting it can only help; nothing else about her text is touched. */
  if (engine === 'scenema') {
    script = sanitizeScenema(script).script;
  } else {
    script = sanitizeSeed(script).script;
  }
  const problem = engine === 'seed' ? checkSeed(script) : checkScenema(script);
  if (problem) return res.status(400).json({ error: problem });

  let project = null;
  try {
    const opts = {};
    const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) && u.length < 2048;
    if (isUrl(b.reference_voice_url)) opts.reference_voice_url = b.reference_voice_url;
    /* Seed takes up to three clips (@Audio1–3); Scenema takes one. A single
     * imported clip is accepted under either name so the two screens can
     * share one import row. */
    if (Array.isArray(b.audio_urls)) opts.audio_urls = b.audio_urls.filter(isUrl).slice(0, 3);
    if (engine === 'seed' && !opts.audio_urls?.length && opts.reference_voice_url) opts.audio_urls = [opts.reference_voice_url];
    if (engine === 'scenema' && !opts.reference_voice_url && opts.audio_urls?.length) opts.reference_voice_url = opts.audio_urls[0];
    if (b.background_sfx === true) opts.background_sfx = true;
    if (Number.isInteger(b.seed) && b.seed >= 0) opts.seed = b.seed;
    /* Scenema's pace: 1.5 is the ENGINE'S normal (its README: "accounts for
     * LTX's naturally slower speaking pace"); higher = slower. The first booth
     * told her 1.0 was normal — that was wrong, and it is fixed in the guide. */
    if (typeof b.pace === 'number' && b.pace >= 0.5 && b.pace <= 3) opts.pace = b.pace;
    if (b.keep_wav === true) opts.keep_wav = true;
    if (b.validate === false) opts.validate = false;
    if (b.audio_quality === 'high') opts.audio_quality = 'high';
    if (typeof b.speed === 'number' && b.speed >= 0.5 && b.speed <= 2) opts.speed = b.speed;
    if (typeof b.volume === 'number' && b.volume >= 0.5 && b.volume <= 2) opts.volume = b.volume;
    if (Number.isInteger(b.pitch) && b.pitch >= -12 && b.pitch <= 12) opts.pitch = b.pitch;
    if (b.multilingual === true) opts.multilingual = true;
    if (typeof b.voice === 'string' && b.voice.trim()) opts.voice = b.voice.trim().slice(0, 64);
    if (b.voice_description) opts.voice_description = String(b.voice_description).slice(0, 600);
    if (['closeup', 'wide', 'scene'].includes(b.shot)) opts.shot = b.shot;
    if (b.scene) opts.scene = String(b.scene).slice(0, 200);
    /* PREVIEW (her "how do I know what I'll get"): Scenema's voice_design mode
     * renders ONE fifteen-second sample of the voice description — no
     * chunking, about a penny — so she can hear the actor before spending
     * on the whole piece. It is a real render on the same lane; it lands in
     * the library as a take like any other, flagged. */
    const preview = engine === 'scenema' && b.preview === true;

    /* One row per piece of work. Re-rendering an existing project appends to
     * it rather than making a second row -- the Library should show a piece
     * once, with its takes, not the same script five times. */
    if (b.projectId && mongoose.Types.ObjectId.isValid(String(b.projectId))) {
      project = await KadeSoundBoothProject.findOne({ _id: b.projectId, user: req.user.id });
    }
    if (!project) {
      project = new KadeSoundBoothProject({ user: req.user.id });
    }
    project.title = String(b.title || project.title || titleFrom(script)).slice(0, 80) || 'Untitled';
    project.engine = engine;
    project.mode = mode;
    project.sourceText = String(b.sourceText || project.sourceText || '').slice(0, 8000);
    project.script = script.slice(0, 8000);
    project.readback = String(b.readback || project.readback || '').slice(0, 600);
    project.options = opts;
    project.lastRenderAt = new Date();
    project.lastError = undefined;

    if (engine === 'scenema') {
      const secret = process.env.BRIDGE_SECRET;
      if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
      let r;
      try {
        /* A preview performs one fixed sample line in the described voice,
         * not her whole script — the point is to hear the ACTOR for a penny.
         * The voice= attribute is lifted off her script so what she previews
         * is exactly what the full render will use. */
        let promptToSend = script;
        if (preview) {
          const speakTag = (script.match(/<speak[^>]*>/i) || [''])[0];
          const attrs = speakTag ? speakTag.replace(/^<speak/i, '').replace(/>$/, '') : ` voice="${escapeXml(opts.voice_description || 'A warm, clear adult voice.')}" gender="${b.gender === 'male' ? 'male' : 'female'}"`;
          promptToSend = `<speak${attrs}>\nHere is how I sound. I can be gentle, I can be sharp, and I can slow all the way down when the moment asks for it.\n</speak>`;
        }
        const bridgeBody = {
          secret,
          userId: String(req.user.id),
          agentId: 'soundbooth',
          agentName: 'Sound Booth',
          prompt: promptToSend,
          reference_voice_url: opts.reference_voice_url,
          background_sfx: opts.background_sfx,
          seed: opts.seed,
          pace: opts.pace,
          keep_wav: opts.keep_wav,
        };
        if (preview) bridgeBody.mode = 'voice_design';
        r = await axios.post(`${bridgeBase()}/audio/scenema/start`, bridgeBody, {
          headers: { 'User-Agent': UA },
          timeout: 20000,
        });
      } catch (e) {
        const msg = e?.response?.data?.error || e.message;
        project.state = 'failed';
        project.lastError = String(msg).slice(0, 300);
        await project.save();
        return res.status(400).json({ error: msg, projectId: String(project._id) });
      }
      const jobId = r.data?.jobId;
      project.state = 'queued';
      if (jobId) project.jobs = [...(project.jobs || []), jobId].slice(-20);
      await project.save();
      const est = preview
        ? { engine: 'scenema', words: 0, audioSeconds: 15, renderSeconds: 60, costUSD: 0.01, spoken: 'A fifteen second sample of the voice, about a minute to make, about a penny. Longer if the graphics card has to wake up.' }
        : estimateFor('scenema', script);
      const bridgeEst = preview ? {} : (r.data?.estimate || {});
      /* audioSeconds comes from HERE (the bridge counts direction words as
       * spoken); the wait and the money come from the BRIDGE, which is the
       * only side that knows the measured render rate and the wake charge. */
      const merged = {
        ...est,
        audioSeconds: est.audioSeconds,
        renderSeconds: bridgeEst.renderSeconds || est.renderSeconds,
        costUSD: typeof bridgeEst.costUSD === 'number' ? bridgeEst.costUSD : est.costUSD,
      };
      merged.spoken = sayEstimate(merged.audioSeconds, merged.renderSeconds, merged.costUSD, true);
      logger.info(`[soundbooth/render] scenema queued job=${jobId} project=${project._id} user=${req.user.id}`);
      return res.json({
        ok: true,
        engine: 'scenema',
        queued: true,
        preview,
        jobId,
        projectId: String(project._id),
        estimate: merged,
      });
    }

    /* ---- Seed Audio: synchronous, so the answer carries the audio itself --- */
    const falKey = process.env.FAL_KEY;
    if (!falKey) return res.status(503).json({ error: 'Seed Audio is not configured on this server.' });
    project.state = 'running';
    await project.save();

    const hq = opts.audio_quality === 'high';
    const body = {
      prompt: script,
      output_format: hq ? 'wav' : 'mp3',
      sample_rate: hq ? 48000 : 24000,
    };
    if (typeof opts.speed === 'number') body.speed = opts.speed;
    if (typeof opts.volume === 'number') body.volume = opts.volume;
    if (Number.isInteger(opts.pitch)) body.pitch = opts.pitch;
    if (opts.multilingual) body.multilingual = true;
    /* Clips override a preset: the docs say a reference clip beats a preset
     * name, and sending both is undefined. */
    if (opts.audio_urls?.length) body.audio_urls = opts.audio_urls;
    else if (opts.voice) body.voice = opts.voice;

    let r;
    try {
      r = await axios.post('https://fal.run/bytedance/seed-audio-1.0', body, {
        headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
        timeout: 180000,
      });
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.response?.data?.error || e.message;
      project.state = 'failed';
      project.lastError = String(msg).slice(0, 300);
      await project.save();
      return res
        .status(502)
        .json({ error: `Seed Audio could not make that: ${String(msg).slice(0, 200)}`, projectId: String(project._id) });
    }
    const audio = r.data?.audio;
    if (!audio?.url) {
      project.state = 'failed';
      project.lastError = 'Seed Audio returned no clip.';
      await project.save();
      return res
        .status(502)
        .json({ error: 'Seed Audio returned no clip. Try rewording it.', projectId: String(project._id) });
    }
    const seconds = Math.max(1, Math.round(Number(audio.duration) || 0));
    const costUSD = Math.round((seconds / 60) * SEED_USD_PER_MIN * 1000) / 1000;
    logKadeUsage({
      userId: req.user.id,
      service: 'fal_audio',
      quantity: seconds,
      unit: 'seconds',
      costUSD,
      metadata: { model: 'seed-audio-1.0', via: 'sound-booth', format: body.output_format },
    }).catch(() => {});
    let assetId = null;
    try {
      const asset = await logKadeAsset({
        userId: req.user.id,
        kind: 'audio',
        service: 'fal_audio',
        url: audio.url,
        prompt: script,
        model: 'seed-audio-1.0',
        costUSD,
        metadata: { seconds, via: 'sound-booth', projectId: String(project._id) },
      });
      if (asset && asset._id) assetId = String(asset._id);
    } catch (e) {
      logger.warn('[soundbooth/render] asset log failed (non-fatal): ' + e.message);
    }
    project.state = 'done';
    project.costUSD = (project.costUSD || 0) + costUSD;
    if (assetId) project.assets = [...(project.assets || []), assetId].slice(-20);
    await project.save();
    logger.info(
      `[soundbooth/render] seed done ${seconds}s $${costUSD} project=${project._id} user=${req.user.id}`,
    );
    return res.json({
      ok: true,
      engine: 'seed',
      queued: false,
      projectId: String(project._id),
      assetId,
      url: audio.url,
      seconds,
      costUSD,
    });
  } catch (error) {
    logger.error('[soundbooth/render] failed:', error);
    if (project) {
      try {
        project.state = 'failed';
        project.lastError = String(error.message || 'render failed').slice(0, 300);
        await project.save();
      } catch (_) {
        /* noop */
      }
    }
    return res.status(500).json({ error: 'That render could not start. Try again.' });
  }
});

/* ============================ GET /status/:jobId =========================== */
/* The phone cannot hold BRIDGE_SECRET, so the fork asks on its behalf -- the
 * same peephole shape build 197 used for the front desk and the crash ring.
 * The row is updated from what comes back, so the Library is right even if the
 * app was closed while the GPU was working. */
router.get('/status/:jobId', requireJwtAuth, async (req, res) => {
  try {
    const secret = process.env.BRIDGE_SECRET;
    if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
    const jobId = String(req.params.jobId || '').slice(0, 64);
    const project = await KadeSoundBoothProject.findOne({ user: req.user.id, jobs: jobId });
    if (!project) return res.status(404).json({ error: 'No render by that name on your account.' });
    let r;
    try {
      r = await axios.get(
        `${bridgeBase()}/audio/scenema/status?jobId=${encodeURIComponent(jobId)}&secret=${encodeURIComponent(secret)}`,
        { headers: { 'User-Agent': UA }, timeout: 15000 },
      );
    } catch (e) {
      if (e?.response?.status === 404) return res.status(404).json({ error: 'That render is not on the board.' });
      throw e;
    }
    const j = r.data || {};
    const map = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' };
    if (map[j.state] && project.state !== map[j.state]) {
      project.state = map[j.state];
      if (j.state === 'failed') project.lastError = String(j.error || 'render failed').slice(0, 300);
      if (j.state === 'done' && typeof j.costUSD === 'number') {
        project.costUSD = (project.costUSD || 0) + j.costUSD;
      }
      await project.save();
      if (j.state === 'done') {
        /* The gallery row may land a beat after the bridge says done -- link
         * what is there now, and the next /projects read catches the rest. */
        try {
          await linkJobAssets([project], req.user.id);
        } catch (e) {
          logger.warn('[soundbooth] link on done failed: ' + e.message);
        }
      }
    }
    const d = Math.round(j.result?.durationS || 0);
    return res.json({
      jobId,
      projectId: String(project._id),
      state: j.state,
      error: j.error || null,
      url: j.result?.url || null,
      durationS: j.result?.durationS || null,
      costUSD: j.costUSD || null,
      /* Said, not shown: the app speaks this on every state change. */
      spoken:
        j.state === 'done'
          ? `Ready. ${Math.floor(d / 60) ? `${Math.floor(d / 60)} minute${Math.floor(d / 60) === 1 ? '' : 's'} ` : ''}${d % 60} seconds of audio, in the Sound Booth library and My Creations.`
          : j.state === 'failed'
            ? `That render did not finish. ${String(j.error || '').slice(0, 120)}`
            : j.state === 'running'
              ? 'Rendering now.'
              : 'Queued. The graphics card may need a minute to wake up.',
    });
  } catch (error) {
    logger.error('[soundbooth/status] failed:', error);
    return res.status(500).json({ error: 'Could not read that render.' });
  }
});

/* ============================ POST /cancel/:jobId ========================== */
router.post('/cancel/:jobId', requireJwtAuth, async (req, res) => {
  try {
    const secret = process.env.BRIDGE_SECRET;
    if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
    const jobId = String(req.params.jobId || '').slice(0, 64);
    const project = await KadeSoundBoothProject.findOne({ user: req.user.id, jobs: jobId });
    if (!project) return res.status(404).json({ error: 'No render by that name on your account.' });
    await axios.post(
      `${bridgeBase()}/audio/scenema/cancel`,
      { secret, jobId },
      { headers: { 'User-Agent': UA }, timeout: 15000 },
    );
    project.state = 'cancelled';
    await project.save();
    return res.json({ ok: true });
  } catch (error) {
    logger.error('[soundbooth/cancel] failed:', error);
    return res.status(500).json({ error: 'Could not stop that render.' });
  }
});

/* ============================ projects ==================================== */
router.get('/projects', requireJwtAuth, async (req, res) => {
  try {
    const rows = await KadeSoundBoothProject.find({ user: req.user.id })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
    await linkJobAssets(rows, req.user.id);
    const takes = await takesFor(rows, req.user.id);
    const projects = rows.map((r) => {
      const v = projectView(r);
      v.takes = (r.assets || []).map((id) => takes.get(String(id))).filter(Boolean).reverse();
      return v;
    });
    return res.json({ count: projects.length, projects });
  } catch (error) {
    logger.error('[soundbooth/projects] failed:', error);
    return res.status(500).json({ error: "Couldn't load your Sound Booth." });
  }
});

router.get('/projects/:id', requireJwtAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const p = await KadeSoundBoothProject.findOne({ _id: req.params.id, user: req.user.id }).lean();
    if (!p) return res.status(404).json({ error: 'No such project.' });
    await linkJobAssets([p], req.user.id);
    const takes = await takesFor([p], req.user.id);
    const v = projectView(p);
    v.takes = (p.assets || []).map((id) => takes.get(String(id))).filter(Boolean).reverse();
    return res.json({ project: v });
  } catch (error) {
    logger.error('[soundbooth/project] failed:', error);
    return res.status(500).json({ error: "Couldn't load that project." });
  }
});

router.patch('/projects/:id', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const p = await KadeSoundBoothProject.findOne({ _id: req.params.id, user: req.user.id });
    if (!p) return res.status(404).json({ error: 'No such project.' });
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) p.title = b.title.trim().slice(0, 80);
    if (typeof b.script === 'string') p.script = b.script.slice(0, 8000);
    if (typeof b.sourceText === 'string') p.sourceText = b.sourceText.slice(0, 8000);
    await p.save();
    return res.json({ project: projectView(p) });
  } catch (error) {
    logger.error('[soundbooth/project patch] failed:', error);
    return res.status(500).json({ error: "Couldn't save that." });
  }
});

router.delete('/projects/:id', requireJwtAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const r = await KadeSoundBoothProject.deleteOne({ _id: req.params.id, user: req.user.id });
    if (!r.deletedCount) return res.status(404).json({ error: 'No such project.' });
    /* The AUDIO is not deleted with the project -- it lives in My Creations,
     * which is the gallery she manages there. Deleting a script here must
     * never quietly take a finished recording with it. */
    return res.json({ ok: true });
  } catch (error) {
    logger.error('[soundbooth/project delete] failed:', error);
    return res.status(500).json({ error: "Couldn't remove that." });
  }
});

/* ====================== POST /reference (import a clip) ====================
 * Her ask, Part 120: "You might put a way to import files in native too."
 *
 * The reliable way to get a SPECIFIC voice is a reference clip -- describing a
 * voice in words missed the age three times out of four when Scenema was
 * measured (Part 119.10), and the record says so plainly. So the phone needs
 * to be able to hand over ten to twenty seconds of somebody talking.
 *
 * The clip goes to the same S3/Backblaze storage every gallery file uses, and
 * the render lane is handed the signed URL. It is NOT filed as a gallery asset:
 * a reference clip is an INPUT, and My Creations is for things she made. It
 * also never leaves the estate for Scenema (her own GPU pulls it); for Seed
 * Audio it does, and the screen says so before she picks that engine.
 * ------------------------------------------------------------------------- */
const refUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
const REF_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/x-flac'];
const REF_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/x-flac': 'flac' };

router.post('/reference', requireJwtAuth, refUpload.single('clip'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) {
      return res.status(400).json({ error: 'No clip arrived. Pick an audio file and try again.' });
    }
    const mime = String(f.mimetype || '').toLowerCase();
    if (!REF_TYPES.includes(mime)) {
      return res
        .status(400)
        .json({ error: 'That file is not audio this can read. A voice memo, an MP3, a WAV or an M4A all work.' });
    }
    if (typeof saveBufferToS3 !== 'function') {
      return res.status(503).json({ error: 'File storage is not set up on this server.' });
    }
    const ext = REF_EXT[mime] || 'mp3';
    const fileName = `soundbooth-ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const url = await saveBufferToS3({
      userId: String(req.user.id),
      buffer: f.buffer,
      fileName,
      basePath: 'audios',
    });
    if (!url) return res.status(502).json({ error: 'The clip did not save. Try again.' });
    logger.info(`[soundbooth/reference] user=${req.user.id} ${f.originalname || fileName} ${f.buffer.length}B`);
    return res.json({
      ok: true,
      url,
      bytes: f.buffer.length,
      name: String(f.originalname || fileName).slice(0, 120),
      /* Said out loud on the phone the moment it lands, because a silent
       * success on an upload is indistinguishable from nothing happening. */
      spoken: `Clip imported, ${Math.max(1, Math.round(f.buffer.length / 1024))} kilobytes. It will be used as the voice to clone.`,
    });
  } catch (error) {
    logger.error('[soundbooth/reference] failed:', error);
    return res.status(500).json({ error: 'That clip could not be imported.' });
  }
});

/* ============================ GET /health ================================= */
/* ============================ POST /suggest =============================== */
router.post('/suggest', requireJwtAuth, express.json({ limit: '64kb' }), (req, res) => {
  return res.json(suggestEngine((req.body || {}).text));
});

router.get('/health', requireJwtAuth, async (_req, res) => {
  return res.json({
    guide: GUIDE,
    engines: {
      scenema: { configured: !!process.env.BRIDGE_SECRET, queued: true, usdPerMin: SCENEMA_USD_PER_MIN },
      seed: { configured: !!process.env.FAL_KEY, queued: false, usdPerMin: SEED_USD_PER_MIN },
    },
    scriptDesk: !!(process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY),
    model: MODEL,
    moods: Object.entries(MOODS).map(([k, v]) => ({ key: k, label: v.label })),
    limits: { scenemaChars: MAX_SCENEMA_CHARS, seedChars: MAX_SEED_CHARS, scriptsPerDay: SCRIPT_DAILY_CAP },
  });
});

module.exports = router;
module.exports.MOODS = MOODS;
module.exports._internals = { checkScenema, checkSeed, estimateFor, splitScriptAndReadback, wrapSpeak, sayEstimate, sanitizeScenema, sanitizeSeed, suggestEngine, looksLikeDescription, GUIDE };
