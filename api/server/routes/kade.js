const express = require('express');
const mongoose = require('mongoose');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { logKadeUsage } = require('~/models/kadeUsage');
const { KadeAsset } = require('~/models/kadeAsset');
const { needsRefresh, getNewS3URL } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const PAYPAL = 'https://paypal.me/kademurdock';

/** credits -> USD */
const usd = (credits) => (credits || 0) / 1e6;
const round = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/* Best-effort Twilio account spend (account-wide infra cost, NOT per-user).
 * Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars on the LibreChat
 * service. NEVER throws — returns null on missing creds or any failure so the
 * dashboard always renders. Uses the rolled-up `totalprice` usage category. */
const TWILIO_TIMEOUT_MS = 6000;
async function fetchTwilioSpend() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  const authHeader = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const base = 'https://api.twilio.com/2010-04-01/Accounts/' + sid;
  const get = async (path) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TWILIO_TIMEOUT_MS);
    try {
      const r = await fetch(base + path, { headers: { Authorization: authHeader }, signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const totalPrice = (j) => {
    const recs = j && Array.isArray(j.usage_records) ? j.usage_records : [];
    const rec = recs.find((x) => x.category === 'totalprice');
    return rec ? round(Math.abs(parseFloat(rec.price) || 0)) : 0;
  };
  try {
    const [bal, month, all] = await Promise.all([
      get('/Balance.json'),
      get('/Usage/Records/ThisMonth.json?Category=totalprice&PageSize=1'),
      get('/Usage/Records/AllTime.json?Category=totalprice&PageSize=1'),
    ]);
    if (!bal && !month && !all) return null;
    return {
      balanceUSD: bal ? round(Math.abs(parseFloat(bal.balance) || 0)) : null,
      currency: (bal && bal.currency) || 'USD',
      monthToDateUSD: month ? totalPrice(month) : null,
      allTimeUSD: all ? totalPrice(all) : null,
    };
  } catch (e) {
    return null;
  }
}

function models() {
  return {
    Transaction: mongoose.models.Transaction || mongoose.model('Transaction'),
    Balance: mongoose.models.Balance || mongoose.model('Balance'),
    User: mongoose.models.User || mongoose.model('User'),
    KadeUsage: mongoose.models.KadeUsage || mongoose.model('KadeUsage'),
  };
}

/* ----------------------------------------------------------------------------
 * KADE Sep 5 2026 (Part 131) — GET /api/kade/my-cost
 * Her ask, verbatim: "it might be nice if people had a thing, aside from their
 * balance, that said you have cost the server this much since the first of the
 * month. Refreshing every month."
 *
 * The balance is what they were CHARGED (real stickers x KADE_BILLING_MULTIPLIER,
 * see data-schemas tx.ts). This is what they actually COST: charged model spend
 * divided back by the multiplier, plus the metered extras (phone minutes, images,
 * video, Scenema) at the real prices kadeUsage already records. Month starts at
 * midnight on the 1st, US Central, because that is the clock every other
 * platform note keeps. Any signed-in user reads their own; admins may pass
 * ?userId= to read another's. Never throws a 500 on a bad row -- a zero beats
 * a broken settings page.
 * -------------------------------------------------------------------------- */
function centralMonthStart(now = new Date()) {
  // First of the current month, 00:00 America/Chicago, as a UTC Date.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce((o, p) => ((o[p.type] = p.value), o), {});
  // Offset between Central wall clock and UTC at "now", applied to the 1st.
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  const offsetMs = now.getTime() - wall;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, 1, 0, 0) + offsetMs);
}
function billingMultiplierNow() {
  const raw = Number(process.env.KADE_BILLING_MULTIPLIER);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
router.get('/my-cost', requireJwtAuth, async (req, res) => {
  try {
    const { Transaction, KadeUsage } = models();
    const isAdmin = req.user && req.user.role === 'ADMIN';
    const userId = isAdmin && req.query.userId ? String(req.query.userId) : String(req.user.id);
    const since = centralMonthStart();
    const mult = billingMultiplierNow();
    const uid = new mongoose.Types.ObjectId(userId);
    const [tx] = await Transaction.aggregate([
      { $match: { user: uid, createdAt: { $gte: since } } },
      { $group: { _id: null, spend: { $sum: '$tokenValue' }, turns: { $sum: 1 } } },
    ]);
    const extras = await KadeUsage.aggregate([
      { $match: { user: uid, createdAt: { $gte: since } } },
      { $group: { _id: '$service', costUSD: { $sum: '$costUSD' }, quantity: { $sum: '$quantity' } } },
    ]);
    const chargedModelUSD = round(Math.abs(usd(tx ? tx.spend : 0)));
    const modelUSD = round(chargedModelUSD / mult);
    const extrasUSD = round(extras.reduce((s, r) => s + (r.costUSD || 0), 0));
    const totalUSD = round(modelUSD + extrasUSD);
    const label = `Since ${since.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' })} you have cost the server about $${totalUSD.toFixed(2)}.`;
    res.json({
      userId,
      monthStart: since.toISOString(),
      multiplier: mult,
      modelUSD,
      chargedModelUSD,
      modelTurns: tx ? tx.turns : 0,
      extrasUSD,
      extras: extras.map((r) => ({ service: r._id, costUSD: round(r.costUSD || 0), quantity: r.quantity })),
      totalUSD,
      spoken: label,
    });
  } catch (e) {
    logger.warn('[kade/my-cost] ' + (e && e.message));
    res.json({ totalUSD: 0, modelUSD: 0, extrasUSD: 0, spoken: 'Your server cost for this month is not available right now.' });
  }
});

/* ----------------------------------------------------------------------------
 * KADE Sep 5 2026 (Part 131) — ADMIN: GET /api/kade/books
 * The month so far, for the dashboard: the bridge's books line (charged vs real
 * provider spend, extras, fixed bills, the multiplier in force and the one the
 * month needed) plus every person's month-to-date SERVER COST (charged model
 * spend / multiplier + metered extras), most expensive first. The bridge is
 * the keeper of the daily balance snapshots, so "real" comes from there.
 * -------------------------------------------------------------------------- */
router.get('/books', requireJwtAuth, requireAdminAccess, async (req, res) => {
  const out = { monthStart: centralMonthStart().toISOString(), multiplier: billingMultiplierNow(), books: null, users: [] };
  try {
    const base = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    const secret = process.env.BRIDGE_SECRET || '';
    if (secret) {
      const r = await fetch(`${base}/monthly?secret=${encodeURIComponent(secret)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
      if (r.ok) out.books = await r.json();
    }
  } catch (e) { out.booksError = e && e.message; }
  try {
    const { Transaction, KadeUsage, User } = models();
    const since = centralMonthStart();
    const mult = billingMultiplierNow();
    const [tx, ku, users] = await Promise.all([
      Transaction.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$user', spend: { $sum: '$tokenValue' }, turns: { $sum: 1 } } }]),
      KadeUsage.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$user', costUSD: { $sum: '$costUSD' } } }]),
      User.find({}, { name: 1, email: 1, role: 1 }).lean(),
    ]);
    const names = {}; for (const u of users) names[String(u._id)] = { name: u.name || u.email || String(u._id), role: u.role };
    const rows = {};
    for (const t of tx) { const k = String(t._id); rows[k] = rows[k] || { userId: k, chargedModelUSD: 0, modelUSD: 0, extrasUSD: 0, turns: 0 }; rows[k].chargedModelUSD = round(Math.abs(usd(t.spend))); rows[k].modelUSD = round(rows[k].chargedModelUSD / mult); rows[k].turns = t.turns; }
    for (const e of ku) { const k = String(e._id); rows[k] = rows[k] || { userId: k, chargedModelUSD: 0, modelUSD: 0, extrasUSD: 0, turns: 0 }; rows[k].extrasUSD = round(e.costUSD || 0); }
    out.users = Object.values(rows).map((r) => ({ ...r, name: (names[r.userId] || {}).name || r.userId, role: (names[r.userId] || {}).role || null, totalUSD: round(r.modelUSD + r.extrasUSD) })).sort((a, b) => b.totalUSD - a.totalUSD);
    out.totalUSD = round(out.users.reduce((s, r) => s + r.totalUSD, 0));
  } catch (e) { out.usersError = e && e.message; }
  res.json(out);
});

/* ----------------------------------------------------------------------------
 * ADMIN: GET /api/kade/usage?days=30 — full per-user / per-service breakdown
 * -------------------------------------------------------------------------- */
router.get('/usage', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { Transaction, Balance, User, KadeUsage } = models();

    const [users, balances] = await Promise.all([
      User.find({}, { name: 1, username: 1, email: 1, role: 1 }).lean(),
      Balance.find({}, { user: 1, tokenCredits: 1 }).lean(),
    ]);

    const userMap = {};
    const blank = () => ({
      balanceUSD: 0,
      llmSpendUSD: { allTime: 0, window: 0 },
      services: {},
    });
    for (const u of users) {
      userMap[String(u._id)] = {
        userId: String(u._id),
        name: u.name || u.username || u.email || String(u._id),
        email: u.email || null,
        role: u.role || null,
        ...blank(),
      };
    }
    const ensureUser = (id) => {
      const k = String(id);
      if (!userMap[k]) {
        userMap[k] = { userId: k, name: k, email: null, role: null, ...blank() };
      }
      return userMap[k];
    };

    for (const b of balances) {
      ensureUser(b.user).balanceUSD = round(usd(b.tokenCredits));
    }

    const txAgg = await Transaction.aggregate([
      {
        $group: {
          _id: { user: '$user', recent: { $gte: ['$createdAt', since] } },
          spend: { $sum: '$tokenValue' },
        },
      },
    ]);
    for (const row of txAgg) {
      const u = ensureUser(row._id.user);
      const spendUSD = round(Math.abs(usd(row.spend)));
      u.llmSpendUSD.allTime = round(u.llmSpendUSD.allTime + spendUSD);
      if (row._id.recent) u.llmSpendUSD.window = round(u.llmSpendUSD.window + spendUSD);
    }

    const kuAgg = await KadeUsage.aggregate([
      {
        $group: {
          _id: { user: '$user', service: '$service', recent: { $gte: ['$createdAt', since] } },
          quantity: { $sum: '$quantity' },
          costUSD: { $sum: '$costUSD' },
          unit: { $first: '$unit' },
        },
      },
    ]);
    for (const row of kuAgg) {
      const u = ensureUser(row._id.user);
      const svc = row._id.service || 'unknown';
      if (!u.services[svc]) {
        u.services[svc] = {
          unit: row.unit || null,
          quantity: { allTime: 0, window: 0 },
          costUSD: { allTime: 0, window: 0 },
        };
      }
      u.services[svc].quantity.allTime += row.quantity || 0;
      u.services[svc].costUSD.allTime = round(u.services[svc].costUSD.allTime + (row.costUSD || 0));
      if (row._id.recent) {
        u.services[svc].quantity.window += row.quantity || 0;
        u.services[svc].costUSD.window = round(u.services[svc].costUSD.window + (row.costUSD || 0));
      }
    }

    const perUser = Object.values(userMap).sort(
      (a, b) => b.llmSpendUSD.allTime - a.llmSpendUSD.allTime,
    );
    const perService = {};
    const totals = {
      llmSpendUSD: { allTime: 0, window: 0 },
      extraSpendUSD: { allTime: 0, window: 0 },
      balanceUSD: 0,
    };
    const addService = (svc, unit, qA, qW, cA, cW) => {
      if (!perService[svc]) {
        perService[svc] = {
          unit: unit || null,
          quantity: { allTime: 0, window: 0 },
          costUSD: { allTime: 0, window: 0 },
        };
      }
      perService[svc].quantity.allTime += qA;
      perService[svc].quantity.window += qW;
      perService[svc].costUSD.allTime = round(perService[svc].costUSD.allTime + cA);
      perService[svc].costUSD.window = round(perService[svc].costUSD.window + cW);
    };
    for (const u of perUser) {
      totals.llmSpendUSD.allTime = round(totals.llmSpendUSD.allTime + u.llmSpendUSD.allTime);
      totals.llmSpendUSD.window = round(totals.llmSpendUSD.window + u.llmSpendUSD.window);
      totals.balanceUSD = round(totals.balanceUSD + u.balanceUSD);
      for (const [svc, d] of Object.entries(u.services)) {
        addService(svc, d.unit, d.quantity.allTime, d.quantity.window, d.costUSD.allTime, d.costUSD.window);
        totals.extraSpendUSD.allTime = round(totals.extraSpendUSD.allTime + d.costUSD.allTime);
        totals.extraSpendUSD.window = round(totals.extraSpendUSD.window + d.costUSD.window);
      }
    }
    totals.grandSpendUSD = {
      allTime: round(totals.llmSpendUSD.allTime + totals.extraSpendUSD.allTime),
      window: round(totals.llmSpendUSD.window + totals.extraSpendUSD.window),
    };

    let twilio = null;
    try {
      twilio = await fetchTwilioSpend();
    } catch (e) {
      twilio = null;
    }

    // KADE July 21 2026: Inworld voice-pool meter for the admin dashboard.
    // CALENDAR month (the pool renews monthly), not the rolling ?days window.
    // Site+apps TTS only -- phone-call synthesis happens on the bridge and is
    // not in kadeusage; the card's copy says so out loud.
    let inworld = null;
    try {
      const ttsMonth = await KadeUsage.aggregate([
        { $match: { service: 'tts', createdAt: { $gte: monthStart() } } },
        { $group: { _id: null, chars: { $sum: '$quantity' } } },
      ]);
      inworld = {
        monthChars: (ttsMonth[0] && ttsMonth[0].chars) || 0,
        includedChars: 25e6, // founder/creator plan allowance
        overagePerMillionUSD: 10,
      };
    } catch (e) {
      inworld = null;
    }

    return res.json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      windowSince: since.toISOString(),
      totals,
      twilio,
      inworld,
      perService,
      perUser,
    });
  } catch (error) {
    logger.error('[/api/kade/usage] error:', error);
    return res.status(500).json({ error: 'Failed to aggregate usage' });
  }
});

/* ----------------------------------------------------------------------------
 * SELF: GET /api/kade/my-usage — the logged-in user's OWN usage + suggested
 * donation (month-to-date spend). Safe for any authenticated user.
 * -------------------------------------------------------------------------- */
router.get('/my-usage', requireJwtAuth, async (req, res) => {
  try {
    const { Transaction, Balance, KadeUsage } = models();
    const userId = req.user.id || req.user._id;
    const oid = new mongoose.Types.ObjectId(String(userId));
    const since = monthStart();

    const [bal, txAgg, kuAgg] = await Promise.all([
      Balance.findOne({ user: oid }, { tokenCredits: 1 }).lean(),
      Transaction.aggregate([
        { $match: { user: oid } },
        {
          $group: {
            _id: { recent: { $gte: ['$createdAt', since] } },
            spend: { $sum: '$tokenValue' },
          },
        },
      ]),
      KadeUsage.aggregate([
        { $match: { user: oid } },
        {
          $group: {
            _id: { service: '$service', recent: { $gte: ['$createdAt', since] } },
            quantity: { $sum: '$quantity' },
            costUSD: { $sum: '$costUSD' },
          },
        },
      ]),
    ]);

    const month = { llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, phoneUSD: 0, otherUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0, phone_minutes: 0 };
    const all = { llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, phoneUSD: 0, otherUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0, phone_minutes: 0 };

    for (const r of txAgg) {
      const v = round(Math.abs(usd(r.spend)));
      all.llmUSD = round(all.llmUSD + v);
      if (r._id.recent) month.llmUSD = round(month.llmUSD + v);
    }
    const qKey = { tts: 'tts_chars', flux: 'flux_images', tavily: 'tavily_searches', phone: 'phone_minutes' };
    // Session 22: voice_chat = the bridge's per-call LLM estimate (calls ride
    // the proxy's own login, so LibreChat's balance system never sees them).
    // Its COST joins the Chat line -- it IS chat thinking, just by voice; its
    // token quantity deliberately joins no quantity counter (tokens aren't
    // minutes/chars/images).
    const cKey = { tts: 'ttsUSD', flux: 'fluxUSD', tavily: 'tavilyUSD', phone: 'phoneUSD', voice_chat: 'llmUSD' };
    for (const r of kuAgg) {
      const svc = r._id.service;
      if (cKey[svc]) {
        all[cKey[svc]] = round(all[cKey[svc]] + (r.costUSD || 0));
        if (qKey[svc]) { all[qKey[svc]] += r.quantity || 0; }
        if (r._id.recent) {
          month[cKey[svc]] = round(month[cKey[svc]] + (r.costUSD || 0));
          if (qKey[svc]) { month[qKey[svc]] += r.quantity || 0; }
        }
      } else {
        // anything else (fal_video, fal_image, future services) rolls into "other"
        all.otherUSD = round(all.otherUSD + (r.costUSD || 0));
        if (r._id.recent) month.otherUSD = round(month.otherUSD + (r.costUSD || 0));
      }
    }
    month.totalUSD = round(month.llmUSD + month.ttsUSD + month.fluxUSD + month.tavilyUSD + month.phoneUSD + month.otherUSD);
    all.totalUSD = round(all.llmUSD + all.ttsUSD + all.fluxUSD + all.tavilyUSD + all.phoneUSD + all.otherUSD);

    return res.json({
      user: { name: req.user.name || req.user.username || req.user.email, email: req.user.email },
      balanceUSD: round(usd(bal ? bal.tokenCredits : 0)),
      monthToDate: month,
      allTime: all,
      suggestedDonationUSD: month.totalUSD,
      monthLabel: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      paypal: PAYPAL,
    });
  } catch (error) {
    logger.error('[/api/kade/my-usage] error:', error);
    return res.status(500).json({ error: 'Failed to load your usage' });
  }
});


/* ----------------------------------------------------------------------------
 * SELF: GET /api/kade/my-assets — the logged-in user's generated videos and
 * images (newest first) for the /my-creations gallery. Any authenticated user.
 * -------------------------------------------------------------------------- */
/** Re-sign S3-signed URLs at read time so stored gallery links never expire. */
async function freshAssetUrl(url) {
  let u = String(url || '');
  if (u && !/^https?:\/\//i.test(u) && !u.startsWith('/')) {
    u = '/' + u;
  }
  try {
    if (/[?&]X-Amz-/.test(u) && typeof needsRefresh === 'function' && needsRefresh(u, 3600)) {
      u = await getNewS3URL(u);
    }
  } catch (e) {
    logger.warn('[kade] URL re-sign failed (serving stored URL):', e.message);
  }
  return u;
}

async function assetView(d, { withOwner = false } = {}) {
  const view = {
    id: String(d._id),
    kind: d.kind,
    service: d.service,
    url: await freshAssetUrl(d.url),
    backupUrl: d.backupUrl ? await freshAssetUrl(d.backupUrl) : '',
    description: d.description || '',
    shared: !!d.shared,
    prompt: d.prompt || '',
    model: d.model || '',
    costUSD: d.costUSD || 0,
    createdAt: d.createdAt,
  };
  /* Part 91.7 — a document's face is its generation-time spoken summary
   * (kade_make_file writes it into metadata.spoken). Exposed as one flat
   * field rather than the whole metadata blob: the blob is internal. */
  if (d.kind === 'document' && d.metadata && d.metadata.spoken) {
    view.spoken = String(d.metadata.spoken).slice(0, 1200);
  }
  if (withOwner) {
    const name = (d.user && (d.user.name || d.user.username)) || 'Someone';
    view.by = String(name).split(' ')[0];
    delete view.costUSD;
  }
  return view;
}

router.get('/my-assets', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const oid = new mongoose.Types.ObjectId(String(userId));
    const docs = await KadeAsset.find({ user: oid })
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();
    const assets = await Promise.all(docs.map((d) => assetView(d)));
    return res.json({ count: assets.length, assets });
  } catch (error) {
    logger.error('[/api/kade/my-assets] error:', error);
    return res.status(500).json({ error: 'Failed to load your creations' });
  }
});

/* ----------------------------------------------------------------------------
 * SELF: POST /api/kade/my-assets/:id/share — toggle an asset onto/off the
 * communal Wall of Fame. Body: { shared: true|false }. Owner only.
 * -------------------------------------------------------------------------- */
router.post('/my-assets/:id/share', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const oid = new mongoose.Types.ObjectId(String(userId));
    const shared = req.body?.shared === true || req.body?.shared === 'true';
    const r = await KadeAsset.updateOne(
      { _id: new mongoose.Types.ObjectId(String(req.params.id)), user: oid },
      { $set: { shared } },
    );
    if (!r.matchedCount) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.json({ ok: true, shared });
  } catch (error) {
    logger.error('[/api/kade/my-assets/share] error:', error);
    return res.status(500).json({ error: 'Failed to update sharing' });
  }
});

/* ----------------------------------------------------------------------------
 * DOWNLOAD: GET /api/kade/asset-download/:id — streams the media with a
 * Content-Disposition attachment so browsers actually SAVE it instead of
 * playing it (cross-origin fal.media links ignore the <a download> attribute).
 * Allowed for the asset's owner, or anyone signed-in if the asset is shared.
 * Prefers the primary URL, falls back to the B2 mirror.
 * -------------------------------------------------------------------------- */
router.get('/asset-download/:id', requireJwtAuth, async (req, res) => {
  try {
    const userId = String(req.user.id || req.user._id);
    const d = await KadeAsset.findById(String(req.params.id)).lean();
    if (!d || (String(d.user) !== userId && !d.shared)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const candidates = [d.url, d.backupUrl].filter(Boolean);
    let upstream = null;
    for (const raw of candidates) {
      try {
        let u = await freshAssetUrl(raw);
        if (u.startsWith('/')) {
          u = (process.env.DOMAIN_SERVER || 'https://kademurdock.com').replace(/\/$/, '') + u;
        }
        upstream = await axios.get(u, { responseType: 'stream', timeout: 60000 });
        break;
      } catch (e) {
        logger.warn('[asset-download] source failed, trying next:', e.message);
      }
    }
    if (!upstream) {
      return res.status(502).json({ error: 'Could not fetch the media from its source' });
    }
    /* Part 91.4 — documents (kade_make_file) carry their real extension in
     * `model`, because a .xlsx served as image/png downloads as a file Excel
     * refuses to open. */
    const docExt = d.kind === 'document' ? String(d.model || 'md').replace(/[^a-z0-9]/gi, '').slice(0, 5) : null;
    const docCt =
      { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', md: 'text/markdown' }[docExt] ||
      'application/octet-stream';
    const kindDefaultCt =
      d.kind === 'video' ? 'video/mp4'
        : d.kind === 'audio' ? 'audio/mpeg'
          : d.kind === 'document' ? docCt
            : 'image/png';
    const kindDefaultExt =
      d.kind === 'video' ? 'mp4'
        : d.kind === 'audio' ? 'mp3'
          : d.kind === 'document' ? (docExt || 'md')
            : 'png';
    /* Part 91.5 — for a DOCUMENT, our own known type beats the storage
     * bucket's guess. Backblaze hands back application/octet-stream for an
     * .xlsx, and a browser told "octet-stream" is a browser that may not know
     * to open it in a spreadsheet app. We generated the file, so we know
     * exactly what it is; only fall back to upstream when we do not. */
    const upstreamCt = String(upstream.headers['content-type'] || '');
    const ct =
      d.kind === 'document' && (!upstreamCt || /octet-stream/i.test(upstreamCt))
        ? kindDefaultCt
        : String(upstreamCt || kindDefaultCt);
    const ext =
      {
        'video/mp4': 'mp4', 'video/webm': 'webm',
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
        'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
        'audio/ogg': 'ogg', 'audio/webm': 'weba',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'text/csv': 'csv', 'text/markdown': 'md',
      }[ct.split(';')[0].trim()] || kindDefaultExt;
    const stamp = new Date(d.createdAt || Date.now()).toISOString().slice(0, 10);
    res.setHeader('Content-Type', ct);
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    res.setHeader('Content-Disposition', `attachment; filename="kade-ai-${d.kind}-${stamp}.${ext}"`);
    upstream.data.pipe(res);
  } catch (error) {
    logger.error('[/api/kade/asset-download] error:', error);
    return res.status(500).json({ error: 'Download failed' });
  }
});

/* ----------------------------------------------------------------------------
 * SAVE BY URL: GET /api/kade/media-save?u=<encoded media url>
 * Sibling of /asset-download/:id, but keyed on the media URL itself so the
 * in-chat inline players (Seed Audio / Rio video) can offer a real "save to
 * device" button the instant a clip is posted — without needing its gallery
 * asset id (which is written fire-and-forget and may not exist yet). Streams
 * the file with a Content-Disposition attachment so iOS Safari SAVES it (via
 * the share sheet) instead of just playing it. Host-allowlisted to fal's
 * media/CDN hosts so it can't be abused as an open proxy. Auth required.
 * -------------------------------------------------------------------------- */
const MEDIA_SAVE_HOSTS = /(^|\.)fal\.media$|(^|\.)fal\.run$|(^|\.)fal\.ai$/i;
router.get('/media-save', requireJwtAuth, async (req, res) => {
  try {
    const raw = String(req.query.u || '');
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return res.status(400).json({ error: 'Bad url' });
    }
    if (parsed.protocol !== 'https:' || !MEDIA_SAVE_HOSTS.test(parsed.hostname)) {
      return res.status(400).json({ error: 'Unsupported media host' });
    }
    let upstream;
    try {
      upstream = await axios.get(parsed.toString(), { responseType: 'stream', timeout: 60000 });
    } catch (e) {
      logger.warn('[media-save] fetch failed:', e.message);
      return res.status(502).json({ error: 'Could not fetch the media from its source' });
    }
    const ct = String(upstream.headers['content-type'] || 'application/octet-stream');
    const extFromCt = {
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/mp4': 'm4a',
    }[ct.split(';')[0].trim()];
    // Prefer the real extension from the URL path when it has one.
    const pathExt = (parsed.pathname.match(/\.([a-z0-9]{2,4})$/i) || [])[1];
    const ext = String(pathExt || extFromCt || 'bin').toLowerCase();
    const kind = ct.startsWith('video')
      ? 'video'
      : ct.startsWith('audio')
        ? 'audio'
        : ct.startsWith('image')
          ? 'image'
          : 'file';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', ct);
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    res.setHeader('Content-Disposition', `attachment; filename="kade-ai-${kind}-${stamp}.${ext}"`);
    upstream.data.pipe(res);
  } catch (error) {
    logger.error('[/api/kade/media-save] error:', error);
    return res.status(500).json({ error: 'Download failed' });
  }
});

/* ----------------------------------------------------------------------------
 * WALL OF FAME: GET /api/kade/wall — every asset users chose to share, newest
 * first, with the creator's first name. Any signed-in user (family only —
 * the page requires a login, nothing is public).
 * -------------------------------------------------------------------------- */
router.get('/wall', requireJwtAuth, async (req, res) => {
  try {
    const docs = await KadeAsset.find({ shared: true })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('user', 'name username')
      .lean();
    const assets = await Promise.all(docs.map((d) => assetView(d, { withOwner: true })));
    return res.json({ count: assets.length, assets });
  } catch (error) {
    logger.error('[/api/kade/wall] error:', error);
    return res.status(500).json({ error: 'Failed to load the wall' });
  }
});


/* ----------------------------------------------------------------------------
 * GAME ROOM LEADERBOARD: GET /api/kade/game-leaderboard — family standings
 * computed straight from kadegamestates (no separate results collection:
 * finished tables keep their full engine state, so every game ever played
 * counts). Any signed-in user — bragging rights are the whole point.
 * A table quit mid-game (status 'over' but the engine says not over) is
 * skipped entirely: walking away isn't a loss.
 * -------------------------------------------------------------------------- */
const { KadeGameState } = require('~/models/kadeGameState');
const { getGame: getParlorGame } = require('~/app/clients/tools/kadegames');
const { visualView } = require('~/app/clients/tools/kadegames/visual');

/* ----------------------------------------------------------------------------
 * GAME TABLE VISUAL: GET /api/kade/game-view/:gameId — render-ready JSON for
 * the chat's GameTable widget (July 3 2026). Owner-scoped: you only ever see
 * YOUR view of YOUR table (hole cards hidden, other hands as counts, trivia
 * answers never included — see kadegames/visual.js). Purely decorative for
 * sighted family; the widget is aria-hidden so screen readers are untouched.
 * -------------------------------------------------------------------------- */
router.get('/game-view/:gameId', requireJwtAuth, async (req, res) => {
  try {
    const gameId = String(req.params.gameId || '').slice(0, 12);
    const doc = await KadeGameState.findOne({ user: req.user.id, gameId }).lean();
    if (!doc) {
      return res.status(404).json({ error: 'No such table' });
    }
    const G = getParlorGame(doc.gameKey);
    if (!G) {
      return res.status(404).json({ error: 'Unknown game' });
    }
    const visual = visualView(doc.gameKey, doc.state);
    if (!visual) {
      return res.status(404).json({ error: 'No visual for this game' });
    }
    return res.json({
      gameId,
      game: doc.gameKey,
      name: G.meta.name,
      status: doc.status,
      updatedAt: doc.updatedAt,
      visual,
    });
  } catch (error) {
    logger.error('[/api/kade/game-view] error:', error);
    return res.status(500).json({ error: 'Failed to load the table' });
  }
});


/* ----------------------------------------------------------------------------
 * MY TABLES (July 23 2026, phase 5): GET /api/kade/my-tables — the signed-in
 * user's side of the parlor: fake-chip bank + resumable active tables. The
 * Game Room page shows it above the family standings.
 * -------------------------------------------------------------------------- */
router.get('/my-tables', requireJwtAuth, async (req, res) => {
  try {
    const { KadeGameChips } = require('~/models/kadeGameChips');
    const bank = await KadeGameChips.findOne({ user: req.user.id }).lean();
    const active = await KadeGameState.find({ user: req.user.id, status: 'active' })
      .sort({ updatedAt: -1 })
      .limit(12)
      .lean();
    return res.json({
      chips: bank ? bank.chips : 500,
      lifetimeWon: bank ? bank.lifetimeWon : 0,
      lifetimeLost: bank ? bank.lifetimeLost : 0,
      active: active.map((d) => {
        const G = getParlorGame(d.gameKey);
        return {
          gameId: d.gameId,
          name: G ? G.meta.name : d.gameKey,
          turns: d.turns,
          updatedAt: d.updatedAt,
        };
      }),
    });
  } catch (error) {
    logger.error('[/api/kade/my-tables] error:', error);
    return res.status(500).json({ error: 'Failed to load your tables' });
  }
});

router.get('/game-leaderboard', requireJwtAuth, async (req, res) => {
  try {
    const docs = await KadeGameState.find({})
      .sort({ updatedAt: -1 })
      .limit(5000)
      .populate('user', 'name username')
      .lean();

    const firstName = (u) =>
      ((u && (u.name || u.username)) || 'Someone').trim().split(/\s+/)[0] || 'Someone';

    const players = new Map(); // userId -> row
    const perGame = new Map(); // gameKey -> { name, played, byPlayer: Map }
    const recent = [];
    let activeTables = 0;
    let finished = 0;
    let biggestBlackjack = null;
    let bestTrivia = null;
    /* Daily Word streaks (Aug 6 2026, idea 49): day results per player off
     * the same doc scan — docs arrive updatedAt-desc, so the FIRST doc seen
     * for a (player, dateKey) is the one that counts. */
    const { computeStreak: dwComputeStreak, centralDateKey: dwToday } = require('~/app/clients/tools/kadegames/dailyWord');
    const dailyDays = new Map(); // uid -> { by, days: Map(dateKey -> won) }

    for (const d of docs) {
      const G = getParlorGame(d.gameKey);
      if (!G) continue;
      /* Phase 2.1 (July 28 2026): party tables now COUNT — every human seat
       * (host + each joined guest) gets its own win/loss/chips row off the
       * shared result. Contract: every party-capable game stores a numeric
       * winning seat in state.winner (hearts, five_card_draw, both judge
       * games — verified). A quit-mid-game party table is skipped exactly
       * like a solo one. */
      if (d.state && d.state.party) {
        if (d.status === 'active') {
          activeTables += 1;
          continue;
        }
        let pv;
        try {
          pv = G.view(d.state);
        } catch (_e) {
          continue;
        }
        if (!pv || !pv.over || typeof d.state.winner !== 'number') continue;
        finished += 1;
        const winnerSeat = d.state.winner;
        const seatsMap = (d.state.party && d.state.party.seats) || {};
        const humanSeats = [
          { seat: 0, uid: String(d.user && d.user._id ? d.user._id : d.user || 'unknown'), name: firstName(d.user) },
        ];
        for (const [k, s] of Object.entries(seatsMap)) {
          if (s && s.kind === 'guest' && s.userId) {
            humanSeats.push({
              seat: Number(k),
              uid: String(s.userId),
              name: (s.name || (d.state.names || [])[Number(k)] || 'A guest').trim().split(/\s+/)[0],
            });
          }
        }
        for (const h of humanSeats) {
          if (!players.has(h.uid)) {
            players.set(h.uid, { by: h.name, wins: 0, losses: 0, draws: 0, played: 0, chips: 0 });
          }
          const row = players.get(h.uid);
          row.played += 1;
          if (h.seat === winnerSeat) row.wins += 1;
          else row.losses += 1;
          if (G.meta.usesChips && typeof G.chipsDeltaSeat === 'function') {
            try {
              row.chips += G.chipsDeltaSeat(d.state, h.seat) || 0;
            } catch (_e) { /* chips are garnish, never break standings */ }
          }
        }
        if (!perGame.has(d.gameKey)) {
          perGame.set(d.gameKey, { key: d.gameKey, name: G.meta.name, played: 0, byPlayer: new Map() });
        }
        perGame.get(d.gameKey).played += 1;
        continue;
      }
      if (d.status === 'active') {
        activeTables += 1;
        continue;
      }
      let v;
      try {
        v = G.view(d.state);
      } catch (_e) {
        continue;
      }
      if (!v || !v.over || !v.winner) continue; // quit mid-game or unreadable — not a result
      finished += 1;

      const uid = String(d.user && d.user._id ? d.user._id : d.user || 'unknown');
      const by = firstName(d.user);
      const outcome = v.winner === 'player' ? 'won' : v.winner === 'push' || v.winner === 'tie' ? 'draw' : 'lost';

      if (!players.has(uid)) {
        players.set(uid, { by, wins: 0, losses: 0, draws: 0, played: 0, chips: 0 });
      }
      const p = players.get(uid);
      p.played += 1;
      if (outcome === 'won') p.wins += 1;
      else if (outcome === 'lost') p.losses += 1;
      else p.draws += 1;

      if (!perGame.has(d.gameKey)) {
        perGame.set(d.gameKey, { key: d.gameKey, name: G.meta.name, played: 0, byPlayer: new Map() });
      }
      const g = perGame.get(d.gameKey);
      g.played += 1;
      if (!g.byPlayer.has(uid)) g.byPlayer.set(uid, { by, w: 0, l: 0, d: 0, p: 0 });
      const gp = g.byPlayer.get(uid);
      gp.p += 1;
      if (outcome === 'won') gp.w += 1;
      else if (outcome === 'lost') gp.l += 1;
      else gp.d += 1;

      let detail = '';
      if (d.gameKey === 'blackjack') {
        const payout = Number(d.state && d.state.payout) || 0;
        p.chips += payout;
        detail = payout > 0 ? `won ${payout} chips` : payout < 0 ? `lost ${Math.abs(payout)} chips` : 'push';
        if (payout > 0 && (!biggestBlackjack || payout > biggestBlackjack.chips)) {
          biggestBlackjack = { by, chips: payout, when: d.updatedAt };
        }
      } else if (d.gameKey === 'trivia') {
        const score = (d.state && d.state.scores && d.state.scores[0]) || 0;
        const total = (d.state && d.state.qs && d.state.qs.length) || 0;
        detail = total ? `scored ${score} of ${total}` : '';
        if (total >= 3) {
          const pct = score / total;
          if (!bestTrivia || pct > bestTrivia.pct || (pct === bestTrivia.pct && total > bestTrivia.total)) {
            bestTrivia = { by, score, total, pct, when: d.updatedAt };
          }
        }
      } else if (d.gameKey === 'pig') {
        const score = (d.state && d.state.scores && d.state.scores[0]) || 0;
        detail = `finished with ${score} points`;
      } else if (d.gameKey === 'five_card_draw') {
        // July 23 2026 (phase 5): poker settles the same fake-chip column.
        const delta = (typeof G.chipsDelta === 'function' && G.chipsDelta(d.state)) || 0;
        p.chips += delta;
        detail = delta > 0 ? `won ${delta} chips` : delta < 0 ? `lost ${Math.abs(delta)} chips` : 'broke even';
      } else if (d.gameKey === 'hearts') {
        const sc = (d.state && d.state.scores) || [];
        detail = sc.length ? `finished with ${sc[0]} points` : '';
      } else if (d.gameKey === 'daily_word') {
        const n = (d.state && d.state.guesses && d.state.guesses.length) || 0;
        const won = v.winner === 'player';
        detail = won ? `solved in ${n}` : 'the word got away';
        const dk = d.state && d.state.dateKey;
        if (dk) {
          if (!dailyDays.has(uid)) dailyDays.set(uid, { by, days: new Map() });
          const rec = dailyDays.get(uid);
          if (!rec.days.has(dk)) rec.days.set(dk, won);
        }
      }

      if (recent.length < 12) {
        recent.push({ by, game: G.meta.name, outcome, detail, when: d.updatedAt });
      }
    }

    const playerRows = [...players.values()].sort((a, b) => b.wins - a.wins || b.played - a.played);
    const games = [...perGame.values()]
      .sort((a, b) => b.played - a.played)
      .map((g) => {
        const rows = [...g.byPlayer.values()].sort((a, b) => b.w - a.w || b.p - a.p);
        return { key: g.key, name: g.name, played: g.played, rows: rows.slice(0, 5) };
      });
    if (bestTrivia) delete bestTrivia.pct;

    /* Daily Word family board: current streaks first — the bragging number. */
    const todayKey = dwToday();
    const dailyWord = [...dailyDays.values()]
      .map((rec) => {
        const { current, best } = dwComputeStreak(rec.days, todayKey);
        const wins = [...rec.days.values()].filter(Boolean).length;
        return { by: rec.by, streak: current, best, wins, played: rec.days.size, playedToday: rec.days.has(todayKey) };
      })
      .sort((a, b) => b.streak - a.streak || b.best - a.best || b.wins - a.wins);

    return res.json({
      finished,
      activeTables,
      players: playerRows,
      games,
      highlights: { biggestBlackjack, bestTrivia },
      dailyWord,
      recent,
    });
  } catch (error) {
    logger.error('[/api/kade/game-leaderboard] error:', error);
    return res.status(500).json({ error: 'Failed to load the leaderboard' });
  }
});

/* ----------------------------------------------------------------------------
 * ADMIN: POST /api/kade/admin/phone-register { phone, name?, email? }
 * Session 22 (Kade: "you can build that thing you were talking about into my
 * dashboard"). Browser-safe skeleton key: the dashboard's "Add or link a
 * caller" card posts here with her ordinary admin login; this route holds
 * BRIDGE_SECRET server-side (env, set July 21) and forwards to the bridge's
 * /register, which MERGES onto any existing row. If an email is given, it's
 * checked against real site accounts first — attaching is still allowed
 * either way (fail-soft), but the card says out loud whether it matched,
 * because an email with no account attributes nothing and bills nobody.
 * -------------------------------------------------------------------------- */
router.post('/admin/phone-register', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const bridgeSecret = process.env.BRIDGE_SECRET;
    const bridgeUrl = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
    if (!bridgeSecret) return res.status(500).json({ error: 'BRIDGE_SECRET not configured on this service.' });
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 10) return res.status(400).json({ error: 'Need a full phone number (10 digits).' });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);

    let accountMatch = null;
    if (email) {
      const { User } = models();
      const u = await User.findOne({ email }, { _id: 1, name: 1 }).lean();
      accountMatch = u ? { found: true, name: u.name || email } : { found: false };
    }

    const body = { secret: bridgeSecret, phone };
    if (name) body.name = name;
    if (email) body.lcEmail = email;
    const axios = require('axios');
    const r = await axios.post(`${bridgeUrl}/register`, body, { timeout: 10000 });

    logger.info(`[kade/admin/phone-register] ${req.user.email} wired ${phone}${email ? ' -> ' + email : ''}`);
    return res.json({ ok: true, phone: r.data && r.data.phone, accountMatch });
  } catch (e) {
    logger.error('[kade/admin/phone-register]', e);
    return res.status(500).json({ error: 'Could not reach the bridge. Row not saved.' });
  }
});

/* ----------------------------------------------------------------------------
 * SERVICE: POST /api/kade/usage-event — secret-guarded ingestion so external
 * services (the phone bridge) can land per-user spend in kadeusage. No JWT:
 * the caller is a machine; KADE_USAGE_EVENT_SECRET (env, both sides) gates it.
 * -------------------------------------------------------------------------- */
router.post('/usage-event', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.body || {}).secret !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { userId, userEmail, service, quantity, unit, costUSD, metadata } = req.body || {};
    // Session 22 (voice-chat billing): the bridge's PHONE registry rows carry
    // the linked EMAIL (lcEmail), not the LibreChat user id -- accept either
    // and resolve email -> id here, where the User model lives.
    let uid = userId ? String(userId) : null;
    if (!uid && userEmail) {
      const { User } = models();
      const u = await User.findOne({ email: String(userEmail).toLowerCase().trim() }, { _id: 1 }).lean();
      if (u) uid = String(u._id);
    }
    if (!uid || !service || !(Number(quantity) > 0)) {
      return res.status(400).json({ error: 'userId (or a known userEmail), service, and a positive quantity are required' });
    }
    await logKadeUsage({
      userId: uid,
      service: String(service).slice(0, 32),
      quantity: Number(quantity),
      unit: unit ? String(unit).slice(0, 16) : undefined,
      costUSD: typeof costUSD === 'number' ? costUSD : undefined,
      metadata,
    });
    return res.json({ ok: true });
  } catch (error) {
    logger.error('[/api/kade/usage-event] error:', error);
    return res.status(500).json({ error: 'Failed to log usage event' });
  }
});

/* ----------------------------------------------------------------------------
 * SERVICE: POST /api/kade/asset-event — Part 119.9 (Sep 3 2026). The bridge's
 * Scenema lane finishes a render on RunPod and hands the MP3 here so it lands
 * in the user's My Creations exactly like a fal clip: logKadeAsset mirrors it
 * into our own S3 and writes the blind-friendly description. Same trust model
 * as /usage-event (KADE_USAGE_EVENT_SECRET, both sides).
 * -------------------------------------------------------------------------- */
router.post('/asset-event', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.body || {}).secret !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { userId, kind, service, url, prompt, model, costUSD, metadata } = req.body || {};
    const allowedKinds = ['video', 'image', 'audio', 'document'];
    if (!userId || !url || !allowedKinds.includes(String(kind)) || !/^https?:\/\//i.test(String(url))) {
      return res.status(400).json({ error: 'userId, kind (video|image|audio|document) and an http(s) url are required' });
    }
    const { logKadeAsset } = require('~/models/kadeAsset');
    await logKadeAsset({
      userId: String(userId),
      kind: String(kind),
      service: String(service || 'bridge').slice(0, 32),
      url: String(url),
      prompt: prompt ? String(prompt).slice(0, 2000) : undefined,
      model: model ? String(model).slice(0, 64) : undefined,
      costUSD: typeof costUSD === 'number' ? costUSD : 0,
      metadata,
    });
    return res.json({ ok: true });
  } catch (error) {
    logger.error('[/api/kade/asset-event] error:', error);
    return res.status(500).json({ error: 'Failed to log asset' });
  }
});

/* ----------------------------------------------------------------------------
 * HTML pages (no server-side auth; client JS gets a token via /api/auth/refresh
 * exactly like the SPA does, then calls the gated APIs above).
 * -------------------------------------------------------------------------- */
/* --- Feedback / bug reports (the kade_feedback tool writes here) ---------- */
const { KadeFeedback } = require('~/models/kadeFeedback');
const FEEDBACK_STATUSES = ['open', 'acknowledged', 'resolved', 'wontfix'];

/* ----------------------------------------------------------------------------
 * SELF: POST /api/kade/feedback { detail, category?, subject?, surface? } —
 * any signed-in user files a report directly. Session 23: the native app's
 * "Report a problem" screen posts here; the model's own doc comment always
 * claimed this route existed ("or directly via POST /api/kade/feedback") —
 * now it does. Same collection the kade_feedback chat tool writes and the
 * admin /feedback-dashboard reads, so reports land in one pile either way.
 * -------------------------------------------------------------------------- */
router.post('/feedback', requireJwtAuth, async (req, res) => {
  try {
    const detail = String((req.body || {}).detail || '').trim().slice(0, 8000);
    if (detail.length < 3) {
      return res.status(400).json({ error: 'Say a little about what happened.' });
    }
    const category = ['bug', 'feature', 'feedback'].includes((req.body || {}).category)
      ? req.body.category : 'feedback';
    const subjectRaw = String((req.body || {}).subject || '').trim().slice(0, 200);
    const surface = ['chat', 'phone', 'conversation', 'web', 'app'].includes((req.body || {}).surface)
      ? req.body.surface : 'app';
    const doc = await KadeFeedback.create({
      user: req.user.id,
      category,
      subject: subjectRaw || undefined,
      detail,
      surface,
      agent: 'Report a problem',
    });
    /* Session 23: owner alert (in-chat nudge + app push) — see
     * services/kadeOwnerAlerts. Fire-and-forget, never blocks the 200. */
    try {
      const { alertOwnerNewFeedback } = require('~/server/services/kadeOwnerAlerts');
      alertOwnerNewFeedback(doc, req.user.name || req.user.username).catch(() => {});
    } catch (_) {
      /* non-fatal */
    }
    return res.json({ ok: true, id: String(doc._id) });
  } catch (err) {
    logger.error(`[kade/feedback] user submit failed: ${err.message}`);
    return res.status(500).json({ error: 'Could not save your report. Try again.' });
  }
});

/** ADMIN: GET /api/kade/feedback?status=open|all — user-filed reports, newest first. */
router.get('/feedback', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const q = {};
    if (req.query.status && req.query.status !== 'all') {
      q.status = FEEDBACK_STATUSES.includes(req.query.status) ? req.query.status : 'open';
    }
    const items = await KadeFeedback.find(q)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('user', 'name email')
      .lean();
    res.json(items);
  } catch (err) {
    logger.error(`[kade/feedback] list failed: ${err.message}`);
    res.status(500).json({ error: 'Could not load feedback.' });
  }
});

/** ADMIN: POST /api/kade/feedback/:id/status { status } — triage a report.
 * Session 23 (Kade: "When I mark a bug resolved, it should probably be
 * relayed to that person... Whoever they reported the bug to, kiana or
 * whatever, should let them know. Then they can reopen it if they need
 * to."): flipping a report TO 'resolved' (from any other status) now
 * notifies the reporter over the SAME rail reminders use (deliverNudge):
 * push if that's their channel, else it queues for their next chat, where
 * whichever companion they talk to delivers it naturally in character. The
 * text names the report and the persona it was filed through, and tells
 * them they can reopen it by just saying so — the kade_feedback tool now
 * has action:'reopen' for exactly that. Fail-soft: a relay hiccup NEVER
 * breaks the admin action; the response's `relayed` field is the receipt
 * ('push' | 'chat' | 'call' | 'off' | null when no relay fired). */
router.post('/feedback/:id/status', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!FEEDBACK_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    const prev = await KadeFeedback.findById(req.params.id).lean();
    if (!prev) {
      return res.status(404).json({ error: 'Report not found.' });
    }
    /* Part 100: an optional note travels with the status flip — the
     * auto-resolve rule is that a report is only ever closed WITH a receipt
     * (the commit/build that shipped the fix), never on a guess. The note is
     * appended to the detail so the receipt lives on the row itself. */
    const update = { status };
    const noteText = String((req.body || {}).note || '').trim().slice(0, 2000);
    if (noteText) {
      const stamp = new Date().toISOString().slice(0, 10);
      update.detail = `${prev.detail || ''}\n\n[${stamp} → ${status}] ${noteText}`.slice(0, 8000);
    }
    const doc = await KadeFeedback.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    let relayed = null;
    if (status === 'resolved' && prev.status !== 'resolved' && doc.user) {
      try {
        const { deliverNudge } = require('~/server/services/kadeNudges');
        const label =
          doc.category === 'bug'
            ? 'bug you reported'
            : doc.category === 'feature'
              ? 'feature you asked for'
              : 'feedback you sent';
        const via = doc.agent && doc.agent !== 'Report a problem' ? ` through ${doc.agent}` : '';
        const subject = doc.subject ? ` — "${doc.subject}"` : '';
        const text =
          `Good news: the ${label}${via}${subject} has been marked SOLVED by Kade. ` +
          `If it's still not working right, just say "reopen it" and it goes straight back on Kade's list.`;
        relayed = await deliverNudge(doc.user, text, { type: 'feedback' });
        logger.info(
          `[kade/feedback] resolved-relay for report ${doc._id} -> ${relayed} (user ${doc.user})`,
        );
      } catch (relayErr) {
        logger.warn(`[kade/feedback] resolved-relay failed (non-fatal): ${relayErr.message}`);
      }
    }
    res.json({ ok: true, id: String(doc._id), status: doc.status, relayed });
  } catch (err) {
    logger.error(`[kade/feedback] status update failed: ${err.message}`);
    res.status(500).json({ error: 'Could not update status.' });
  }
});

/** ADMIN: POST /api/kade/feedback/:id/reassign { email } — point a report at
 * the user it actually belongs to. Session 23: needed because pre-identity-
 * threading voice turns filed reports as the SERVICE account (Amber's row bug
 * landed under Kade's name); with the report reassigned, the resolved-relay
 * and the reopen path both reach the real reporter. */
router.post('/feedback/:id/reassign', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    const User = mongoose.models.User || mongoose.model('User');
    const target = await User.findOne(
      { email: { $in: [email, email.toLowerCase()] } },
      { _id: 1, name: 1, email: 1 },
    ).lean();
    if (!target) {
      return res.status(404).json({ error: 'No user with that email.' });
    }
    const doc = await KadeFeedback.findByIdAndUpdate(
      req.params.id,
      { user: target._id },
      { new: true },
    ).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Report not found.' });
    }
    logger.info(
      `[kade/feedback] report ${doc._id} reassigned to ${target.email} (${target._id}) by admin ${req.user.id}`,
    );
    res.json({ ok: true, id: String(doc._id), user: String(target._id), email: target.email });
  } catch (err) {
    logger.error(`[kade/feedback] reassign failed: ${err.message}`);
    res.status(500).json({ error: 'Could not reassign.' });
  }
});

const FEED_HTML = require('./kadePages').feedHtml;
/** ADMIN: GET /api/kade/usage-by-model — LLM spend grouped by model, all-time.
 * Same conversion as /usage (abs(sum(tokenValue))/1e6). Answers "which model
 * cost the most." */
router.get('/usage-by-model', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const { Transaction } = models();
    const agg = await Transaction.aggregate([
      { $group: { _id: '$model', spend: { $sum: '$tokenValue' }, txns: { $sum: 1 } } },
    ]);
    const rows = agg
      .map((r) => ({ model: r._id || '(unknown)', spendUSD: round(Math.abs(usd(r.spend))), txns: r.txns }))
      .filter((r) => r.spendUSD > 0.0001)
      .sort((a, b) => b.spendUSD - a.spendUSD);
    res.json({ models: rows });
  } catch (e) {
    logger.error('[kade/usage-by-model]', e);
    res.status(500).json({ error: 'usage-by-model failed' });
  }
});

/* ============================================================================
 * ADMIN LOGS VIEWER (session 21h, Kade: "put a logs link in my admin dashboard
 * ... by user, then the users' conversations ... so if someone says my chatbot
 * did this, I can pull up the log"). Read-only. Three admin-guarded endpoints
 * feed a drill-down page (users -> their conversations -> the messages), laid
 * out the way a user sees their own chat.
 * ========================================================================== */
const logsModels = () => ({
  User: mongoose.models.User || mongoose.model('User'),
  Conversation: mongoose.models.Conversation || mongoose.model('Conversation'),
  Message: mongoose.models.Message || mongoose.model('Message'),
});

// Strip the same tag families the speech/chat display path strips, so the log
// shows what the user actually SAW/heard, not the raw stored markup. Mirrors
// the bridge's scrubTranscriptText: %%%voice tags, [sound:]/[table:] cues,
// think blocks, [END CALL], and the citation glyphs / turnN-searchN tokens
// (the "searchterms"). These are stored raw on purpose (the TTS proxy needs
// the %%% tags), but the client always cleans them before display — so seeing
// them here was a LOG artifact, never something the user received.
const logsScrub = (text) => {
  if (!text) return text;
  return String(text)
    .replace(/:::thinking[\s\S]*?:::\n?/g, '')
    .replace(/<think>[\s\S]*?<\/think>\n?/g, '')
    // Aug 21 2026 (Kade, reading Amber L's log: "I see some tags"): the old
    // single pass capped tag content at 81 chars, and the v130+ personas
    // teach LAYERED directions that run longer -- the live survivor was an
    // 89-char tag. Canonical pass is now UNBOUNDED (same as the native
    // sanitizer and the TTS converter, which never had this cap), the sloppy
    // 2-4-percent pass stays for typo'd tags, and a residual sweep eats any
    // orphaned %%-runs (a swallowed delimiter always beats a shown one).
    .replace(/%%%[\s\S]*?%%%/g, '')
    // Aug 21 2026 (Kade, same admin-log read-through: "I saw stars * on the
    // logs output"): markdown emphasis markers, same rules as the native
    // sanitizer -- markers vanish, words survive. Span must start/end on
    // non-space so "2 * 3 * 4" keeps its operators.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*(\S(?:[^*\n]{0,58}\S)?)\*(?!\*)/g, '$1$2')
    .replace(/\*{2,}/g, '')
    .replace(/%{2,4}[a-zA-Z][^%\n]{0,160}%{2,4}/g, '')
    .replace(/%{2,}/g, '')
    .replace(/\[(?:sound:[a-z0-9_]+|table:[a-z0-9]{1,12})\]/gi, '')
    .replace(/\[END CALL\]/gi, '')
    .replace(/[\uE200-\uE20F]turn\d+[a-z]+\d+/gi, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/turn\d+(?:search|image|news|video|ref|file)\d+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
};

const logsMsgText = (m) => {
  let raw = '';
  if (Array.isArray(m.content) && m.content.length) {
    raw = m.content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n\n');
  }
  if (!raw && typeof m.text === 'string' && m.text.trim()) raw = m.text;
  const clean = logsScrub(raw);
  if (clean) return clean;
  return m.isCreatedByUser ? '' : '(no text — tool activity only)';
};

// Everyone on the instance, with a conversation count, most-active first.
/* ─── MEMORY SHARE, the person's own knob (Part 128, Sep 4 2026) ────────────
 * "So she doesn't have to tell either of them something twice." Facts (cards
 * + logbook) are shared across the companions this seat talks to; opinions
 * (takes, threads, canon) never are. GET returns the setting and the list of
 * companions with memory on this seat so a manager screen can offer 'list'. */
router.get('/memory-share', requireJwtAuth, async (req, res) => {
  try {
    const { getShare, companionBucketsFor } = require('~/server/services/kadeMemoryShare');
    const share = await getShare(req.user.id);
    const ids = await companionBucketsFor(req.user.id);
    const companions = [];
    for (const id of ids.filter(Boolean)) {
      let name = String(id).slice(-6);
      try { const a = await require('~/models').getAgent({ id: String(id) }); if (a && a.name) name = a.name; } catch (_) {}
      companions.push({ agentId: String(id), name });
    }
    res.json({ ...share, companions });
  } catch (e) {
    logger.error('[kade/memory-share] read failed:', e);
    res.status(500).json({ error: 'Could not read your sharing setting.' });
  }
});
router.put('/memory-share', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const { setShare } = require('~/server/services/kadeMemoryShare');
    const b = req.body || {};
    res.json({ ok: true, ...(await setShare(req.user.id, { mode: b.mode, agents: b.agents, setBy: 'user' })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/admin/logs-users', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const { User, Conversation } = logsModels();
    const [users, counts] = await Promise.all([
      User.find({}, { name: 1, username: 1, email: 1, role: 1 }).lean(),
      Conversation.aggregate([{ $group: { _id: '$user', n: { $sum: 1 } } }]),
    ]);
    const countMap = {};
    for (const c of counts) countMap[String(c._id)] = c.n;
    const out = users
      .map((u) => ({
        id: String(u._id),
        name: u.name || u.username || '(no name)',
        email: u.email || '',
        role: u.role || 'USER',
        convoCount: countMap[String(u._id)] || 0,
      }))
      .sort((a, b) => b.convoCount - a.convoCount || a.name.localeCompare(b.name));
    res.json({ users: out });
  } catch (e) {
    logger.error('[kade/admin/logs-users]', e);
    res.status(500).json({ error: 'Could not load users' });
  }
});

/* PART 115 (Sep 1 2026) — WHO OWNS WHICH AGENT, admin-only, projection only.
 * Kade asked to publish Amber A's agent to the marketplace from the proxy, and
 * there was no way to even FIND it: /api/agents is ACL-scoped to the caller's
 * own view, so another person's private agent is invisible to the admin seat,
 * and the proxy's list projection drops `author`. This returns id, mongo _id,
 * name, author, version, isPublic — never instructions, never the persona.
 * ?author=<userId> filters to one person. */
router.get('/admin/agents', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const Agent = mongoose.models.Agent || mongoose.model('Agent');
    const q = {};
    if (req.query.author) q.author = req.query.author;
    const rows = await Agent.find(q, { id: 1, name: 1, author: 1, version: 1, isPublic: 1, updatedAt: 1, createdAt: 1 })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({
      agents: rows.map((a) => ({
        id: a.id,
        _id: String(a._id),
        name: a.name || '',
        author: a.author ? String(a.author) : null,
        version: a.version,
        isPublic: Boolean(a.isPublic),
        updatedAt: a.updatedAt,
        createdAt: a.createdAt,
      })),
    });
  } catch (e) {
    logger.error('[kade/admin/agents]', e);
    res.status(500).json({ error: 'Could not list agents' });
  }
});

// One user's conversations, newest first (same order they see them).
router.get('/admin/logs-convos', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const { Conversation } = logsModels();
    /* Aug 9 2026 (her bloat report, root-caused): this raw find() showed
     * every isTemporary scratch turn — 24 canary probes a day, phone-turn
     * shadows — burying her real audit trail in lab noise. The convo LIST
     * respects the retention filter; this admin drill-down now does the
     * moral equivalent. ?temp=1 shows the scratch layer when an audit
     * genuinely wants it. */
    const includeTemp = String(req.query.temp || '') === '1';
    const filter = includeTemp ? { user: userId } : { user: userId, isTemporary: { $ne: true } };
    const convos = await Conversation.find(
      filter,
      { conversationId: 1, title: 1, updatedAt: 1, endpoint: 1 },
    )
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    res.json({
      convos: convos.map((c) => ({
        conversationId: c.conversationId,
        title: c.title || '(untitled)',
        updatedAt: c.updatedAt,
        endpoint: c.endpoint || '',
      })),
    });
  } catch (e) {
    logger.error('[kade/admin/logs-convos]', e);
    res.status(500).json({ error: 'Could not load conversations' });
  }
});

// The messages of one conversation, oldest-first, laid out like the chat.
router.get('/admin/logs-messages', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const conversationId = String(req.query.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
    const { Message } = logsModels();
    // KADE July 30 2026 (session 35, Amber's armadillo debug): ?raw=1
    // returns the messages EXACTLY as GET /api/messages serves them to
    // the apps (full docs, minus nothing) -- because the session-19
    // watch-item said "pull raw immediately" and there was no raw lane:
    // this projection hid `files`/`content` shape bugs that only bite
    // the native decoder. Admin-only like the rest of this route.
    const wantRaw = String(req.query.raw || '') === '1';
    if (wantRaw) {
      const rawMsgs = await Message.find({ conversationId })
        .sort({ createdAt: 1 })
        .limit(2000)
        .lean();
      return res.json({ messages: rawMsgs });
    }
    const msgs = await Message.find(
      { conversationId },
      { sender: 1, text: 1, content: 1, isCreatedByUser: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .limit(2000)
      .lean();
    /* Part 126 (Sep 4 2026), her ask: "hear the voice they heard" on the logs.
     * The synthesized clip is not retained anywhere, and she said regenerating
     * in the voice they had chosen is fine — so this route now names THAT
     * voice: the seat's own pick for this character, resolved by the same
     * chain every surface uses (personal pick > agent default > catalog). The
     * page renders it with the manual TTS lane. Fail-soft: no voice, no button. */
    let agentId = null;
    let voice = null;
    let voiceSource = null;
    try {
      const { Conversation } = logsModels();
      const convo = Conversation
        ? await Conversation.findOne({ conversationId }, { user: 1, agent_id: 1, title: 1 }).lean()
        : null;
      agentId = convo && convo.agent_id ? String(convo.agent_id) : null;
      if (convo && agentId) {
        const { resolveVoice } = require('~/server/services/kadeVoiceResolver');
        const r = await resolveVoice({ userId: String(convo.user), agentId, surface: 'web' });
        if (r && r.voice) {
          voice = r.voice;
          voiceSource = r.source || null;
        }
      }
    } catch (e) {
      logger.warn('[kade/admin/logs-messages] voice resolve failed (non-fatal): ' + e.message);
    }
    res.json({
      agentId,
      voice,
      voiceSource,
      messages: msgs.map((m) => ({
        sender: m.isCreatedByUser ? 'User' : m.sender || 'Assistant',
        isUser: !!m.isCreatedByUser,
        text: logsMsgText(m),
        createdAt: m.createdAt,
      })),
    });
  } catch (e) {
    logger.error('[kade/admin/logs-messages]', e);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

const DASH_HTML = require('./kadePages').dashboardHtml;
const LOGS_HTML = require('./kadePages').logsHtml;
const CREATIONS_HTML = require('./kadePages').creationsHtml;
const WALL_HTML = require('./kadePages').wallHtml;
// July 24 2026: the Game Room folded into the Parlor (her call — redundant pages).
const NOTIFICATIONS_HTML = require('./kadePages').notificationsHtml;
const FEEDBACK_HTML = require('./kadePages').feedbackHtml;
const TOOLS_HTML = require('./kadePages').toolsHtml;
const YOU_HTML = require('./kadePages').youHtml;
const TABBAR_JS = require('./kadePages').tabBarAsset;
// Session 17/18 (Kade: "If you wanna add a webpage that's fine too" --
// re: the pronunciation dictionary). Permissive web parity for the same
// CRUD the native PronunciationDictionaryView already covers -- both hit
// the exact same /pronunciation-dictionary JSON API a few hundred lines
// down in this file.
const PRONUNCIATION_DICTIONARY_HTML = require('./kadePages').pronunciationDictionaryHtml;
const DIARY_HTML = require('./kadePages').diaryHtml;
const BRIEF_HTML = require('./kadePages').briefHtml;
const REQUEST_ACCESS_HTML = require('./kadePages').requestAccessHtml;
const ACCESS_REQUESTS_HTML = require('./kadePages').accessRequestsHtml;
const WORLD_HTML = require('./kadePages').worldHtml;
const sendHtml = (html) => (req, res) => res.type('html').send(html);

// ---------------------------------------------------------------------------
// Avatar generator for the agent builder (July 2 2026, Kade's ask).
// POST /api/kade/avatar-generate { prompt } -> { image: dataURL, costUSD }
// Generates a square portrait via BFL FLUX.2 pro (~$0.03) and returns it as a
// data URL; the CLIENT then attaches it through the normal avatar-upload form
// flow (preview first, nothing committed until the user saves the agent).
// Cost logs to kadeusage exactly like in-chat flux images.
const axios = require('axios');
const { fluxCost } = require('~/models/kadeUsage');
const _avatarGenLast = new Map(); // userId -> ts (simple cooldown)
const AVATAR_ENDPOINT = '/v1/flux-2-pro-preview';

router.post('/avatar-generate', requireJwtAuth, async (req, res) => {
  try {
    const apiKey = process.env.FLUX_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Image generation is not configured on this server.' });
    }
    const prompt = String((req.body && req.body.prompt) || '').trim();
    if (prompt.length < 3) {
      return res.status(400).json({ error: 'A short description is required.' });
    }
    if (prompt.length > 2500) {
      return res.status(400).json({ error: 'That description is too long.' });
    }
    const uid = String(req.user.id);
    const last = _avatarGenLast.get(uid) || 0;
    if (Date.now() - last < 12000) {
      return res.status(429).json({ error: 'Hold on a few seconds between generations.' });
    }
    _avatarGenLast.set(uid, Date.now());

    const baseUrl = process.env.FLUX_API_BASE_URL || 'https://api.us1.bfl.ai';
    const task = await axios.post(
      `${baseUrl}${AVATAR_ENDPOINT}`,
      { prompt, width: 768, height: 768, safety_tolerance: 2 },
      { headers: { 'x-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 20000 },
    );
    const pollingUrl = task.data.polling_url || `${baseUrl}/v1/get_result`;
    const taskId = task.data.id;

    let sampleUrl = null;
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await axios.get(pollingUrl, {
        headers: { 'x-key': apiKey, Accept: 'application/json' },
        params: task.data.polling_url ? undefined : { id: taskId },
        timeout: 15000,
      });
      if (poll.data.status === 'Ready') {
        sampleUrl = poll.data.result && poll.data.result.sample;
        break;
      }
      if (poll.data.status === 'Error') {
        logger.error('[kade/avatar-generate] BFL task error:', poll.data);
        return res.status(502).json({ error: 'The image generator reported an error. Try rewording the description.' });
      }
    }
    if (!sampleUrl) {
      return res.status(504).json({ error: 'Image generation timed out. Try again.' });
    }

    const img = await axios.get(sampleUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 15 * 1024 * 1024 });
    const mime = (img.headers['content-type'] || 'image/jpeg').split(';')[0];
    const costUSD = fluxCost(AVATAR_ENDPOINT, 1);
    logKadeUsage({
      userId: req.user.id,
      service: 'flux',
      quantity: 1,
      unit: 'images',
      costUSD,
      metadata: { purpose: 'agent-avatar', endpoint: AVATAR_ENDPOINT },
    });
    return res.json({
      image: `data:${mime};base64,${Buffer.from(img.data).toString('base64')}`,
      costUSD,
    });
  } catch (err) {
    logger.error(`[kade/avatar-generate] failed: ${err && err.message}`);
    return res.status(500).json({ error: 'Avatar generation failed. Try again in a moment.' });
  }
});

/* ----------------------------------------------------------------------------
 * ADMIN: POST /api/kade/account-type { email, type: 'adult'|'child' }
 * Flips kadeAccountType on an existing account (e.g. marking Skylee as child
 * after the fact — signup codes only tag NEW accounts). July 3 2026.
 * -------------------------------------------------------------------------- */
router.post('/account-type', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const { findUser, updateUser } = require('~/models');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const type = String(req.body?.type || '').trim();
    if (!email || !['adult', 'child'].includes(type)) {
      return res.status(400).json({ message: "Need an email and a type of 'adult' or 'child'." });
    }
    const user = await findUser({ email }, 'email name kadeAccountType');
    if (!user) {
      return res.status(404).json({ message: 'No account with that email.' });
    }
    await updateUser(user._id, { kadeAccountType: type });
    return res.json({ ok: true, email, name: user.name, kadeAccountType: type });
  } catch (error) {
    logger.error('[/api/kade/account-type] error:', error);
    return res.status(500).json({ message: 'Could not update the account type.' });
  }
});

/* ----------------------------------------------------------------------------
 * ADMIN: POST /api/kade/admin/set-password { email, password }
 * Aug 24 2026 (Part 92.10) — THE MISSING PIECE, and it was missing in BOTH
 * directions, which is why an empty account nearly got deleted to solve it.
 *
 * A friend forgot her password. What existed:
 *   · `passwordResetEnabled: false` on the live config — the reset code ships
 *     with LibreChat and the switch is OFF.
 *   · `emailEnabled: false` — nothing can mail a reset link anyway.
 *   · `DELETE /api/user/delete` is SELF-SERVICE: it needs the account's own
 *     login. Somebody locked out cannot use it, and no admin route could do it
 *     for them. So "just delete it and re-register" was not actually available.
 * The only remaining path was deleting a person's account over a forgotten
 * password. This route exists so that is never the answer again.
 *
 * ⚠️⚠️ AND THE TRAP WE ARE STEPPING AROUND, WRITTEN DOWN SO NOBODY "FIXES" THE
 * PROBLEM BY FLIPPING THE OBVIOUS SWITCH: DO NOT SET `ALLOW_PASSWORD_RESET=true`
 * WHILE EMAIL IS UNCONFIGURED. `requestPasswordReset` in AuthService returns
 * `{ link }` IN THE HTTP RESPONSE BODY when `checkEmailConfig()` is false, and
 * that route is PUBLIC AND UNAUTHENTICATED. Anyone who knows a family member's
 * email address could POST it and be handed a working reset link. That is
 * account takeover for every seat on the platform, one environment variable
 * away. Configure SMTP first; then the switch is safe and this route becomes a
 * convenience instead of the only way in.
 *
 * Deliberate choices:
 *   · `requireJwtAuth` + `requireAdminAccess` — the STRONGEST gate available
 *     here, Kade's actual logged-in admin session, not a shared header secret.
 *     A route that sets arbitrary passwords should not be reachable by anything
 *     that leaks as easily as a secret in a config file.
 *   · Sessions are killed after the change (`deleteAllUserSessions`), matching
 *     what the real reset flow does — otherwise an old session outlives the new
 *     password, which is the opposite of what "reset my password" means.
 *   · The password is NEVER logged, NEVER echoed back, and never stored in
 *     plaintext: bcrypt hashSync(…, 10), identical to registration and reset.
 *     ⚠️ The bridge already keeps `lcPass` in the clear for two seats and that
 *     is a known open item — this route does not add a third.
 *   · WHO did it and TO WHOM is logged, because an admin power that can open
 *     anyone's account should leave a trail even when the admin is the owner.
 * -------------------------------------------------------------------------- */
router.post('/admin/set-password', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { findUser, updateUser, deleteAllUserSessions } = require('~/models');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ message: 'Need an email and a password.' });
    }
    /* Same floor the registration schema enforces. A route that bypasses the
     * normal flow must not also bypass its rules. */
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ message: 'Password must be 8 to 128 characters.' });
    }
    const user = await findUser({ email }, 'email name _id');
    if (!user) {
      return res.status(404).json({ message: 'No account with that email.' });
    }
    await updateUser(user._id, { password: bcrypt.hashSync(password, 10) });
    /* Best-effort: a failure here must not report the password change as failed
     * when it already landed. Say so instead of lying in either direction. */
    let sessionsCleared = true;
    try {
      await deleteAllUserSessions({ userId: user._id });
    } catch (e) {
      sessionsCleared = false;
      logger.error('[/api/kade/admin/set-password] session clear failed:', e);
    }
    logger.info(
      `[/api/kade/admin/set-password] ${req.user.email} set the password for ${user.email}`,
    );
    return res.json({
      ok: true,
      email: user.email,
      name: user.name,
      sessionsCleared,
      note: 'Tell them to sign in with this password and change it in Settings.',
    });
  } catch (error) {
    logger.error('[/api/kade/admin/set-password] error:', error);
    return res.status(500).json({ message: 'Could not set the password.' });
  }
});

/* ----------------------------------------------------------------------------
 * ADMIN: POST /api/kade/add-credits { userId, amountUSD? }
 * Instant prepaid top-up — adds credit to a user's shared wallet (1,000,000 = $1).
 * Default $5 per click, $100 ceiling. Upserts the Balance record so it works even
 * for users who never had one. July 5 2026 (prepaid Stage C — the "+$5" button).
 * -------------------------------------------------------------------------- */
router.post('/add-credits', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const userId = String(req.body?.userId || '').trim();
    let amountUSD = Number(req.body?.amountUSD);
    if (!Number.isFinite(amountUSD) || amountUSD <= 0) amountUSD = 5;
    if (amountUSD > 100) amountUSD = 100;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Need a valid userId.' });
    }
    const Balance = mongoose.models.Balance;
    if (!Balance) return res.status(500).json({ message: 'Balance system unavailable.' });
    const oid = new mongoose.Types.ObjectId(userId);
    const setUSDRaw = req.body?.setUSD;
    /** KADE Stage B (2026-07-28): absolute set - for the supervised
     *  zero-boundary cutoff test and balance corrections. Same admin
     *  guard as the rest of this route; 0..100 clamp; logged. */
    if (setUSDRaw !== undefined) {
      let setUSD = Number(setUSDRaw);
      if (!Number.isFinite(setUSD) || setUSD < 0) {
        return res.status(400).json({ message: 'setUSD must be a number >= 0.' });
      }
      if (setUSD > 100) setUSD = 100;
      const doc = await Balance.findOneAndUpdate(
        { user: oid },
        { $set: { tokenCredits: Math.round(setUSD * 1e6) } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();
      const balanceUSD = (doc?.tokenCredits || 0) / 1e6;
      logger.info(`[/api/kade/add-credits] SET $${setUSD} on ${userId} -> $${balanceUSD.toFixed(2)}`);
      return res.json({ ok: true, userId, setUSD, balanceUSD });
    }
    const credits = Math.round(amountUSD * 1e6);
    const doc = await Balance.findOneAndUpdate(
      { user: oid },
      { $inc: { tokenCredits: credits } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const balanceUSD = (doc?.tokenCredits || 0) / 1e6;
    logger.info(`[/api/kade/add-credits] +$${amountUSD} to ${userId} -> $${balanceUSD.toFixed(2)}`);
    return res.json({ ok: true, userId, addedUSD: amountUSD, balanceUSD });
  } catch (error) {
    logger.error('[/api/kade/add-credits] error:', error);
    return res.status(500).json({ message: 'Could not add credits.' });
  }
});

/** ---- KADE NUDGE ENGINE (July 11 2026): push subscriptions, prefs, test ---- */
const {
  isPushConfigured,
  deliverNudge: deliverKadeNudge,
} = require('~/server/services/kadeNudges');
const { KadePushSub, KadeNudgePref, KadePendingNudge, CHANNELS } = require('~/models/kadeNudge');

router.get('/nudges/config', requireJwtAuth, async (req, res) => {
  res.json({
    pushConfigured: isPushConfigured(),
    vapidPublicKey: process.env.KADE_VAPID_PUBLIC_KEY || null,
  });
});

router.get('/nudges/prefs', requireJwtAuth, async (req, res) => {
  try {
    const [prefs, subCount, recent] = await Promise.all([
      KadeNudgePref.findOne({ userId: req.user.id }).lean(),
      KadePushSub.countDocuments({ userId: req.user.id }),
      KadePendingNudge.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(15).lean(),
    ]);
    res.json({
      prefs: prefs || {
        reminders: 'chat', birthday: 'off', birthdayDate: '', phone: '', longTaskPing: false,
      },
      pushSubscriptions: subCount,
      recent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/nudges/prefs', requireJwtAuth, async (req, res) => {
  try {
    const { reminders, birthday, birthdayDate, phone, longTaskPing } = req.body || {};
    const update = {};
    // Aug 13 2026 — the long-task ping opt-in. Strict boolean check on
    // purpose: an absent field must leave the existing choice alone, so the
    // older callers of this route (kadePages' notifications page, which knows
    // nothing about this field) can keep POSTing their four keys without
    // silently switching it off for whoever saved settings there last.
    if (typeof longTaskPing === 'boolean') {
      update.longTaskPing = longTaskPing;
    }
    if (CHANNELS.includes(reminders)) {
      update.reminders = reminders;
    }
    if (CHANNELS.includes(birthday)) {
      update.birthday = birthday;
    }
    if (typeof birthdayDate === 'string' && (/^\d{2}-\d{2}$/.test(birthdayDate) || birthdayDate === '')) {
      update.birthdayDate = birthdayDate;
    }
    if (typeof phone === 'string') {
      const digits = phone.replace(/\D/g, '').replace(/^1/, '');
      update.phone = digits.length === 10 ? digits : '';
    }
    const prefs = await KadeNudgePref.findOneAndUpdate(
      { userId: req.user.id },
      { $set: update },
      { new: true, upsert: true },
    ).lean();
    res.json({ ok: true, prefs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/nudges/subscribe', requireJwtAuth, async (req, res) => {
  try {
    const { subscription } = req.body || {};
    if (!subscription || typeof subscription.endpoint !== 'string') {
      return res.status(400).json({ error: 'subscription object with endpoint required' });
    }
    await KadePushSub.findOneAndUpdate(
      { userId: req.user.id, endpoint: subscription.endpoint },
      { $set: { subscription, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) } },
      { upsert: true },
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/nudges/unsubscribe', requireJwtAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    const r = await KadePushSub.deleteMany(
      endpoint ? { userId: req.user.id, endpoint } : { userId: req.user.id },
    );
    res.json({ ok: true, removed: r.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/nudges/test', requireJwtAuth, async (req, res) => {
  try {
    const channel = await deliverKadeNudge(
      req.user.id,
      'Test nudge from Kade-AI — if you can read this, nudges are working for you.',
      { type: 'reminder', userName: req.user.name || req.user.username || '' },
    );
    res.json({ ok: true, channel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * SERVICE: POST /api/kade/nudges/ingest — secret-guarded (same secret as
 * /usage-event) so the BRIDGE can hand a wellness-call summary (or any
 * server-side note) to the nudge engine for a specific user. Delivery rides
 * the user's own channel prefs; 'wellness' type uses the reminders pref.
 */
router.post('/nudges/ingest', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.body || {}).secret !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { userId, text, type, chatOnly } = req.body || {};
    if (!userId || !text) {
      return res.status(400).json({ error: 'userId and text required' });
    }
    /* ⭐ chatOnly (Part 121.5) — bypass the user's channel prefs and queue for
     * the next CONVERSATION, never push, never a phone call.
     *
     * Why this exists: some notes are only meaningful when a character says
     * them, in context, in their own words. The first one was an apology Kiana
     * owed somebody about something said during her grief. Delivered through
     * deliverNudge it would have honoured that person's prefs — and if hers
     * read 'push' it would have arrived as a lock-screen banner, or if 'call',
     * as an outbound phone call at whatever hour the queue fired. An apology
     * is not a notification. There was also no way to READ another user's
     * prefs from here to check first, so the choice was gamble or force it.
     *
     * Rule for using it: chatOnly is for things that must be SAID rather than
     * DELIVERED. A reminder is still a reminder and still rides prefs. */
    if (chatOnly === true) {
      const { KadePendingNudge: PendingNudge } = require('~/models/kadeNudge');
      await PendingNudge.create({
        userId: String(userId),
        text: String(text).slice(0, 3000),
        type: ['reminder', 'birthday', 'wellness'].includes(type) ? type : 'reminder',
        channel: 'chat',
      });
      return res.json({ ok: true, channel: 'chat', forced: true });
    }
    const channel = await deliverKadeNudge(String(userId), String(text).slice(0, 3000), {
      type: ['reminder', 'birthday', 'wellness'].includes(type) ? type : 'reminder',
    });
    return res.json({ ok: true, channel });
  } catch (error) {
    logger.error('[/api/kade/nudges/ingest] error:', error);
    return res.status(500).json({ error: 'Failed to ingest nudge' });
  }
});

/* ----------------------------------------------------------------------------
 * FAMILY WELLNESS CALLS (July 11 2026): thin JWT-gated proxy onto the bridge's
 * /wellness store so the Notifications page (and agents via kade_phone_call)
 * can manage check-in schedules. Non-admins only ever see/touch their own.
 * -------------------------------------------------------------------------- */
const BRIDGE_URL = (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');

function bridgeSecretOk(res) {
  if (!process.env.BRIDGE_SECRET) {
    res.status(503).json({ error: 'Bridge is not configured on this server.' });
    return false;
  }
  return true;
}

/* Part 112 (Aug 31 2026): ANNOUNCEMENTS — the family's read of the bridge's
 * broadcast history. Any signed-in seat may read it: a What's New digest is
 * addressed to everyone by definition, so there is nothing per-user to scope.
 * The bridge stores the last 50 broadcasts; the native Announcements screen
 * (build 258+) and the web /notifications page both read THIS route. */
router.get('/announcements', requireJwtAuth, async (req, res) => {
  try {
    if (!bridgeSecretOk(res)) return;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const r = await fetch(`${BRIDGE_URL}/broadcasts?secret=${encodeURIComponent(process.env.BRIDGE_SECRET)}&limit=${limit}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    logger.error('[kade/announcements] failed:', e);
    return res.status(502).json({ error: 'Could not reach the phone bridge.' });
  }
});

router.get('/wellness', requireJwtAuth, async (req, res) => {
  try {
    if (!bridgeSecretOk(res)) return;
    const isAdmin = req.user.role === 'ADMIN';
    const qs = new URLSearchParams({ secret: process.env.BRIDGE_SECRET });
    if (!isAdmin || req.query.mine === '1') qs.set('userId', String(req.user.id));
    const r = await fetch(`${BRIDGE_URL}/wellness?${qs}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    logger.error('[kade/wellness] list failed:', e);
    return res.status(502).json({ error: 'Could not reach the phone bridge.' });
  }
});

/** People available for check-ins (registry names; numbers admin-only). */
router.get('/wellness/people', requireJwtAuth, async (req, res) => {
  try {
    if (!bridgeSecretOk(res)) return;
    const r = await fetch(`${BRIDGE_URL}/users?secret=${encodeURIComponent(process.env.BRIDGE_SECRET)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await r.json();
    const isAdmin = req.user.role === 'ADMIN';
    const people = Object.entries(j || {}).map(([phone, u]) => ({
      name: (u && u.name) || 'Friend',
      ...(isAdmin ? { phone } : {}),
    }));
    return res.json({ people });
  } catch (e) {
    logger.error('[kade/wellness] people failed:', e);
    return res.status(502).json({ error: 'Could not reach the phone bridge.' });
  }
});

router.post('/wellness', requireJwtAuth, async (req, res) => {
  try {
    if (!bridgeSecretOk(res)) return;
    const b = req.body || {};
    const isAdmin = req.user.role === 'ADMIN';
    // Ownership: non-admins may only touch their own schedules.
    if (b.id && !isAdmin) {
      const check = await fetch(
        `${BRIDGE_URL}/wellness?secret=${encodeURIComponent(process.env.BRIDGE_SECRET)}&userId=${encodeURIComponent(String(req.user.id))}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
      ).then((r) => r.json());
      if (!(check.schedules || []).some((w) => w.id === b.id)) {
        return res.status(403).json({ error: 'Not your schedule.' });
      }
    }
    const action = String(b.action || 'save');
    if (action === 'toggle') {
      const r = await fetch(`${BRIDGE_URL}/wellness/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ secret: process.env.BRIDGE_SECRET, id: b.id, enabled: b.enabled }),
      });
      return res.status(r.status).json(await r.json());
    }
    if (action === 'fire') {
      const r = await fetch(`${BRIDGE_URL}/wellness/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ secret: process.env.BRIDGE_SECRET, id: b.id }),
      });
      return res.status(r.status).json(await r.json());
    }
    if (action === 'delete') {
      const r = await fetch(
        `${BRIDGE_URL}/wellness?secret=${encodeURIComponent(process.env.BRIDGE_SECRET)}&id=${encodeURIComponent(String(b.id || ''))}`,
        { method: 'DELETE', headers: { 'User-Agent': 'Mozilla/5.0' } },
      );
      return res.status(r.status).json(await r.json());
    }
    const r = await fetch(`${BRIDGE_URL}/wellness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        secret: process.env.BRIDGE_SECRET,
        id: b.id || undefined,
        who: b.who,
        time: b.time,
        days: b.days,
        agentId: b.agentId,
        agentName: b.agentName,
        topics: b.topics,
        enabled: b.enabled,
        enrolledBy: { userId: String(req.user.id), userName: req.user.name || req.user.username || 'a Kade-AI user' },
      }),
    });
    return res.status(r.status).json(await r.json());
  } catch (e) {
    logger.error('[kade/wellness] save failed:', e);
    return res.status(502).json({ error: 'Could not reach the phone bridge.' });
  }
});

