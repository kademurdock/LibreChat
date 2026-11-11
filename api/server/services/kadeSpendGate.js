'use strict';
/**
 * KADE SPEND GATE (Nov 10 2026): a paid start needs a price heard in an EARLIER reply and the
 * person's own plain yes in their latest message.
 *
 * Why: the Nov 10 money review found two live holes. kade_task start checked only that a quote
 * row existed, so a character could quote and start in one reply and the person never heard a
 * price. The fal song tool spent 8 or 15 cents real with only a budget check, and a looping
 * reply could call it several times. Code decides here, never the character.
 *
 * The rules this file gives both tools (services/kadeTasks.js and tools/structured/FalAI.js):
 *   - a TURN is one request. The request object is the key (the agents runtime builds the tools
 *     again for every round of tool calls, so state is never kept on a tool instance);
 *   - a quote made in this turn cannot be used in this turn;
 *   - the yes is read from the person's own latest message only. On the voice lane the request
 *     text is the folded call history (the voice proxy's composeTextWithHistory), so only what
 *     follows its closing sentence is read. When that cannot be isolated, the answer is no;
 *   - the message must BE the yes. "ok, read this page for me" is not a yes to a price: every
 *     word has to be a yes word, a filler word or a word about the thing being paid for. A page,
 *     a document or a tool result is never read here at all;
 *   - one paid start per turn, claimed before anything is awaited.
 *
 * Added the same day, after review (the first cut proved a price row existed, not that the
 * person had heard it, and let any later yes claim it):
 *   - the price must have been SAID. When a reply ends, the prices worked out during it are
 *     stamped with whether the reply's own words carried a money amount (afterReply). A price
 *     that was never said cannot be claimed; the character is told to say it and ask again;
 *   - the yes must answer the price. When a later message in the conversation is not a plain
 *     yes, the open prices there are closed, so "sure" to some other question twenty minutes
 *     on finds nothing to buy;
 *   - a retry is not a yes. A regenerated or continued reply sends the same old message
 *     again, so it can never approve a price.
 *
 * No model call and no wait: string checks and, for a song, one or two small database calls
 * inside a tool call that was about to spend money anyway.
 *
 * Off switches (default on, "=0" turns one off):
 *   KADE_TASK_YES_GATE=0        kade_task start goes back to "a quote row is enough"
 *   KADE_TASK_ATOMIC_START=0    kade_task start goes back to read, check, then mark
 *   KADE_SONG_YES_GATE=0        fal generate_song goes back to the budget check only
 *   KADE_SONG_ONCE_PER_TURN=0   no limit on songs per reply
 *   KADE_SPEND_PRICE_HEARD=0    a price row is enough again: it need not have been said in a
 *                               reply, and it stays open for its hour whatever is said next
 *   KADE_SPEND_NO_REPLAY=0      a regenerated or continued reply may approve a price again
 *
 * No '~' requires at load time, so node --test loads it.
 */

const crypto = require('crypto');

const SONG_QUOTES = 'kadesongquotes';
const SONG_QUOTE_MINUTES = 60;

function on(name, env = process.env) {
  return String((env && env[name]) ?? '') !== '0';
}

/* ---------------------------------------------------------------- the turn */

const turns = new WeakMap();

function turnOf(req) {
  if (!req || typeof req !== 'object') return null;
  let t = turns.get(req);
  if (!t) {
    t = { id: crypto.randomBytes(8).toString('hex'), claims: new Set(), quoted: new Set() };
    turns.set(req, t);
  }
  return t;
}

/** An id for this request, the same for every tool call in the turn; null without a request. */
function turnId(req) {
  const t = turnOf(req);
  return t ? t.id : null;
}

/** True the first time a turn asks for `key`; false after that, and false without a request. */
function claimOnce(req, key) {
  const t = turnOf(req);
  if (!t || t.claims.has(key)) return false;
  t.claims.add(key);
  return true;
}

