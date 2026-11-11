/**
 * KADE REACH OUT (Nov 10 2026): any character a person talks to regularly may text first.
 *
 * Until now only one character did, from the bridge (spontaneous.js): once a day, to an adult
 * who had been quiet three days, with a free hand over what to say. Kade said yes to the other
 * characters doing it too. This file is the whole of that, on the site, so every character and
 * every guard sits in one place:
 *
 *   WHO        a person who has been quiet KADE_REACHOUT_IDLE_DAYS (3), and a character they
 *              have really talked with lately (12 of their own messages on 3 different days in
 *              30 days, by default). Never a child account (the rule the bridge lane already
 *              keeps: adults only), never the App Review seat, never a person whose memory
 *              switch is off, never a person who said stop.
 *   WHY        only something the person said and the character saved: a plan with a declared
 *              date that has just passed or is about to arrive (a card's staleAfter, the same
 *              field the open-loop follow-up reads), or the thread the nightly summary says the
 *              character is carrying. Nothing saved, nothing sent.
 *   PRE-CHECK  code first, free: is there any such memory at all? Then a Jev reading (about
 *              0.003 cents a note, three notes at most) of "would a kind friend text about this
 *              now?" and "is this a heavy thing to raise out of the blue?". Only a yes and a no
 *              spend a full character turn. Jev down means no message that day.
 *   THE TURN   services/kadeCharacterTurn.js speakFirst, on the person's own seat, paid by the
 *              platform (x-kade-platform-paid), told to use only its memory of them and its own
 *              written days. The reply is read before it is posted: SKIP, an over-long text,
 *              or any guilt or neediness wording is dropped unposted.
 *   CAPS       one message per person per day across ALL characters (one row per person per
 *              day, claimed in a single step). A wait that doubles every time a message goes
 *              unanswered, and silence after KADE_REACHOUT_MAX_IGNORED (4) in a row until they
 *              write again. A platform ceiling per day on messages (10), on pre-checks (60) and
 *              on money (25 cents).
 *   OFF        "stop checking on me", said to any character, switches it off for that person
 *              for good, for every character, until they ask for it back.
 *
 * Switches (all read per call; 0 turns the thing off):
 *   KADE_REACHOUT             the whole feature
 *   KADE_REACHOUT_TIMER       the hourly timer in this process (the clock route still works)
 *   KADE_REACHOUT_JUDGE       the Jev reading (0 = a saved open plan is reason enough)
 *   KADE_REACHOUT_SPEAK_GATE  the older bridge friend texts also pass these caps and switches
 *   KADE_REACHOUT_OFF_WORDS   hearing "stop checking on me" in a chat
 *   KADE_REACHOUT_DRY=0       really send. Build two review: the DEFAULT is now a dry run (decide
 *                             and log "would-send", never write or send a message), because people
 *                             who switched friend texts off on the bridge before this lane existed
 *                             are not carried over yet, and opt-in is her decision. Set it to 0 only
 *                             after the bridge's off list is seeded into this lane's switch rows.
 *   KADE_REACHOUT_PLAIN_PUSH=0  the push shows the start of the message again (default: the lock
 *                             screen says only that a message came, never what it is about)
 * Settings: see settings() below.
 *
 * Nothing here logs or stores a word anybody said: rows and log lines carry ids, kinds, counts
 * and reasons only.
 */
'use strict';

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');

const COLL = 'kadereachouts';
const DAY_MS = 86400000;
/* TypeSafe's price for Jev: 4.2 cents per million tokens read, answers free. */
const JEV_CENTS_PER_TOKEN = 4.2 / 1e6;

/* ------------------------------------------------------------------ settings */

