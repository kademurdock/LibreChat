/**
 * KADE NUDGE ENGINE — delivery + the due-reminder/birthday sweep.
 * See api/models/kadeNudge.js for the channel model. Reminder cards are just
 * memory entries with type:'reminder' + dueAt (fields shipped June 30 2026);
 * the memory writer sets them when someone says "remind me ..." in any chat.
 * Server-side only, no Cowork/Claude dependency (Kade's July 1 rule).
 */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  KadePushSub,
  KadeNudgePref,
  KadePendingNudge,
  KadeNudgeState,
} = require('~/models/kadeNudge');

let webpush = null;
let pushConfigured = false;
try {
  // Optional dep: everything falls back to the free 'chat' channel without it.
  // eslint-disable-next-line import/no-extraneous-dependencies
  webpush = require('web-push');
  const pub = process.env.KADE_VAPID_PUBLIC_KEY;
  const priv = process.env.KADE_VAPID_PRIVATE_KEY;
  if (pub && priv) {
    webpush.setVapidDetails(
      process.env.KADE_VAPID_SUBJECT || 'mailto:kademurdock@gmail.com',
      pub,
      priv,
    );
    pushConfigured = true;
  }
} catch (e) {
  logger.warn('[kadeNudges] web-push not available; push channel disabled:', e.message);
}

function isPushConfigured() {
  return pushConfigured;
}

/** ---- US Central time helpers (whole family is Missouri; DST-safe) ---- */
function chicagoParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour === '24' ? 0 : parts.hour),
    mm: Number(parts.minute),
  };
}

/** "YYYY-MM-DD HH:mm" Central wall time -> UTC Date (tries both CST/CDT offsets, picks the one that round-trips). */
function chicagoToUtc(y, m, d, hh, mm) {
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm));
    const back = chicagoParts(candidate);
    if (back.y === y && back.m === m && back.d === d && back.hh === hh && back.mm === mm) {
      return candidate;
    }
  }
  // DST gap edge (2:30am on spring-forward night): just use CST
  return new Date(Date.UTC(y, m - 1, d, hh + 6, mm));
}

function parseCentralDateTime(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) {
    return null;
  }
  const dt = chicagoToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** ---- channels ---- */
async function sendPushToUser(userId, { title, body, url }) {
  if (!pushConfigured) {
    return 0;
  }
  const subs = await KadePushSub.find({ userId }).lean();
  let delivered = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({ title: title || 'Kade-AI', body: body || '', url: url || '/' }),
        { TTL: 60 * 60 * 24 },
      );
      delivered += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // subscription expired/revoked — prune it
        await KadePushSub.deleteOne({ _id: sub._id }).catch(() => {});
      } else {
        logger.warn(`[kadeNudges] push send failed (${err.statusCode}): ${err.message}`);
      }
    }
  }
  return delivered;
}

async function queueChatNudge(userId, text, type) {
  await KadePendingNudge.create({ userId, text, type, channel: 'chat' });
}

