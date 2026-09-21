/* THE VOICE - the one place a citizen is allowed to say something nobody wrote.
 *
 * KADE'S SHAPE, Sep 21 2026: "it's expensive to have an llm play the game, I
 * was thinking jev does the playing and llm does the speeking interacting
 * whatever." That split is exactly right, and the arithmetic says so louder
 * than the intuition did.
 *
 * PLAYING is constant: every citizen, every room, every tick, forever, whether
 * or not anybody is watching. SPEAKING is rare, because it is bounded by how
 * fast a human can type, and it only ever happens when a human is present. So
 * the expensive thing is the planning and the cheap thing is the talking, and
 * the city had them the wrong way round.
 *
 * THE NUMBER THAT UNLOCKS IT. residentReply runs z-ai/glm-5.3-flash, which is
 * $0.09 per million tokens in and $0.30 out. A turn is about 1,500 tokens in
 * and 90 out:
 *
 *     1500 * 0.09/1e6  +  90 * 0.30/1e6  =  $0.00016 a turn
 *
 * The old lane reserved ONE CENT a call, which is sixty-two times the real
 * price, and then capped itself at 100 calls for the lifetime of the
 * deployment, shared across every player and every restart, with no reset path
 * anywhere in the tree. That is 50 taps of the "Say hello" button, ever, for a
 * reserved dollar whose true cost is two cents. Every conversation in Reverie
 * after those 100 calls fell back to a sentence that said so out loud.
 *
 * At the real price a dollar is about six thousand turns. A whole busy day -
 * six people playing, forty turns each - is four cents.
 *
 * SO THIS FILE. A rolling DAILY allowance measured in dollars on the world
 * clock, the same shape planning.js already uses for REVERIE_RESIDENT_DAILY_USD,
 * reserving the real price instead of a guess, and REFUNDING when the call
 * fails. The old code charged first and never gave it back, so an outage at
 * the provider permanently ate the world's ability to talk.
 *
 * THE DEFAULT IS DELIBERATE. Five cents a day is about three hundred turns a
 * day: strictly more conversation than the 100-lifetime cap it replaces, at a
 * ceiling of a dollar fifty a month. It only ever adds. Raise it with
 * REVERIE_VOICE_DAILY_USD on the service; 0 turns the lane off and the
 * authored lines carry the city exactly as they did before Jev or glm existed.
 *
 * AND THE THING IT MUST NEVER DO IS ANNOUNCE ITSELF. The old fallback said
 * "<name> cannot answer freely right now", which tells a player, in words,
 * that this person is run by a machine whose meter has run out. A soul never
 * says that. On every failure - no key, no allowance, provider down, a reply
 * we do not like the look of - this returns null and the caller quietly uses
 * the authored line, which is what a person with nothing new to say does.
 */
const { residentReply } = require('@librechat/api');
const { MooDistrict } = require('~/models/kadeMoo');
const veil = require('./veil');

const DAILY_ID = 'reverie_voice_daily_241';
/* The measured price of one turn, not a guess. Reserved before the call and
 * reconciled after, so a failure costs the day nothing. */
const TURN_USD = 0.00016;

/* THE DEFAULT, RAISED Sep 21 2026 from five cents to twenty-five.
 *
 * Her words, and they are an instruction about when to spend rather than how
 * much: "it's like a tree falling and nobody being around to hear it. If
 * nobody's connected, might as well not waste money. But if someone is, things
 * are gold."
 *
 * This lane already obeys the first half completely -- an empty city makes no
 * calls, because nothing in it speaks unless somebody is standing there to be
 * spoken to. The second half is the part that was underfunded. As of today the
 * ROOM answers through here too, not just the two conversation verbs, so a
 * person who talks to the city gets a real answer every time instead of the
 * one written sentence in that topic's pool.
 *
 * Twenty-five cents a day is about fifteen hundred turns: a ceiling of $7.50 a
 * month, and realistically pennies, because it can only be reached by people
 * typing. Set REVERIE_VOICE_DAILY_USD to change it; 0 turns the lane off and
 * the authored lines carry the city exactly as they did before.
 */
