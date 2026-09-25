'use strict';
/**
 * KADE Sep 25 2026 (Part 291) — FUNDING: what each person's use really cost Kade, and what they
 * have paid her back.
 *
 * Her words: "can you somehow make those three things, the difference between the record of them
 * paying me back and what it cost me to actually fund them? Like, if a user asks an agent, they
 * should look the difference up."
 *
 *   realCostUSD   chat   = their transactions re-priced at today's real sticker rows (kadeRealCost:
 *                          never "charged / 2", credit rows never counted)
 *                 extras = their kadeusage costUSD as written (already real, charged at 1x; never
 *                          divided)
 *   paidBackUSD   = kadefundingledger kind 'repayment', not voided. Credit Kade loads with
 *                   add-credits is recorded as kind 'grant' and never counts.
 *   differenceUSD = realCostUSD - paidBackUSD (positive: Kade has covered more than was paid back;
 *                   negative: they are ahead)
 *
 * Direct provider cost only: fixed monthly bills (Railway, Inworld, Twilio numbers, Codemagic) and
 * background brains have no per-person record and are left out. Voice and phone chat turns run on
 * Kade's own seat, so the caller's share appears as their voice_chat estimate; with
 * KADE_VOICE_BILL_REAL=1 (Part 291) the real turns of a call the caller started are billed to the
 * caller as transactions tagged context 'voice', kept on their own "voice" line, and that call's
 * bridge estimate is written at $0. Outbound calls still run on Kade's seat and keep the estimate.
 * Kade's own figure never adds her voice_chat estimates: her seat's chat rows already hold them.
 *
 * No '~' requires at the top (defaultDeps loads them lazily), so node --test loads this file.
 */
const mongoose = require('mongoose');
const {
  CREDIT_USD,
  platformFactor,
  spendMatch,
  txGroupStage,
  createPricer,
  priceGroup,
  isAdminRole,
  voiceBilledReal,
  VOICE_KEY,
  isVoiceEstimate,
} = require('./kadeRealCost');