/* ----------------------------------------------------------------------------
 * PER-USER VOICE OVERRIDES (July 12 2026): "my Kiana sounds like Voice 27."
 * Kade's builder voices are suggestions; each person's pick follows them
 * across devices + surfaces (read-aloud, web calls; phone pending registry map).
 * -------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------
 * DEFAULT AGENT (Aug 6 2026, her ask: "pin the person's default agent at the
 * top, so they don't have to sort through alphabetical agents" — her pick:
 * most-talked-to). GET /api/kade/agent-default: this user's top companions by
 * conversation count, computed straight off their own conversations. Zero
 * setup, per-person by construction: Skylee's top pick is Skylee's. Fail-soft
 * to an empty list — pickers fall back to alphabetical, never an error.
 * -------------------------------------------------------------------------- */
router.get('/agent-default', requireJwtAuth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const Conversation = mongoose.models.Conversation;
    if (!Conversation) return res.json({ top: [] });
    const rows = await Conversation.aggregate([
      { $match: { user: String(req.user.id), agent_id: { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: '$agent_id', count: { $sum: 1 }, last: { $max: '$updatedAt' } } },
      { $sort: { count: -1, last: -1 } },
      { $limit: 3 },
    ]);
    return res.json({ top: rows.map((r) => ({ agentId: r._id, count: r.count })) });
  } catch (e) {
    logger.warn('[kade/agent-default] failed:', e.message);
    return res.json({ top: [] });
  }
});