function dailyCapUSD() {
  const raw = process.env.REVERIE_VOICE_DAILY_USD;
  const n = Number(raw === undefined || raw === '' ? 0.25 : raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Take one turn's worth of the day, or say no. Same pattern as planning.js. */
async function reserve() {
  const cap = dailyCapUSD();
  if (!cap) return false;
  const day = require('./ctx').worldClock().dayKey;
  await MooDistrict.updateOne(
    { districtId: DAILY_ID },
    {
      $setOnInsert: {
        name: 'Resident conversation, daily allowance',
        props: { day, calls: 0, spentUSD: 0, refunds: 0, perTurnUSD: TURN_USD },
      },
    },
    { upsert: true },
  );
  await MooDistrict.updateOne(
    { districtId: DAILY_ID, 'props.day': { $ne: day } },
    { $set: { 'props.day': day, 'props.calls': 0, 'props.spentUSD': 0, 'props.refunds': 0 } },
  );
  const taken = await MooDistrict.updateOne(
    { districtId: DAILY_ID, 'props.day': day, 'props.spentUSD': { $lte: cap - TURN_USD + 1e-9 } },
    { $inc: { 'props.calls': 1, 'props.spentUSD': TURN_USD } },
  );
  return taken.modifiedCount === 1;
}

/** Give it back. A call that produced no words must not cost the city a turn. */
async function refund() {
  await MooDistrict.updateOne(
    { districtId: DAILY_ID },
    { $inc: { 'props.calls': -1, 'props.spentUSD': -TURN_USD, 'props.refunds': 1 } },
  ).catch(() => {});
}

/* THE FILE ON A PERSON ------------------------------------------------------
 *
 * KADE, Sep 21 2026: "I want people to talk to these npc people like they're
 * real people, like they could give you a phone number irl if they were real."
 *
 * What makes that fail is not the model, it is what the model is handed. The
 * old call passed a one-line description and nothing else, so every citizen
 * arrived at the prompt as a job title with a name on it, and a job title
 * answers like a job title no matter which model reads it.
 *
 * A person is four things the city already knows and was throwing away:
 *
 *  1. HOW THEY TALK. The census wrote three or four lines of real dialogue
 *     for everybody, and overhear.js wrote each of them a greeting and -- the
 *     best line any of these people have -- their own way of saying they do
 *     not know. Register is learned from examples and not from adjectives, so
 *     these go in verbatim. This is the single biggest difference between
 *     "Pat Harris, diner owner" and Pat.
 *  2. WHAT THEY WANT. Two standing wants each, already written, never once
 *     shown to the thing doing the speaking.
 *  3. WHO THEY KNOW. Family and friends by name, so "ask Dez, he's my cousin"
 *     is available to them instead of being a thing only the narrator knows.
 *  4. WHAT THEY ARE AN AUTHORITY ON, and by omission what they are not. A
 *     librarian who holds forth on outboard motors is the oldest synth tell
 *     there is, and overhear.js already has the table.
 *
 * Plus the one thing that is about the PAIR and not the person: where you two
 * stand. Somebody who has known you for a month does not greet you like a
 * stranger, and until now nothing in the speaking lane could tell the
 * difference.
 *
 * Kept under 2200 characters because residentReply slices there; the samples
 * are trimmed before anything load-bearing is.
 */
function joinNames(ids, byId) {
  return (ids || [])
    .map((id) => (byId[id] || byId['npc:' + id] || {}).name)
    .filter(Boolean)
    .join(', ');
}

function dossier(def, opts = {}) {
  if (!def) return opts.standing ? { standing: opts.standing } : null;
  const reverie = require('../reverie');
  const byId = reverie.CENSUS_BY_ID || {};
  const overhear = require('../overhear');
  const v = (overhear.VOICES || {})[def.id] || {};
  const out = {};
  if (def.desc) out.who = String(def.desc).slice(0, 700);
  if (veil.pronounsOf(def.id)) out.pronouns = veil.pronounsOf(def.id);
  if (def.wants && def.wants.length) out.wants = def.wants.slice(0, 2);
  const known = [joinNames(def.family, byId), joinNames(def.knows, byId)].filter(Boolean).join(', ');
  if (known) out.knowsPeople = known.slice(0, 200);
  if (v.knows && v.knows.length) out.authorityOn = v.knows.join(', ');
  /* Their own words, which is the part that does the work. Greeting first
   * because it is the most-heard line in the game, then the shrug, then the
   * written dialogue. */
  const samples = [
    ...(v.greet || []).slice(0, 1),
    ...(v.shrug || []).slice(0, 1),
    ...(def.talk || []).slice(0, 3),
  ]
    .map((s) => String(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (samples.length) out.talksLikeThis = samples;
  if (opts.standing) out.standing = opts.standing;
  if (opts.note) out.note = opts.note;
  return out;
}

/** Where these two stand, in the words `look` already uses. Never a number. */
async function standingBetween(userId, otherUserId) {
  try {
    const rel = require('./relationships');
    const r = await rel.getRel(userId, otherUserId);
    const tier = rel.tierOf(r);
    if (tier === 'strangers') return 'You two have not really talked before.';
    return `You and this person are ${tier}.`;
  } catch (_) {
    return null;
  }
}

/**
 * New words from a citizen, or null.
 *
 * NEVER THROWS AND NEVER EXPLAINS. Null means "use the authored line", and the
 * caller must do that silently. See the note at the top about why.
 */
/* Every spoken line in the city wears the same clothes. The census writes its
 * dialogue inside quotation marks and the model returns bare prose, so without
 * this a player learns in about four turns that quoted means written and
 * unquoted means fresh -- which is the canned-versus-real tell wearing a
 * different hat. */
function asSpeech(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/^["'\u201c\u2018]/.test(t)) return t;
  return `"${t.replace(/^[-\u2013\u2014]\s*/, '')}"`;
}

async function speak({ person, place, weather, doing, player, message, history = [], canon, steer, timeoutMs }) {
  if (!process.env.REFRAME_PROXY_SECRET) return null;
  if (!(await reserve())) return null;
  let answer = null;
  try {
    answer = await residentReply({
      name: person.name,
      character: JSON.stringify({ description: person.attrs?.desc, canon }).slice(0, 2200),
      place,
      weather,
      doing,
      player,
      message,
      history,
      steer,
      timeoutMs,
    });
  } catch (_) {
    answer = null;
  }
  if (!answer) {
    await refund();
    return null;
  }
  try {
    require('~/models/kadeUsage')
      .logKadeUsage({
        userId: null,
        service: 'openrouter',
        quantity: 1,
        unit: 'reverie-turn',
        costUSD: TURN_USD,
        metadata: { via: 'reverie-voice', model: 'z-ai/glm-5.3-flash', person: person.userId },
      })
      .catch(() => {});
  } catch (_) {
    /* the ledger is a record, not a gate */
  }
  return answer;
}

/** For `@voice` and the status line: what the day has actually spent. */
async function dayLine() {
  const cap = dailyCapUSD();
  if (!cap) return 'Citizen conversation: off (REVERIE_VOICE_DAILY_USD is 0).';
  const d = await MooDistrict.findOne({ districtId: DAILY_ID }).lean();
  const p = (d && d.props) || {};
  const turns = Math.floor(cap / TURN_USD);
  return (
    `Citizen conversation: $${cap.toFixed(2)} a day, about ${turns} turns. ` +
    `Today (${p.day || 'no day yet'}): ${p.calls || 0} turn${p.calls === 1 ? '' : 's'}, ` +
    `$${Number(p.spentUSD || 0).toFixed(4)} spent, ${p.refunds || 0} refunded.`
  );
}

module.exports = {
  speak, dayLine, dailyCapUSD, reserve, refund, DAILY_ID, TURN_USD,
  dossier, standingBetween, asSpeech,
};