async function placeNudgeCall(userId, userName, phone, text) {
  const bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
  const secret = process.env.BRIDGE_SECRET;
  if (!secret || !phone) {
    return false;
  }
  const resp = await fetch(`${bridgeUrl}/outbound-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: phone,
      secret,
      userId: String(userId),
      userName: userName || undefined,
      calleeName: userName || undefined,
      purpose: text,
      context: 'This is a friendly scheduled nudge call the person opted into on the website. Deliver the message conversationally, chat briefly if they want, keep it short.',
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    logger.warn(`[kadeNudges] nudge call failed (${resp.status}): ${errBody.slice(0, 200)}`);
    return false;
  }
  return true;
}

/**
 * Delivers one nudge to one user via their chosen channel for that type,
 * falling back to the free 'chat' channel when the fancier one can't work
 * (no push subscription / no phone number / bridge says no). Always records
 * the nudge in KadePendingNudge — for 'chat' as the actual carrier, for
 * push/call as an already-delivered history row (so /notifications can show
 * "what has nudged me lately" either way).
 */
async function deliverNudge(userId, text, { type = 'reminder', userName = '' } = {}) {
  const prefs = (await KadeNudgePref.findOne({ userId }).lean()) || {};
  const channel = prefs[type === 'birthday' ? 'birthday' : 'reminders'] || 'chat';
  if (channel === 'off') {
    return 'off';
  }
  if (channel === 'push') {
    const sent = await sendPushToUser(userId, { title: 'Kade-AI', body: text, url: '/' });
    if (sent > 0) {
      await KadePendingNudge.create({ userId, text, type, channel: 'push', deliveredAt: new Date() });
      return 'push';
    }
    await queueChatNudge(userId, text, type);
    return 'chat';
  }
  if (channel === 'call') {
    const ok = await placeNudgeCall(userId, userName, prefs.phone, text).catch(() => false);
    if (ok) {
      await KadePendingNudge.create({ userId, text, type, channel: 'call', deliveredAt: new Date() });
      return 'call';
    }
    await queueChatNudge(userId, text, type);
    return 'chat';
  }
  await queueChatNudge(userId, text, type);
  return 'chat';
}

/** ---- next-chat pickup (called from the agent controller) ---- */
async function takePendingChatNudges(userId, limit = 5) {
  const pending = await KadePendingNudge.find({ userId, channel: 'chat', deliveredAt: null })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  if (pending.length === 0) {
    return [];
  }
  await KadePendingNudge.updateMany(
    { _id: { $in: pending.map((p) => p._id) } },
    { $set: { deliveredAt: new Date() } },
  );
  return pending;
}

/** ---- the sweep ---- */
async function sweepDueReminders() {
  const MemoryEntry = mongoose.models.MemoryEntry;
  if (!MemoryEntry) {
    return 0;
  }
  const now = new Date();
  const due = await MemoryEntry.find({
    type: 'reminder',
    completed: { $ne: true },
    status: { $ne: 'superseded' },
    dueAt: { $ne: null, $lte: now },
  })
    .limit(50)
    .lean();
  let fired = 0;
  for (const entry of due) {
    try {
      const staleDays = (now - new Date(entry.dueAt)) / 86400000;
      const suffix = staleDays > 1 ? ' (this one was scheduled a while back — the server may have been asleep)' : '';
      await deliverNudge(entry.userId, `Reminder: ${entry.value}${suffix}`, { type: 'reminder' });
      const rec = String(entry.recurrence || '').toLowerCase();
      if (['daily', 'weekly', 'monthly', 'yearly'].includes(rec)) {
        const next = new Date(entry.dueAt);
        // advance PAST now so a long outage can't machine-gun every missed occurrence
        while (next <= now) {
          if (rec === 'daily') { next.setUTCDate(next.getUTCDate() + 1); }
          if (rec === 'weekly') { next.setUTCDate(next.getUTCDate() + 7); }
          if (rec === 'monthly') { next.setUTCMonth(next.getUTCMonth() + 1); }
          if (rec === 'yearly') { next.setUTCFullYear(next.getUTCFullYear() + 1); }
        }
        await MemoryEntry.updateOne({ _id: entry._id }, { $set: { dueAt: next } });
      } else {
        await MemoryEntry.updateOne({ _id: entry._id }, { $set: { completed: true } });
      }
      fired += 1;
    } catch (err) {
      logger.error('[kadeNudges] reminder delivery failed:', err.message);
    }
  }
  return fired;
}

async function sweepBirthdays() {
  const nowCentral = chicagoParts();
  if (nowCentral.hh < 9) {
    return 0; // birthdays fire from 9am Central, never earlier
  }
  const today = `${String(nowCentral.m).padStart(2, '0')}-${String(nowCentral.d).padStart(2, '0')}`;
  const todayFull = `${nowCentral.y}-${today}`;
  const state =
    (await KadeNudgeState.findById('singleton')) || new KadeNudgeState({ _id: 'singleton' });
  if (state.lastBirthdayDay === todayFull) {
    return 0;
  }
  state.lastBirthdayDay = todayFull;
  await state.save();
  const celebrants = await KadeNudgePref.find({
    birthdayDate: today,
    birthday: { $nin: ['off', '', null] },
  }).lean();
  let fired = 0;
  for (const prefs of celebrants) {
    try {
      await deliverNudge(
        prefs.userId,
        'Happy birthday!! Everybody at Kade-AI hopes it is a great one. Come say hi — your favorite character has been told and wants to celebrate.',
        { type: 'birthday' },
      );
      fired += 1;
    } catch (err) {
      logger.error('[kadeNudges] birthday delivery failed:', err.message);
    }
  }
  return fired;
}

/** July 12 2026 (Kade: "people need to be prompted to add a number"):
 * ONE-TIME chat nudge for users with no phone on file — daily pass from 10am
 * Central, marks promptedPhone so nobody ever hears it twice. Chat channel
 * only (zero permission, lands at the start of their next conversation). */
async function sweepPhonePrompts() {
  const nowCentral = chicagoParts();
  if (nowCentral.hh < 10) {
    return 0;
  }
  const today = `${nowCentral.y}-${String(nowCentral.m).padStart(2, '0')}-${String(nowCentral.d).padStart(2, '0')}`;
  const state =
    (await KadeNudgeState.findById('singleton')) || new KadeNudgeState({ _id: 'singleton' });
  if (state.lastPhonePromptDay === today) {
    return 0;
  }
  state.lastPhonePromptDay = today;
  await state.save();
  const User = mongoose.models.User;
  if (!User) {
    return 0;
  }
  const users = await User.find({}, '_id').lean();
  let fired = 0;
  for (const u of users) {
    try {
      const pref = await KadeNudgePref.findOne({ userId: u._id }).lean();
      if (pref && (pref.promptedPhone || (pref.phone && pref.phone.trim()))) {
        continue;
      }
      await KadeNudgePref.updateOne(
        { userId: u._id },
        { $set: { promptedPhone: true } },
        { upsert: true },
      );
      await queueChatNudge(
        u._id,
        'One-time tip from the platform: if you add your phone number on the Notifications & Reminders page (account menu), reminders can CALL you, and the Kade-AI phone line can know it\'s you when you call in. Totally optional — mention it casually and move on.',
        'reminder',
      );
      fired += 1;
    } catch (err) {
      logger.warn('[kadeNudges] phone prompt failed for a user: ' + err.message);
    }
  }
  return fired;
}

/* One sweep pass — extracted (July 18 2026, clock migration) so the bridge's
 * clock service can run it via POST /api/kade/clock/nudges. Identical work to
 * what the interval below always did. */
async function runNudgeSweepOnce() {
  const reminders = await sweepDueReminders();
  const birthdays = await sweepBirthdays();
  const phonePrompts = await sweepPhonePrompts();
  if (reminders || birthdays || phonePrompts) {
    logger.info(`[kadeNudges] sweep fired ${reminders} reminder(s), ${birthdays} birthday nudge(s), ${phonePrompts} phone prompt(s)`);
  }
  return { reminders, birthdays, phonePrompts };
}

let sweepTimer = null;
function startNudgeSweep() {
  const intervalMs = Number(process.env.KADE_NUDGE_SWEEP_INTERVAL_MS || 60000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.info('[kadeNudges] sweep disabled (KADE_NUDGE_SWEEP_INTERVAL_MS=0)');
    return;
  }
  sweepTimer = setInterval(async () => {
    try {
      await runNudgeSweepOnce();
    } catch (err) {
      logger.error('[kadeNudges] sweep error:', err.message);
    }
  }, intervalMs);
  if (sweepTimer.unref) {
    sweepTimer.unref();
  }
  logger.info(`[kadeNudges] Nudge sweep started — every ${Math.round(intervalMs / 1000)}s (push ${pushConfigured ? 'CONFIGURED' : 'not configured — chat/call only'})`);
}


/** ---- Phase 2 (App Sleeping, July 18 2026): next-due reporting ----
 * While the app is awake it TELLS the bridge when the next reminder is due,
 * so the bridge's clock can stop poking every 60s and only wake the app when
 * something actually needs delivering. New reminders can only be created
 * while the app is awake (they come from live chats), so a 60s reporter
 * always gets the word out before Railway's idle-sleep window closes. */
async function computeNextDueAt() {
  const MemoryEntry = mongoose.models.MemoryEntry;
  if (!MemoryEntry) {
    return null;
  }
  const next = await MemoryEntry.findOne({
    type: 'reminder',
    completed: { $ne: true },
    status: { $ne: 'superseded' },
    dueAt: { $ne: null },
  })
    .sort({ dueAt: 1 })
    .select('dueAt')
    .lean();
  return next && next.dueAt ? new Date(next.dueAt).toISOString() : null;
}

let dueReportTimer = null;
let lastReportedDue = 'unreported'; // sentinel: always report once on boot
function startDueTimeReporter() {
  const bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) {
    logger.warn('[kadeNudges] due-time reporter disabled — no BRIDGE_SECRET');
    return;
  }
  const intervalMs = Number(process.env.KADE_DUE_REPORT_INTERVAL_MS || 60000);
  dueReportTimer = setInterval(async () => {
    try {
      const nextDueAt = await computeNextDueAt();
      const key = nextDueAt || 'none';
      if (key === lastReportedDue) {
        return;
      }
      const resp = await fetch(`${bridgeUrl}/clock/next-due`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-kade-secret': secret },
        body: JSON.stringify({ nextDueAt }),
      });
      if (resp.ok) {
        lastReportedDue = key; // only mark reported on success — failures retry next tick
      }
    } catch (err) {
      logger.warn('[kadeNudges] due-time report failed (will retry): ' + err.message);
    }
  }, intervalMs);
  if (dueReportTimer.unref) {
    dueReportTimer.unref();
  }
  logger.info(`[kadeNudges] Due-time reporter started — every ${Math.round(intervalMs / 1000)}s (App Sleeping phase 2)`);
}

module.exports = {
  isPushConfigured,
  deliverNudge,
  sendPushToUser,
  takePendingChatNudges,
  startNudgeSweep,
  runNudgeSweepOnce,
  computeNextDueAt,
  startDueTimeReporter,
  parseCentralDateTime,
  chicagoParts,
};