const { getUserVoicePrefs, setUserVoicePref } = require('~/models/kadeVoicePref');

router.get('/voice-prefs', requireJwtAuth, async (req, res) => {
  try {
    return res.json({ prefs: await getUserVoicePrefs(req.user.id) });
  } catch (e) {
    logger.error('[kade/voice-prefs] get failed:', e);
    return res.status(500).json({ error: 'Could not load voice preferences' });
  }
});

router.post('/voice-prefs', requireJwtAuth, async (req, res) => {
  try {
    const { agentId, voice } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }
    await setUserVoicePref(req.user.id, String(agentId).slice(0, 64), voice ? String(voice) : null);
    return res.json({ ok: true });
  } catch (e) {
    logger.error('[kade/voice-prefs] set failed:', e);
    return res.status(500).json({ error: 'Could not save voice preference' });
  }
});

/* ----------------------------------------------------------------------------
 * PHONE-LINE PERSONAL VOICES (July 12 2026): secret-guarded server-to-server
 * lookup/ingest so the BRIDGE can apply (and save) a caller's own per-agent
 * voice pick. Caller resolved by userId, email, or the phone number on their
 * Notifications prefs. Same trust model as /usage-event.
 * -------------------------------------------------------------------------- */
const { getUserVoicePref: lookupVoicePref, setUserVoicePref: ingestVoicePref } = require('~/models/kadeVoicePref');
const { KadeNudgePref: VoiceLookupPrefs } = require('~/models/kadeNudge');

