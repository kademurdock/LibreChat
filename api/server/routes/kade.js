const express = require('express');
const mongoose = require('mongoose');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

router.use(requireJwtAuth, requireAdminAccess);

/** credits -> USD */
const usd = (credits) => (credits || 0) / 1e6;
const round = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/**
 * GET /api/kade/usage?days=30
 * Admin-only. Aggregates LLM spend (transactions) + extra-service usage
 * (KadeUsage: tts/flux/tavily) + current balances, per-user and per-service.
 * Returns all-time totals plus a windowed (default 30-day) breakdown.
 */
router.get('/usage', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const Transaction = mongoose.models.Transaction || mongoose.model('Transaction');
    const Balance = mongoose.models.Balance || mongoose.model('Balance');
    const User = mongoose.models.User || mongoose.model('User');
    const KadeUsage = mongoose.models.KadeUsage || mongoose.model('KadeUsage');

    const [users, balances] = await Promise.all([
      User.find({}, { name: 1, username: 1, email: 1, role: 1 }).lean(),
      Balance.find({}, { user: 1, tokenCredits: 1 }).lean(),
    ]);

    const userMap = {};
    for (const u of users) {
      userMap[String(u._id)] = {
        userId: String(u._id),
        name: u.name || u.username || u.email || String(u._id),
        email: u.email || null,
        role: u.role || null,
        balanceUSD: 0,
        llmSpendUSD: { allTime: 0, window: 0 },
        services: {}, // service -> { quantity, unit, costUSD: {allTime, window} }
      };
    }
    const ensureUser = (id) => {
      const k = String(id);
      if (!userMap[k]) {
        userMap[k] = {
          userId: k,
          name: k,
          email: null,
          role: null,
          balanceUSD: 0,
          llmSpendUSD: { allTime: 0, window: 0 },
          services: {},
        };
      }
      return userMap[k];
    };

    for (const b of balances) {
      ensureUser(b.user).balanceUSD = round(usd(b.tokenCredits));
    }

    // ---- LLM spend from transactions (tokenValue is negative on spend) ----
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
      if (row._id.recent) {
        u.llmSpendUSD.window = round(u.llmSpendUSD.window + spendUSD);
      }
    }

    // ---- Extra-service usage from KadeUsage ----
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
        u.services[svc].costUSD.window = round(
          u.services[svc].costUSD.window + (row.costUSD || 0),
        );
      }
    }

    // ---- Roll up per-service and grand totals ----
    const perUser = Object.values(userMap).sort((a, b) => b.llmSpendUSD.allTime - a.llmSpendUSD.allTime);
    const perService = {}; // service -> { quantity, costUSD: {allTime, window} }
    const totals = {
      llmSpendUSD: { allTime: 0, window: 0 },
      extraSpendUSD: { allTime: 0, window: 0 },
      balanceUSD: 0,
    };
    const addService = (svc, unit, qAll, qWin, cAll, cWin) => {
      if (!perService[svc]) {
        perService[svc] = {
          unit: unit || null,
          quantity: { allTime: 0, window: 0 },
          costUSD: { allTime: 0, window: 0 },
        };
      }
      perService[svc].quantity.allTime += qAll;
      perService[svc].quantity.window += qWin;
      perService[svc].costUSD.allTime = round(perService[svc].costUSD.allTime + cAll);
      perService[svc].costUSD.window = round(perService[svc].costUSD.window + cWin);
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

    return res.json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      windowSince: since.toISOString(),
      totals,
      perService,
      perUser,
    });
  } catch (error) {
    logger.error('[/api/kade/usage] error:', error);
    return res.status(500).json({ error: 'Failed to aggregate usage' });
  }
});

module.exports = router;