const cents = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100 || 0;
/** Dollars and cents for speech and pages: $1,234.50 (always positive; words carry the sign). */
const dollars = (n) =>
  `$${Math.abs(cents(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FEATURES = {
  chat: 'Text chats with characters',
  voice: 'Voice and phone conversations (estimated)',
  phone: 'Phone line minutes',
  speech: "Spoken replies (inside Kade's voice plan)",
  pictures: 'Pictures',
  video: 'Videos',
  audio: 'Songs, narration and Sound Booth',
  describe: 'Describing videos, photos and library items',
  search: 'Web searches',
  research: 'Deep research',
  rooms: 'Game tables, the debate room and the clubhouse',
  other: 'Other',
};

/** A feature's label. Voice is only "(estimated)" while the bridge's estimate is what is charged. */
function featureLabel(key, voiceReal = false) {
  return key === 'voice' && voiceReal ? 'Voice and phone conversations' : FEATURES[key];
}

function featureOf(service) {
  const s = String(service || '').toLowerCase();
  if (s === 'voice_chat') return 'voice';
  if (s === 'phone') return 'phone';
  if (s === 'tts' || s === 'inworld_tts') return 'speech';
  if (/^(flux|fal_image|gemini_image|image|avatar)/.test(s)) return 'pictures';
  if (/^fal_video/.test(s)) return 'video';
  if (/^(fal_audio|fal_song|fal_stable_audio|google_lyria|soundbooth|scenema|runpod|yue)/.test(s)) return 'audio';
  if (/^(describe|media|library)/.test(s)) return 'describe';
  if (/^(tavily|search)/.test(s)) return 'search';
  if (/^research/.test(s)) return 'research';
  if (/^(game_table|debate_room|clubhouse)/.test(s)) return 'rooms';
  return 'other';
}

function range(field, { from, to } = {}) {
  const m = {};
  if (from) m.$gte = new Date(from);
  if (to) m.$lt = new Date(to);
  return Object.keys(m).length ? { [field]: m } : {};
}

/** Midnight on the 1st, US Central (the same clock as routes/kade.js). */
function centralMonthStart(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(now)
    .reduce((o, x) => ((o[x.type] = x.value), o), {});
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return new Date(Date.UTC(+p.year, +p.month - 1, 1, 0, 0) + (now.getTime() - wall));
}

/** 'this_month' = since the 1st (Central); anything else = all time, or an explicit from/to. */
function windowFor(period, extra = {}, now = new Date()) {
  if (period === 'this_month') return { from: centralMonthStart(now) };
  return { from: extra.from || undefined, to: extra.to || undefined };
}

/**
 * Assemble one person's figures. Pure: every input is plain data.
 * @param {object} o
 * @param {{ _id: unknown, name?: string, username?: string, role?: string, kadeAccountType?: string }} o.user
 * @param {Array} [o.txGroups]   buckets from kadeRealCost.txGroupStage
 * @param {Array} [o.usageRows]  [{ _id: service | { service }, costUSD }]
 * @param {{ usd?: number, entries?: number, last?: Date }} [o.repaid]
 */
function compose({
  user,
  txGroups = [],
  usageRows = [],
  repaid,
  balanceCredits = null,
  price,
  factor,
  window = {},
  voiceReal = false,
}) {
  const byFeature = new Map();
  const add = (key, realUSD, chargedUSD, extra = {}) => {
    const f = byFeature.get(key) || {
      feature: key,
      label: featureLabel(key, voiceReal),
      realUSD: 0,
      chargedUSD: 0,
      services: [],
    };
    f.realUSD += realUSD;
    f.chargedUSD += chargedUSD;
    if (extra.service && !f.services.includes(extra.service)) f.services.push(extra.service);
    if (extra.estimated) f.estimated = true;
    byFeature.set(key, f);
  };
  const admin = isAdminRole(user.role);
  const unpriced = new Set();
  let voiceTx = false;
  for (const g of txGroups) {
    const p = priceGroup(g, price, factor);
    if (p.unpriced) unpriced.add(p.unpriced);
    /* Part 291: rows a billed voice turn wrote (context 'voice') keep their own line. */
    if (g._id && g._id.voice) voiceTx = true;
    add(g._id && g._id.voice ? 'voice' : 'chat', p.realUSD, p.chargedUSD);
  }
  for (const r of usageRows) {
    const id = r._id;
    const service = String((id && typeof id === 'object' ? id.service : id) ?? '');
    /* Review F14: an administrator's voice turns run on her own seat, so they are already in her
     * chat rows at the real price; her voice_chat estimates would count them twice. */
    if (admin && isVoiceEstimate(service)) continue;
    const cost = Number(r.costUSD) || 0; /* already real: never divided */
    /* A $0 voice_chat row (switch on) is a count, not an estimate. */
    add(featureOf(service), cost, cost, { service, estimated: isVoiceEstimate(service) && cost > 0 });
  }
  /* Review F40: with the switch on, an outbound call keeps the bridge's estimate, so one voice line
   * can hold real turns and estimates together; its label says which. */
  const voice = byFeature.get('voice');
  if (voice && voice.estimated) {
    voice.label = voiceTx ? 'Voice and phone conversations (partly estimated)' : FEATURES.voice;
  }
  const all = [...byFeature.values()];
  const realCostUSD = cents(all.reduce((s, f) => s + f.realUSD, 0));
  const paidBackUSD = cents((repaid && repaid.usd) || 0);
  const differenceUSD = cents(realCostUSD - paidBackUSD);
  return {
    userId: String(user._id),
    name: user.name || user.username || 'this person',
    admin,
    child: !admin && user.kadeAccountType === 'child',
    window: {
      from: window.from ? new Date(window.from).toISOString() : null,
      to: window.to ? new Date(window.to).toISOString() : null,
    },
    realCostUSD,
    chargedUSD: admin ? 0 : cents(all.reduce((s, f) => s + f.chargedUSD, 0)),
    paidBackUSD,
    differenceUSD,
    status: differenceUSD > 0 ? 'short' : differenceUSD < 0 ? 'ahead' : 'even',
    repayments: (repaid && repaid.entries) || 0,
    lastRepaymentAt: (repaid && repaid.last) || null,
    walletBalanceUSD: balanceCredits == null ? null : cents(balanceCredits * CREDIT_USD),
    multiplier: factor,
    voiceBilledReal: Boolean(voiceReal),
    breakdown: all
      .map((f) => ({ ...f, realUSD: cents(f.realUSD), chargedUSD: cents(f.chargedUSD) }))
      .sort((a, b) => b.realUSD - a.realUSD),
    unpricedModels: [...unpriced],
  };
}

function defaultDeps() {
  const m = (n) => mongoose.models[n] || mongoose.model(n);
  return {
    db: require('~/models'),
    env: process.env,
    Transaction: m('Transaction'),
    Balance: m('Balance'),
    User: m('User'),
    KadeUsage: require('~/models/kadeUsage').KadeUsage,
    Ledger: require('~/models/kadeFunding').KadeFundingEntry,
  };
}

const USER_FIELDS = { name: 1, username: 1, role: 1, kadeAccountType: 1 };
const usageGroupStage = (byUser) => ({
  $group: {
    _id: byUser ? { user: '$user', service: '$service' } : '$service',
    costUSD: { $sum: '$costUSD' },
    quantity: { $sum: '$quantity' },
  },
});
const repaidMatch = (extra, window) => ({ ...extra, kind: 'repayment', voidedAt: null, ...range('at', window) });

/** One person's figures, or null when the id is not an account. */
async function fundingSummary(userId, window = {}, deps = defaultDeps()) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) return null;
  const oid = new mongoose.Types.ObjectId(String(userId));
  const factor = platformFactor(deps.env);
  const [user, txGroups, usageRows, repaidRows, balance] = await Promise.all([
    deps.User.findById(oid, USER_FIELDS).lean(),
    deps.Transaction.aggregate([
      { $match: spendMatch({ user: oid, ...range('createdAt', window) }) },
      txGroupStage({ voice: VOICE_KEY }),
    ]),
    deps.KadeUsage.aggregate([{ $match: { user: oid, ...range('createdAt', window) } }, usageGroupStage(false)]),
    deps.Ledger.aggregate([
      { $match: repaidMatch({ user: oid }, window) },
      { $group: { _id: null, usd: { $sum: '$usd' }, entries: { $sum: 1 }, last: { $max: '$at' } } },
    ]),
    deps.Balance.findOne({ user: oid }, { tokenCredits: 1 }).lean(),
  ]);
  if (!user) return null;
  return compose({
    user,
    txGroups,
    usageRows,
    repaid: repaidRows[0],
    balanceCredits: balance ? balance.tokenCredits : null,
    price: createPricer(deps.db, factor),
    factor,
    window,
    voiceReal: voiceBilledReal(deps.env || process.env),
  });
}

/** Everyone with a cost or a repayment, most covered first. */
async function fundingPeople(window = {}, deps = defaultDeps()) {
  const factor = platformFactor(deps.env);
  const price = createPricer(deps.db, factor);
  const [users, tx, usage, repaid, balances] = await Promise.all([
    deps.User.find({}, USER_FIELDS).lean(),
    deps.Transaction.aggregate([
      { $match: spendMatch(range('createdAt', window)) },
      txGroupStage({ user: '$user', voice: VOICE_KEY }),
    ]),
    deps.KadeUsage.aggregate([
      { $match: { user: { $ne: null }, ...range('createdAt', window) } },
      usageGroupStage(true),
    ]),
    deps.Ledger.aggregate([
      { $match: repaidMatch({}, window) },
      { $group: { _id: '$user', usd: { $sum: '$usd' }, entries: { $sum: 1 }, last: { $max: '$at' } } },
    ]),
    deps.Balance.find({}, { user: 1, tokenCredits: 1 }).lean(),
  ]);
  const bucket = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const k = String(r._id && r._id.user);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return out;
  };
  const txBy = bucket(tx);
  const useBy = bucket(usage);
  const paidBy = new Map(repaid.map((r) => [String(r._id), r]));
  const balBy = new Map(balances.map((b) => [String(b.user), b.tokenCredits]));
  const voiceReal = voiceBilledReal(deps.env || process.env);
  return users
    .map((u) => {
      const k = String(u._id);
      return compose({
        user: u,
        txGroups: txBy.get(k) || [],
        usageRows: useBy.get(k) || [],
        repaid: paidBy.get(k),
        balanceCredits: balBy.has(k) ? balBy.get(k) : null,
        price,
        factor,
        window,
        voiceReal,
      });
    })
    .filter((s) => s.realCostUSD > 0 || s.paidBackUSD > 0)
    .sort((a, b) => b.differenceUSD - a.differenceUSD);
}

function sinceWords(s) {
  if (!s.window.from) return 'so far';
  const day = new Date(s.window.from).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'long',
    day: 'numeric',
  });
  return `since ${day}`;
}

/**
 * The plain spoken sentence. self: the person asking is the person described. When Kade asks about
 * someone else she is "you" and they are named.
 */
function spokenLine(s, { self = true } = {}) {
  const when = sinceWords(s);
  const cost = dollars(s.realCostUSD);
  const paid = dollars(s.paidBackUSD);
  const diff = dollars(s.differenceUSD);
  if (s.admin && self) {
    return `You pay the bills, so nothing is owed. Your own use has really cost ${cost} ${when}.`;
  }
  if (s.child && self) {
    const head =
      s.realCostUSD > 0
        ? `Kade is happy to take care of what your use costs, so there is nothing for you to worry about. It has come to ${cost} ${when}.`
        : "Kade is happy to take care of what your use costs, so there is nothing for you to worry about. It hasn't cost anything yet.";
    return s.paidBackUSD > 0 ? `${head} You've also given her ${paid} toward it, which was really kind.` : head;
  }
  if (self) {
    if (s.realCostUSD <= 0 && s.paidBackUSD <= 0) return "Your use hasn't cost Kade anything yet, so nothing is owed.";
    const head = `Your use has really cost Kade ${cost} ${when}.`;
    if (s.paidBackUSD <= 0) return `${head} You haven't paid her back anything yet, so the difference is ${diff}.`;
    if (s.status === 'ahead') return `${head} You've paid her back ${paid}, so you're ${diff} ahead.`;
    if (s.status === 'even') return `${head} You've paid her back ${paid}, so you're all square.`;
    return `${head} You've paid her back ${paid}, so the difference is ${diff}.`;
  }
  const name = s.name;
  if (s.realCostUSD <= 0 && s.paidBackUSD <= 0) return `${name}'s use hasn't cost you anything yet.`;
  const head = `${name}'s use has really cost you ${cost} ${when}.`;
  if (s.paidBackUSD <= 0) return `${head} ${name} hasn't paid you back anything yet, so the difference is ${diff}.`;
  if (s.status === 'ahead') return `${head} ${name} has paid you back ${paid}, so ${name} is ${diff} ahead.`;
  if (s.status === 'even') return `${head} ${name} has paid you back ${paid}, so you're all square.`;
  return `${head} ${name} has paid you back ${paid}, so the difference is ${diff}.`;
}