async function resolveUserForVoice({ userId, email, phone }) {
  if (userId) {
    return String(userId);
  }
  if (email) {
    try {
      const { findUser } = require('~/models');
      const u = await findUser({ email: String(email).toLowerCase() }, '_id');
      if (u) {
        return String(u._id);
      }
    } catch { /* fall through */ }
  }
  if (phone) {
    const last10 = String(phone).replace(/\D/g, '').slice(-10);
    if (last10.length === 10) {
      try {
        const rows = await VoiceLookupPrefs.find({ phone: { $ne: '' } }, 'userId phone').lean();
        const hit = rows.find((r) => String(r.phone).replace(/\D/g, '').slice(-10) === last10);
        if (hit) {
          return String(hit.userId);
        }
      } catch { /* fall through */ }
    }
  }
  return null;
}

router.get('/voice-pref-lookup', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    /* July 13 2026 security sweep: header-first (query secrets land in edge logs). */
    if (!expected || (req.get('x-kade-secret') || req.query.secret) !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const agentId = String(req.query.agentId || '').slice(0, 64);
    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }
    const uid = await resolveUserForVoice({ userId: req.query.userId, email: req.query.email, phone: req.query.phone });
    if (!uid) {
      return res.json({ voice: null, userId: null });
    }
    const voice = await lookupVoicePref(uid, agentId);
    return res.json({ voice: voice || null, userId: uid });
  } catch (e) {
    logger.error('[kade/voice-pref-lookup] failed:', e);
    return res.status(500).json({ error: 'lookup failed' });
  }
});

