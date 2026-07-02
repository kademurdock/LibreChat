const express = require('express');
const mongoose = require('mongoose');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { logKadeUsage } = require('~/models/kadeUsage');
const { KadeAsset } = require('~/models/kadeAsset');
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

    const month = { llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, phoneUSD: 0, otherUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0, phone_minutes: 0 };
    const all = { llmUSD: 0, ttsUSD: 0, fluxUSD: 0, tavilyUSD: 0, phoneUSD: 0, otherUSD: 0, tts_chars: 0, flux_images: 0, tavily_searches: 0, phone_minutes: 0 };

    for (const r of txAgg) {
      const v = round(Math.abs(usd(r.spend)));
      all.llmUSD = round(all.llmUSD + v);
      if (r._id.recent) month.llmUSD = round(month.llmUSD + v);
    }
    const qKey = { tts: 'tts_chars', flux: 'flux_images', tavily: 'tavily_searches', phone: 'phone_minutes' };
    const cKey = { tts: 'ttsUSD', flux: 'fluxUSD', tavily: 'tavilyUSD', phone: 'phoneUSD' };
    for (const r of kuAgg) {
      const svc = r._id.service;
      if (cKey[svc]) {
        all[cKey[svc]] = round(all[cKey[svc]] + (r.costUSD || 0));
        all[qKey[svc]] += r.quantity || 0;
        if (r._id.recent) {
          month[cKey[svc]] = round(month[cKey[svc]] + (r.costUSD || 0));
          month[qKey[svc]] += r.quantity || 0;
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
router.get('/my-assets', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const oid = new mongoose.Types.ObjectId(String(userId));
    const docs = await KadeAsset.find({ user: oid })
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();
    const assets = docs.map((d) => {
      let url = String(d.url || '');
      if (url && !/^https?:\/\//i.test(url) && !url.startsWith('/')) {
        url = '/' + url;
      }
      return {
        kind: d.kind,
        service: d.service,
        url,
        prompt: d.prompt || '',
        model: d.model || '',
        costUSD: d.costUSD || 0,
        createdAt: d.createdAt,
      };
    });
    return res.json({ count: assets.length, assets });
  } catch (error) {
    logger.error('[/api/kade/my-assets] error:', error);
    return res.status(500).json({ error: 'Failed to load your creations' });
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
    const { userId, service, quantity, unit, costUSD, metadata } = req.body || {};
    if (!userId || !service || !(Number(quantity) > 0)) {
      return res.status(400).json({ error: 'userId, service, and a positive quantity are required' });
    }
    await logKadeUsage({
      userId: String(userId),
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
 * HTML pages (no server-side auth; client JS gets a token via /api/auth/refresh
 * exactly like the SPA does, then calls the gated APIs above).
 * -------------------------------------------------------------------------- */
const FEED_HTML = require('./kadePages').feedHtml;
const DASH_HTML = require('./kadePages').dashboardHtml;
const CREATIONS_HTML = require('./kadePages').creationsHtml;
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

router.feedPage = sendHtml(FEED_HTML);
router.dashboardPage = sendHtml(DASH_HTML);
router.creationsPage = sendHtml(CREATIONS_HTML);
// Also reachable under the API namespace:
router.get('/feed', router.feedPage);
router.get('/dashboard', router.dashboardPage);
router.get('/creations', router.creationsPage);

module.exports = router;
