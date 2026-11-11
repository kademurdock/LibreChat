'use strict';
/**
 * KADE EVERYDAY (Nov 11 2026): reminders that really arrive, for every character, and the small
 * daily helpers that need no mailbox. Home agent plan (Nov 11 2026), cards 6 and 7.
 *
 * HOW REMINDERS DELIVERED BEFORE THIS (found Nov 11, read from the code):
 *   1. kade_notify set_reminder posted to the phone bridge (/reminders). The bridge kept the row in
 *      a file on its volume and, at the minute, sent the reminder's own words as an iPhone push
 *      through its shared notify budget (cooldown and daily caps applied; quiet hours did not). It
 *      refused outright when the person had no phone registered. A push that did not land was
 *      handed back to the site as a waiting chat note for whichever character spoke next.
 *   2. Memory cards of type "reminder" with a due time (the memory writer makes them from "remind
 *      me" in any chat) are swept here on the site every minute (kadeNudges.sweepDueReminders) and
 *      delivered by the person's Notifications page choice: a waiting chat note (the default), a
 *      browser push, or a phone call.
 *   Only characters whose record lists kade_notify could set either kind on purpose.
 *
 * WHAT THIS ADDS (switch KADE_REMIND_ALL, default on; =0 is exactly the old behaviour):
 *   - every character gets kade_notify (initialize.js autoTools). Where the record did not list
 *     it, it attaches only when the person's own words call for it (kadeToolRetrieval).
 *   - reminders and "check back" questions are rows on the site (kadereminders), owned by one
 *     person and one character. The same minute sweep delivers them (sweepDueReminders calls
 *     sweepDue below). Nothing here goes through reach-out, which stays a dry run.
 *   - delivery is code, never a model call: the reminder is posted into the person's
 *     conversation with that character as the character's own message, then a push opens that
 *     conversation. The lock screen says only "Harley has a reminder for you." unless the person
 *     asked for full wording; medicine is never named on a lock screen, whatever they chose.
 *     iPhone push first (the bridge, as a requested push, so the outreach budget never eats it),
 *     a browser push second. When neither reaches a device, the character is handed a note for
 *     the next time the person talks with it, and says it tried.
 *   - delivered or not is written to the ledger (lane safety's kadeLedger, through a small
 *     adapter, so this file works whether or not that exists yet).
 *   - at most two messages about one thing: a reminder and one check-back, or two check-backs.
 *   - "stop reminders" in the person's own words (text, or signed-in app voice) cancels every
 *     waiting reminder and check-back and pauses medicine times, until they ask for them back.
 *
 * CARD 7 (switch KADE_EVERYDAY, default on; needs KADE_REMIND_ALL on, since it is delivered the
 * same way): timers and alarms, the date and time where the person lives, a daily medicine
 * schedule, running lists, saved phone numbers, and paperwork or ride reminders as plain
 * reminders with a label. Lists, medicine and numbers belong to one person and are shared by
 * that person's characters; no query here ever reads another person's rows.
 *
 * PHONE LANE: a plain phone call is known only by caller ID, which can be borrowed or faked, so
 * it gets the time and nothing that belongs to a person: no reminders made, read or cancelled,
 * no lists, no medicine, no numbers, no stop by words (home agent plan, section 10). Signed-in
 * app voice counts as signed in when the bridge says so (KADE_STUDIO_APP_VOICE=1, as for songs).
 * A paired phone counts too once card 2 provides services/kadePhonePairing.isPairedCall(req).
 *
 * No '~' requires at load time, so node --test loads it.
 */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const tool = require('./kadeEverydayTool');
const spend = require('./kadeSpendGate');

const C = {
  reminders: 'kadereminders',
  meds: 'kademedicines',
  lists: 'kadelists',
  contacts: 'kadecontacts',
  prefs: 'kadeeverydayprefs',
};

const DEFAULT_ZONE = 'America/Chicago';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const MAX_PENDING = 60;
const MAX_DAYS_OUT = 400;
const MAX_CHAIN = 2;
const MAX_LISTS = 30;
const MAX_ITEMS = 200;
const MAX_CONTACTS = 100;
const MAX_MEDS = 20;
const MAX_DOSES_A_DAY = 8;
const LATE_NOTE_MS = 10 * MIN;
const MED_STALE_MS = 2 * 60 * MIN;
const STALE_SENDING_MS = 10 * MIN;
const CLEAR_ASK_MS = 10 * MIN;
const SHORT_TIMER_MS = 30 * MIN;

/* Test seams. Production leaves every one null. */
const seam = {
  coll: null,
  now: null,
  post: null,
  push: null,
  webPush: null,
  chatNote: null,
  ledger: null,
  bridge: null,
  pairing: null,
  setStopped: null,
  noTimers: false,
};

function now() {
  return seam.now ? seam.now() : new Date();
}

function coll(name) {
  return seam.coll ? seam.coll(name) : require('mongoose').connection.collection(name);
}

/* Driver 6 returns the document; older drivers wrap it in { value }. */
const unwrap = (found) => (found && Object.prototype.hasOwnProperty.call(found, 'value') && !found._id ? found.value : found);
const short = (id) => String(id || '').slice(0, 8);
const newId = (prefix) => `${prefix}${crypto.randomBytes(5).toString('hex')}`;

let indexed = false;
async function ensureIndexes() {
  if (indexed || seam.coll) return;
  indexed = true;
  try {
    await coll(C.reminders).createIndex({ status: 1, fireAt: 1 });
    await coll(C.reminders).createIndex({ userId: 1, status: 1 });
    await coll(C.meds).createIndex({ paused: 1, nextAt: 1 });
    await coll(C.meds).createIndex({ userId: 1 });
    await coll(C.lists).createIndex({ userId: 1 });
    await coll(C.contacts).createIndex({ userId: 1 });
  } catch (e) {
    logger.warn('[kadeEveryday] indexes not made: ' + e.message);
  }
}

/* ------------------------------------------------------------------ time */

function validZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(new Date(0));
    return true;
  } catch (_) {
    return false;
  }
}

const ZONE_WORDS = {
  central: 'America/Chicago',
  eastern: 'America/New_York',
  mountain: 'America/Denver',
  arizona: 'America/Phoenix',
  pacific: 'America/Los_Angeles',
  alaska: 'America/Anchorage',
  hawaii: 'Pacific/Honolulu',
  atlantic: 'America/Puerto_Rico',
};

/** "Pacific", "pacific time", "America/Denver" -> an IANA zone, or null. */
function zoneFromWords(words) {
  const raw = String(words || '').trim();
  if (!raw) return null;
  if (raw.includes('/') && validZone(raw)) return raw;
  const low = raw.toLowerCase().replace(/\b(?:standard|daylight|time|zone|us)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const abbr = { cst: 'central', cdt: 'central', est: 'eastern', edt: 'eastern', mst: 'mountain', mdt: 'mountain', pst: 'pacific', pdt: 'pacific' };
  const key = abbr[low] || low;
  return ZONE_WORDS[key] || null;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const o = {};
  for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
  return {
    y: Number(o.year),
    m: Number(o.month),
    d: Number(o.day),
    hh: Number(o.hour === '24' ? 0 : o.hour),
    mm: Number(o.minute),
    wd: WEEKDAYS.indexOf(String(o.weekday || '').slice(0, 3).toLowerCase()),
  };
}

const wallKey = (p) => Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);