/**
 * SERVICE: GET /api/kade/resolve-voice — UNIFIED VOICE RESOLVER (July 17 2026,
 * overnight proposal A). One authoritative answer to "what voice does this
 * user hear for this agent?" — personal pick -> builder voice -> name-match
 * -> platform default, each validated against the live catalog. The bridge's
 * lookupVoicePref and kadeWebVoice's ticket mint both consume this chain so
 * the precedence logic can never drift between surfaces again.
 * /voice-pref-lookup below stays for compat (personal-pick-only contract).
 */
router.get('/resolve-voice', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.get('x-kade-secret') || req.query.secret) !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const agentId = String(req.query.agentId || '').slice(0, 64);
    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }
    const uid = await resolveUserForVoice({
      userId: req.query.userId,
      email: req.query.email,
      phone: req.query.phone,
    });
    const { resolveVoice } = require('~/server/services/kadeVoiceResolver');
    const out = await resolveVoice({
      userId: uid || undefined,
      agentId,
      surface: String(req.query.surface || '').slice(0, 16) || undefined,
    });
    return res.json({ ...out, userId: uid || null });
  } catch (e) {
    logger.error('[kade/resolve-voice] failed:', e);
    return res.status(500).json({ error: 'resolve failed' });
  }
});

router.post('/voice-pref-ingest', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.body || {}).secret !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { userId, email, phone, agentId, voice } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }
    const uid = await resolveUserForVoice({ userId, email, phone });
    if (!uid) {
      return res.json({ ok: false, note: 'no matching account' });
    }
    await ingestVoicePref(uid, String(agentId).slice(0, 64), voice ? String(voice) : null);
    return res.json({ ok: true, userId: uid });
  } catch (e) {
    logger.error('[kade/voice-pref-ingest] failed:', e);
    return res.status(500).json({ error: 'ingest failed' });
  }
});

