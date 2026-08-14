/**
 * KADE — CREATE A CHARACTER (Aug 14 2026, PART 52).
 *
 * Her brief, near-verbatim: "make some quiz options to help less creative
 * people make an agent... access for all, even those who don't know what AI
 * is really, and those who are very familiar. Make sure models are
 * explanatory choices, maybe even wire in where you can generate a profile
 * pic for your agent too in the builder. I'm talking native web etc."
 *
 * ONE FILE ON PURPOSE. The quiz brain, the model menu, the portrait
 * generator, and the guided web page all live here, exported as one API
 * router plus one page handler, mounted with two lines in index.js. Both
 * surfaces ride the SAME brain: the web page below consumes these routes,
 * and the native app's quiz screen (build 202) consumes the identical JSON —
 * so a question edited here changes everywhere, and native never drifts from
 * web the way the caller-memories fix once did.
 *
 * DESIGN RULES, hers:
 *  - Screen-reader flow is sacred. The page is one real <form> per step,
 *    real <fieldset>/<legend>, one aria-live region that narrates progress,
 *    zero visual-only affordances.
 *  - Free stuff first: the quiz composes personas with templates — zero
 *    model calls, zero cost, works offline-fast. The ONLY paid action is the
 *    portrait ($0.03), it says so on the button, and it draws from the same
 *    prepaid wallet everything else uses (admins exempt, per Stage A).
 *  - Experts lose nothing: every plain-language model choice carries its
 *    technical name behind a toggle, and the classic builder remains exactly
 *    where it always was.
 */

const express = require('express');
const https = require('https');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage, deductKadeCredits, fluxCost } = require('~/models/kadeUsage');
const { SHARED_HEAD } = require('./kadePages');

/* ────────────────────────────────────────────────────────────────────────────
 * THE MODEL MENU — models as choices a person can hear and pick between.
 * Slugs verified against the live fleet (Kiana herself runs OpenRouter /
 * moonshotai/kimi-k3). `everyoneNote` is the line the page reads out loud;
 * `expert` is what the "show technical names" toggle reveals.
 * ──────────────────────────────────────────────────────────────────────── */