/**
 * A wall clock time in `tz` as a real moment. A time the clocks skip (spring forward) becomes
 * the same time one hour on; a time that happens twice (fall back) is the first one.
 */
function wallToUtc(wall, tz, depth = 0) {
  const target = wallKey(wall);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const back = wallKey(partsIn(new Date(guess), tz));
    if (back === target) break;
    guess += target - back;
  }
  if (wallKey(partsIn(new Date(guess), tz)) !== target) {
    if (depth > 1) return new Date(guess);
    const shifted = new Date(target + 60 * MIN);
    return wallToUtc(
      { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), hh: shifted.getUTCHours(), mm: shifted.getUTCMinutes() },
      tz,
      depth + 1,
    );
  }
  const earlier = guess - 60 * MIN;
  if (wallKey(partsIn(new Date(earlier), tz)) === target) guess = earlier;
  return new Date(guess);
}

/** "8:40", "08:40", "20:40", "8:40 pm", "8pm" -> { hh, mm } or null. */
function parseClock(s) {
  const t = String(s || '').trim().toLowerCase().replace(/\./g, '');
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] === undefined ? 0 : Number(m[2]);
  const half = m[3] ? m[3][0] : '';
  if (m[2] === undefined && !half) return null;
  if (mm > 59) return null;
  if (half) {
    if (hh < 1 || hh > 12) return null;
    if (half === 'p' && hh !== 12) hh += 12;
    if (half === 'a' && hh === 12) hh = 0;
  }
  if (hh > 23) return null;
  return { hh, mm };
}

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function addDays(day, n) {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d) + n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The next time the wall clock in `tz` reads hh:mm, at least a minute from `from`. */
function nextClock(clock, tz, from) {
  const today = partsIn(from, tz);
  for (let i = 0; i < 3; i += 1) {
    const day = addDays(today, i);
    const at = wallToUtc({ ...day, ...clock }, tz);
    if (at.getTime() > from.getTime() + MIN) return at;
  }
  return null;
}

function dayString(p) {
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** "Thursday, November 12 at 8:00 AM" in `tz`. */
function spoken(date, tz, { year = false } = {}) {
  const day = date.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  const time = date.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day} at ${time}`;
}

function clockWords(date, tz) {
  return date.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
}

/* ----------------------------------------------------------------- lanes */

function appVoiceOn(env) {
  return String((env && env.KADE_STUDIO_APP_VOICE) ?? '') === '1';
}

/** Card 2 adapter: a phone paired to an account by a spoken code counts as that person. */
function pairedCall(req) {
  try {
    if (seam.pairing) return seam.pairing(req) === true;
    const P = require('./kadePhonePairing');
    return Boolean(P && typeof P.isPairedCall === 'function' && P.isPairedCall(req) === true);
  } catch (_) {
    return false;
  }
}

/**
 * Who is asking, and on which lane. Mirrors kadeStudio.actor, without the studio switch.
 * @returns {{ ok: boolean, userId?: string, lane?: 'text'|'app-voice'|'paired-phone'|'phone', why?: string }}
 */
function laneOf(req, env = process.env) {
  if (!req || !req.user || !req.user.id) return { ok: false, why: 'unavailable' };
  if (req.kadeHiddenRun === true) return { ok: false, why: 'hidden' };
  if (req.kadeOnBehalfOfUnresolved === true) return { ok: false, why: 'unknown-caller' };
  const body = req.body || {};
  const behalf = req.kadeOnBehalfOf;
  if (behalf && behalf.id) {
    const seat = String(req.user.role || '').toUpperCase() === 'ADMIN';
    if (seat && appVoiceOn(env) && body.kadeCallerSignedIn === true) {
      return { ok: true, userId: String(behalf.id), lane: 'app-voice' };
    }
    if (seat && pairedCall(req)) return { ok: true, userId: String(behalf.id), lane: 'paired-phone' };
    return { ok: true, userId: String(behalf.id), lane: 'phone' };
  }
  if (body.kadeOnBehalfOf) return { ok: false, why: 'unknown-caller' };
  if (spend.latestWords(body.text).folded) return { ok: true, userId: String(req.user.id), lane: 'phone' };
  return { ok: true, userId: String(req.user.id), lane: 'text' };
}

const personal = (lane) => lane === 'text' || lane === 'app-voice' || lane === 'paired-phone';

const PHONE_NO =
  'FAILED: not on a plain phone call. A phone number alone does not prove who is calling, so reminders, lists, medicine times and saved numbers ' +
  'are only for the signed-in app or text chat. Say that kindly in one sentence and offer to do it when they are in the app.';

/* ----------------------------------------------------------------- prefs */

async function prefs(userId) {
  return (await coll(C.prefs).findOne({ _id: String(userId) })) || { _id: String(userId) };
}

async function setPrefs(userId, set) {
  await coll(C.prefs).updateOne({ _id: String(userId) }, { $set: { ...set, updatedAt: now() } }, { upsert: true });
}

/** The person's zone: the one they told us, else the one their app sends, else Central. */
async function zoneOf(userId, req, lane, env = process.env) {
  const supplied = req && req.body && typeof req.body.timezone === 'string' ? req.body.timezone.trim() : '';
  if (!personal(lane)) return validZone(supplied) ? supplied : DEFAULT_ZONE;
  const p = await prefs(userId);
  if (validZone(p.tz)) return p.tz;
  if (validZone(supplied)) {
    setPrefs(userId, { tz: supplied, tzVia: 'app' }).catch(() => {});
    return supplied;
  }
  const fallback = String((env && env.LC_DEFAULT_TIMEZONE) || '').trim();
  return validZone(fallback) ? fallback : DEFAULT_ZONE;
}

/* ---------------------------------------------------------------- ledger */

/**
 * Write one row to the ledger (home agent card 4, lane safety). That service may not exist yet;
 * this adapter uses whichever writer it has and otherwise logs one line. Never chat text.
 */
function ledgerWrite(entry) {
  const row = { tool: 'kade_notify', at: now(), ...entry };
  try {
    if (seam.ledger) {
      seam.ledger(row);
      return true;
    }
    let L = null;
    try {
      L = require('./kadeLedger');
    } catch (_) {
      L = null;
    }
    const fn = L && [L.recordDelivery, L.record, L.write, L.append].find((f) => typeof f === 'function');
    if (fn) {
      Promise.resolve()
        .then(() => fn.call(L, row))
        .catch((e) => logger.warn('[kadeEveryday] ledger write failed: ' + e.message));
      return true;
    }
  } catch (_) {
    /* the ledger never breaks a delivery */
  }
  logger.info(`[kadeEveryday] ledger ${row.event} ${row.kind || ''} ${row.outcome || ''} user=${short(row.userId)} ref=${row.ref || ''}`);
  return false;
}

/* --------------------------------------------------------------- channels */

function bridgeBase() {
  return (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** iPhone push through the bridge: a push the person asked for, at the moment they picked. */
async function pushNative({ userId, agentId, agentName, body, conversationId }) {
  if (seam.push) return seam.push({ userId, agentId, agentName, body, conversationId });
  const secret = process.env.BRIDGE_SECRET || '';
  if (!secret) return { sent: 0, why: 'no bridge secret' };
  try {
    const r = await fetch(`${bridgeBase()}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        secret,
        agentId: String(agentId || 'kade-reminder'),
        agentName,
        title: String(agentName || 'Kade-AI').slice(0, 40),
        body,
        userId: String(userId),
        requested: true,
        urgent: true,
        route: conversationId ? 'conversation' : undefined,
        conversationId: conversationId || undefined,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json().catch(() => ({}));
    return { sent: Number(d && d.sent) || 0, why: (d && (d.blocked || d.note || d.error)) || '' };
  } catch (e) {
    return { sent: 0, why: e.message };
  }
}