/* ----------------------------------------------------------------------------
 * PER-USER PRONUNCIATION DICTIONARY (July 20 2026): "I know my name Kade is
 * pronounced Katie. What if everyone had a dictionary they can put their own
 * names in?" User-facing CRUD here; STT (Deepgram keyterms, both the call
 * path and /api/kade/transcribe) and TTS (voice-message read-aloud, phone/
 * Spotter call speech) each consume the same list differently -- see
 * kadePronunciation.js's file header for the term-vs-pronunciation split.
 * -------------------------------------------------------------------------- */
const {
  getUserDictionary,
  setUserDictionaryEntry,
  deleteUserDictionaryEntry,
} = require('~/models/kadePronunciation');

router.get('/pronunciation-dictionary', requireJwtAuth, async (req, res) => {
  try {
    return res.json({ entries: await getUserDictionary(req.user.id) });
  } catch (e) {
    logger.error('[kade/pronunciation-dictionary] get failed:', e);
    return res.status(500).json({ error: 'Could not load your pronunciation dictionary' });
  }
});

router.post('/pronunciation-dictionary', requireJwtAuth, async (req, res) => {
  try {
    const { term, pronunciation } = req.body || {};
    const entry = await setUserDictionaryEntry(req.user.id, term, pronunciation);
    return res.json({ entry });
  } catch (e) {
    logger.warn('[kade/pronunciation-dictionary] set failed:', e && e.message);
    return res.status(400).json({ error: e.message || 'Could not save that entry' });
  }
});