/** What the agent tool hands the model: the figures, a short breakdown and the sentence to say. */
function forModel(s, { self = true } = {}) {
  const notes = [
    "Direct provider cost only; Kade's fixed monthly bills are not shared out.",
    'The wallet balance is prepaid credit left, not the difference.',
  ];
  if (s.unpricedModels && s.unpricedModels.length) notes.push('Part of the chat figure is an estimate (a model with no price row).');
  if (s.admin && self) {
    notes.push(
      s.voiceBilledReal
        ? "Kade's own figure includes her own voice calls, outbound calls and calls from people with no linked account, which run on her seat; everyone else's calls to the characters are on their own figures."
        : "Kade's own figure includes voice and phone turns, which run on her seat.",
    );
  }
  if (s.child && self) {
    notes.push(
      "This is a child's account: say it gently and warmly, Kade is glad to cover it, and never suggest they owe her or should pay.",
    );
  }
  return {
    who: self ? 'the person asking' : s.name,
    period: s.window.from ? 'this month' : 'all time',
    realCostUSD: s.realCostUSD,
    paidBackUSD: s.paidBackUSD,
    differenceUSD: s.differenceUSD,
    status: s.status,
    breakdown: s.breakdown
      .filter((f) => f.realUSD >= 0.01)
      .slice(0, 6)
      .map((f) => ({ what: f.label, costUSD: f.realUSD, ...(f.estimated ? { estimated: true } : {}) })),
    ...(self && s.walletBalanceUSD != null ? { walletBalanceUSD: s.walletBalanceUSD } : {}),
    spoken: spokenLine(s, { self }),
    note: notes.join(' '),
  };
}