function releaseOnce(req, key) {
  const t = turnOf(req);
  if (t) t.claims.delete(key);
}

/** Remember that this turn worked out a price kept in collection `name` (see afterReply). */
function markQuoted(req, name) {
  const t = turnOf(req);
  if (t && name) t.quoted.add(String(name));
}

/** A regenerated, continued or edited-and-continued reply: the person's message is an old one sent again. */
function isReplay(req) {
  const b = (req && req.body) || {};
  return Boolean(b.isRegenerate) || Boolean(b.isContinued) || Boolean(b.editedContent) || Boolean(b.isEdited);
}

/** The conversation this turn belongs to, or null when it has no settled id. */
function conversationOf(req) {
  const id = req && req.body && req.body.conversationId;
  if (typeof id !== 'string' || !id || id === 'new') return null;
  return id;
}

/** The voice and phone lane: the bridge names who is on the line (Kade included). */
function isVoiceLane(req) {
  if (!req) return false;
  return Boolean(req.kadeOnBehalfOf || req.kadeOnBehalfOfUnresolved === true || (req.body && req.body.kadeOnBehalfOf));
}

/* ------------------------------------------------- the person's latest words */

const FOLD_OPEN = '[earlier in this conversation';
const FOLD_CLOSE = 'reply only to what follows.]';

/**
 * The person's own latest message. A voice turn's text is the folded history followed by the
 * last caller utterance; only the part after the LAST closing sentence is returned, and only
 * when the fold is whole (it opens the text, it closes, and no "YOU:" or "THEM:" line follows).
 * @param {unknown} text req.body.text
 * @returns {{ ok: boolean, folded: boolean, words: string }}
 */
function latestWords(text) {
  const raw = typeof text === 'string' ? text : '';
  const low = raw.toLowerCase();
  const open = low.indexOf(FOLD_OPEN);
  const close = low.lastIndexOf(FOLD_CLOSE);
  if (open < 0 && close < 0) return { ok: raw.trim().length > 0, folded: false, words: raw.trim() };
  if (open < 0 || close < 0 || close < open || raw.slice(0, open).trim() !== '') {
    return { ok: false, folded: true, words: '' };
  }
  const tail = raw.slice(close + FOLD_CLOSE.length).trim();
  if (!tail || /^\s*(?:YOU|THEM)\s*:/m.test(tail)) return { ok: false, folded: true, words: '' };
  return { ok: true, folded: true, words: tail };
}

/* ------------------------------------------------------------- the plain yes */

/* Words a yes can be made of. Nothing here names a new job: no "read", "find", "look", "call". */
const NUMBER_WORDS =
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen ' +
  'twenty thirty forty fifty sixty seventy eighty ninety hundred half couple few';
const YES_WORDS = new Set(
  (
    NUMBER_WORDS +
    " i'd id proceed agree agreed confirm confirmed charge afford huh mhm mm hmm mmhmm ma'am maam sir right correct " +
    'hell heck guess honey dear darling sweetie hon bucks buck penny pennies ' +
    'yes yeah yep yup yea ya aye ok okay kay k sure alright all right absolutely definitely certainly totally ' +
    'of course for please pls thanks thank you ty go ahead it do that this the a an and then now just so ' +
    "let's lets let us start begin run make send ship approve approved approves i i'm im am i'll we you can me my " +
    "is it's its that's thats fine good great perfect cool sounds works work with to pay price cost one on up " +
    'oh uh um well hey really very much be would like want love happy glad ready worth deal sold thing ' +
    'cent cents dollar dollars about under'
  ).split(' '),
);

