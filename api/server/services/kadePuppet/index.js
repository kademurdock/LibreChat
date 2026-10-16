/**
 * KADE Oct 16 2026 — puppet bodies. The kit (./kit/*.mjs) compiles a body recipe into a
 * code-drawn, morphable vector scene that the web and iPhone renderers animate. This
 * module is the server's door to it: catalog, normalize, compile (cached), plain-words
 * description, the line a character is told about its own body, and the two paid
 * helpers that turn words or a portrait into a starting recipe.
 */
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { pathToFileURL } = require('url');
const { logger } = require('@librechat/data-schemas');

let kitPromise = null;
function kit() {
  if (!kitPromise) {
    kitPromise = import(pathToFileURL(path.join(__dirname, 'kit', 'recipe.mjs')).href);
  }
  return kitPromise;
}

const KIT_VERSION = '2026-10-16.2';
/* Scenes are cached as JSON text: 300 parsed scenes held about 82 MB of heap, the same
 * scenes as text about 25 MB (86 KB each on average, 16 KB gzipped on the wire). Only
 * saved bodies are cached; editor previews and surprises are drawn and sent once. */
const SCENE_CACHE_LIMIT = 200;
const sceneCache = new Map();

function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

async function catalog() {
  const k = await kit();
  return { schema: 1, kit: KIT_VERSION, catalog: k.buildCatalog(), defaults: k.normalizeRecipe({}) };
}

async function normalize(recipe) {
  const k = await kit();
  return k.normalizeRecipe(recipe);
}

async function describe(recipe) {
  const k = await kit();
  return k.describeRecipe(recipe);
}

/**
 * Compile a recipe into { recipe, description, sceneHash, sceneJson }; the scene travels as
 * JSON text (see sendWithScene in the route). Saved bodies are cached by recipe hash + kit
 * version; pass { cache: false } for one-off drawings.
 */
async function compile(recipe, { cache = true } = {}) {
  const k = await kit();
  const normalized = k.normalizeRecipe(recipe);
  const key = `${KIT_VERSION}:${hashOf(normalized)}`;
  const hit = sceneCache.get(key);
  if (hit) {
    sceneCache.delete(key);
    sceneCache.set(key, hit);
    return hit;
  }
  const { scene } = k.buildScene(normalized);
  scene.recipeHash = key.split(':')[1];
  scene.kit = KIT_VERSION;
  const out = {
    recipe: normalized,
    description: scene.description,
    sceneHash: key.replace(':', '-'),
    sceneJson: JSON.stringify(scene),
  };
  if (cache) {
    sceneCache.set(key, out);
    if (sceneCache.size > SCENE_CACHE_LIMIT) {
      sceneCache.delete(sceneCache.keys().next().value);
    }
  }
  return out;
}

async function random(seed, fantasy) {
  const k = await kit();
  return compile(k.randomRecipe(String(seed || Date.now()), { fantasy: !!fantasy }), { cache: false });
}

/* Characters with a hand-made animated face. Chat, calls and the iPhone keep showing that
 * face even when a body is saved, so the body note is skipped for them (they would describe
 * a puppet nobody sees) and the backfill leaves them alone. */
const HAND_PAINTED = new Set([
  'agent_6llV0eMu4fmIaj8f2x1Sb', // Kiana
  'agent_BSOLa3eNEZyjs-7abCjMt', // Della
  'agent_TOdYS8v-bRxeNw0dia_Md', // Lilly (public)
  'agent_JhouuajXMYsfhCTVMQCv_', // Lilly (Skylee's)
  'agent_d26Mtu8mgOzkVGQECqO1a', // Harley
  'agent_o7TKU3lK0Euo0MKgpNpvZ', // Witherspoon
  'agent_NkG_Fb8_xLz8HFJyx4gNv', // Angel
]);

/* ---------- the character's own sense of its body ---------- */
const BODY_NOTE_TTL_MS = 60 * 1000;
const noteCache = new Map();

function bodyNoteText(description) {
  const d = String(description || '').trim();
  if (!d) {
    return '';
  }
  return (
    'YOUR LOOK ON SCREEN: the people you talk with can see you as an animated puppet that ' +
    `moves while you talk. This is how you look right now: ${d} ` +
    'If someone asks what you look like, answer from this. Mention it only when it comes up naturally.'
  );
}

/** The note for one agent, or '' when it has no body or the note is switched off. */
async function bodyNoteFor(agentId) {
  if (process.env.KADE_BODY_NOTE === '0' || !agentId || HAND_PAINTED.has(String(agentId))) {
    return '';
  }
  const id = String(agentId);
  const hit = noteCache.get(id);
  if (hit && Date.now() - hit.at < BODY_NOTE_TTL_MS) {
    return hit.text;
  }
  let text = '';
  try {
    const { getAgentBody } = require('~/models/kadeAgentBody');
    const body = await getAgentBody(id);
    if (body && body.recipe) {
      text = bodyNoteText(body.description || (await describe(body.recipe)));
    }
  } catch (e) {
    logger.warn(`[kadePuppet] body note for ${id} failed: ${e.message}`);
  }
  noteCache.set(id, { text, at: Date.now() });
  return text;
}