const REVIEW_SEAT_DEFAULT = '6a6125d73939d20b95251078';
/** The App Store review seat(s), by id (KADE_APP_REVIEW_USER_IDS, default the vischeck seat). */
function reviewSeatIds(env = process.env) {
  return String(env.KADE_APP_REVIEW_USER_IDS || REVIEW_SEAT_DEFAULT)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
function isReviewSeat(user, env = process.env) {
  if (!user) return false;
  const id = String(user.id || user._id || '').toLowerCase();
  if (id && reviewSeatIds(env).includes(id)) return true;
  try {
    const { libraryReviewSeat } = require('@librechat/api');
    if (typeof libraryReviewSeat === 'function') return libraryReviewSeat({ ...user, id });
  } catch (_) {
    /* the id list above still holds */
  }
  return false;
}

/** The acting person as the database knows them (role from the database, never from req). */
async function account(id, deps = defaultDeps()) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  const u = await deps.User.findById(id, { name: 1, username: 1, role: 1, email: 1, kadeAccountType: 1 }).lean();
  if (!u) return null;
  const admin = isAdminRole(u.role);
  return {
    id: String(u._id),
    name: u.name || u.username || '',
    admin,
    child: !admin && u.kadeAccountType === 'child',
    reviewSeat: isReviewSeat({ id: String(u._id), email: u.email }, deps.env || process.env),
  };
}