const MODEL_MENU = [
  {
    key: 'all-rounder',
    plainName: 'The all-rounder',
    provider: 'OpenRouter',
    model: 'moonshotai/kimi-k3',
    blurb: 'Quick, warm, and steady, with a good memory for the conversation. This is what nearly every character on the platform runs.',
    goodFor: 'friends, companions, helpers, almost anything',
    speed: 'fast',
    default: true,
  },
  {
    key: 'deep-thinker',
    plainName: 'The deep thinker',
    provider: 'OpenRouter',
    model: 'deepseek/deepseek-v4-pro',
    blurb: 'Slower to answer, but writes long, careful, thorough replies. Likes a hard question.',
    goodFor: 'research buddies, essay lovers, planners',
    speed: 'take-your-time',
  },
  {
    key: 'chatterbox',
    plainName: 'The chatterbox',
    provider: 'OpenRouter',
    model: 'minimax/minimax-m3',
    blurb: 'Snappy and playful. Short fun replies, quick comebacks.',
    goodFor: 'banter, games, quick company',
    speed: 'very fast',
  },
  {
    key: 'speedster',
    plainName: 'The speedster',
    provider: 'OpenRouter',
    model: 'z-ai/glm-4.7-flash',
    blurb: 'The fastest answers on the shelf, a little lighter on nuance.',
    goodFor: 'utility helpers, list-makers, quick lookups',
    speed: 'instant-ish',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * THE QUIZ — eight questions, every one answerable by picking. Free-text is
 * always optional, never required: "less creative people" was the brief, and
 * a required blank box is exactly the cliff this page exists to remove.
 * ──────────────────────────────────────────────────────────────────────── */
const QUIZ = [
  {
    id: 'role',
    ask: 'Who is this character to you?',
    help: 'There are no wrong answers anywhere in this quiz. Pick whatever feels right.',
    options: [
      { v: 'friend', label: 'A friend to talk to' },
      { v: 'helper', label: 'A helper for getting things done' },
      { v: 'story', label: 'A character from a story world' },
      { v: 'elder', label: 'Somebody wise, like family' },
      { v: 'expert', label: 'An expert on one subject' },
    ],
  },
  {
    id: 'tone',
    ask: 'How do they talk?',
    options: [
      { v: 'warm', label: 'Warm and cozy' },
      { v: 'funny', label: 'Quick and funny' },
      { v: 'calm', label: 'Calm and wise' },
      { v: 'dramatic', label: 'Big dramatic energy' },
      { v: 'plain', label: 'Plain and practical' },
    ],
  },
  {
    id: 'length',
    ask: 'How long should their answers usually run?',
    options: [
      { v: 'short', label: 'Short and snappy' },
      { v: 'medium', label: 'A comfortable middle' },
      { v: 'long', label: 'Storyteller long' },
    ],
  },
  {
    id: 'loves',
    ask: 'Pick up to three things they love.',
    multi: true,
    max: 3,
    options: [
      { v: 'food', label: 'Food and cooking' },
      { v: 'music', label: 'Music' },
      { v: 'games', label: 'Games and puzzles' },
      { v: 'nature', label: 'Nature and animals' },
      { v: 'books', label: 'Books and stories' },
      { v: 'tech', label: 'Gadgets and how things work' },
      { v: 'faith', label: 'Faith and quiet reflection' },
      { v: 'sports', label: 'Sports' },
      { v: 'gossip', label: 'Neighborhood news and gossip' },
    ],
  },
  {
    id: 'never',
    ask: 'Pick anything they should NEVER do.',
    multi: true,
    max: 4,
    options: [
      { v: 'lecture', label: 'Lecture or preach' },
      { v: 'jargon', label: 'Use big complicated words' },
      { v: 'babytalk', label: 'Talk down to me' },
      { v: 'rush', label: 'Rush me' },
      { v: 'swear', label: 'Swear' },
      { v: 'gloom', label: 'Get gloomy' },
    ],
  },
  {
    id: 'species',
    ask: 'Are they human, or something else?',
    help: 'The marketplace has a talking skillet and a thunderstorm. Anything goes.',
    options: [
      { v: 'human', label: 'Human' },
      { v: 'animal', label: 'An animal' },
      { v: 'robot', label: 'A robot' },
      { v: 'magic', label: 'A magical being' },
      { v: 'object', label: 'An everyday object with a soul' },
    ],
  },
  {
    id: 'age',
    ask: 'What kind of energy do they carry?',
    options: [
      { v: 'young', label: 'Young spark' },
      { v: 'grown', label: 'Grown and steady' },
      { v: 'elder', label: 'Elder wisdom' },
    ],
  },
  {
    id: 'name',
    ask: 'Last one: their name.',
    help: 'Type one if you have it, or leave it blank and we will offer five that fit.',
    freeText: true,
  },
];

/* ── Name pools keyed by species×age. Small, warm, deliberately not exotic —
 * these are STARTING offers; the page always lets them type their own. ── */
const NAME_POOLS = {
  human: {
    young: ['Josie', 'Eli', 'Marisol', 'Theo', 'Winnie'],
    grown: ['Ruth', 'Marcus', 'Delia', 'Sam', 'Iris'],
    elder: ['Opal', 'Walter', 'Hattie', 'Gus', 'Pearl'],
  },
  animal: {
    young: ['Pip', 'Clover', 'Ziggy', 'Maple', 'Scout'],
    grown: ['Bramble', 'Juniper', 'Otis', 'Hazel', 'Rufus'],
    elder: ['Mosey', 'Willow', 'Barnaby', 'Sage', 'Duchess'],
  },
  robot: {
    young: ['Bolt', 'Pixel', 'Widget', 'Chirp', 'Dot'],
    grown: ['Cog', 'Vera-5', 'Sprocket', 'Relay', 'Axle'],
    elder: ['Tinman', 'Odometer', 'Vacuum Tube Vic', 'Analog Annie', 'Crank'],
  },
  magic: {
    young: ['Wisp', 'Ember', 'Fennel', 'Twyla', 'Nix'],
    grown: ['Seraphel', 'Rowan', 'Isolde', 'Thorne', 'Lyra'],
    elder: ['Grimsby', 'Morwenna', 'Aldous', 'Hecuba', 'Fenwick'],
  },
  object: {
    young: ['Zipper', 'Spoons', 'Doodle', 'Whistle', 'Buttons'],
    grown: ['Kettle', 'Compass', 'Lantern', 'Fiddle', 'Anchor'],
    elder: ['Mantel', 'Grandfather Clock', 'Quilt', 'Rocking Chair Rae', 'Hymnal'],
  },
};

const TONE_VOICE = {
  warm: 'You talk like a warm kitchen feels. Gentle teasing, easy laughter, real interest in how the person is actually doing.',
  funny: 'You are quick with a joke and quicker with a comeback, but never at the expense of the person you are talking to.',
  calm: 'You speak slowly and choose words with care. Silence does not scare you. People leave conversations with you feeling steadier.',
  dramatic: 'Every conversation is a small stage and you are delighted to be on it. Big feelings, big declarations, all heart underneath.',
  plain: 'You say things straight, in short plain sentences. No fuss, no flowery talk. People trust you because you never dress things up.',
};

const LENGTH_RULE = {
  short: 'Keep replies short — a few sentences, like texting a friend. One question at most per reply.',
  medium: 'Keep replies a comfortable middle length — a paragraph or two, conversational.',
  long: 'You are welcome to stretch out and tell it like a story when the moment invites it — but read the room and go short when they do.',
};

const LOVE_LINES = {
  food: 'Food is love made edible; you have opinions about cast iron and you share recipes like secrets.',
  music: 'Music runs under everything you say — you connect songs to moments and hum while you think.',
  games: 'You love games and puzzles of every kind, and you are a gracious winner and a worse loser, and you know it.',
  nature: 'You notice weather, birds, and the turn of seasons, and you bring the outdoors into conversation like fresh air.',
  books: 'You are a reader. You recommend stories the way doctors prescribe, and you never spoil endings.',
  tech: 'You like knowing how things work and explaining it so it clicks, without ever making anyone feel small.',
  faith: 'You carry a quiet steady faith and offer comfort without preaching — presence over sermons.',
  sports: 'You follow the games, hold grudges about old seasons, and believe in the underdog every single time.',
  gossip: 'You keep up with the neighborhood better than the newspaper and share news with relish but never cruelty.',
};

const NEVER_LINES = {
  lecture: 'Never lecture or preach. Offer, do not push.',
  jargon: 'Never use complicated words when plain ones work. If a technical term is truly needed, explain it in the same breath.',
  babytalk: 'Never talk down to anyone. Simple is respectful; simplified is not.',
  rush: 'Never rush anyone. Let people finish. Sit with them at their pace.',
  swear: 'Never swear.',
  gloom: 'Never wallow. You can be honest about hard things, but you always leave a light on.',
};

const SPECIES_FLAVOR = {
  human: '',
  animal: 'You are an animal, and you lean into it — your senses, your habits, your view from down here (or up there) color everything.',
  robot: 'You are a robot and comfortable saying so — you find humans fascinating, occasionally baffling, and worth the study.',
  magic: 'You are a magical being. You carry old knowledge lightly and let wonder into ordinary moments.',
  object: 'You are an everyday object with a soul, and your whole view of life comes from what you were made to do.',
};

const ROLE_OPENERS = {
  friend: 'You are a friend first. Not an assistant, not a service — company.',
  helper: 'You are a practical helper. You like finishing things and you keep track of what was started.',
  story: 'You are a character from a story world, and you stay in it — the world is real to you.',
  elder: 'You are the family-elder kind of presence: steady, a little wry, generous with hard-won sense.',
  expert: 'You know one field deeply and you love sharing it at whatever level the person needs.',
};

function pickNames(species, age) {
  const pool = (NAME_POOLS[species] || NAME_POOLS.human)[age] || NAME_POOLS.human.grown;
  return pool.slice(0, 5);
}

/**
 * The composer. Deterministic, template-built, zero model calls — a first
 * draft the person can edit, not a slot machine. Persona conventions honored:
 * plain prose, no honesty-floor language (her standing veto), nothing about
 * being "an AI language model" (the platform's characters simply are who
 * they are).
 */
function compose(answers) {
  const a = {
    role: 'friend', tone: 'warm', length: 'medium', loves: [], never: [],
    species: 'human', age: 'grown', name: '',
    ...answers,
  };
  const names = a.name && a.name.trim() ? [a.name.trim()] : pickNames(a.species, a.age);
  const loveText = (a.loves || []).map((l) => LOVE_LINES[l]).filter(Boolean).join(' ');
  const neverText = (a.never || []).map((n) => NEVER_LINES[n]).filter(Boolean).join(' ');
  const paragraphs = [
    `${ROLE_OPENERS[a.role] || ROLE_OPENERS.friend} ${SPECIES_FLAVOR[a.species] || ''}`.trim(),
    TONE_VOICE[a.tone] || TONE_VOICE.warm,
    loveText,
    LENGTH_RULE[a.length] || LENGTH_RULE.medium,
    neverText,
    'Remember what people tell you and bring it back later — it is the difference between talking AT someone and knowing them. When someone seems low, care about the person before the problem.',
  ].filter(Boolean);

  const menuPick = a.tone === 'funny' ? 'chatterbox' : a.role === 'expert' ? 'deep-thinker' : 'all-rounder';
  const modelEntry = MODEL_MENU.find((m) => m.key === menuPick) || MODEL_MENU[0];

  const ageWord = { young: 'young', grown: '', elder: 'elderly' }[a.age] || '';
  const speciesWord = {
    human: `${ageWord} person`.trim(),
    animal: `${ageWord} animal character`.trim(),
    robot: 'friendly robot',
    magic: 'magical being',
    object: 'everyday object with a gentle face and a soul',
  }[a.species];
  const toneWord = { warm: 'warm and kind', funny: 'playful and grinning', calm: 'serene', dramatic: 'theatrical and expressive', plain: 'sensible and steady' }[a.tone];
  const propWord = (a.loves || [])[0] ? {
    food: 'with a wooden spoon or a fresh pie', music: 'with headphones or a small instrument',
    games: 'with dice or playing cards', nature: 'with leaves or a small bird nearby',
    books: 'holding a well-loved book', tech: 'with tiny tools or gadgets',
    faith: 'in soft golden light', sports: 'with a worn team cap', gossip: 'mid-story, hand half-raised',
  }[(a.loves || [])[0]] : '';

  const avatarPrompt =
    `A ${toneWord} ${speciesWord} ${propWord}. Warm friendly character portrait avatar, ` +
    'stylized 3D animation illustration style, chest-up bust, centered composition, soft studio key lighting, ' +
    'simple clean solid-color background, rich saturated color, high detail, characterful expression, square, ' +
    'no text, no words, no watermark, no border.';

  const starters = {
    friend: ["How's your day actually going?", 'Tell me something good that happened this week.', 'I was just thinking about you. What are you up to?'],
    helper: ['What are we knocking out today?', "What's been sitting on your list too long?", 'Want me to help you plan something?'],
    story: ['Come in, come in — you made it.', 'You look like someone with a question.', 'Shall I tell you what happened here yesterday?'],
    elder: ['Sit down, honey. What`s on your mind?', 'You eating enough? Tell me the truth.', 'I was about to make coffee. Talk to me.'],
    expert: ['What are you curious about today?', 'Ask me anything — start anywhere.', 'What should we dig into?'],
  }[a.role];

  return {
    names,
    description: buildDescription(a),
    instructions: paragraphs.join('\n\n'),
    category: a.role === 'story' ? 'roleplay' : a.role === 'helper' ? 'productivity' : a.role === 'expert' ? 'education' : 'friends',
    conversation_starters: starters,
    modelKey: modelEntry.key,
    provider: modelEntry.provider,
    model: modelEntry.model,
    avatarPrompt,
  };
}

function buildDescription(a) {
  const bits = [];
  if (a.species !== 'human') {
    bits.push({ animal: 'An animal friend', robot: 'A friendly robot', magic: 'A magical being', object: 'An everyday object with a soul' }[a.species]);
  } else {
    bits.push({ young: 'A young spark', grown: 'A steady presence', elder: 'An old soul' }[a.age] || 'A steady presence');
  }
  bits.push({ warm: 'warm as a kitchen', funny: 'quick with a joke', calm: 'calm as still water', dramatic: 'with big stage energy', plain: 'plain-spoken and true' }[a.tone]);
  const l = (a.loves || [])[0];
  if (l) bits.push(`who loves ${{ food: 'good food', music: 'music', games: 'a good game', nature: 'the outdoors', books: 'books', tech: 'knowing how things work', faith: 'quiet reflection', sports: 'game day', gossip: 'the neighborhood news' }[l]}`);
  return bits.join(', ') + '.';
}

/* ────────────────────────────────────────────────────────────────────────────
 * PORTRAIT GENERATION — the one paid action. $0.03 via BFL FLUX.2, charged to
 * the same prepaid wallet as everything else (admins exempt inside
 * deductKadeCredits). Daily cap is in-memory and resets on redeploy — that is
 * a cap on accidents and mischief, not accounting, and the wallet is the real
 * ledger underneath it either way.
 * ──────────────────────────────────────────────────────────────────────── */
const GEN_DAILY_CAP = Number(process.env.KADE_AVATAR_GEN_DAILY_CAP || 8);
let genDayStamp = '';
const genCounts = new Map();
const FLUX_ENDPOINT = '/v1/flux-2-pro-preview';

function httpsReq(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers, family: 4, timeout: 45000 },
      (resp) => {
        if (resp.statusCode >= 301 && resp.statusCode <= 308 && resp.headers.location) {
          resp.resume();
          return httpsReq(resp.headers.location, { headers: { Accept: '*/*' } }).then(resolve, reject);
        }
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, buf: Buffer.concat(chunks) }));
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (err) => reject(new Error(`${err.code || err.message} @ ${u.hostname}`)));
    if (body) r.write(body);
    r.end();
  });
}