router.delete('/pronunciation-dictionary/:id', requireJwtAuth, async (req, res) => {
  try {
    await deleteUserDictionaryEntry(req.user.id, req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    logger.error('[kade/pronunciation-dictionary] delete failed:', e);
    return res.status(500).json({ error: 'Could not remove that entry' });
  }
});

/* ----------------------------------------------------------------------------
 * KEYBOARD QUICK PHRASES (Aug 4 2026): per-user one-tap phrases for the Kade
 * Keys keyboard — her call: custom per person "instead of canned crap." The
 * app CRUDs here and mirrors the list into the App Group for the keyboard's
 * offline read. Same JSON conventions as the pronunciation dictionary above.
 * -------------------------------------------------------------------------- */
const {
  getUserPhrases,
  addUserPhrase,
  deleteUserPhrase,
} = require('~/models/kadeKeyboardPhrase');

router.get('/keyboard-phrases', requireJwtAuth, async (req, res) => {
  try {
    return res.json({ phrases: await getUserPhrases(req.user.id) });
  } catch (e) {
    logger.error('[kade/keyboard-phrases] get failed:', e);
    return res.status(500).json({ error: 'Could not load your phrases' });
  }
});

router.post('/keyboard-phrases', requireJwtAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    const phrase = await addUserPhrase(req.user.id, text);
    return res.json({ phrase });
  } catch (e) {
    logger.warn('[kade/keyboard-phrases] add failed:', e && e.message);
    return res.status(400).json({ error: e.message || 'Could not save that phrase' });
  }
});