/** Same lookup as KadeMessage: email, exact name, then a first-name prefix. */
async function findPerson(text, deps = defaultDeps()) {
  const t = String(text || '').trim();
  if (!t) return {};
  if (t.includes('@')) {
    const u = await deps.User.findOne({ email: t.toLowerCase() }, { name: 1 }).lean();
    return u ? { one: { id: String(u._id), name: u.name || t } } : {};
  }
  const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let c = await deps.User.find({ name: new RegExp(`^${safe}$`, 'i') }, { name: 1 }).limit(3).lean();
  if (!c.length) c = await deps.User.find({ name: new RegExp(`^${safe}\\b`, 'i') }, { name: 1 }).limit(3).lean();
  if (c.length === 1) return { one: { id: String(c[0]._id), name: c[0].name } };
  if (c.length > 1) return { many: c.map((u) => u.name) };
  return {};
}

/** A repayment from the web form or an ops call: { userId, usd, at, note, clientKey }. */
function validateRepayment(body = {}, now = new Date()) {
  const userId = String(body.userId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(userId)) return { error: 'Pick who paid you back.' };
  const usd = Math.round(Number(String(body.usd ?? '').replace(/[$,\s]/g, '')) * 100) / 100;
  if (!Number.isFinite(usd) || usd < 0.01) return { error: 'The amount must be at least one cent.' };
  if (usd > 1000) return { error: 'That is over $1,000. Check the amount and try again.' };
  const rawAt = String(body.at || '').trim();
  /* A date-picker day is noon Central, so it lands on that day in every view. */
  const at = !rawAt ? now : /^\d{4}-\d{2}-\d{2}$/.test(rawAt) ? new Date(`${rawAt}T17:00:00Z`) : new Date(rawAt);
  if (Number.isNaN(at.getTime())) return { error: 'That date did not read. Use the date picker.' };
  if (at.getTime() > now.getTime() + 36 * 3600e3) return { error: 'That date is in the future.' };
  if (at < new Date('2026-01-01T00:00:00Z')) return { error: 'That date is before the platform existed.' };
  const clientKey = /^[A-Za-z0-9-]{8,64}$/.test(String(body.clientKey || '')) ? String(body.clientKey) : undefined;
  return { value: { userId, usd, at, note: String(body.note || '').trim().slice(0, 280), clientKey } };
}

module.exports = {
  FEATURES,
  featureLabel,
  featureOf,
  cents,
  dollars,
  centralMonthStart,
  windowFor,
  compose,
  fundingSummary,
  fundingPeople,
  spokenLine,
  forModel,
  reviewSeatIds,
  isReviewSeat,
  account,
  findPerson,
  validateRepayment,
};
