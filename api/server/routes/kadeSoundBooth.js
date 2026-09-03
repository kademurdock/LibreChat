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

/** Spoken words -> rough seconds of audio. 2.6 words/second is the bridge's
 * own constant, kept identical here so the two estimates agree. */
function spokenSeconds(script) {
  const words = String(script || '')
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

const SCENEMA_GRAMMAR = `SCENEMA AUDIO SCRIPT FORMAT (this is the only format you may output):

<speak voice="a sentence describing WHO is speaking" gender="male|female" scene="optional place" shot="closeup|wide|scene" pace="1.0">
The spoken words go as plain text, one paragraph per beat.
<action>what the speaker is DOING and FEELING right here</action>
More spoken words.
<sound>an environment sound, only if a scene was asked for</sound>
</speak>

HARD RULES:
- <action> is a note to a human actor. It says what the person is DOING and FEELING ("her voice catches", "he turns away from the window", "she is trying not to laugh"). It NEVER describes the audio ("make it echo", "add reverb", "louder", "speed up") -- that is not what this control is for and it degrades the take.
- Everything not inside a tag is SPOKEN ALOUD. Never put narration, headings, labels, speaker names, stage notes or markdown outside a tag.
- One voice only. This engine performs a single speaker. Never write two characters.
- No music. This engine has no music.
- The voice= attribute is the primary identity control: age, sex, build, accent, texture, and manner, in one sentence.
- NEVER use %%%…%%% markers. That is a different engine's syntax; this one would read it out loud. Directions go in <action> tags and nowhere else.
- Never leave a cue in parentheses or square brackets on its own line. Convert it to an <action>.
- Output the XML and nothing else. No code fence, no preamble, no explanation.`;

const SEED_GRAMMAR = `SEED AUDIO 1.0 SCRIPT FORMAT (this is the only format you may output):

[genre / environment / mood — one bracketed line that sets the whole scene]
[a continuous sound bed, e.g. rain on a tin roof, low room tone]
Name (voice traits, emotion, pace) says: "the dialogue."
[a concrete sound effect, e.g. a screen door slaps shut]
Other Name (voice traits, emotion, pace) says: "the reply."

HARD RULES:
- Every spoken line uses the exact shape: Name (traits, emotion, pace) says: "words."
- Sound effects, music cues and ambience go in [square brackets] on their own line, described concretely -- a thing that happens, not an adjective.
- Up to three named voices. Music and effects are allowed and encouraged; this engine mixes a whole scene in one pass.
- Keep the whole script under 1900 characters. It is a hard engine cap, not a style note.
- Output the script and nothing else. No code fence, no preamble, no explanation.`;

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
  if (s.length > MAX_SEED_CHARS) {
    return `That script is ${s.length} characters; Seed Audio tops out at ${MAX_SEED_CHARS} (about two minutes). Shorten it, or render it in parts.`;
  }
  return null;
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
  }
  const problem = engine === 'seed' ? checkSeed(script) : checkScenema(script);
  if (problem) return res.status(400).json({ error: problem });

  let project = null;
  try {
    const opts = {};
    if (typeof b.reference_voice_url === 'string' && /^https?:\/\/\S+$/i.test(b.reference_voice_url)) {
      opts.reference_voice_url = b.reference_voice_url.slice(0, 2048);
    }
    if (b.background_sfx === true) opts.background_sfx = true;
    if (Number.isInteger(b.seed) && b.seed >= 0) opts.seed = b.seed;
    if (typeof b.pace === 'number' && b.pace >= 0.5 && b.pace <= 3) opts.pace = b.pace;
    if (b.keep_wav === true) opts.keep_wav = true;
    if (b.audio_quality === 'high') opts.audio_quality = 'high';
    if (typeof b.speed === 'number' && b.speed >= 0.5 && b.speed <= 2) opts.speed = b.speed;
    if (b.voice_description) opts.voice_description = String(b.voice_description).slice(0, 600);

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
        r = await axios.post(
          `${bridgeBase()}/audio/scenema/start`,
          {
            secret,
            userId: String(req.user.id),
            agentId: 'soundbooth',
            agentName: 'Sound Booth',
            prompt: script,
            ...opts,
          },
          { headers: { 'User-Agent': UA }, timeout: 20000 },
        );
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
      const est = estimateFor('scenema', script);
      const bridgeEst = r.data?.estimate || {};
      const merged = {
        ...est,
        audioSeconds: bridgeEst.audioSeconds || est.audioSeconds,
        renderSeconds: bridgeEst.renderSeconds || est.renderSeconds,
        costUSD: typeof bridgeEst.costUSD === 'number' ? bridgeEst.costUSD : est.costUSD,
      };
      merged.spoken = sayEstimate(merged.audioSeconds, merged.renderSeconds, merged.costUSD, true);
      logger.info(`[soundbooth/render] scenema queued job=${jobId} project=${project._id} user=${req.user.id}`);
      return res.json({
        ok: true,
        engine: 'scenema',
        queued: true,
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
    if (typeof b.pitch === 'number' && b.pitch >= -12 && b.pitch <= 12) body.pitch = Math.round(b.pitch);
    if (opts.reference_voice_url) body.audio_urls = [opts.reference_voice_url];
    else if (typeof b.voice === 'string' && b.voice.trim()) body.voice = b.voice.trim().slice(0, 64);

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
router.get('/health', requireJwtAuth, async (_req, res) => {
  return res.json({
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
module.exports._internals = { checkScenema, checkSeed, estimateFor, splitScriptAndReadback, wrapSpeak, sayEstimate, sanitizeScenema };
