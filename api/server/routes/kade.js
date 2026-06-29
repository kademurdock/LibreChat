const express = require('express');
const mongoose = require('mongoose');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
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

    return res.json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      windowSince: since.toISOString(),
      totals,
      twilio,
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

    const month = { llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0 };
    const all = { llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0 };

    for (const r of txAgg) {
      const v = round(Math.abs(usd(r.spend)));
      all.llmUSD = round(all.llmUSD + v);
      if (r._id.recent) month.llmUSD = round(month.llmUSD + v);
    }
    const qKey = { tts: 'tts_chars', flux: 'flux_images', tavily: 'tavily_searches' };
    const cKey = { tts: 'ttsUSD', flux: 'fluxUSD', tavily: 'tavilyUSD' };
    for (const r of kuAgg) {
      const svc = r._id.service;
      if (cKey[svc]) {
        all[cKey[svc]] = round(all[cKey[svc]] + (r.costUSD || 0));
        all[qKey[svc]] += r.quantity || 0;
        if (r._id.recent) {
          month[cKey[svc]] = round(month[cKey[svc]] + (r.costUSD || 0));
          month[qKey[svc]] += r.quantity || 0;
        }
      }
    }
    month.totalUSD = round(month.llmUSD + month.ttsUSD + month.fluxUSD + month.tavilyUSD);
    all.totalUSD = round(all.llmUSD + all.ttsUSD + all.fluxUSD + all.tavilyUSD);

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
 * HTML pages (no server-side auth; client JS gets a token via /api/auth/refresh
 * exactly like the SPA does, then calls the gated APIs above).
 * -------------------------------------------------------------------------- */
const FEED_HTML = require('./kadePages').feedHtml;
const DASH_HTML = require('./kadePages').dashboardHtml;
const sendHtml = (html) => (req, res) => res.type('html').send(html);

router.feedPage = sendHtml(FEED_HTML);
router.dashboardPage = sendHtml(DASH_HTML);
// Also reachable under the API namespace:
router.get('/feed', router.feedPage);
router.get('/dashboard', router.dashboardPage);

module.exports = router;