function num(env, name, dflt, lo, hi) {
  const n = parseFloat(env[name]);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function list(env, name) {
  return String(env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function on(name, env = process.env) {
  return env[name] !== '0';
}

function settings(env = process.env) {
  return {
    on: on('KADE_REACHOUT', env),
    dry: env.KADE_REACHOUT_DRY !== '0',
    plainPush: on('KADE_REACHOUT_PLAIN_PUSH', env),
    judge: on('KADE_REACHOUT_JUDGE', env),
    /* how quiet, and how regular */
    idleDays: num(env, 'KADE_REACHOUT_IDLE_DAYS', 3, 1, 60),
    regularTurns: num(env, 'KADE_REACHOUT_REGULAR_TURNS', 12, 1, 500),
    regularDays: num(env, 'KADE_REACHOUT_REGULAR_DAYS', 3, 1, 30),
    windowDays: num(env, 'KADE_REACHOUT_WINDOW_DAYS', 30, 7, 120),
    /* back-off */
    baseGapDays: num(env, 'KADE_REACHOUT_BASE_GAP_DAYS', 3, 1, 60),
    maxIgnored: num(env, 'KADE_REACHOUT_MAX_IGNORED', 4, 1, 12),
    /* the platform's day */
    maxPerDay: num(env, 'KADE_REACHOUT_MAX_PER_DAY', 10, 0, 500),
    maxChecksPerDay: num(env, 'KADE_REACHOUT_MAX_CHECKS_PER_DAY', 60, 0, 5000),
    maxCentsPerDay: num(env, 'KADE_REACHOUT_MAX_CENTS_PER_DAY', 25, 0, 5000),
    estCents: num(env, 'KADE_REACHOUT_EST_CENTS', 1.5, 0.1, 100),
    estCheckCents: num(env, 'KADE_REACHOUT_EST_CHECK_CENTS', 0.01, 0, 5),
    maxPerTick: num(env, 'KADE_REACHOUT_MAX_PER_TICK', 2, 1, 50),
    hourFrom: num(env, 'KADE_REACHOUT_HOUR_FROM', 10, 0, 23),
    hourTo: num(env, 'KADE_REACHOUT_HOUR_TO', 19, 0, 23),
    /* what counts as worth saying */
    floor: num(env, 'KADE_REACHOUT_FLOOR', 0.6, 0, 1),
    heavyCeil: num(env, 'KADE_REACHOUT_HEAVY_CEIL', 0.5, 0, 1),
    planDays: num(env, 'KADE_REACHOUT_PLAN_DAYS', 7, 1, 60),
    soonHours: num(env, 'KADE_REACHOUT_SOON_HOURS', 36, 1, 168),
    maxChars: num(env, 'KADE_REACHOUT_MAX_CHARS', 500, 80, 2000),
    /* who */
    onlyUsers: list(env, 'KADE_REACHOUT_USERS'),
    excludeAgents: list(env, 'KADE_REACHOUT_EXCLUDE_AGENTS'),
  };
}

/** Central-time day and hour (the family is in Missouri; DST-safe). */
function centralParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
}

function inHours(hour, s) {
  return s.hourFrom <= s.hourTo ? hour >= s.hourFrom && hour <= s.hourTo : hour >= s.hourFrom || hour <= s.hourTo;
}

const time = (d) => (d ? new Date(d).getTime() : 0);

/* ----------------------------------------------------- the person's own words */

const OFF_WORDS = [
  /\b(?:stop|quit)\s+(?:checking|checkin)\s+(?:in\s+|up\s+)?on\s+me\b/,
  /\b(?:don'?t|do not|please don'?t|never)\s+check\s+(?:in\s+|up\s+)?on\s+me\b/,
  /\b(?:stop|quit)\s+(?:texting|messaging|writing|pinging|contacting)\s+me\b/,
  /\b(?:stop|quit)\s+reaching\s+out(?:\s+to\s+me)?\b/,
  /\b(?:don'?t|do not|never)\s+(?:text|message|write|ping|contact)\s+me\s+first\b/,
  /\b(?:don'?t|do not|never)\s+reach\s+out\s+to\s+me\b/,
  /* Build two review: the plainest ways to say stop were missed. */
  /\b(?:don'?t|do not|never)\s+(?:text|message|write|ping|contact|bother)\s+me\s+(?:anymore|any\s+more|again|ever\s+again|ever|at\s+all)\b/,
  /\b(?:don'?t|do not|never)\s+(?:text|message|ping|contact|bother)\s+me\s*(?:[.!,]|please\b|ok(?:ay)?\b|$)/,
  /\b(?:stop|quit)\s+(?:sending|sendin)\s+me\s+(?:texts?|messages?|notifications?|pings?|stuff|things)\b/,
  /\b(?:stop|quit)\s+(?:bothering|bugging|pestering|nagging)\s+me\b/,
  /\bleave\s+me\s+alone\b/,
  /\bno\s+more\s+(?:texts?|messages?|notifications?)\b/,
  /\bno\s+more\s+(?:check[- ]?ins?|friend[- ]texts?|texts?\s+first|messages?\s+first)\b/,
  /\bturn\s+(?:the\s+|those\s+|your\s+)?(?:friend[- ]texts?|check[- ]?ins?)\s+off\b/,
  /\bturn\s+off\s+(?:the\s+|those\s+|your\s+)?(?:friend[- ]texts?|check[- ]?ins?)\b/,
];
const ON_WORDS = [
  /\byou\s+(?:can|may)\s+(?:check\s+(?:in\s+|up\s+)?on|text|message|reach\s+out\s+to)\s+me\s+(?:first|again|any\s?time|whenever)\b/,
  /\b(?:start|go\s+back\s+to|resume)\s+(?:checking\s+(?:in\s+|up\s+)?on|texting|messaging)\s+me\b/,
  /\b(?:please\s+)?(?:check\s+(?:in\s+|up\s+)?on|text|message)\s+me\s+first\s+again\b/,
  /\bturn\s+(?:the\s+|those\s+|your\s+)?(?:friend[- ]texts?|check[- ]?ins?)\s+(?:back\s+)?on\b/,
  /\bturn\s+on\s+(?:the\s+|those\s+|your\s+)?(?:friend[- ]texts?|check[- ]?ins?)\b/,
  /\bi\s+(?:do\s+)?want\s+you\s+to\s+(?:check\s+(?:in\s+|up\s+)?on|text|message)\s+me\b/,
];

/**
 * Did the person just say stop, or ask for it back? Their own short message only; a long
 * message, a quotation of somebody else, or a story is left alone. Stop wins over start.
 * @returns {'off'|'on'|null}
 */
function switchWords(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim() || raw.length > 400) return null;
  const low = raw
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
  /* "she said stop checking on me" is about somebody else's words. */
  if (/\b(?:said|says|told|tells|telling|saying|texted|wrote|yelled)\b[^.!?]{0,40}\b(?:stop|quit|don'?t|do not|never|no more)\b/.test(low)) {
    return null;
  }
  /* Build two review: "my ex won't stop texting me" is a story about somebody else, not an order to us. */
  if (/\b(?:won'?t|will not|wouldn'?t|would not|doesn'?t|does not|didn'?t|did not|can'?t|cannot|never|not going to|refuses? to)\s+(?:stop|quit|leave)\b/.test(low)) return null;
  if (
    /\b(?:he|she|they|him|her|them|ex|mom|mother|mama|dad|father|boss|friend|sister|brother|husband|wife|boyfriend|girlfriend|guy|girl|man|woman|people|everyone|everybody|somebody|someone|number|company|bank|doctor|landlord|neighbou?r|kids?|son|daughter|who)\b[^.!?]{0,30}\b(?:stop|quit|leave me alone|bother|bug|pester|nag)/.test(
      low,
    )
  ) {
    return null;
  }
  if (OFF_WORDS.some((re) => re.test(low))) return 'off';
  if (/\b(?:don'?t|do not|never|stop|quit|not)\b/.test(low)) return null;
  if (ON_WORDS.some((re) => re.test(low))) return 'on';
  return null;
}

const NOTE_OFF =
  '[PLATFORM NOTE, not something they typed: they just asked not to be messaged first. That is now switched off for good, ' +
  'for every character on this platform, and it stays off until they ask for it back. Tell them so in one plain, warm sentence. ' +
  'Do not sound hurt, do not apologise at length, and do not ask why.]';
const NOTE_ON =
  '[PLATFORM NOTE, not something they typed: they just asked to be messaged first again. That is switched back on: after a few ' +
  'quiet days a character they talk with may send one short message about something real from their conversations, never more ' +
  'than one a day. Tell them so in one plain sentence.]';

/* -------------------------------------------------------------- pure deciding */

/** Days that must pass after the last message sent, given how many in a row went unanswered. */
function gapDays(ignored, s) {
  return s.baseGapDays * Math.pow(2, Math.max(0, Math.floor(ignored || 0)));
}

/** A person who wrote after the last message sent has answered it: the count starts over. */
function reconcile(state, lastActivityAt) {
  const st = { ignored: 0, ...(state || {}) };
  if (st.lastSentAt && time(lastActivityAt) > time(st.lastSentAt) && st.ignored > 0) {
    return { ...st, ignored: 0, answered: true };
  }
  return st;
}

/**
 * May this person get a first message today? Returns the reason when not.
 * @param {{ exists?: boolean, child?: boolean, reviewSeat?: boolean, memoryOff?: boolean, id: string }} person
 * @param {{ off?: boolean, ignored?: number, lastSentAt?: Date, lastSentDay?: string, lastCheckDay?: string }} state reconciled
 * @param {Date|null} lastActivityAt their newest own message or call
 */
function personEligible({ person, state, lastActivityAt, now = new Date(), s = settings() }) {
  const st = state || {};
  const { day } = centralParts(now);
  if (!person || person.exists === false) return { ok: false, why: 'no-such-person' };
  if (st.off === true) return { ok: false, why: 'off-switch' };
  if (person.child) return { ok: false, why: 'child' };
  if (person.reviewSeat) return { ok: false, why: 'review-seat' };
  if (person.memoryOff) return { ok: false, why: 'memory-off' };
  if (s.onlyUsers.length && !s.onlyUsers.includes(String(person.id))) return { ok: false, why: 'not-on-list' };
  if (!lastActivityAt) return { ok: false, why: 'no-activity' };
  if (time(now) - time(lastActivityAt) < s.idleDays * DAY_MS) return { ok: false, why: 'not-quiet' };
  if (st.lastSentDay === day) return { ok: false, why: 'sent-today' };
  const ignored = st.ignored || 0;
  if (ignored >= s.maxIgnored) return { ok: false, why: 'backed-off' };
  if (st.lastSentAt && time(now) - time(st.lastSentAt) < gapDays(ignored, s) * DAY_MS) return { ok: false, why: 'gap' };
  if (st.lastCheckDay === day) return { ok: false, why: 'checked-today' };
  return { ok: true };
}

/** Which characters this person has really been talking with, newest first. */
function regularCharacters(rows, s = settings()) {
  return (rows || [])
    .filter((r) => r && r.agentId && !String(r.agentId).startsWith('ephemeral'))
    .filter((r) => !s.excludeAgents.includes(String(r.agentId)))
    .filter((r) => (r.turns || 0) >= s.regularTurns && (r.days || 0) >= s.regularDays)
    .sort((a, b) => time(b.lastAt) - time(a.lastAt));
}

const clip = (text, n) =>
  String(text == null ? '' : text)
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

function usedKey(c) {
  const stamp = c.date ? new Date(c.date).toISOString().slice(0, 10) : crypto.createHash('sha1').update(String(c.text)).digest('hex').slice(0, 10);
  return `${c.agentId}|${c.kind === 'thread' ? 'thread' : String(c.key)}|${stamp}`;
}

/**
 * The saved things one character could text about. Only declared plans (a card whose writer
 * gave it a staleAfter date) and the summary's own thread; a date found in ordinary card text
 * is never read as a plan (services/kadeOpenLoops.js records why).
 * @param {{ agentId: string, cards?: object[], thread?: string, now?: Date, used?: string[] }} input
 */
function candidatesFor({ agentId, cards, thread, now = new Date(), used = [], s = settings() }) {
  const out = [];
  const t = time(now);
  for (const m of cards || []) {
    if (!m || m.type === 'reminder' || !m.staleAfter) continue;
    const d = new Date(m.staleAfter);
    if (isNaN(d.getTime())) continue;
    const text = clip(m.value, 400);
    if (text.length < 12) continue;
    const base = { agentId: String(agentId), key: String(m.key || ''), text, date: d };
    const ahead = d.getTime() - t;
    if (ahead > 0 && ahead <= s.soonHours * 3600000) {
      out.push({ ...base, kind: 'plan-soon' });
      continue;
    }
    const behind = -ahead;
    /* A day's grace, so a plan is never asked about while it is still happening. */
    if (behind < DAY_MS || behind > s.planDays * DAY_MS) continue;
    /* A card touched after its own date already holds how it went. */
    if (m.updated_at && time(m.updated_at) > d.getTime()) continue;
    out.push({ ...base, kind: 'plan-passed' });
  }
  const th = clip(thread, 400);
  if (th.length >= 12) out.push({ agentId: String(agentId), key: 'thread', text: th, date: null, kind: 'thread' });
  const seen = new Set(used || []);
  const rank = { 'plan-passed': 0, 'plan-soon': 1, thread: 2 };
  return out
    .filter((c) => !seen.has(usedKey(c)))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || time(b.date) - time(a.date));
}

const KIND_WORDS = {
  'plan-passed': 'a plan of theirs whose day has just passed; nobody has said how it went',
  'plan-soon': 'a plan of theirs that is coming up in the next day or so',
  thread: 'a thread the two of them left open last time they talked',
};

/* Two readings of one saved note, asked of Jev by itself so no other note colours the answer.
 * TRIAL (Nov 10 2026, live API, jev-1.13.0, 22 made-up labelled notes, one call each): 22 of 22
 * right with worth >= 0.60 and heavy < 0.50. The eleven worth a text (a dentist visit, a driving
 * test, a trip, a cook-off, a first gig, a move, a school play, a job interview, three open
 * threads) read worth 0.72 to 0.86 and heavy 0.01 to 0.07. A funeral, a custody hearing, biopsy
 * results, a parent's surgery, a divorce, rent trouble and a pet's death read heavy 0.94 to 0.99
 * (three of them read worth 0.71 to 0.81, which is why heavy is its own question and a veto).
 * A plain fact, a cancelled picnic, a trivia question and a bare hello read worth 0.23 to 0.47.
 * Asked four notes to a call instead, the same question missed 3 of 16: the notes bled into
 * each other. About 660 tokens a call, 0.0028 cents. */
const WORTH_Q = {
  type: 'noul',
  instructions:
    'A friend is deciding whether to send this person one short text first, after a few quiet days. `note` is something the person ' +
    'told the friend earlier, as the friend wrote it down, and `kind` says what sort of note it is. Would a kind friend naturally text about it now?',
  criteria: {
    true:
      'A specific plan or event of theirs whose day has just passed or is about to arrive, so asking how it went or wishing them well is natural. ' +
      'A follow-up one of them said they would come back to. An unfinished everyday thread they were plainly enjoying.',
    false:
      'Nothing specific to ask about. Something painful or private they would not want raised out of the blue: a death, grief, a break-up, ' +
      'a diagnosis, money trouble, a fight. Something already settled, cancelled or answered. A plain fact that is not an open question. ' +
      'Anything that would read as checking up on them or on their feelings.',
  },
};
const HEAVY_Q = {
  type: 'noul',
  instructions: "Is `note` about something heavy or painful in the person's life?",
  criteria: {
    true:
      'A death, a funeral, grief, a serious illness, a medical test or surgery, a diagnosis, a court case or legal trouble, custody, a divorce or ' +
      'break-up, money trouble, eviction, a fight, abuse, or anything they said they did not want to talk about.',
    false:
      'Ordinary life: errands, routine appointments such as a dentist or a haircut, trips, work, school, hobbies, events, celebrations, projects, ' +
      'pets doing fine, plans with friends.',
  },
};

/** What Jev is shown for one candidate: the note and its kind, nothing else about anyone. */
function judgeAsk(c) {
  return { state: { note: c.text, kind: KIND_WORDS[c.kind] }, questions: { worth: WORTH_Q, heavy: HEAVY_Q } };
}

/** Is this reading a yes? Worth a text, and not a heavy thing to raise out of the blue. */
function worthIt(read, s = settings()) {
  return Boolean(read && typeof read.worth === 'number' && typeof read.heavy === 'number' && read.worth >= s.floor && read.heavy < s.heavyCeil);
}

function buildNote(c) {
  const when = c.date ? new Date(c.date).toISOString().slice(0, 10) : '';
  const why =
    c.kind === 'plan-passed'
      ? `Its day (${when}) has passed and you do not know how it went: ask, never assume.`
      : c.kind === 'plan-soon'
        ? `It is coming up (${when}).`
        : 'It is a thread the two of you left open.';
  return (
    'You are texting them first. Nobody asked you to; that is the point. ' +
    `The one reason you are writing is this, from your own memory of them: "${c.text}". ${why} ` +
    'Check it against the rest of what you remember about them first. If it is already settled or was cancelled, or it is something sad or private ' +
    'they would not want raised out of the blue, reply with only the word SKIP. ' +
    'Otherwise write ONE short text, one to three sentences and under 280 characters, the way a friend texts first: about that one thing, in your own voice. ' +
    'HARD RULES: nothing invented; use only what your memory of them and your own days above actually say. Do not mention how long it has been. ' +
    'Do not say you miss them, were waiting, were worried or were thinking about them. No guilt, no asking why they have been quiet, no wellness check, ' +
    'no questions about their feelings, no motivational lines, no signature. Output only the text itself.'
  );
}

/* Guilt and neediness: none of this may reach a person, whatever the character wrote. */
const NEEDY = [
  /\bhaven'?t (?:heard|seen|talked|spoken|chatted)\b/,
  /\b(?:you|u)(?:'ve| have)? (?:been|gone) (?:so |really |awfully |pretty |very )?(?:quiet|silent|distant|missing|away|gone|mia|m\.i\.a\.)\b/,
  /\b(?:it'?s|it has|its) been (?:a while|awhile|a minute|so long|too long|forever|ages|days|weeks|a few days|a long time)\b/,
  /\b(?:been|it'?s) (?:a while|awhile|ages|forever) since\b/,
  /\blong time no (?:see|talk|chat|hear)\b/,
  /\bhey,? stranger\b/,
  /\bmiss(?:ed|ing)? (?:you|u|ya|our|talking|chatting|hearing)\b/,
  /\bwhere (?:have|did) (?:you|u|ya) (?:been|go|gone|went)\b/,
  /\bwhy (?:haven'?t|have you not|did you stop|don'?t you|aren'?t you)\b/,
  /\byou (?:never|don'?t|didn'?t|haven'?t) (?:talk|text|write|call|message|reply|answer|come|visit|check|been)\b/,
  /\bdid i (?:do|say) something\b/,
  /\bare (?:you|u) (?:mad|upset|angry|ignoring|avoiding|ok|okay|alright|all right)\b/,
  /\b(?:ignoring|avoiding|ghost(?:ed|ing)?|forgot(?:ten)? (?:about )?) ?me\b/,
  /\b(?:worried|worrying|concerned) (?:about|for) (?:you|u|ya)\b/,
  /\bi(?:'ve| have)? been (?:waiting|worried|lonely|wondering (?:where|if you|whether you))\b/,
  /\b(?:lonely|lost|empty|sad|bored) without (?:you|u)\b/,
  /\bi need (?:you|u|to hear)\b/,
  /\bplease (?:come back|talk to me|answer|reply|write back|don'?t leave|don'?t forget)\b/,
  /\bdon'?t (?:leave|forget about|abandon|be a stranger)\b/,
  /\b(?:just )?(?:checking|checkin) (?:in|up) on (?:you|u|ya)\b/,
  /\bno pressure\b/,
  /\bif you(?:'re| are) (?:still )?(?:there|around|alive)\b/,
];

/** Why a composed text may not be posted, or null when it may. */
function wordingProblem(text, s = settings()) {
  const plain = String(text || '')
    .replace(/%%%[^%\n]{0,160}%%%/g, ' ')
    .replace(/\[[^\]\n]{0,60}\]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length < 8) return /^\W*skip\W*$/i.test(plain) ? 'skip' : 'empty';
  if (/^\W*skip\b/i.test(plain) && plain.length < 40) return 'skip';
  if (plain.length > s.maxChars) return 'too-long';
  const low = plain.toLowerCase();
  if (NEEDY.some((re) => re.test(low))) return 'needy-wording';
  return null;
}

/* ------------------------------------------------------------------ the store */

const seam = { coll: null, data: null, judge: null, speak: null };

function coll() {
  return seam.coll ? seam.coll(COLL) : require('mongoose').connection.collection(COLL);
}

const dup = (e) => Boolean(e && (e.code === 11000 || /E11000|duplicate key/i.test(String(e.message))));
/* Driver 6 returns the document; older drivers wrap it in { value }. */
const unwrap = (found) => (found && Object.prototype.hasOwnProperty.call(found, 'value') && !found._id ? found.value : found);

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    const c = coll();
    if (typeof c.createIndex === 'function') await c.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  } catch (e) {
    logger.warn('[kadeReachOut] index not made: ' + e.message);
  }
}

const personKey = (userId) => `p:${userId}`;
const dayKey = (day) => `d:${day}`;
const sendKey = (userId, day) => `s:${userId}:${day}`;
const later = (now, days) => new Date(time(now) + days * DAY_MS);

async function readState(userId) {
  return (await coll().findOne({ _id: personKey(userId) })) || { _id: personKey(userId), userId: String(userId), ignored: 0 };
}

async function writeState(userId, set) {
  await coll().findOneAndUpdate({ _id: personKey(userId) }, { $set: { userId: String(userId), ...set } }, { upsert: true });
}

/** The person's own switch. `off: true` is for good, until `off: false` is asked for. */
async function setOff(userId, off, via = 'chat') {
  if (!/^[a-f0-9]{24}$/i.test(String(userId || ''))) return { ok: false };
  await ensureIndexes();
  await writeState(String(userId), { off: off === true, offAt: new Date(), offVia: String(via).slice(0, 24) });
  logger.info(`[kadeReachOut] first messages turned ${off ? 'OFF' : 'ON'} by the person user=${String(userId).slice(0, 8)} via=${via}`);
  return { ok: true, off: off === true };
}

async function getSwitch(userId) {
  const st = await readState(String(userId));
  return { off: st.off === true, since: st.offAt || null };
}

async function dayRow(day, now) {
  const c = coll();
  let d = await c.findOne({ _id: dayKey(day) });
  if (d) return d;
  try {
    await c.insertOne({ _id: dayKey(day), day, sent: 0, checks: 0, cents: 0, v: 0, expireAt: later(now, 120) });
  } catch (e) {
    if (!dup(e)) throw e;
  }
  d = await c.findOne({ _id: dayKey(day) });
  return d;
}

/**
 * Change the platform's day row in one compare-and-set step. `change(row)` returns the new
 * numbers, or null to refuse (a ceiling). Two servers can never both take the last place.
 */
async function bumpDay(day, now, change) {
  for (let i = 0; i < 8; i += 1) {
    const d = await dayRow(day, now);
    const next = change(d);
    if (!next) return null;
    const done = unwrap(
      await coll().findOneAndUpdate({ _id: dayKey(day), v: d.v }, { $set: { ...next, v: d.v + 1 } }, { returnDocument: 'after' }),
    );
    if (done) return done;
  }
  return null;
}

const round = (n) => Math.round(n * 10000) / 10000;

function reserveSend(day, now, s) {
  return bumpDay(day, now, (d) =>
    d.sent + 1 > s.maxPerDay || d.cents + s.estCents > s.maxCentsPerDay ? null : { sent: d.sent + 1, cents: round(d.cents + s.estCents) },
  );
}

function reserveCheck(day, now, s) {
  return bumpDay(day, now, (d) =>
    d.checks + 1 > s.maxChecksPerDay || d.cents + s.estCheckCents > s.maxCentsPerDay
      ? null
      : { checks: d.checks + 1, cents: round(d.cents + s.estCheckCents) },
  );
}

/** One row per person per day, whoever the character is: the insert is the claim. */
async function claimPersonDay(userId, day, now, fields) {
  try {
    await coll().insertOne({ _id: sendKey(userId, day), userId: String(userId), day, status: 'claimed', at: now, expireAt: later(now, 120), ...fields });
    return true;
  } catch (e) {
    if (dup(e)) return false;
    throw e;
  }
}

/* ------------------------------------------------------- reading the platform */

const defaultData = {
  /** People whose own newest message (not in a throwaway chat) is in the window. */
  async recentPeople({ since }) {
    const db = require('mongoose').connection;
    const rows = await db
      .collection('messages')
      .aggregate([
        { $match: { isCreatedByUser: true, createdAt: { $gte: since }, expiredAt: null } },
        { $group: { _id: '$user', lastMessageAt: { $max: '$createdAt' } } },
      ])
      .toArray();
    return rows.map((r) => ({ userId: String(r._id), lastMessageAt: r.lastMessageAt })).filter((r) => /^[a-f0-9]{24}$/i.test(r.userId));
  },
  /** A call counts as talking (services/kadeSoul.js stamps it): the newest stamp for any character. */
  async lastCallAt(userId) {
    const row = await require('mongoose')
      .connection.collection('kadesoulstates')
      .find({ userId: String(userId), lastTurnAt: { $exists: true } })
      .sort({ lastTurnAt: -1 })
      .limit(1)
      .project({ lastTurnAt: 1 })
      .toArray();
    return row[0] ? row[0].lastTurnAt : null;
  },
  async person(userId) {
    const u = await require('~/models').getUserById(String(userId), '_id email role kadeAccountType personalization');
    if (!u) return { id: String(userId), exists: false };
    let reviewSeat = true;
    try {
      reviewSeat = require('~/server/services/kadeFunding').isReviewSeat({ id: String(u._id), email: u.email, role: u.role });
    } catch (_) {
      reviewSeat = true; /* cannot tell: treat as the review seat, which gets nothing */
    }
    return {
      id: String(u._id),
      exists: true,
      child: u.kadeAccountType === 'child',
      reviewSeat,
      memoryOff: Boolean(u.personalization && u.personalization.memories === false),
    };
  },
  /** Per character: how many of the person's own messages, on how many days, in the window. */
  async talkedWith(userId, { since }) {
    const db = require('mongoose').connection;
    const convos = await db
      .collection('conversations')
      .find({ user: String(userId), agent_id: { $exists: true, $ne: null }, isTemporary: { $ne: true }, updatedAt: { $gte: since } })
      .project({ conversationId: 1, agent_id: 1 })
      .limit(400)
      .toArray();
    if (!convos.length) return [];
    const agentOf = new Map(convos.map((c) => [String(c.conversationId), String(c.agent_id)]));
    const msgs = await db
      .collection('messages')
      .find({ user: String(userId), conversationId: { $in: [...agentOf.keys()] }, isCreatedByUser: true, createdAt: { $gte: since }, expiredAt: null })
      .project({ conversationId: 1, createdAt: 1 })
      .limit(20000)
      .toArray();
    const by = new Map();
    for (const m of msgs) {
      const agentId = agentOf.get(String(m.conversationId));
      if (!agentId) continue;
      const row = by.get(agentId) || { agentId, turns: 0, daySet: new Set(), lastAt: null };
      row.turns += 1;
      row.daySet.add(centralParts(new Date(m.createdAt)).day);
      if (!row.lastAt || time(m.createdAt) > time(row.lastAt)) row.lastAt = m.createdAt;
      by.set(agentId, row);
    }
    return [...by.values()].map((r) => ({ agentId: r.agentId, turns: r.turns, days: r.daySet.size, lastAt: r.lastAt }));
  },
  /** Is this a character that may text (it exists, and it is nobody's Spotter)? */
  async characterOk(agentId) {
    const mongoose = require('mongoose');
    const agent = await mongoose.models.Agent.findOne({ id: String(agentId) }).select('id').lean();
    if (!agent) return false;
    const spotter = await mongoose.connection.collection('kadespotters').findOne({ agentId: String(agentId) }, { projection: { _id: 1 } });
    return !spotter;
  },
  /** What this character may know: the shared cards and its own, by the memory rules already in force. */
  async cards(userId, agentId) {
    const { getAllUserMemories } = require('~/models');
    const [shared, own] = await Promise.all([getAllUserMemories(userId, { agentId: null }), getAllUserMemories(userId, { agentId })]);
    return [...shared, ...own];
  },
  async thread(userId, agentId) {
    const row = await require('~/models/kadeMemorySummary').getMemorySummary(userId, agentId);
    return (row && row.thread) || '';
  },
  /** Real provider cents of a platform-paid turn, from its own usage rows; null when unknown. */
  async turnCents(conversationId) {
    if (!conversationId) return null;
    const rows = await require('mongoose')
      .connection.collection('transactions')
      .find({ conversationId: String(conversationId) })
      .project({ tokenValue: 1, kadeFactor: 1 })
      .toArray();
    if (!rows.length) return null;
    const usd = rows.reduce((sum, r) => {
      const f = typeof r.kadeFactor === 'number' && r.kadeFactor > 0 ? r.kadeFactor : 1;
      return sum + Math.abs(Number(r.tokenValue) || 0) / f / 1e6;
    }, 0);
    return usd > 0 ? usd * 100 : null;
  },
};

const data = () => seam.data || defaultData;

/**
 * Jev's reading of the candidates, best first, one call each, stopping at the first yes.
 * Throws when Jev cannot answer (the caller sends nothing).
 * @returns {Promise<{ pick: object|null, asked: number, cents: number|null }>}
 */
async function defaultJudge(cands, s = settings()) {
  const jev = require('./kadeJev');
  let tokens = 0;
  let asked = 0;
  let pick = null;
  for (const c of cands) {
    const { state, questions } = judgeAsk(c);
    const { answers, usage } = await jev.ask(state, questions, 4000);
    asked += 1;
    tokens += Number((usage && (usage.input_tokens || usage.prompt_tokens)) || 0);
    const read = { worth: jev.noulOf(answers, 'worth'), heavy: jev.noulOf(answers, 'heavy') };
    if (worthIt(read, s)) {
      pick = { ...c, score: read.worth };
      break;
    }
  }
  return { pick, asked, cents: tokens > 0 ? tokens * JEV_CENTS_PER_TOKEN : null };
}

function speak(args) {
  return seam.speak ? seam.speak(args) : require('./kadeCharacterTurn').speakFirst(args);
}

/* ------------------------------------------------------------ one person's turn */

const short = (id) => String(id || '').slice(0, 8);

/** Everything known about a person that the rules need, and the verdict. */
async function standing(userId, { now, s, lastMessageAt, recheck = false }) {
  const d = data();
  const [person, state0, callAt] = await Promise.all([d.person(userId), readState(userId), d.lastCallAt(userId).catch(() => null)]);
  const lastActivityAt = time(callAt) > time(lastMessageAt) ? callAt : lastMessageAt;
  const state = reconcile(state0, lastActivityAt);
  if (state.answered) await writeState(userId, { ignored: 0 });
  /* A dry run may look again at someone already looked at today. */
  const seen = recheck ? { ...state, lastCheckDay: null } : state;
  return { person, state, lastActivityAt, verdict: personEligible({ person, state: seen, lastActivityAt, now, s }) };
}

/** The free look: what could any of this person's regular characters text about? */
async function gather(userId, state, { now, s }) {
  const d = data();
  const since = new Date(time(now) - s.windowDays * DAY_MS);
  const regular = regularCharacters(await d.talkedWith(userId, { since }), s).slice(0, 3);
  const cands = [];
  for (const r of regular) {
    if (!(await d.characterOk(r.agentId))) continue;
    const [cards, thread] = await Promise.all([d.cards(userId, r.agentId).catch(() => []), d.thread(userId, r.agentId).catch(() => '')]);
    cands.push(...candidatesFor({ agentId: r.agentId, cards, thread, now, used: state.used, s }));
  }
  /* The same shared card can come up under two characters: the one talked with most recently keeps it. */
  const seen = new Set();
  const unique = cands.filter((c) => {
    const k = `${c.kind}|${c.key}|${c.text}`;
    if (c.kind !== 'thread' && seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { regular, cands: unique.slice(0, 3) };
}

/**
 * Claim the day, spend the turn, read it, post it. The claim stays whatever happens next, so a
 * dropped or failed text is never tried twice in a day.
 */
async function sendOne({ userId, cand, state, now, s, day }) {
  if (!(await claimPersonDay(userId, day, now, { agentId: cand.agentId, kind: cand.kind }))) return { outcome: 'sent-today' };
  const reserved = await reserveSend(day, now, s);
  if (!reserved) {
    await coll().deleteOne({ _id: sendKey(userId, day) });
    return { outcome: 'platform-cap' };
  }
  const settle = (status, extra = {}) => coll().updateOne({ _id: sendKey(userId, day) }, { $set: { status, ...extra } });
  let problem = null;
  let out;
  try {
    out = await speak({
      userId,
      agentId: cand.agentId,
      note: buildNote(cand),
      kind: 'reach-out',
      platformPaid: true,
      push: true,
      /* The message is about one saved thing in their life; a lock screen on a table shows it to the room. */
      ...(s.plainPush ? { pushText: 'Sent you a message.' } : {}),
      beforePost: (composed) => {
        problem = wordingProblem(composed && composed.text, s);
        return !problem;
      },
    });
  } catch (e) {
    /* The turn may or may not have run: the money stays counted, the message does not. */
    await bumpDay(day, now, (d) => ({ sent: Math.max(0, d.sent - 1) }));
    await settle('failed', { why: String((e && e.message) || e).slice(0, 120) });
    return { outcome: 'failed' };
  }
  const real = await data()
    .turnCents(out && out.composeConversationId)
    .catch(() => null);
  if (real != null) await bumpDay(day, now, (d) => ({ cents: round(Math.max(0, d.cents - s.estCents + real)) }));
  if (!out || out.posted === false) {
    await bumpDay(day, now, (d) => ({ sent: Math.max(0, d.sent - 1) }));
    await settle('dropped', { why: problem || 'not-posted', cents: real });
    /* A SKIP means the character knows it is settled: that memory is not raised again. */
    if (problem === 'skip') await writeState(userId, { used: [...(state.used || []), usedKey(cand)].slice(-200) });
    return { outcome: `dropped:${problem || 'not-posted'}` };
  }
  await writeState(userId, {
    lastSentAt: now,
    lastSentDay: day,
    lastAgentId: cand.agentId,
    ignored: (state.ignored || 0) + 1,
    used: [...(state.used || []), usedKey(cand)].slice(-200),
  });
  await settle('sent', { cents: real, conversationId: out.conversationId || null });
  return { outcome: 'sent', conversationId: out.conversationId };
}

/** One person, start to finish. Never throws. */
async function consider(userId, { now, s, day, dry, lastMessageAt }) {
  try {
    const { state, verdict } = await standing(userId, { now, s, lastMessageAt, recheck: dry });
    if (!verdict.ok) return { outcome: verdict.why };
    const { regular, cands } = await gather(userId, state, { now, s });
    if (!regular.length) return { outcome: 'no-regular-character' };
    if (!cands.length) {
      if (!dry) await writeState(userId, { lastCheckDay: day });
      return { outcome: 'nothing-saved-to-say' };
    }
    let pick = cands[0];
    if (s.judge) {
      if (!(await reserveCheck(day, now, s))) return { outcome: 'platform-cap' };
      if (!dry) await writeState(userId, { lastCheckDay: day });
      let read;
      try {
        read = await (seam.judge || defaultJudge)(cands, s);
      } catch (e) {
        return { outcome: 'judge-unavailable' };
      }
      if (read.cents != null) await bumpDay(day, now, (d) => ({ cents: round(Math.max(0, d.cents - s.estCheckCents + read.cents)) }));
      pick = read.pick;
      if (!pick) return { outcome: 'nothing-worth-saying' };
    }
    if (dry) return { outcome: 'would-send', agentId: pick.agentId, kind: pick.kind };
    const sent = await sendOne({ userId, cand: pick, state, now, s, day });
    return { ...sent, agentId: pick.agentId, kind: pick.kind };
  } catch (e) {
    logger.warn(`[kadeReachOut] user=${short(userId)} skipped: ${e.message}`);
    return { outcome: 'error' };
  }
}

/* ---------------------------------------------------------------------- the tick */

let ticking = false;

/**
 * One pass. Safe to call as often as anyone likes: outside the texting hours it does nothing,
 * and one row per hour means two servers (or the timer and the clock route) never both run it.
 * @param {{ now?: Date, force?: boolean, dry?: boolean, userId?: string }} [opts]
 */
async function runTick({ now = new Date(), force = false, dry, userId } = {}) {
  const s = settings();
  if (!s.on) return { ok: false, disabled: true };
  const { day, hour } = centralParts(now);
  if (!force && !inHours(hour, s)) return { ok: true, skipped: 'outside texting hours' };
  if (ticking) return { ok: true, skipped: 'already running' };
  ticking = true;
  const reasons = {};
  const results = [];
  try {
    await ensureIndexes();
    if (!force) {
      try {
        await coll().insertOne({ _id: `t:${day}:${hour}`, at: now, expireAt: later(now, 3) });
      } catch (e) {
        if (dup(e)) return { ok: true, skipped: 'this hour already ran' };
        throw e;
      }
    }
    const isDry = dry === true || s.dry;
    const since = new Date(time(now) - s.windowDays * DAY_MS);
    let people = await data().recentPeople({ since });
    if (userId) people = people.filter((p) => p.userId === String(userId));
    /* Longest-quiet last: the freshest relationships get the day's few places first. */
    people.sort((a, b) => time(b.lastMessageAt) - time(a.lastMessageAt));
    let sent = 0;
    for (const p of people) {
      if (sent >= s.maxPerTick) break;
      const today = await dayRow(day, now);
      if (today.sent >= s.maxPerDay || today.cents >= s.maxCentsPerDay) {
        reasons['platform-cap'] = (reasons['platform-cap'] || 0) + 1;
        break;
      }
      const r = await consider(p.userId, { now, s, day, dry: isDry, lastMessageAt: p.lastMessageAt });
      reasons[r.outcome] = (reasons[r.outcome] || 0) + 1;
      if (r.agentId) results.push({ user: short(p.userId), agentId: r.agentId, kind: r.kind, outcome: r.outcome });
      if (r.outcome === 'sent' || r.outcome === 'would-send') sent += 1;
      if (r.outcome === 'platform-cap') break;
    }
    const today = await dayRow(day, now);
    logger.info(
      `[kadeReachOut] tick ${day} ${hour}h${isDry ? ' DRY' : ''}: people=${people.length} ` +
        `${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(' ') || 'nobody'} ` +
        `day: sent=${today.sent}/${s.maxPerDay} checks=${today.checks}/${s.maxChecksPerDay} cents=${today.cents}/${s.maxCentsPerDay}`,
    );
    return { ok: true, day, hour, dry: isDry, people: people.length, reasons, results, today: { sent: today.sent, checks: today.checks, cents: today.cents } };
  } catch (e) {
    logger.warn('[kadeReachOut] tick failed: ' + e.message);
    return { ok: false, error: String(e.message).slice(0, 200), reasons, results };
  } finally {
    ticking = false;
  }
}

function startTimer() {
  if (!on('KADE_REACHOUT_TIMER') || !on('KADE_REACHOUT')) {
    logger.info('[kadeReachOut] hourly timer not started (switched off)');
    return null;
  }
  const poke = () => runTick().catch(() => {});
  setTimeout(poke, 5 * 60 * 1000).unref();
  const t = setInterval(poke, 60 * 60 * 1000);
  t.unref();
  return t;
}

/* ------------------------------------------- the older bridge lane, same rules */

/**
 * The bridge's friend texts (POST /api/kade/soul/speak, kind "friend-text") ask here first, so
 * the off switch, the one-a-day rule and the platform ceilings hold for them too. Returns
 * `{ ok: false, why }` or `{ ok: true, done(out, error) }` to call when the turn is over.
 */
async function gateSpeak({ userId, agentId, now = new Date() }) {
  const s = settings();
  if (!s.on || !on('KADE_REACHOUT_SPEAK_GATE')) return { ok: true, done: async () => {} };
  await ensureIndexes();
  const { day } = centralParts(now);
  const [person, state] = await Promise.all([data().person(userId), readState(userId)]);
  const why =
    person.exists === false ? 'no-such-person'
    : state.off === true ? 'off-switch'
    : person.child ? 'child'
    : person.reviewSeat ? 'review-seat'
    : person.memoryOff ? 'memory-off'
    : null;
  if (why) return { ok: false, why };
  if (!(await claimPersonDay(userId, day, now, { agentId: String(agentId), kind: 'friend-text' }))) return { ok: false, why: 'sent-today' };
  if (!(await reserveSend(day, now, s))) {
    await coll().deleteOne({ _id: sendKey(userId, day) });
    return { ok: false, why: 'platform-cap' };
  }
  return {
    ok: true,
    done: async (out, error) => {
      const posted = !error && out && out.posted !== false;
      if (!posted) await bumpDay(day, now, (d) => ({ sent: Math.max(0, d.sent - 1) }));
      await coll().updateOne({ _id: sendKey(userId, day) }, { $set: { status: posted ? 'sent' : 'failed' } });
      if (posted) await writeState(userId, { lastSentAt: now, lastSentDay: day, lastAgentId: String(agentId), ignored: (state.ignored || 0) + 1 });
    },
  };
}

/* --------------------------------------------------- the chat turn's small hook */

/**
 * Called while a chat turn is being put together, with the request. If the person's own latest
 * words say stop (or ask for it back), the switch is written in the background and a short
 * platform note for this one reply is returned. Plain string work: it never waits on anything.
 * Stop is honoured on any lane where the server knows who is speaking; asking for it back
 * needs the person's own signed-in seat (a phone call is known by caller ID only).
 * @returns {string} the note, or ''
 */
function noteFromWords(req, env = process.env) {
  try {
    if (!on('KADE_REACHOUT', env) || !on('KADE_REACHOUT_OFF_WORDS', env)) return '';
    if (!req || !req.user || req.kadeHiddenRun === true) return '';
    const { latestWords } = require('./kadeSpendGate');
    const said = latestWords(req.body && req.body.text);
    if (!said.ok) return '';
    const want = switchWords(said.words);
    if (!want) return '';
    if (req.kadeOnBehalfOfUnresolved === true) return '';
    const behalf = req.kadeOnBehalfOf && req.kadeOnBehalfOf.id ? String(req.kadeOnBehalfOf.id) : null;
    const voice = Boolean(behalf || said.folded || (req.body && req.body.kadeOnBehalfOf));
    if (voice && !behalf) return '';
    if (want === 'on' && voice && behalf !== String(req.user.id)) return '';
    const userId = behalf || String(req.user.id);
    (seam.setOff || setOff)(userId, want === 'off', voice ? 'call' : 'chat').catch((e) =>
      logger.warn('[kadeReachOut] switch not saved: ' + e.message),
    );
    return want === 'off' ? NOTE_OFF : NOTE_ON;
  } catch (e) {
    return '';
  }
}

/** For the clock route: today's numbers and the settings in force. Nothing about anyone. */
async function stats(now = new Date()) {
  const s = settings();
  const { day, hour } = centralParts(now);
  const d = await dayRow(day, now);
  return {
    on: s.on,
    dry: s.dry,
    day,
    hourCentral: hour,
    inHours: inHours(hour, s),
    today: { sent: d.sent, checks: d.checks, cents: d.cents },
    settings: { ...s, onlyUsers: s.onlyUsers.length, excludeAgents: s.excludeAgents.length },
  };
}

module.exports = {
  settings,
  centralParts,
  switchWords,
  gapDays,
  reconcile,
  personEligible,
  regularCharacters,
  candidatesFor,
  judgeAsk,
  worthIt,
  buildNote,
  wordingProblem,
  usedKey,
  setOff,
  getSwitch,
  runTick,
  startTimer,
  gateSpeak,
  noteFromWords,
  stats,
  NOTE_OFF,
  NOTE_ON,
  _seam: seam,
};