router.delete('/keyboard-phrases/:id', requireJwtAuth, async (req, res) => {
  try {
    await deleteUserPhrase(req.user.id, req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    logger.error('[kade/keyboard-phrases] delete failed:', e);
    return res.status(500).json({ error: 'Could not remove that phrase' });
  }
});

/* ----------------------------------------------------------------------------
 * PHONE-LINE / SPOTTER PRONUNCIATION LOOKUP (July 20 2026): secret-guarded
 * server-to-server read so the BRIDGE can pull a caller's dictionary the same
 * way it already pulls their voice pick -- resolved by userId, email, or the
 * phone number on their Notifications prefs. Same trust model as
 * /voice-pref-lookup and /usage-event.
 * -------------------------------------------------------------------------- */
router.get('/pronunciation-lookup', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    if (!expected || (req.get('x-kade-secret') || req.query.secret) !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const uid = await resolveUserForVoice({
      userId: req.query.userId,
      email: req.query.email,
      phone: req.query.phone,
    });
    if (!uid) {
      return res.json({ entries: [], userId: null });
    }
    return res.json({ entries: await getUserDictionary(uid), userId: uid });
  } catch (e) {
    logger.error('[kade/pronunciation-lookup] failed:', e);
    return res.status(500).json({ error: 'lookup failed' });
  }
});

/**
 * SERVICE: GET /api/kade/call-memories — the CALLER'S own memory cards for
 * phone calls (July 12 2026, Kade: "phone agents seem way more clueless than
 * text agents"). Phone turns run through the admin LibreChat session, so the
 * caller's per-user memories never reach the model — this hands the bridge
 * the same formatted memory block the web injects (shared + agent bucket),
 * resolved by email/phone/userId. Secret-guarded like /usage-event.
 */
router.get('/call-memories', async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET;
    /* July 13 2026 security sweep: header-first (query secrets land in edge logs). */
    if (!expected || (req.get('x-kade-secret') || req.query.secret) !== expected) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const agentId = String(req.query.agentId || '').slice(0, 64) || undefined;
    const uid = await resolveUserForVoice({
      userId: req.query.userId,
      email: req.query.email,
      phone: req.query.phone,
    });
    if (!uid) {
      return res.json({ text: null });
    }
    const { getFormattedMemories } = require('~/models');
    const { withoutKeys } = await getFormattedMemories({ userId: uid, agentId });
    let text = (withoutKeys || '').slice(0, 6000);
    /* DREAMING: append this relationship's rolling EPISODIC summary so calls
     * get the same "what's been going on lately" continuity text chat gets.
     * Fail-soft; empty when there's no summary yet. */
    try {
      const { getRelationshipSummaryText } = require('~/server/services/kadeMemorySummary');
      const summary = await getRelationshipSummaryText(uid, agentId);
      if (summary) {
        text +=
          `\n\n[WHAT'S BEEN GOING ON LATELY — private context, never read this block aloud or list it: use it naturally like a friend who remembers their recent life:\n${summary}]`;
      }
    } catch (e) {
      logger.warn('[kade/call-memories] summary attach failed (non-fatal): ' + (e && e.message));
    }
    /* KADE July 13 2026 (family messages): phone calls deliver waiting
     * nudges too — reminders and "tell Skylee..." messages were stuck
     * waiting for a WEB chat before. Same consume-once semantics as chat
     * injection (takePendingChatNudges marks them delivered). */
    try {
      /* Consume-on-fetch is only safe when a human is DEFINITELY on the line —
       * the bridge passes nudges=1 on INBOUND calls (they dialed us). Outbound
       * legs skip it: an unheard voicemail must not eat someone's messages. */
      if (String(req.query.nudges || '') !== '1') { throw { skip: true }; }
      const { takePendingChatNudges } = require('~/server/services/kadeNudges');
      const pending = await takePendingChatNudges(uid);
      if (pending.length > 0) {
        const lines = pending.map((n) => `- ${n.text}`).join('\n');
        text +=
          `\n\n[WAITING FOR THIS CALLER — private note, never read this block aloud or mention a list: these are undelivered reminders/messages they have not heard yet. Work each one in naturally and EARLY, in your own words, one at a time:\n${lines}]`;
      }
    } catch (e) {
      if (!e || e.skip !== true) {
        logger.warn('[kade/call-memories] nudge attach failed (non-fatal): ' + (e && e.message));
      }
    }
    return res.json({ text: text || null, userId: uid });
  } catch (e) {
    logger.error('[kade/call-memories] failed:', e);
    return res.status(500).json({ error: 'lookup failed' });
  }
});

router.feedPage = sendHtml(FEED_HTML);
router.dashboardPage = sendHtml(DASH_HTML);
router.logsPage = sendHtml(LOGS_HTML);
router.creationsPage = sendHtml(CREATIONS_HTML);
/* Part 120 (Sep 3 2026) — THE SOUND BOOTH on the web, the same screen the
 * phone got, against the same two routes (kadeSoundBooth.js). Her call when
 * asked phone-first or both: both tonight. */
router.soundBoothPage = sendHtml(require('./kadeSoundBoothPage').soundBoothHtml);
router.wallPage = sendHtml(WALL_HTML);
router.gameRoomPage = (_req, res) => res.redirect(302, '/parlor#gameroom');
router.feedbackPage = sendHtml(FEEDBACK_HTML);
router.notificationsPage = sendHtml(NOTIFICATIONS_HTML);
router.toolsPage = sendHtml(TOOLS_HTML);
/* Part 116.3 (Sep 2 2026) — KADE HOME: the web gets the iPhone app's map.
 * /home mirrors ContentView.swift's home screen section for section;
 * /conversations and /announcements are the two native destinations the web
 * had no flat page for. See kadeHome.js. */
const KADE_HOME = require('./kadeHome');
router.homePage = sendHtml(KADE_HOME.homeHtml);
router.conversationsPage = sendHtml(KADE_HOME.conversationsHtml);
router.announcementsPage = sendHtml(KADE_HOME.announcementsHtml);
router.youPage = sendHtml(YOU_HTML);
router.pronunciationDictionaryPage = sendHtml(PRONUNCIATION_DICTIONARY_HTML);
router.diaryPage = sendHtml(DIARY_HTML);
router.briefPage = sendHtml(BRIEF_HTML);
/* ----------------------------------------------------------------------------
 * BUILD 197 (Aug 11 2026): TWO ADMIN PEEPHOLES ONTO THE BRIDGE.
 *
 * The bridge guards /front-desk and /diagnostics with BRIDGE_SECRET. A phone
 * app cannot hold that secret -- anything shipped in a binary is extractable,
 * and this one unlocks the whole phone lane. So the fork proxies: the app
 * sends its ordinary admin JWT, this server holds the secret, the bridge never
 * hears from the phone directly. Same shape as /admin/phone-register (July 21)
 * and the wellness proxies.
 *
 * These are READ-ONLY on purpose. Nothing here can change the world; the worst
 * a bug can do is show Kade a stale list.
 * -------------------------------------------------------------------------- */

/** Messages the front desk took from callers the registry doesn't know. */
router.get('/admin/front-desk', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    if (!bridgeSecretOk(res)) return;
    const r = await fetch(`${BRIDGE_URL}/front-desk?secret=${encodeURIComponent(process.env.BRIDGE_SECRET)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    logger.error('[kade/admin/front-desk] failed:', e);
    return res.status(502).json({ error: 'Could not reach the phone bridge.' });
  }
});

/** The crash ring -- what the app told on itself about, newest last.
 *  Named /app-crashes rather than /diagnostics because "diagnostics" on this
 *  side would read like the SITE's diagnostics; these are the phone's. */
router.get('/admin/app-crashes', requireJwtAuth, requireAdminAccess, async (req, res) => {
  try {
    if (!bridgeSecretOk(res)) return;
    const r = await fetch(`${BRIDGE_URL}/diagnostics?secret=${encodeURIComponent(process.env.BRIDGE_SECRET)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await r.json();
    /* The ring stores { at, build, device, kind, payload, breadcrumbs } and the
     * payload is a whole MetricKit dump -- hundreds of KB of stack that no
     * phone screen can use and no phone should download. Read live before
     * mapping: `signature` is NOT a stored field, the bridge parses it at
     * POST time for its log line only, and `breadcrumbs` is a newline STRING,
     * not an array. So parse the same signature here and hand the app a
     * readable card; the monsters stay on the bridge for a session that
     * actually needs a stack. */
    const entries = Array.isArray(j && j.entries) ? j.entries : [];
    const signatureOf = (payload) => {
      try {
        const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const meta = p && p.crashDiagnostics && p.crashDiagnostics[0] && p.crashDiagnostics[0].diagnosticMetaData;
        if (!meta) return null;
        const reason = String(meta.terminationReason || '').slice(0, 140);
        return [
          meta.exceptionType != null ? `type ${meta.exceptionType}` : null,
          meta.exceptionCode != null ? `code ${meta.exceptionCode}` : null,
          meta.signal != null ? `signal ${meta.signal}` : null,
          reason || null,
        ].filter(Boolean).join(' · ') || null;
      } catch (_e) {
        return null;
      }
    };
    const slim = entries.slice().reverse().map((e) => ({
      at: e.at || null,
      kind: e.kind || null,
      build: e.build || null,
      device: e.device || null,
      signature: signatureOf(e.payload),
      breadcrumbs: String(e.breadcrumbs || '').split('\n').filter(Boolean).slice(-12),
    }));
    return res.json({ count: (j && j.count) || entries.length, entries: slim });
  } catch (e) {
    logger.error('[kade/admin/app-crashes] failed:', e);
    return res.status(502).json({ error: 'Could not reach the phone bridge.' });
  }
});

router.requestAccessPage = sendHtml(REQUEST_ACCESS_HTML);
router.accessRequestsPage = sendHtml(ACCESS_REQUESTS_HTML);
router.worldPage = sendHtml(WORLD_HTML);
router.tabBarAssetPage = (req, res) => res.type('application/javascript').send(TABBAR_JS);
// Also reachable under the API namespace:
router.get('/feed', router.feedPage);
router.get('/dashboard', router.dashboardPage);
router.get('/logs', router.logsPage);
router.get('/creations', router.creationsPage);
router.get('/game-room-page', router.gameRoomPage);

module.exports = router;
