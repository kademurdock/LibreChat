const { createDescriptionRouter, describedVideoPage, initializeS3 } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage } = require('~/models/kadeUsage');
const { SHARED_HEAD } = require('./kadePages');

const { router } = createDescriptionRouter({
  auth: requireJwtAuth,
  actor: (req) => ({ id: String(req.user.id || req.user._id), role: req.user.role }),
  storage: () => initializeS3(),
  log: (message) => logger.info(`[described-video] ${message}`),
  usage: (userId, job, kind, costUSD) =>
    logKadeUsage({
      userId,
      service: 'describe',
      quantity: 1,
      unit: 'requests',
      costUSD,
      metadata: { source: 'described-video', job, kind },
    }),
});

router.page = (_req, res) => res.type('html').send(describedVideoPage(SHARED_HEAD));
module.exports = router;