/* Said next to a yes, these are not a hold-on. Taken out before the hold-on check. */
const SOFT_NO = /\b(?:no problem|no worries|not a problem|don't worry|do not worry)\b/g;

const EXTRA_YES = /\b(?:sounds good|that's fine|that is fine|that works|works for me|please do|absolutely|definitely|of course|for sure|alright|all right|yes please)\b/;

/* Review fix: people who dictate say yes in more ways than the Forge reading knows. Each of
 * these, when the WHOLE message is still only yes words, is a yes: "fine", "right", "uh huh",
 * "mhm", "proceed", "I agree", "I confirm", "make it", "I want it", "please", "why not". */
const WHY_NOT = /\bwhy not\b/g;
const SPOKEN_YES =
  /^[^a-z0-9]*(?:fine|right|correct|please|proceed)\b|\b(?:i agree|agreed|i confirm|confirmed|uh huh|mhm|mm ?hmm|mmhmm|charge me|(?:make|start|do|send|run|create|generate|write|sing|play) (?:it|that|this|one)|i(?:'d| would)? (?:want|like|love) (?:it|that|this|one)|i can afford (?:it|that))\b/;

const TASK_TOPIC = ['job', 'task', 'search', 'research', 'work'];
/* A song is made, written, sung and played; said next to a yes these are about the song. */
const SONG_TOPIC = ['song', 'track', 'music', 'tune', 'create', 'generate', 'write', 'sing', 'play'];

/**
 * Is this message, as a whole, a yes to a price? Reuses the Forge approval reading
 * (kadeApprovals.herWordsApprove: a yes phrase, and any hold-on word wins), then asks more:
 * short, no link, and no word that is not a yes word, a filler, the character's own name or a
 * word for the thing being bought.
 * @param {string} words the person's own latest message (see latestWords)
 * @param {{ names?: Array<string | undefined | null>, topic?: string[] }} [opts]
 */
function approvesPrice(words, opts = {}) {
  const t = String(words || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .trim();
  if (!t || t.length > 160) return false;
  if (/https?:|www\.|\n\s*\n/.test(t)) return false;
  /* "uh-huh" and "mm-hmm" are read as two words; "why not" is a yes, not a hold-on. */
  const spoken = t.replace(SOFT_NO, ' ').replace(/(?<=[a-z])-(?=[a-z])/g, ' ');
  const whyNot = WHY_NOT.test(spoken);
  WHY_NOT.lastIndex = 0;
  const soft = spoken.replace(WHY_NOT, ' ');
  const { herWordsApprove } = require('./kadeApprovals');
  /* "yes " in front asks only the hold-on question; the yes itself must be in their words. */
  if (!herWordsApprove(`yes ${soft}`)) return false;
  if (!herWordsApprove(soft) && !EXTRA_YES.test(soft) && !SPOKEN_YES.test(soft) && !whyNot) return false;
  const allowed = new Set(YES_WORDS);
  for (const w of opts.topic || []) allowed.add(String(w).toLowerCase());
  for (const name of opts.names || []) {
    for (const part of String(name || '').toLowerCase().match(/[a-z0-9']+/g) || []) allowed.add(part);
  }
  const tokens = soft.match(/[a-z0-9']+/g) || [];
  return tokens.every((tok) => allowed.has(tok) || /^\d+$/.test(tok));
}

/* ------------------------------------------------ the price was said, and answered */

/* Any money amount in the reply's own words: "$0.16", "16 cents", "sixteen cents", "under a cent". */
const PRICE_SHAPE = /\$\s?\d|\b(?:cents?|dollars?|bucks?|penny|pennies)\b/i;
const TASK_QUOTES = 'kadetaskquotes';

function priceHeardOn(env = process.env) {
  return on('KADE_SPEND_PRICE_HEARD', env);
}

/** May this price row be claimed as far as "was it said" goes? Rows from before the rule
 *  (no turn on them) pass, as they did. */
function priceWasSaid(q, env = process.env) {
  if (!priceHeardOn(env)) return true;
  if (!q || !q.turnId) return true;
  return q.heard === true;
}

/* conversationId -> does it hold an open price, as far as this server knows. A conversation
 * this server has not seen is checked in the database once. */
const openPrices = new Map();
const OPEN_MAX = 5000;
function noteOpen(convo, open) {
  openPrices.delete(convo);
  if (openPrices.size >= OPEN_MAX) {
    let n = Math.floor(OPEN_MAX / 5);
    for (const k of openPrices.keys()) {
      if (n-- <= 0) break;
      openPrices.delete(k);
    }
  }
  openPrices.set(convo, open);
}

/**
 * Runs once a reply is finished (controllers/agents/client.js), after it has gone out; nothing
 * waits on it. Two jobs, both plain database updates, no model:
 *   1. a price worked out during this reply is stamped heard or not heard, by whether the
 *      reply's own words (never a tool result) carried a money amount;
 *   2. when the person's message this turn was not a plain yes, prices left open in this
 *      conversation by earlier turns are closed.
 * Never throws.
 * @returns {Promise<{ stamped: number, heard: boolean | null, lapsed: number } | null>}
 */
async function afterReply({ req, replyText, agentName, env = process.env, colls } = {}) {
  try {
    if (!priceHeardOn(env)) return null;
    if (!req || req.kadeHiddenRun === true) return null;
    const t = turnOf(req);
    if (!t) return null;
    const get = (name) => (colls && colls[name]) || require('mongoose').connection.collection(name);
    const out = { stamped: 0, heard: null, lapsed: 0 };
    const now = new Date();
    const count = (r) => (r && (r.modifiedCount ?? r.nModified)) || 0;
    if (t.quoted.size > 0) {
      out.heard = PRICE_SHAPE.test(String(replyText || ''));
      for (const name of t.quoted) {
        out.stamped += count(
          await get(name).updateMany({ turnId: t.id, usedAt: { $exists: false } }, { $set: { heard: out.heard, heardAt: now } }),
        );
      }
    }
    const convo = conversationOf(req);
    if (!convo) return out;
    const said = latestWords(req.body && req.body.text);
    const plainYes =
      said.ok && approvesPrice(said.words, { names: [agentName], topic: [...TASK_TOPIC, ...SONG_TOPIC] });
    if (said.ok && !plainYes && !isReplay(req) && openPrices.get(convo) !== false) {
      for (const name of [TASK_QUOTES, SONG_QUOTES]) {
        out.lapsed += count(
          await get(name).updateMany(
            { conversationId: convo, usedAt: { $exists: false }, turnId: { $ne: t.id } },
            { $set: { usedAt: now, lapsed: true } },
          ),
        );
      }
      noteOpen(convo, t.quoted.size > 0);
    } else if (t.quoted.size > 0) {
      noteOpen(convo, true);
    }
    return out;
  } catch (_) {
    return null;
  }
}

/* --------------------------------------------------------------- the song gate */

function songColl() {
  return require('mongoose').connection.collection(SONG_QUOTES);
}

function unwrap(found) {
  const doc = found && (found.value !== undefined ? found.value : found);
  return doc && doc._id !== undefined ? doc : null;
}

/**
 * May this fal song be made now? The first ask in a conversation only records the price
 * (reason 'quoted'): the character says it and asks. A later turn whose message is a plain yes
 * claims that price once and the song is made.
 *
 * @returns {Promise<{ ok: true, release: () => Promise<void> } | { ok: false, reason: 'quoted' | 'not-approved' | 'replay' | 'turn-limit' | 'voice' | 'hidden' | 'unavailable' }>}
 */
async function songGate({ req, userId, engine, estUSD, agentName, env = process.env, coll } = {}) {
  const gateOn = on('KADE_SONG_YES_GATE', env);
  const onceOn = on('KADE_SONG_ONCE_PER_TURN', env);
  const KEY = 'fal_song';
  if (!gateOn) {
    /* Without a request there is no turn to count; the old behaviour stands. */
    if (onceOn && req && !claimOnce(req, KEY)) return { ok: false, reason: 'turn-limit' };
    return { ok: true, release: async () => releaseOnce(req, KEY) };
  }
  const uid = userId == null ? '' : String(userId);
  if (!req || !uid) return { ok: false, reason: 'unavailable' };
  if (req.kadeHiddenRun === true) return { ok: false, reason: 'hidden' };
  /* A call: its conversation is new every turn, so a price given now could never be found
   * again. Said up front, before any price row is written (the first sentence of a call
   * carries no folded history and used to be taken for a text chat). */
  if (isVoiceLane(req)) return { ok: false, reason: 'voice' };

  const c = coll || songColl();
  const convo = conversationOf(req);
  const said = latestWords(req.body && req.body.text);
  const tid = turnId(req);
  const cutoff = new Date(Date.now() - SONG_QUOTE_MINUTES * 60000);
  const open = convo
    ? await c.findOne(
        {
          userId: uid,
          conversationId: convo,
          engine,
          usedAt: { $exists: false },
          createdAt: { $gte: cutoff },
          turnId: { $ne: tid },
          /* only a price the person was told (afterReply stamps it) */
          ...(priceHeardOn(env) ? { heard: true } : {}),
        },
        { sort: { createdAt: -1 } },
      )
    : null;

  if (!open) {
    /* A folded turn is a call whose conversation is new every turn: a price could never be
     * found again, so none is recorded and the character is told to send them to the chat. */
    if (!convo || said.folded) return { ok: false, reason: 'voice' };
    const mine = await c.findOne({ userId: uid, conversationId: convo, engine, turnId: tid, usedAt: { $exists: false } });
    if (!mine) {
      await c.insertOne({
        quoteId: `s${crypto.randomBytes(6).toString('hex')}`,
        userId: uid,
        conversationId: convo,
        engine,
        estUSD: Number(estUSD) || 0,
        turnId: tid,
        createdAt: new Date(),
      });
    }
    markQuoted(req, SONG_QUOTES);
    return { ok: false, reason: 'quoted' };
  }

  if (!said.ok) return { ok: false, reason: 'voice' };
  if (on('KADE_SPEND_NO_REPLAY', env) && isReplay(req)) return { ok: false, reason: 'replay' };
  if (!approvesPrice(said.words, { names: [agentName], topic: SONG_TOPIC })) return { ok: false, reason: 'not-approved' };
  if (onceOn && !claimOnce(req, KEY)) return { ok: false, reason: 'turn-limit' };

  const now = new Date();
  let claimed;
  try {
    claimed = unwrap(
      await c.findOneAndUpdate(
        { _id: open._id, usedAt: { $exists: false } },
        { $set: { usedAt: now, usedTurnId: tid } },
        { returnDocument: 'after' },
      ),
    );
  } catch (e) {
    releaseOnce(req, KEY);
    throw e;
  }
  if (!claimed) return { ok: false, reason: 'turn-limit' };
  /* One yes buys one song: older unanswered prices in this conversation are closed with it. */
  await c
    .updateMany(
      { userId: uid, conversationId: convo, engine, usedAt: { $exists: false }, turnId: { $ne: tid } },
      { $set: { usedAt: now, superseded: true } },
    )
    .catch(() => {});
  return {
    ok: true,
    /* fal turned the job away before anything was spent: the yes and the turn stand again. */
    release: async () => {
      releaseOnce(req, KEY);
      await c.updateOne({ _id: open._id, usedTurnId: tid }, { $unset: { usedAt: 1, usedTurnId: 1 } }).catch(() => {});
    },
  };
}

module.exports = {
  on,
  turnId,
  claimOnce,
  releaseOnce,
  conversationOf,
  markQuoted,
  isReplay,
  priceHeardOn,
  priceWasSaid,
  afterReply,
  PRICE_SHAPE,
  TASK_QUOTES,
  _resetForTests: () => openPrices.clear(),
  isVoiceLane,
  latestWords,
  approvesPrice,
  songGate,
  TASK_TOPIC,
  SONG_TOPIC,
  SONG_QUOTES,
};