function forgetBodyNote(agentId) {
  noteCache.delete(String(agentId));
}

/* ---------- words or a picture -> a starting recipe (paid, small) ---------- */
const MODEL = () => process.env.KADE_BODY_MODEL || 'xiaomi/mimo-v2.6-flash';
const PRICE_IN = () => Number(process.env.KADE_BODY_IN_USD_PER_M || 0.14);
const PRICE_OUT = () => Number(process.env.KADE_BODY_OUT_USD_PER_M || 0.28);

function choicesText(cat) {
  const lines = [];
  for (const section of cat.sections) {
    for (const c of section.controls) {
      if (c.kind === 'slider') {
        lines.push(`${c.path}: number 0..1 (${c.ends[0]} .. ${c.ends[1]})`);
      } else if (c.kind === 'accessory') {
        lines.push(`accessories (${c.name}, at most one): ${c.options.filter((o) => o.id).map((o) => o.id).join(', ')}`);
      } else {
        lines.push(`${c.path}: ${c.options.map((o) => o.id).join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}

const SYSTEM = (cat) =>
  'You design a cartoon puppet body (head and shoulders) for a character on a family AI platform. ' +
  'Choose parts ONLY from these options. Reply with one JSON object shaped like ' +
  '{"head":{"shape","width","length"},"skin":{"tone","blush"},"eyes":{"shape","size","spacing","color","lashes"},' +
  '"brows":{"shape","thickness","color"},"nose":{"shape","size"},"mouth":{"shape","width","fullness","color"},' +
  '"ears":{"shape"},"hair":{"style","color"},"facialHair":{"style","color"},"marks":{"style"},"body":{"build"},' +
  '"outfit":{"top","color","accent","pattern"},"accessories":[ids],"motion":{"energy","expressiveness","blink"},"backdrop"}. ' +
  'Fill every field. Match what you are told or shown; where nothing is said, choose what fits the character. ' +
  'Never copy a real person, a celebrity or a brand.\nOPTIONS:\n' +
  choicesText(cat);

function parseJson(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

async function askModel(userContent, { maxTokens = 900 } = {}) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    const err = new Error('Body design is not configured right now.');
    err.status = 503;
    throw err;
  }
  const k = await kit();
  const cat = k.buildCatalog();
  const started = Date.now();
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL(),
      max_tokens: maxTokens,
      temperature: 0.7,
      reasoning: { enabled: false },
      usage: { include: true },
      response_format: { type: 'json_object' },
      /* Portraits and character descriptions are family data: keep Kade's
       * zero-data-retention rule, as every fleet model does in reframe. */
      provider: { zdr: true, data_collection: 'deny', allow_fallbacks: true },
      messages: [
        { role: 'system', content: SYSTEM(cat) },
        { role: 'user', content: userContent },
      ],
    },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 60000 },
  );
  const usage = (r.data && r.data.usage) || {};
  const raw = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
    ? r.data.choices[0].message.content
    : '';
  const inTok = Number(usage.prompt_tokens || 0);
  const outTok = Number(usage.completion_tokens || 0);
  const reported = Number(usage.cost);
  const costUSD = Number.isFinite(reported) && reported > 0 ? reported : (inTok * PRICE_IN() + outTok * PRICE_OUT()) / 1e6;
  const parsed = parseJson(raw);
  if (!parsed) {
    const err = new Error('The designer came back with nothing usable. Try again.');
    err.status = 502;
    err.costUSD = costUSD;
    throw err;
  }
  return { recipe: k.normalizeRecipe(parsed), costUSD, inTok, outTok, ms: Date.now() - started };
}

/** Turn a person's words ("a tall cowboy with a gray handlebar mustache") into a recipe. */
async function recipeFromWords(words, base) {
  const text = String(words || '').trim().slice(0, 1500);
  const baseLine = base ? `\nCurrent body (change only what the words ask for): ${JSON.stringify(base)}` : '';
  return askModel(`Design this body: ${text}${baseLine}`);
}

/** Turn a portrait image URL (the agent's avatar) into a resembling recipe. */
async function recipeFromPicture(imageUrl, hint) {
  const content = [
    {
      type: 'text',
      text:
        'Design a puppet body that resembles the character in this portrait: face shape, skin, eyes, ' +
        'hair, facial hair, clothes, glasses and other accessories, and any fantasy features.' +
        (hint ? ` The character: ${String(hint).slice(0, 600)}` : ''),
    },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];
  return askModel(content);
}

module.exports = {
  KIT_VERSION,
  HAND_PAINTED,
  kit,
  catalog,
  normalize,
  describe,
  compile,
  random,
  bodyNoteText,
  bodyNoteFor,
  forgetBodyNote,
  recipeFromWords,
  recipeFromPicture,
};
