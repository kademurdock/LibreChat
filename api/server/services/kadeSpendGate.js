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
 * No model call and no wait: string checks and, for a song, one or two small database calls
 * inside a tool call that was about to spend money anyway.
 *
 * Off switches (default on, "=0" turns one off):
 *   KADE_TASK_YES_GATE=0        kade_task start goes back to "a quote row is enough"
 *   KADE_TASK_ATOMIC_START=0    kade_task start goes back to read, check, then mark
 *   KADE_SONG_YES_GATE=0        fal generate_song goes back to the budget check only
 *   KADE_SONG_ONCE_PER_TURN=0   no limit on songs per reply
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
    t = { id: crypto.randomBytes(8).toString('hex'), claims: new Set() };
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
const YES_WORDS = new Set(
  (
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

const TASK_TOPIC = ['job', 'task', 'search', 'research', 'work'];
const SONG_TOPIC = ['song', 'track', 'music', 'tune'];

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
  const soft = t.replace(SOFT_NO, ' ');
  const { herWordsApprove } = require('./kadeApprovals');
  /* "yes " in front asks only the hold-on question; the yes itself must be in their words. */
  if (!herWordsApprove(`yes ${soft}`)) return false;
  if (!herWordsApprove(soft) && !EXTRA_YES.test(soft)) return false;
  const allowed = new Set(YES_WORDS);
  for (const w of opts.topic || []) allowed.add(String(w).toLowerCase());
  for (const name of opts.names || []) {
    for (const part of String(name || '').toLowerCase().match(/[a-z0-9']+/g) || []) allowed.add(part);
  }
  const tokens = soft.match(/[a-z0-9']+/g) || [];
  return tokens.every((tok) => allowed.has(tok) || /^\d+$/.test(tok));
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
 * @returns {Promise<{ ok: true, release: () => Promise<void> } | { ok: false, reason: 'quoted' | 'not-approved' | 'turn-limit' | 'voice' | 'hidden' | 'unavailable' }>}
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

  const c = coll || songColl();
  const convo = conversationOf(req);
  const said = latestWords(req.body && req.body.text);
  const tid = turnId(req);
  const cutoff = new Date(Date.now() - SONG_QUOTE_MINUTES * 60000);
  const open = convo
    ? await c.findOne(
        { userId: uid, conversationId: convo, engine, usedAt: { $exists: false }, createdAt: { $gte: cutoff }, turnId: { $ne: tid } },
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
    return { ok: false, reason: 'quoted' };
  }

  if (!said.ok) return { ok: false, reason: 'voice' };
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
  isVoiceLane,
  latestWords,
  approvesPrice,
  songGate,
  TASK_TOPIC,
  SONG_TOPIC,
  SONG_QUOTES,
};