async function pushWeb({ userId, title, body, conversationId }) {
  if (seam.webPush) return seam.webPush({ userId, title, body, conversationId });
  try {
    return await require('./kadeNudges').sendPushToUser(userId, { title, body, url: conversationId ? `/c/${conversationId}` : '/' });
  } catch (e) {
    return 0;
  }
}

/** A note the character gets the next time this person talks with it (that character only). */
async function chatNote({ userId, agentId, text }) {
  if (seam.chatNote) return seam.chatNote({ userId, agentId, text });
  await require('./kadeNudges').queueChatNudge(userId, text, 'everyday', agentId);
  return true;
}

async function postInChat({ userId, agentId, text, conversationId }) {
  if (seam.post) return seam.post({ userId, agentId, text, conversationId });
  return require('./kadeCharacterTurn').post({ userId, agentId, text, conversationId, title: 'Reminder', kind: 'reminder' });
}

/* The older bridge reminders, so a person hears all of theirs and can cancel any. */
function bridge() {
  if (seam.bridge) return seam.bridge;
  const secret = process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '';
  const headers = { 'x-notify-secret': secret, 'User-Agent': UA, 'Content-Type': 'application/json' };
  return {
    async list(userId) {
      if (!secret) return [];
      const r = await fetch(`${bridgeBase()}/reminders?userId=${encodeURIComponent(String(userId))}`, { headers, signal: AbortSignal.timeout(10000) });
      const d = await r.json().catch(() => ({}));
      return Array.isArray(d && d.reminders) ? d.reminders.filter((x) => String(x.userId) === String(userId)) : [];
    },
    async cancel(id) {
      if (!secret) return false;
      const r = await fetch(`${bridgeBase()}/reminders?id=${encodeURIComponent(String(id))}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000) });
      return r.ok;
    },
  };
}

/* -------------------------------------------------------------- wording */

function clean(text, max = 300) {
  return String(text || '')
    .replace(/%%%[\s\S]*?%%%/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** What the lock screen shows. Content free unless the person chose full wording; never a medicine. */
function lockLine({ agentName, kind, message, fullWording }) {
  const who = clean(agentName, 40) || 'Kade-AI';
  if (kind === 'medicine' || fullWording !== true) return `${who} has a reminder for you.`;
  const m = clean(message, 180);
  return m || `${who} has a reminder for you.`;
}

/** The message posted in the chat, built by code from the stored row. */
function messageFor(row, tz, at) {
  const text = clean(row.text);
  const due = new Date(row.fireAt);
  let msg;
  if (row.kind === 'checkback') msg = `Checking back, like you asked: ${text}`;
  else if (row.kind === 'timer') msg = text ? `Your timer is done: ${text}` : `Your ${row.minutes || ''} minute timer is done.`.replace('  ', ' ');
  else if (row.kind === 'alarm') msg = text ? `Alarm: ${text}` : `This is your ${clockWords(due, tz)} alarm.`;
  else if (row.label) msg = `Reminder (${clean(row.label, 40)}): ${text}`;
  else msg = `Reminder: ${text}`;
  if (at.getTime() - due.getTime() > LATE_NOTE_MS) {
    msg += ` (This was due at ${clockWords(due, tz)}. It is late because the server was busy or asleep.)`;
  }
  return msg;
}

/**
 * Deliver one message: post it in the chat, push the lock-screen line, fall back to a note for
 * the character, write the ledger. Returns what happened.
 */
async function deliver({ userId, agentId, agentName, kind, message, conversationId, fullWording, ref, dueAt, tz }) {
  const out = { posted: false, conversationId: conversationId || null, push: 0, web: 0, noted: false, why: '' };
  try {
    const placed = await postInChat({ userId, agentId, text: message, conversationId });
    out.posted = true;
    if (placed && placed.conversationId) out.conversationId = placed.conversationId;
  } catch (e) {
    out.why = `post: ${e.message}`;
  }
  const line = lockLine({ agentName, kind, message, fullWording });
  try {
    const native = await pushNative({ userId, agentId, agentName, body: line, conversationId: out.conversationId });
    out.push = Number(native && native.sent) || 0;
    if (!out.push && native && native.why) out.why = [out.why, `push: ${native.why}`].filter(Boolean).join('; ');
  } catch (e) {
    out.why = [out.why, `push: ${e.message}`].filter(Boolean).join('; ');
  }
  if (!out.push) {
    try {
      out.web = Number(await pushWeb({ userId, title: clean(agentName, 40) || 'Kade-AI', body: line, conversationId: out.conversationId })) || 0;
    } catch (_) {
      out.web = 0;
    }
  }
  const delivered = out.push > 0 || out.web > 0;
  if (!delivered) {
    const when = dueAt ? clockWords(new Date(dueAt), tz || DEFAULT_ZONE) : 'the time they picked';
    const where = out.posted ? ' It is also waiting in your conversation with them as your message.' : '';
    try {
      out.noted = Boolean(
        await chatNote({
          userId,
          agentId,
          text:
            `You tried to reach their phone at ${when} with a ${kind === 'medicine' ? 'medicine reminder' : kind === 'checkback' ? 'check-back question' : 'reminder'} and could not.` +
            ` It said: ${message}.${where} Tell them once, briefly, that you tried to reach them at ${when} and what it was about.`,
        }),
      );
    } catch (e) {
      out.why = [out.why, `note: ${e.message}`].filter(Boolean).join('; ');
    }
  }
  ledgerWrite({
    event: 'delivery',
    kind,
    ref,
    userId: String(userId),
    agentId: String(agentId || ''),
    outcome: delivered ? 'delivered' : 'not delivered',
    channel: out.push ? 'push' : out.web ? 'web-push' : out.posted ? 'chat' : 'none',
  });
  return { ...out, delivered };
}

/* ------------------------------------------------------------- reminders */

const OPEN = ['pending', 'sending'];
const SPENT = ['sent', 'missed'];

async function chainCount(userId, chainId) {
  const rows = await coll(C.reminders)
    .find({ userId: String(userId), chainId: String(chainId) })
    .limit(20)
    .toArray();
  return rows.filter((r) => OPEN.includes(r.status) || SPENT.includes(r.status)).length;
}

/** When should this fire? From in_minutes, or fire_date and fire_time in the person's zone. */
function fireTimeFrom(data, tz, at, { needTime = true } = {}) {
  const inMinutes = data.in_minutes;
  if (inMinutes !== undefined && inMinutes !== null && String(inMinutes) !== '') {
    const n = Number(inMinutes);
    if (!Number.isFinite(n) || n < 1) return { error: 'in_minutes must be 1 or more' };
    if (n > MAX_DAYS_OUT * 24 * 60) return { error: `that is more than ${MAX_DAYS_OUT} days away` };
    return { at: new Date(at.getTime() + Math.round(n) * MIN), minutes: Math.round(n) };
  }
  const clockText = data.fire_time || (/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(String(data.time || '').trim()) ? data.time : '');
  const clock = parseClock(clockText);
  if (!clock) return needTime ? { error: 'give in_minutes, or fire_time as HH:mm (and fire_date as YYYY-MM-DD for another day)' } : {};
  if (data.fire_date) {
    const day = parseDate(data.fire_date);
    if (!day) return { error: 'fire_date must be YYYY-MM-DD' };
    const when = wallToUtc({ ...day, ...clock }, tz);
    if (when.getTime() < at.getTime() + 30 * 1000) return { error: 'that time has already passed where they are' };
    if (when.getTime() > at.getTime() + MAX_DAYS_OUT * DAY) return { error: `that is more than ${MAX_DAYS_OUT} days away` };
    return { at: when };
  }
  return { at: nextClock(clock, tz, at) };
}

function armShortTimer(row) {
  if (seam.noTimers || seam.coll) return;
  const wait = new Date(row.fireAt).getTime() - Date.now();
  if (wait > SHORT_TIMER_MS || wait < 0) return;
  const t = setTimeout(() => {
    deliverReminderById(row._id).catch((e) => logger.warn('[kadeEveryday] short timer delivery failed: ' + e.message));
  }, wait + 500);
  if (t.unref) t.unref();
}

async function addReminder({ userId, agentId, agentName, kind, text, label, at, minutes, conversationId, follows, tz }) {
  ensureIndexes(); /* never waited for: it runs once per process, in the background */
  const pending = await coll(C.reminders)
    .find({ userId: String(userId), status: 'pending' })
    .limit(MAX_PENDING + 1)
    .toArray();
  if (pending.length >= MAX_PENDING) {
    return { error: `they already have ${MAX_PENDING} reminders waiting; cancel some first` };
  }
  const id = newId('r');
  let chainId = id;
  if (follows) {
    const parent = await coll(C.reminders).findOne({ _id: String(follows), userId: String(userId) });
    if (parent) chainId = parent.chainId || parent._id;
  }
  if (chainId !== id && (await chainCount(userId, chainId)) >= MAX_CHAIN) {
    return { error: 'two messages about one thing is the limit, so no more check-backs on it. Tell them you will leave it be' };
  }
  const row = {
    _id: id,
    userId: String(userId),
    agentId: String(agentId || ''),
    agentName: clean(agentName, 60) || 'Kade-AI',
    kind,
    text: clean(text),
    label: clean(label, 40) || null,
    minutes: minutes || null,
    fireAt: at,
    tz,
    status: 'pending',
    chainId,
    conversationId: conversationId || null,
    createdAt: now(),
  };
  await coll(C.reminders).insertOne(row);
  ledgerWrite({ event: 'set', kind, ref: id, userId: String(userId), agentId: String(agentId || ''), outcome: 'set' });
  armShortTimer(row);
  return { row };
}

/** Claim one due row and deliver it. Two servers can never both send it. */
async function deliverReminderById(id) {
  const claimed = unwrap(
    await coll(C.reminders).findOneAndUpdate(
      { _id: String(id), status: 'pending' },
      { $set: { status: 'sending', claimedAt: now() } },
      { returnDocument: 'after' },
    ),
  );
  if (!claimed || claimed.status !== 'sending') return null;
  return deliverClaimed(claimed);
}

async function deliverClaimed(row) {
  const at = now();
  const settle = (set) => coll(C.reminders).updateOne({ _id: row._id }, { $set: set });
  const p = await prefs(row.userId);
  if (p.remindersOff === true) {
    await settle({ status: 'stopped', settledAt: at });
    ledgerWrite({ event: 'delivery', kind: row.kind, ref: row._id, userId: row.userId, agentId: row.agentId, outcome: 'not delivered', channel: 'stopped' });
    return { status: 'stopped' };
  }
  /* The cap counts the other messages already sent about this one thing. */
  if (row.chainId && row.chainId !== row._id) {
    const others = (await coll(C.reminders).find({ userId: row.userId, chainId: row.chainId }).limit(20).toArray()).filter(
      (r) => r._id !== row._id && SPENT.includes(r.status),
    ).length;
    if (others >= MAX_CHAIN) {
      await settle({ status: 'capped', settledAt: at });
      ledgerWrite({ event: 'delivery', kind: row.kind, ref: row._id, userId: row.userId, agentId: row.agentId, outcome: 'not delivered', channel: 'capped' });
      return { status: 'capped' };
    }
  }
  const tz = validZone(row.tz) ? row.tz : DEFAULT_ZONE;
  const message = messageFor(row, tz, at);
  const out = await deliver({
    userId: row.userId,
    agentId: row.agentId,
    agentName: row.agentName,
    kind: row.kind,
    message,
    conversationId: row.conversationId,
    fullWording: p.fullWording === true,
    ref: row._id,
    dueAt: row.fireAt,
    tz,
  });
  const status = out.delivered ? 'sent' : out.posted || out.noted ? 'missed' : 'failed';
  await settle({
    status,
    settledAt: now(),
    postedAt: out.posted ? now() : null,
    outcome: { push: out.push, web: out.web, posted: out.posted, noted: out.noted },
  });
  logger.info(
    `[kadeEveryday] ${row.kind} ${row._id} user=${short(row.userId)} -> ${status} push=${out.push} web=${out.web} posted=${out.posted} noted=${out.noted}${out.why ? ` (${out.why.slice(0, 120)})` : ''}`,
  );
  return { status, ...out };
}

/* --------------------------------------------------------------- medicine */

function parseTimes(s) {
  const out = [];
  for (const part of String(s || '').split(/[,;]|\band\b/i)) {
    const c = parseClock(part);
    if (!c) {
      if (part.trim()) return null;
      continue;
    }
    const k = `${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
    if (!out.includes(k)) out.push(k);
  }
  return out.sort();
}

function parseDays(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || t === 'daily' || t === 'every day' || t === 'everyday') return 'daily';
  if (t === 'weekdays') return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (t === 'weekends') return ['sat', 'sun'];
  const days = [];
  for (const part of t.split(/[\s,;/]+/)) {
    if (!part || part === 'and') continue;
    const k = part.slice(0, 3);
    if (!WEEKDAYS.includes(k)) return null;
    if (!days.includes(k)) days.push(k);
  }
  return days.length ? days : null;
}

/** The next dose after `after`, in the schedule's own zone, DST-correct. */
function nextDose(med, after) {
  const tz = validZone(med.tz) ? med.tz : DEFAULT_ZONE;
  const start = partsIn(after, tz);
  for (let i = 0; i < 9; i += 1) {
    const day = addDays(start, i);
    const wd = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    if (med.days !== 'daily' && !(Array.isArray(med.days) && med.days.includes(WEEKDAYS[wd]))) continue;
    for (const t of med.times || []) {
      const c = parseClock(t);
      if (!c) continue;
      const at = wallToUtc({ ...day, ...c }, tz);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}

function daysWords(days) {
  if (days === 'daily') return 'every day';
  const names = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
  return (days || []).map((d) => names[d] || d).join(', ');
}

async function findMed(userId, name) {
  const key = clean(name, 80).toLowerCase();
  if (!key) return null;
  const rows = await coll(C.meds).find({ userId: String(userId) }).limit(MAX_MEDS + 5).toArray();
  return rows.find((r) => r.key === key) || rows.find((r) => r.key.includes(key) || key.includes(r.key)) || null;
}

async function deliverDose(med, doseAt, at) {
  const tz = validZone(med.tz) ? med.tz : DEFAULT_ZONE;
  const today = dayString(partsIn(doseAt, tz));
  if (med.skipDate === today) {
    ledgerWrite({ event: 'delivery', kind: 'medicine', ref: med._id, userId: med.userId, agentId: med.agentId, outcome: 'not delivered', channel: 'skipped-today' });
    return { status: 'skipped' };
  }
  const p = await prefs(med.userId);
  if (p.remindersOff === true) return { status: 'stopped' };
  const when = clockWords(doseAt, tz);
  if (at.getTime() - doseAt.getTime() > MED_STALE_MS) {
    /* Hours late (the server was down): say so in the chat, no buzz that could prompt a double dose. */
    try {
      await postInChat({
        userId: med.userId,
        agentId: med.agentId,
        text: `Your ${when} medicine reminder (${clean(med.name, 80)}) could not go out on time. Check your pill box before taking anything.`,
        conversationId: null,
      });
    } catch (_) {}
    ledgerWrite({ event: 'delivery', kind: 'medicine', ref: med._id, userId: med.userId, agentId: med.agentId, outcome: 'not delivered', channel: 'too-late' });
    return { status: 'late' };
  }
  const out = await deliver({
    userId: med.userId,
    agentId: med.agentId,
    agentName: med.agentName,
    kind: 'medicine',
    message: `Time for your ${when} medicine: ${clean(med.name, 80)}.`,
    conversationId: null,
    fullWording: false,
    ref: med._id,
    dueAt: doseAt,
    tz,
  });
  return { status: out.delivered ? 'sent' : 'missed', ...out };
}

/* ------------------------------------------------------------------ sweep */

/**
 * Deliver whatever is due. Called by kadeNudges.sweepDueReminders, which the minute timer and
 * the bridge clock both run. Rows already promised keep being delivered whatever the switches
 * say; the switches only stop new ones being made. KADE_REMIND_SWEEP=0 stops delivery outright.
 */
async function sweepDue({ limit = 50 } = {}) {
  if (String(process.env.KADE_REMIND_SWEEP ?? '') === '0') return 0;
  const at = now();
  let fired = 0;
  /* A row stuck in "sending" (a crash mid-delivery): back to pending if nothing was posted. */
  const stale = await coll(C.reminders)
    .find({ status: 'sending', claimedAt: { $lte: new Date(at.getTime() - STALE_SENDING_MS) } })
    .limit(limit)
    .toArray();
  for (const row of stale) {
    await coll(C.reminders).updateOne({ _id: row._id, status: 'sending' }, { $set: { status: row.postedAt ? 'missed' : 'pending' } });
  }
  const due = await coll(C.reminders).find({ status: 'pending', fireAt: { $lte: at } }).sort({ fireAt: 1 }).limit(limit).toArray();
  for (const row of due) {
    try {
      const r = await deliverReminderById(row._id);
      if (r && (r.status === 'sent' || r.status === 'missed')) fired += 1;
    } catch (e) {
      logger.error(`[kadeEveryday] reminder ${row._id} delivery failed: ${e.message}`);
    }
  }
  const doses = await coll(C.meds).find({ paused: false, nextAt: { $lte: at } }).limit(limit).toArray();
  for (const med of doses) {
    try {
      const doseAt = new Date(med.nextAt);
      const next = nextDose(med, new Date(Math.max(doseAt.getTime(), at.getTime())));
      const claimed = unwrap(
        await coll(C.meds).findOneAndUpdate(
          { _id: med._id, nextAt: med.nextAt, paused: false },
          { $set: { nextAt: next, lastDoseAt: doseAt } },
          { returnDocument: 'after' },
        ),
      );
      if (!claimed) continue;
      const r = await deliverDose(med, doseAt, at);
      if (r.status === 'sent' || r.status === 'missed') fired += 1;
    } catch (e) {
      logger.error(`[kadeEveryday] medicine ${med._id} delivery failed: ${e.message}`);
    }
  }
  return fired;
}

/** The soonest thing waiting, so the bridge clock can wake a sleeping site in time. */
async function nextDueAt() {
  const [r] = await coll(C.reminders).find({ status: 'pending' }).sort({ fireAt: 1 }).limit(1).toArray();
  const [m] = await coll(C.meds).find({ paused: false, nextAt: { $ne: null } }).sort({ nextAt: 1 }).limit(1).toArray();
  const times = [r && r.fireAt, m && m.nextAt].filter(Boolean).map((d) => new Date(d).getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/* ------------------------------------------------------------------ lists */

function listKey(name) {
  const k = clean(name, 60)
    .toLowerCase()
    .replace(/^(?:my|the|our)\s+/, '')
    .replace(/\s+list$/, '')
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\btodo\b|\bto do\b/, 'to-do')
    .trim();
  return k || 'to-do';
}

function splitItems(s) {
  return String(s || '')
    .split(/[,\n;]/)
    .map((x) => clean(x, 200))
    .filter(Boolean);
}

async function getList(userId, key) {
  return coll(C.lists).findOne({ _id: `${userId}:${key}`, userId: String(userId) });
}

function readOut(name, items) {
  if (!items.length) return `OK. The ${name} list is empty.`;
  const words = items.map((i) => i.text);
  if (words.length <= 10) return `OK. The ${name} list has ${words.length} item${words.length === 1 ? '' : 's'}: ${words.join('; ')}.`;
  return `OK. The ${name} list has ${words.length} items. The first ten: ${words.slice(0, 10).join('; ')}. Ask if they want the rest.`;
}

/* --------------------------------------------------------------- contacts */

function contactKey(name) {
  return clean(name, 60)
    .toLowerCase()
    .replace(/'s\b/g, '')
    .replace(/\b(?:my|our|the|phone|cell|number|home|mobile)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanNumber(s) {
  const t = String(s || '').replace(/[^0-9+()\-. ]/g, '').replace(/\s+/g, ' ').trim();
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return t;
}

/* -------------------------------------------------------- stop by words */

const STOP_WORDS = [
  /\bstop\s+(?:all\s+)?(?:the\s+|my\s+|those\s+|these\s+|your\s+|of\s+the\s+|of\s+my\s+)?reminders?\b/,
  /\bstop\s+reminding\s+me\s*(?:[.!,]|please\b|ok(?:ay)?\b|now\b|$)/,
  /\bno\s+more\s+reminders?\b/,
  /\bturn\s+off\s+(?:all\s+)?(?:my\s+|the\s+|your\s+|those\s+)?reminders?\b/,
  /\bturn\s+(?:all\s+)?(?:my\s+|the\s+|your\s+|those\s+)?reminders?\s+off\b/,
  /\b(?:don'?t|do not|never)\s+remind\s+me\s+(?:anymore|any\s+more|again|of\s+anything|about\s+anything)\b/,
  /\bcancel\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?reminders\b/,
];
const ON_WORDS = [
  /\bturn\s+(?:my\s+|the\s+)?reminders?\s+(?:back\s+)?on\b/,
  /\bturn\s+on\s+(?:my\s+|the\s+)?reminders?\b/,
  /\b(?:start|resume|restart)\s+(?:my\s+|the\s+)?reminders?\b/,
  /\breminders?\s+back\s+on\b/,
  /\byou\s+can\s+remind\s+me\s+again\b/,
];

/** Did the person just say stop reminders (or ask for them back)? Their own short words only. */
function stopWords(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim() || raw.length > 400) return null;
  const low = raw.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ');
  if (/\b(?:said|says|told|tells|telling|saying|texted|wrote)\b[^.!?]{0,40}\b(?:stop|no more|don'?t|turn off|cancel)\b/.test(low)) return null;
  if (/\b(?:won'?t|will not|wouldn'?t|doesn'?t|does not|didn'?t|did not|can'?t|cannot|never)\s+(?:stop|quit)\b/.test(low)) return null;
  /* A question about how is not an order: "how do I stop reminders?" */
  if (/^\s*(?:how|can|could|should|would|what|why|when|where|is|are|do|does)\b[^.!]*\?\s*$/.test(low)) return null;
  if (/\b(?:phone|app|alarm|calendar|doctor|pharmacy|he|she|they|mom|dad|sister|brother)\s+(?:keeps?|won'?t)\b/.test(low)) return null;
  if (STOP_WORDS.some((re) => re.test(low))) return 'off';
  if (/\b(?:don'?t|do not|never|stop|quit|not)\b/.test(low)) return null;
  if (ON_WORDS.some((re) => re.test(low))) return 'on';
  return null;
}

const NOTE_OFF =
  '[PLATFORM NOTE, not something they typed: they just asked to stop reminders. Every reminder and check-back waiting for them, from every character, ' +
  'is now cancelled, daily medicine reminders are paused, and nothing new is sent until they ask for reminders back. Tell them so in one plain sentence.]';
const NOTE_ON =
  '[PLATFORM NOTE, not something they typed: they just asked for reminders back. Reminders work again and paused medicine times are back on. ' +
  'Reminders that were cancelled stay cancelled; offer to set any again. Tell them so in one plain sentence.]';
const NOTE_PHONE =
  '[PLATFORM NOTE, not something they typed: they asked to stop reminders, but this is a plain phone call and a phone number alone does not prove who is calling, ' +
  'so nothing was changed. Tell them kindly that they can say it in the app or in text chat, or turn reminders off on the Notifications page.]';

async function setStopped(userId, off) {
  const at = now();
  await setPrefs(userId, { remindersOff: off === true, remindersOffAt: at });
  if (off === true) {
    await coll(C.reminders).updateMany({ userId: String(userId), status: 'pending' }, { $set: { status: 'stopped', settledAt: at } });
    await coll(C.meds).updateMany({ userId: String(userId), paused: false }, { $set: { paused: true, pausedBy: 'stop' } });
    /* The older bridge reminders too, so "stop" means stop. */
    try {
      const b = bridge();
      for (const r of await b.list(userId)) await b.cancel(r.id);
    } catch (e) {
      logger.warn('[kadeEveryday] older reminders not cancelled: ' + e.message);
    }
  } else {
    const paused = await coll(C.meds).find({ userId: String(userId), paused: true, pausedBy: 'stop' }).limit(MAX_MEDS + 5).toArray();
    for (const med of paused) {
      await coll(C.meds).updateOne({ _id: med._id }, { $set: { paused: false, pausedBy: null, nextAt: nextDose(med, at) } });
    }
  }
  ledgerWrite({ event: off ? 'reminders-off' : 'reminders-on', userId: String(userId), outcome: 'done' });
  logger.info(`[kadeEveryday] reminders turned ${off ? 'OFF' : 'ON'} by the person user=${short(userId)}`);
}

/**
 * The chat turn's small hook (client.js): the person's own latest words. The write happens in
 * the background, so the reply never waits. Returns a one-reply note, or ''.
 */
function noteFromWords(req, env = process.env) {
  try {
    if (!tool.remindOn(env)) return '';
    if (!req || !req.user || req.kadeHiddenRun === true) return '';
    const said = spend.latestWords(req.body && req.body.text);
    if (!said.ok) return '';
    const want = stopWords(said.words);
    if (!want) return '';
    const who = laneOf(req, env);
    if (!who.ok) return '';
    if (!personal(who.lane)) return want === 'off' ? NOTE_PHONE : '';
    (seam.setStopped || setStopped)(who.userId, want === 'off').catch((e) => logger.warn('[kadeEveryday] stop switch not saved: ' + e.message));
    return want === 'off' ? NOTE_OFF : NOTE_ON;
  } catch (_) {
    return '';
  }
}

/* ------------------------------------------------------------ the actions */

const WHY = {
  unavailable: 'FAILED: this is not available here.',
  hidden: 'FAILED: a background job cannot set reminders or touch lists.',
  'unknown-caller': 'FAILED: the person on the line could not be matched to an account, so nothing can be saved for them.',
};

function setLine(row, tz) {
  const when = spoken(new Date(row.fireAt), tz);
  const what =
    row.kind === 'checkback'
      ? 'a check-back'
      : row.kind === 'timer'
        ? `a ${row.minutes} minute timer`
        : row.kind === 'alarm'
          ? 'an alarm'
          : row.label
            ? `a ${row.label} reminder`
            : 'a reminder';
  return (
    `OK. Reminder set (id ${row._id}, ${what}) for ${when}, their time. It will come as a message from you in this chat and a phone notification ` +
    'that says only that you have a reminder for them. Tell them the time back in one short sentence.'
  );
}

async function actReminders(action, data, ctx) {
  const { userId, agentId, agentName, tz, at, req } = ctx;
  if (action === 'set_reminder' || action === 'check_back' || action === 'timer' || action === 'alarm') {
    const p = await prefs(userId);
    if (p.remindersOff === true) {
      return 'FAILED: they asked to stop reminders, so none can be set. Ask whether they want reminders back on; if they say yes, call reminders_on, then set it.';
    }
    const kind = action === 'check_back' ? 'checkback' : action === 'set_reminder' ? 'reminder' : action;
    const text = clean(data.body);
    if ((kind === 'reminder' || kind === 'checkback') && !text) {
      return kind === 'checkback'
        ? 'FAILED: check_back needs body, the question to ask them later.'
        : 'FAILED: set_reminder needs body, the words of the reminder.';
    }
    const when = kind === 'timer'
      ? fireTimeFrom({ in_minutes: data.in_minutes }, tz, at)
      : kind === 'alarm'
        ? fireTimeFrom({ fire_time: data.fire_time || data.time, fire_date: data.fire_date }, tz, at)
        : fireTimeFrom(data, tz, at);
    if (when.error || !when.at) {
      return `FAILED: not set, ${when.error || (kind === 'timer' ? 'a timer needs in_minutes' : 'an alarm needs fire_time')}. Tell them it is not set.`;
    }
    const made = await addReminder({
      userId,
      agentId,
      agentName,
      kind,
      text,
      label: kind === 'reminder' ? data.label : null,
      at: when.at,
      minutes: when.minutes,
      conversationId: spend.conversationOf(req),
      follows: kind === 'checkback' ? data.follows : null,
      tz,
    });
    if (made.error) return `FAILED: not set, ${made.error}.`;
    return setLine(made.row, tz);
  }
  if (action === 'list_reminders') {
    const rows = await coll(C.reminders).find({ userId, status: 'pending' }).sort({ fireAt: 1 }).limit(MAX_PENDING).toArray();
    let older = [];
    try {
      older = await bridge().list(userId);
    } catch (_) {
      older = [];
    }
    if (!rows.length && !older.length) return 'OK. No reminders are waiting.';
    const lines = rows.map((r) => `id ${r._id}: ${r.kind === 'checkback' ? 'check-back' : r.kind}${r.label ? ` (${r.label})` : ''} ${spoken(new Date(r.fireAt), tz)}: ${clean(r.text) || '(no words)'}`);
    for (const r of older) lines.push(`id ${r.id}: reminder ${r.fireAtCentral || r.fireAt}: ${clean(r.text)}`);
    return `OK. ${lines.length} waiting:\n${lines.join('\n')}`;
  }
  if (action === 'cancel_reminder') {
    const id = String(data.schedule_id || '').trim();
    if (!id) return 'FAILED: cancel_reminder needs schedule_id from list_reminders.';
    if (/^r[0-9a-f]{10}$/.test(id)) {
      const r = await coll(C.reminders).updateOne({ _id: id, userId, status: 'pending' }, { $set: { status: 'cancelled', settledAt: at } });
      const n = (r && (r.modifiedCount ?? r.nModified)) || 0;
      return n ? 'OK. Reminder cancelled.' : 'FAILED: no waiting reminder of theirs has that id.';
    }
    const older = await bridge().list(userId).catch(() => []);
    if (!older.some((r) => String(r.id) === id)) return 'FAILED: no waiting reminder of theirs has that id.';
    return (await bridge().cancel(id)) ? 'OK. Reminder cancelled.' : 'FAILED: the older reminder could not be cancelled.';
  }
  if (action === 'reminder_wording') {
    const full = String(data.wording || '').toLowerCase() === 'full';
    await setPrefs(userId, { fullWording: full });
    return full
      ? 'OK. Lock-screen notifications will now show the reminder words. Medicine names are still never shown there.'
      : 'OK. Lock-screen notifications will say only that you have a reminder for them.';
  }
  if (action === 'reminders_on') {
    await setStopped(userId, false);
    return 'OK. Reminders are back on. Ones cancelled earlier stay cancelled.';
  }
  return 'FAILED: unknown reminder action.';
}

async function actMedicine(action, data, ctx) {
  const { userId, agentId, agentName, tz, at } = ctx;
  if (action === 'medicine_list') {
    const rows = await coll(C.meds).find({ userId }).limit(MAX_MEDS).toArray();
    if (!rows.length) return 'OK. No daily medicine times are saved.';
    return `OK. ${rows.length} saved:\n${rows
      .map((r) => `${r.name}: ${r.times.join(', ')} ${daysWords(r.days)}${r.paused ? ' (paused)' : ''}${r.skipDate === dayString(partsIn(at, r.tz || tz)) ? ' (skipping today)' : ''}`)
      .join('\n')}`;
  }
  if (action === 'medicine_add') {
    const name = clean(data.name, 80);
    if (!name) return 'FAILED: medicine_add needs name.';
    const times = parseTimes(data.times || data.fire_time || data.time);
    if (!times || !times.length) return 'FAILED: medicine_add needs times, for example 08:00,20:00.';
    if (times.length > MAX_DOSES_A_DAY) return `FAILED: at most ${MAX_DOSES_A_DAY} times a day.`;
    const days = parseDays(data.days);
    if (!days) return 'FAILED: days must be daily, or day names such as mon,wed,fri.';
    const p = await prefs(userId);
    if (p.remindersOff === true) return 'FAILED: they asked to stop reminders. Ask whether they want reminders back on; if yes, call reminders_on first.';
    const existing = await coll(C.meds).find({ userId }).limit(MAX_MEDS + 1).toArray();
    const key = name.toLowerCase();
    const same = existing.find((r) => r.key === key);
    if (!same && existing.length >= MAX_MEDS) return `FAILED: at most ${MAX_MEDS} medicines.`;
    const med = { userId, agentId: String(agentId || ''), agentName: clean(agentName, 60) || 'Kade-AI', name, key, times, days, tz, paused: false, skipDate: null };
    med.nextAt = nextDose(med, at);
    if (same) {
      await coll(C.meds).updateOne({ _id: same._id, userId }, { $set: { ...med, updatedAt: at } });
    } else {
      await coll(C.meds).insertOne({ _id: newId('m'), ...med, createdAt: at });
    }
    ledgerWrite({ event: 'set', kind: 'medicine', userId, agentId: String(agentId || ''), outcome: 'set' });
    return (
      `OK. Reminder set (id medicine, ${name}) at ${times.join(', ')} ${daysWords(days)}, their time. The first is ${spoken(med.nextAt, tz)}. ` +
      'The phone notification never names the medicine; the name is only in this chat. Read the times back in one sentence.'
    );
  }
  if (action === 'medicine_change') {
    const med = await findMed(userId, data.name);
    if (!med) return 'FAILED: no saved medicine by that name. Call medicine_list to hear the names.';
    const change = String(data.change || '').toLowerCase();
    if (change === 'remove') {
      await coll(C.meds).deleteOne({ _id: med._id, userId });
      return `OK. ${med.name} reminders are removed.`;
    }
    if (change === 'pause') {
      await coll(C.meds).updateOne({ _id: med._id, userId }, { $set: { paused: true, pausedBy: 'person' } });
      return `OK. ${med.name} reminders are paused until they ask to resume.`;
    }
    if (change === 'resume') {
      await coll(C.meds).updateOne({ _id: med._id, userId }, { $set: { paused: false, pausedBy: null, nextAt: nextDose(med, at) } });
      return `OK. ${med.name} reminders are back on.`;
    }
    if (change === 'skip_today') {
      const day = dayString(partsIn(at, validZone(med.tz) ? med.tz : tz));
      await coll(C.meds).updateOne({ _id: med._id, userId }, { $set: { skipDate: day } });
      return `OK. No ${med.name} reminders for the rest of today. They start again tomorrow.`;
    }
    return 'FAILED: change must be pause, resume, skip_today or remove.';
  }
  return 'FAILED: unknown medicine action.';
}

async function actLists(action, data, ctx) {
  const { userId, at, req } = ctx;
  if (action === 'list_read' && !String(data.list || '').trim()) {
    const rows = await coll(C.lists).find({ userId }).limit(MAX_LISTS).toArray();
    if (!rows.length) return 'OK. They have no lists yet.';
    return `OK. ${rows.length} list${rows.length === 1 ? '' : 's'}: ${rows.map((r) => `${r.name} (${(r.items || []).length})`).join('; ')}.`;
  }
  const key = listKey(data.list);
  const id = `${userId}:${key}`;
  const list = await getList(userId, key);
  const items = (list && list.items) || [];
  if (action === 'list_read') return readOut(key, items);
  if (action === 'list_add') {
    const add = splitItems(data.item);
    if (!add.length) return 'FAILED: list_add needs item.';
    if (!list) {
      const count = (await coll(C.lists).find({ userId }).limit(MAX_LISTS + 1).toArray()).length;
      if (count >= MAX_LISTS) return `FAILED: at most ${MAX_LISTS} lists.`;
    }
    const have = new Set(items.map((i) => i.text.toLowerCase()));
    const fresh = add.filter((t) => !have.has(t.toLowerCase()));
    const next = [...items, ...fresh.map((text) => ({ text, at }))];
    if (next.length > MAX_ITEMS) return `FAILED: a list holds at most ${MAX_ITEMS} items.`;
    await coll(C.lists).updateOne({ _id: id, userId }, { $set: { userId, name: key, items: next, updatedAt: at } }, { upsert: true });
    const dup = add.length - fresh.length;
    return `OK. Added ${fresh.length ? fresh.join('; ') : 'nothing new'} to the ${key} list${dup ? ` (${dup} already on it)` : ''}. It has ${next.length} item${next.length === 1 ? '' : 's'}.`;
  }
  if (action === 'list_remove') {
    const want = splitItems(data.item);
    if (!want.length) return 'FAILED: list_remove needs item.';
    if (!items.length) return `FAILED: the ${key} list is empty.`;
    let next = items;
    const gone = [];
    const unclear = [];
    for (const w of want) {
      const lw = w.toLowerCase();
      const exact = next.filter((i) => i.text.toLowerCase() === lw);
      const near = exact.length ? exact : next.filter((i) => i.text.toLowerCase().includes(lw) || lw.includes(i.text.toLowerCase()));
      if (near.length === 1) {
        gone.push(near[0].text);
        next = next.filter((i) => i !== near[0]);
      } else if (near.length > 1) {
        unclear.push(`${w} (could be ${near.map((i) => i.text).join(' or ')})`);
      } else {
        unclear.push(`${w} (not on it)`);
      }
    }
    if (gone.length) await coll(C.lists).updateOne({ _id: id, userId }, { $set: { items: next, updatedAt: at } });
    return `${gone.length ? 'OK' : 'FAILED'}. ${gone.length ? `Took off ${gone.join('; ')}.` : 'Nothing taken off.'}${unclear.length ? ` Not sure about: ${unclear.join('; ')}.` : ''} The ${key} list has ${next.length} item${next.length === 1 ? '' : 's'}.`;
  }
  if (action === 'list_clear') {
    if (!items.length) return `OK. The ${key} list is already empty.`;
    const p = await prefs(userId);
    const ask = p.pendingClear;
    const turn = spend.turnId(req);
    const said = spend.latestWords(req && req.body && req.body.text);
    const fresh = ask && ask.list === key && ask.turn !== turn && at.getTime() - new Date(ask.at).getTime() < CLEAR_ASK_MS;
    const topic = ['clear', 'empty', 'wipe', 'delete', 'erase', 'list', 'lists', 'all', 'them', 'everything', 'items', 'off', 'out', ...key.split(/[\s-]+/)];
    if (fresh && !spend.isReplay(req) && said.ok && spend.approvesPrice(said.words, { topic })) {
      await coll(C.lists).updateOne({ _id: id, userId }, { $set: { items: [], updatedAt: at } });
      await setPrefs(userId, { pendingClear: null });
      return `OK. The ${key} list is cleared (${items.length} item${items.length === 1 ? '' : 's'} taken off).`;
    }
    await setPrefs(userId, { pendingClear: { list: key, turn, at } });
    return `Not cleared yet. Ask them: clear all ${items.length} items from the ${key} list? Call list_clear again only after their own next message says yes.`;
  }
  return 'FAILED: unknown list action.';
}

async function actContacts(action, data, ctx) {
  const { userId, at } = ctx;
  if (action === 'contact_read' && !String(data.name || '').trim()) {
    const rows = await coll(C.contacts).find({ userId }).limit(MAX_CONTACTS).toArray();
    if (!rows.length) return 'OK. No numbers are saved.';
    return `OK. ${rows.length} saved: ${rows.map((r) => r.label).join('; ')}. Ask whose number they want.`;
  }
  const key = contactKey(data.name);
  if (!key) return `FAILED: ${action} needs name, for example my sister.`;
  const id = `${userId}:${key}`;
  if (action === 'contact_save') {
    const number = cleanNumber(data.number);
    if (!number) return 'FAILED: contact_save needs a phone number of 7 to 15 digits.';
    const existing = await coll(C.contacts).findOne({ _id: id, userId });
    if (!existing) {
      const count = (await coll(C.contacts).find({ userId }).limit(MAX_CONTACTS + 1).toArray()).length;
      if (count >= MAX_CONTACTS) return `FAILED: at most ${MAX_CONTACTS} saved numbers.`;
    }
    await coll(C.contacts).updateOne(
      { _id: id, userId },
      { $set: { userId, key, label: clean(data.name, 60), number, updatedAt: at } },
      { upsert: true },
    );
    return `OK. Saved the number for ${clean(data.name, 60)}. Read it back to them once so they can check it.`;
  }
  const row =
    (await coll(C.contacts).findOne({ _id: id, userId })) ||
    (await coll(C.contacts).find({ userId }).limit(MAX_CONTACTS).toArray()).find((r) => r.key.includes(key) || key.includes(r.key));
  if (!row) return 'FAILED: no saved number by that name. Say so; do not guess a number.';
  if (action === 'contact_read') return `OK. ${row.label}: ${row.number}`;
  if (action === 'contact_remove') {
    await coll(C.contacts).deleteOne({ _id: row._id, userId });
    return `OK. Removed the number for ${row.label}.`;
  }
  return 'FAILED: unknown contact action.';
}

/**
 * Run one kade_notify action that this file owns (see kadeEverydayTool.ownsAction).
 * @returns {Promise<string>} what the character is told, starting OK or FAILED
 */
async function handle({ action, data = {}, req, agentId, agentName, env = process.env }) {
  try {
    const who = laneOf(req, env);
    const at = now();
    if (action === 'now') {
      const tz = who.ok ? await zoneOf(who.userId, req, who.lane, env) : DEFAULT_ZONE;
      return `OK. It is ${spoken(at, tz, { year: true })} where they are (${tz}).`;
    }
    if (!who.ok) return WHY[who.why] || WHY.unavailable;
    if (!personal(who.lane)) return PHONE_NO;
    ensureIndexes(); /* never waited for: it runs once per process, in the background */
    const tz = await zoneOf(who.userId, req, who.lane, env);
    const ctx = { userId: who.userId, agentId, agentName, tz, at, req, lane: who.lane };
    if (action === 'set_timezone') {
      const zone = zoneFromWords(data.timezone);
      if (!zone) return 'FAILED: say the zone as Central, Eastern, Mountain, Pacific, Alaska, Hawaii or a name like America/Denver.';
      await setPrefs(who.userId, { tz: zone, tzVia: 'said' });
      return `OK. Their time zone is now ${zone}. It is ${spoken(at, zone)} there.`;
    }
    if (action.startsWith('medicine_')) return await actMedicine(action, data, ctx);
    if (action.startsWith('list_') && action !== 'list_reminders') return await actLists(action, data, ctx);
    if (action.startsWith('contact_')) return await actContacts(action, data, ctx);
    return await actReminders(action, data, ctx);
  } catch (e) {
    logger.warn(`[kadeEveryday] ${action} failed: ${e.message}`);
    return `FAILED: ${action} did not work (${String(e.message).slice(0, 120)}). Tell them plainly it was not done.`;
  }
}

function _resetForTests() {
  indexed = false;
  for (const k of Object.keys(seam)) seam[k] = k === 'noTimers' ? false : null;
}

module.exports = {
  COLLECTIONS: C,
  handle,
  sweepDue,
  nextDueAt,
  deliverReminderById,
  noteFromWords,
  stopWords,
  setStopped,
  laneOf,
  lockLine,
  messageFor,
  wallToUtc,
  partsIn,
  nextClock,
  nextDose,
  parseClock,
  parseTimes,
  parseDays,
  zoneFromWords,
  listKey,
  contactKey,
  NOTE_OFF,
  NOTE_ON,
  NOTE_PHONE,
  MAX_CHAIN,
  _seam: seam,
  _resetForTests,
};