const router = express.Router();
router.use(requireJwtAuth);

router.get('/model-menu', (req, res) => {
  res.json({ menu: MODEL_MENU });
});

router.get('/quiz', (req, res) => {
  res.json({ quiz: QUIZ });
});

router.post('/quiz/compose', express.json({ limit: '32kb' }), (req, res) => {
  try {
    res.json({ ok: true, draft: compose(req.body && req.body.answers ? req.body.answers : {}) });
  } catch (e) {
    logger.warn(`[kadeBuilder] compose failed: ${e.message}`);
    res.status(400).json({ error: 'Could not build a draft from those answers.' });
  }
});

router.post('/avatar', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const key = process.env.FLUX_API_KEY || '';
    if (!key) return res.status(503).json({ error: 'Picture-making is not configured right now.' });
    const prompt = String((req.body && req.body.prompt) || '').slice(0, 2400);
    if (prompt.length < 8) return res.status(400).json({ error: 'A short description is needed first.' });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    if (genDayStamp !== today) { genDayStamp = today; genCounts.clear(); }
    const used = genCounts.get(req.user.id) || 0;
    if (used >= GEN_DAILY_CAP) {
      return res.status(429).json({ error: `That's ${GEN_DAILY_CAP} portraits today — the easel reopens tomorrow.` });
    }

    const bflBase = process.env.FLUX_API_BASE_URL || 'https://api.bfl.ai';
    const submit = await httpsReq(`${bflBase}${FLUX_ENDPOINT}`, {
      method: 'POST',
      headers: { 'x-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ prompt, width: 1024, height: 1024, safety_tolerance: 2, output_format: 'png' }),
    });
    const task = (() => { try { return JSON.parse(submit.buf.toString('utf8')); } catch (_) { return {}; } })();
    if (submit.status !== 200 || !task.id) {
      logger.warn(`[kadeBuilder] bfl submit ${submit.status}`);
      return res.status(502).json({ error: 'The picture engine is having a moment. Try again shortly.' });
    }
    const pollUrl = task.polling_url || `${bflBase}/v1/get_result?id=${task.id}`;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pr = await httpsReq(pollUrl, { headers: { 'x-key': key, Accept: 'application/json' } });
      const pd = (() => { try { return JSON.parse(pr.buf.toString('utf8')); } catch (_) { return {}; } })();
      if (pd.status === 'Ready') {
        const img = await httpsReq(pd.result.sample);
        if (img.status !== 200 || !img.buf.length) {
          return res.status(502).json({ error: 'The picture finished but could not be fetched. Try again.' });
        }
        genCounts.set(req.user.id, used + 1);
        const cost = fluxCost(FLUX_ENDPOINT, 1);
        deductKadeCredits(req.user.id, cost).catch(() => {});
        logKadeUsage({ userId: req.user.id, service: 'flux', quantity: 1, unit: 'image', costUSD: cost, metadata: { via: 'character-builder' } }).catch(() => {});
        return res.json({ ok: true, image_b64: img.buf.toString('base64'), remainingToday: GEN_DAILY_CAP - used - 1 });
      }
      if (['Error', 'Content Moderated', 'Request Moderated', 'Task not found'].includes(pd.status)) {
        return res.status(502).json({ error: 'The picture engine declined that one. Adjust the description and try again.' });
      }
    }
    res.status(504).json({ error: 'The picture took too long. Try again.' });
  } catch (e) {
    logger.error(`[kadeBuilder] avatar gen failed: ${e.message}`);
    res.status(502).json({ error: 'The picture engine is unreachable right now.' });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE PAGE — /create-a-character. Server-rendered, SPA-free, aria-first.
 * Same auth pattern as every kade page: client JS refreshes a token off the
 * httpOnly cookie and calls the APIs directly, so the created character lands
 * on the signed-in person's own account with no impersonation anywhere.
 * ──────────────────────────────────────────────────────────────────────── */
const pageHtml = `<!doctype html><html lang="en"><head><title>Create a Character — Kade-AI</title>${SHARED_HEAD}
<style>
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.5rem; }
  fieldset { border: 1px solid #8884; border-radius: 12px; padding: 14px; margin: 0 0 14px; }
  legend { font-size: 1.15rem; font-weight: 600; padding: 0 6px; }
  .opt { display: block; margin: 10px 0; padding: 12px; border: 1px solid #8886; border-radius: 10px; font-size: 1.05rem; }
  .opt input { margin-right: 10px; transform: scale(1.3); }
  button { font-size: 1.05rem; padding: 12px 18px; border-radius: 10px; border: 1px solid #8886; cursor: pointer; }
  button.primary { font-weight: 700; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
  #live { position: absolute; left: -9999px; }
  img.portrait { width: 200px; height: 200px; border-radius: 16px; display: block; margin: 10px 0; }
  textarea, input[type=text] { width: 100%; font-size: 1.05rem; padding: 10px; border-radius: 8px; border: 1px solid #8886; }
  .help { opacity: .8; font-size: .95rem; }
  .modelcard { border: 1px solid #8885; border-radius: 10px; padding: 10px; margin: 8px 0; }
  .expert { font-family: monospace; font-size: .85rem; opacity: .75; display: none; }
  .show-expert .expert { display: block; }
</style></head><body><main>
<h1>Create a Character</h1>
<p class="help">Eight quick questions, no wrong answers, and a finished character at the end — picture and all. Nothing here needs you to know anything about AI.</p>
<div id="live" aria-live="polite"></div>
<div id="app"><p>Waking the quiz up…</p></div>
</main><script>
(function(){
  var TOKEN=null, QUIZ=[], MENU=[], step=0, answers={}, draft=null, portraitB64=null, pickedName=null;
  var app=document.getElementById('app'), live=document.getElementById('live');
  function say(t){ live.textContent=''; setTimeout(function(){ live.textContent=t; }, 60); }
  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token?j.token:null; }catch(e){ return null; } }
  async function api(path,opts){ opts=opts||{}; opts.headers=Object.assign({'Authorization':'Bearer '+TOKEN},opts.headers||{}); var r=await fetch(path,opts); if(!r.ok){ var t=await r.text(); throw new Error(t.slice(0,200)); } return r.json(); }

  function renderStep(){
    var q=QUIZ[step];
    if(!q){ return renderReview(); }
    var h='<form id="f"><fieldset><legend>Question '+(step+1)+' of '+QUIZ.length+': '+q.ask+'</legend>';
    if(q.help){ h+='<p class="help">'+q.help+'</p>'; }
    if(q.freeText){
      h+='<label class="opt">Their name (or leave blank for suggestions) <input type="text" name="ft" autocomplete="off"></label>';
    } else {
      (q.options||[]).forEach(function(o){
        h+='<label class="opt"><input type="'+(q.multi?'checkbox':'radio')+'" name="q" value="'+o.v+'">'+o.label+'</label>';
      });
    }
    h+='</fieldset><div class="row">'+(step>0?'<button type="button" id="back">Back</button>':'')+'<button class="primary" type="submit">'+(step===QUIZ.length-1?'Build my character':'Next')+'</button></div></form>';
    app.innerHTML=h;
    say('Question '+(step+1)+' of '+QUIZ.length+'. '+q.ask);
    var back=document.getElementById('back'); if(back){ back.onclick=function(){ step--; renderStep(); }; }
    document.getElementById('f').onsubmit=async function(ev){
      ev.preventDefault();
      if(q.freeText){ answers[q.id]=(new FormData(ev.target).get('ft')||'').trim(); }
      else if(q.multi){ var vs=[].slice.call(ev.target.querySelectorAll('input:checked')).map(function(i){return i.value;}); if(q.max) vs=vs.slice(0,q.max); answers[q.id]=vs; }
      else { var v=ev.target.querySelector('input:checked'); if(!v){ say('Pick one to keep going.'); return; } answers[q.id]=v.value; }
      step++;
      if(step>=QUIZ.length){
        say('Building the character…');
        var out=await api('/api/kade/builder/quiz/compose',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:answers})});
        draft=out.draft; pickedName=draft.names[0];
      }
      renderStep();
    };
  }

  function renderReview(){
    var h='<h2>Here they are</h2>';
    h+='<fieldset><legend>Name</legend>';
    draft.names.forEach(function(n,i){ h+='<label class="opt"><input type="radio" name="nm" value="'+n+'"'+(i===0?' checked':'')+'>'+n+'</label>'; });
    h+='<label class="opt">Or type another: <input type="text" id="customName"></label></fieldset>';
    h+='<fieldset><legend>One-line description</legend><textarea id="desc" rows="2">'+draft.description+'</textarea></fieldset>';
    h+='<fieldset><legend>Their personality (edit anything)</legend><textarea id="inst" rows="10">'+draft.instructions+'</textarea></fieldset>';
    h+='<fieldset id="menuBox"><legend>Their engine</legend><p class="help">This is the machinery that does their thinking. Plain choices — the technical names are behind the toggle for anyone who wants them.</p>';
    MENU.forEach(function(m){ h+='<label class="opt modelcard"><input type="radio" name="mm" value="'+m.key+'"'+(m.key===draft.modelKey?' checked':'')+'><strong>'+m.plainName+'</strong> — '+m.blurb+' <em>Good for: '+m.goodFor+'.</em><span class="expert">'+m.provider+' / '+m.model+'</span></label>'; });
    h+='<button type="button" id="expertBtn" aria-pressed="false">Show technical names</button></fieldset>';
    h+='<fieldset><legend>Their picture</legend><p class="help">One tap paints their portrait — it costs 3 cents of picture credit from the same allowance everything else uses. You can repaint or skip; you can also change it later in the regular builder.</p>';
    h+='<div id="portraitZone"><button type="button" id="paint" class="primary">Paint their portrait (3¢)</button></div></fieldset>';
    h+='<div class="row"><button type="button" id="back2">Back to questions</button><button type="button" id="create" class="primary">Bring them to life</button></div><p id="status" role="status"></p>';
    app.innerHTML=h;
    say('The character is drafted. Review the name, the personality, the engine, and the picture, then bring them to life.');
    document.getElementById('back2').onclick=function(){ step=QUIZ.length-1; renderStep(); };
    document.getElementById('expertBtn').onclick=function(){ var b=document.getElementById('menuBox'); var on=b.classList.toggle('show-expert'); this.setAttribute('aria-pressed',String(on)); this.textContent=on?'Hide technical names':'Show technical names'; };
    document.getElementById('paint').onclick=paint;
    document.getElementById('create').onclick=create;
  }

  async function paint(){
    var zone=document.getElementById('portraitZone');
    zone.innerHTML='<p role="status">Painting… this takes about fifteen seconds.</p>';
    say('Painting the portrait. About fifteen seconds.');
    try{
      var name=currentName();
      var out=await api('/api/kade/builder/avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'Character named '+name+'. '+draft.avatarPrompt})});
      portraitB64=out.image_b64;
      zone.innerHTML='<img class="portrait" alt="Their freshly painted portrait" src="data:image/png;base64,'+portraitB64+'"><div class="row"><button type="button" id="repaint">Paint a different one (3¢)</button></div><p class="help">'+(out.remainingToday)+' repaints left today.</p>';
      say('Portrait painted. There is a repaint button if you want a different one.');
      document.getElementById('repaint').onclick=paint;
    }catch(e){ zone.innerHTML='<p role="alert">'+(e.message||'That did not work.')+'</p><div class="row"><button type="button" id="paint2">Try again</button></div>'; document.getElementById('paint2').onclick=paint; }
  }

  function currentName(){ var c=document.getElementById('customName'); if(c&&c.value.trim()) return c.value.trim(); var r=document.querySelector('input[name=nm]:checked'); return r?r.value:draft.names[0]; }

  async function create(){
    var st=document.getElementById('status');
    st.textContent='Bringing them to life…'; say('Bringing them to life.');
    try{
      var mk=document.querySelector('input[name=mm]:checked'); var menu=MENU.find(function(m){return m.key===(mk?mk.value:draft.modelKey);})||MENU[0];
      var body={ name:currentName(), description:document.getElementById('desc').value.trim(), instructions:document.getElementById('inst').value.trim(), provider:menu.provider, model:menu.model, conversation_starters:draft.conversation_starters, category:draft.category, tools:[] };
      var agent=await api('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(portraitB64){
        st.textContent='Hanging their portrait…';
        var bin=atob(portraitB64), arr=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++){ arr[i]=bin.charCodeAt(i); }
        var fd=new FormData(); fd.append('file', new Blob([arr],{type:'image/png'}), 'portrait.png');
        await fetch('/api/files/images/agents/'+encodeURIComponent(agent.id)+'/avatar',{method:'POST',headers:{'Authorization':'Bearer '+TOKEN},body:fd});
      }
      app.innerHTML='<h2>'+body.name+' is alive.</h2><p>They are yours now — you will find them with your characters on the main site and in the app, and you can fine-tune anything about them in the regular builder any time.</p><div class="row"><a href="/" ><button class="primary" type="button">Go say hello</button></a><button type="button" id="again">Make another</button></div>';
      say(body.name+' is alive. Go say hello.');
      document.getElementById('again').onclick=function(){ step=0; answers={}; draft=null; portraitB64=null; renderStep(); };
    }catch(e){ st.textContent='That did not take: '+(e.message||'unknown error')+' — nothing was lost; try again.'; }
  }

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ app.innerHTML='<p>Sign in on the main site first, then come back here.</p>'; return; }
    try{
      var q=await api('/api/kade/builder/quiz'); QUIZ=q.quiz;
      var m=await api('/api/kade/builder/model-menu'); MENU=m.menu;
      renderStep();
    }catch(e){ app.innerHTML='<p>The quiz could not load. Try again in a minute.</p>'; }
  })();
})();
</script></body></html>`;

const createCharacterPage = (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(pageHtml);
};

module.exports = { router, createCharacterPage, MODEL_MENU, QUIZ, compose };
