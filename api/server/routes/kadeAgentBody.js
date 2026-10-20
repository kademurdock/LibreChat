/**
 * KADE Oct 16 2026 — /api/kade/agent-body: puppet bodies for characters.
 *
 *   GET    /catalog                 every part and colour, with spoken names (drives both editors)
 *   GET    /:agentId                the saved body + compiled scene (VIEW), or { recipe: null }
 *   PUT    /:agentId                save { recipe, baseRev, source } (EDIT); 409 when someone saved first
 *   DELETE /:agentId                back to the plain portrait (EDIT)
 *   GET    /:agentId/history        the last ten saved looks (EDIT)
 *   POST   /preview                 { recipe } -> normalized recipe + scene + description (no save)
 *   POST   /surprise                { seed, fantasy } -> a random body (no save)
 *   POST   /from-words              { words, base } -> a body from a description (small paid call)
 *   POST   /:agentId/from-portrait  a body that resembles the agent's avatar (EDIT, small paid call)
 *
 * Bodies live in their own collection (api/models/kadeAgentBody.js), never on the Agent
 * document. The character is told how it looks (services/kadePuppet bodyNoteFor).
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('@librechat/data-schemas');
const { PermissionBits, FileSources, PermissionTypes, Permissions } = require('librechat-data-provider');
const { refreshS3Url, generateCheckAccess, limiterCache } = require('@librechat/api');
const { requireJwtAuth, canAccessAgentResource } = require('~/server/middleware');
const { getAgent, getRoleByName } = require('~/models');
const { logKadeUsage } = require('~/models/kadeUsage');
const { userPriceFactor } = require('~/server/services/kadeRealCost');
const bodies = require('~/models/kadeAgentBody');
const puppet = require('~/server/services/kadePuppet');

const router = express.Router();

/* ---------- one-time backfill (machine-to-machine) ----------
 * POST /admin/backfill { secret, maxUSD = 1, limit = 300, dryRun, agentIds? } starts a
 * background job that gives every character without a body a starting one: from its
 * portrait when it has one (a small vision call), otherwise from its name and
 * description. Hand-painted characters keep their own faces and are skipped. Same
 * trust model as /api/kade/agent-promote (KADE_USAGE_EVENT_SECRET). Spend stops at
 * maxUSD. GET /admin/backfill (x-kade-secret header) reports progress. */
const { HAND_PAINTED } = puppet;
const ADMIN_USER_ID = () => process.env.ADMIN_USER_ID || '6a3cba4d0b0afa92194e42f7';
let backfill = null;
/* Set before the first await so two quick POSTs cannot both start a paid run. */
let backfillStarting = false;
/* The secret rides in the x-kade-secret header (or the POST body), never the URL, and is
 * compared in constant time. */
const machine = (req) => {
  const expected = process.env.KADE_USAGE_EVENT_SECRET;
  const given = String(req.get('x-kade-secret') || (req.body && req.body.secret) || '');
  if (!expected || !given) {
    return false;
  }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

/* The app-wide parser has already read the body (3 MB), so a route limit is enforced from
 * the declared size. */
const sizeCap = (bytes) => (req, res, next) =>
  Number(req.headers['content-length'] || 0) > bytes
    ? res.status(413).json({ error: 'That request is too large.' })
    : next();

router.get('/admin/backfill', (req, res) => {
  if (!machine(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  res.json(backfill || { state: 'idle' });
});

router.post('/admin/backfill', sizeCap(32 * 1024), async (req, res) => {
  if (!machine(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (backfillStarting || (backfill && backfill.state === 'running')) {
    return res.status(409).json({ error: 'A backfill is already running', backfill });
  }
  backfillStarting = true;
  try {
    await startBackfill(req, res);
  } finally {
    backfillStarting = false;
  }
});

async function startBackfill(req, res) {
  const b = req.body || {};
  const maxUSD = Math.min(5, Math.max(0.01, Number(b.maxUSD) || 1));
  const limit = Math.min(500, Math.max(1, parseInt(b.limit, 10) || 300));
  const only = Array.isArray(b.agentIds) ? new Set(b.agentIds.map(String)) : null;
  const mongoose = require('mongoose');
  const agents = await mongoose.connection.db
    .collection('agents')
    .find({}, { projection: { id: 1, name: 1, description: 1, avatar: 1 } })
    .toArray();
  const existing = new Set((await bodies.KadeAgentBody.find({}, { agentId: 1 }).lean()).map((r) => r.agentId));
  const todo = agents
    .filter((a) => a.id && !HAND_PAINTED.has(a.id) && !existing.has(a.id) && (!only || only.has(a.id)))
    .slice(0, limit);
  backfill = { state: b.dryRun ? 'dry-run' : 'running', startedAt: new Date(), maxUSD, total: todo.length, done: 0, spentUSD: 0, results: [] };
  if (b.dryRun) {
    backfill.results = todo.map((a) => ({ agentId: a.id, name: a.name, from: a.avatar && a.avatar.filepath ? 'portrait' : 'words' }));
    return res.json(backfill);
  }
  res.status(202).json({ ok: true, total: todo.length, maxUSD });
  (async () => {
    for (const a of todo) {
      if (backfill.spentUSD >= maxUSD) {
        backfill.state = 'stopped at spend cap';
        break;
      }
      const hint = [a.name, a.description].filter(Boolean).join(': ').slice(0, 600);
      let out = null;
      let from = 'words';
      try {
        let url = a.avatar && a.avatar.filepath;
        if (url) {
          /* A character with a portrait is designed from it or not at all: words alone
           * cannot tell a dog called Diggy from a person, so any failure here (timeout,
           * unreadable answer, unreachable picture) saves nothing and a later run retries. */
          from = 'portrait';
          if (a.avatar.source === FileSources.s3) {
            url = await refreshS3Url(a.avatar).catch(() => url);
          }
          if (!/^https:\/\//i.test(String(url))) {
            throw new Error('The portrait could not be reached.');
          }
          out = await puppet.recipeFromPicture(url, hint);
        } else {
          out = await puppet.recipeFromWords(
            `A character called ${hint || 'a friendly helper'}`,
            null,
            { requirePerson: true },
          );
        }
        backfill.spentUSD += out.costUSD || 0;
        logUsage(out, from);
        const compiled = await puppet.compile(out.recipe, { cache: false });
        const saved = await bodies.saveAgentBody(a.id, {
          recipe: compiled.recipe,
          description: compiled.description,
          source: 'auto',
          updatedBy: 'backfill',
          baseRev: 0,
        });
        backfill.results.push({ agentId: a.id, name: a.name, from, ok: saved.ok, costUSD: out.costUSD, description: compiled.description });
      } catch (e) {
        // A billed answer that could not be read still costs money.
        backfill.spentUSD += e.costUSD || 0;
        if (e.costUSD) logUsage({ costUSD: e.costUSD }, from);
        backfill.results.push(
          e.code === 'creature'
            ? {
                agentId: a.id,
                name: a.name,
                from,
                ok: false,
                skipped: 'creature',
                what: e.what,
                costUSD: e.costUSD,
              }
            : {
                agentId: a.id,
                name: a.name,
                from,
                ok: false,
                error: String(e.message || e).slice(0, 200),
              },
        );
      }
      backfill.done += 1;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (backfill.state === 'running') {
      backfill.state = 'finished';
    }
    backfill.finishedAt = new Date();
    logger.info(`[kadeAgentBody] backfill ${backfill.state}: ${backfill.results.filter((r) => r.ok).length}/${backfill.total} bodies, $${backfill.spentUSD.toFixed(4)}`);
  })().catch((e) => {
    backfill.state = 'failed';
    backfill.error = e.message;
    logger.error(`[kadeAgentBody] backfill failed: ${e.message}`);
  });
}

/* POST /admin/backfill/undo { agentIds } (x-kade-secret header) removes starting bodies the
 * backfill made, so those characters go back to their paintings. Only a body nobody has
 * touched since (source 'auto', made by the backfill, still revision 1) is removed; an
 * edited one is reported and kept. */
router.post('/admin/backfill/undo', sizeCap(32 * 1024), async (req, res) => {
  if (!machine(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const ids = Array.isArray(req.body && req.body.agentIds)
    ? req.body.agentIds.map(String).slice(0, 500)
    : [];
  if (!ids.length) {
    return res.status(400).json({ error: 'agentIds is required' });
  }
  const results = [];
  for (const agentId of ids) {
    try {
      const removed = await bodies.deleteBackfilledBody(agentId);
      if (removed) {
        puppet.forgetBodyNote(agentId);
      }
      results.push({ agentId, removed });
    } catch (e) {
      results.push({ agentId, removed: false, error: String(e.message || e).slice(0, 120) });
    }
  }
  const removed = results.filter((r) => r.removed).length;
  logger.info(`[kadeAgentBody] backfill undo: ${removed}/${ids.length} removed`);
  res.json({ ok: true, results });
});

/* Backfill calls are logged against the admin seat, so the real cost shows on the usage
 * page without charging anyone. */
function logUsage(out, via) {
  logKadeUsage({
    userId: ADMIN_USER_ID(),
    service: 'openrouter',
    quantity: 1,
    unit: 'body-design',
    costUSD: out.costUSD || 0,
    metadata: { via: `body-backfill-${via}`, inTok: out.inTok, outTok: out.outTok },
  }).catch(() => {});
}

router.use(requireJwtAuth);
/* Same role gates as LibreChat's own /api/agents routes. */
router.use(generateCheckAccess({ permissionType: PermissionTypes.AGENTS, permissions: [Permissions.USE], getRoleByName }));
const canCreate = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
/* Drawing is cheap (a few ms) but unbounded; 60 a minute per person is far above any editor. */
const drawLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  handler: (_req, res) => res.status(429).json({ error: 'That is a lot of drawing at once. Try again in a minute.' }),
  keyGenerator: (req) => req.user?.id,
  store: limiterCache('kade_agent_body_limiter'),
});

const json = sizeCap(64 * 1024);
const canView = canAccessAgentResource({ requiredPermission: PermissionBits.VIEW, resourceIdParam: 'agentId' });
const canEdit = canAccessAgentResource({ requiredPermission: PermissionBits.EDIT, resourceIdParam: 'agentId' });

/* Paid helpers: a small per-person daily cap (Central time day). */
const DAILY_CAP = () => Math.max(1, parseInt(process.env.KADE_BODY_DAILY_CAP, 10) || 40);
let capDay = '';
const capCounts = new Map();
function takeCredit(userId) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  if (today !== capDay) {
    capDay = today;
    capCounts.clear();
  }
  const used = capCounts.get(userId) || 0;
  if (used >= DAILY_CAP()) {
    return false;
  }
  capCounts.set(userId, used + 1);
  return true;
}

function payload(agentId, row, compiled) {
  return {
    agentId,
    rev: row ? row.rev : 0,
    source: row ? row.source : null,
    updatedAt: row ? row.updatedAt : null,
    recipe: compiled ? compiled.recipe : null,
    description: compiled ? compiled.description : null,
    sceneHash: compiled ? compiled.sceneHash : null,
  };
}

/* The compiled scene is cached as JSON text, so it is spliced in rather than parsed and
 * re-serialized on every request. `body` is always a non-empty object (see payload). */
function sendWithScene(res, body, compiled, status = 200) {
  const head = JSON.stringify(body);
  const scene = compiled && compiled.sceneJson ? compiled.sceneJson : 'null';
  return res.status(status).type('application/json').send(`${head.slice(0, -1)},"scene":${scene}}`);
}

function withScene(body, compiled) {
  return { ...body, scene: compiled && compiled.sceneJson ? JSON.parse(compiled.sceneJson) : null };
}

router.get('/catalog', async (_req, res) => {
  try {
    res.set('Cache-Control', 'private, max-age=300');
    res.json(await puppet.catalog());
  } catch (e) {
    logger.error(`[kadeAgentBody] catalog failed: ${e.message}`);
    res.status(500).json({ error: 'The body parts catalog is unavailable right now.' });
  }
});

router.post('/preview', json, drawLimit, async (req, res) => {
  try {
    const compiled = await puppet.compile((req.body && req.body.recipe) || {}, { cache: false });
    sendWithScene(res, payload(null, null, compiled), compiled);
  } catch (e) {
    logger.error(`[kadeAgentBody] preview failed: ${e.message}`);
    res.status(400).json({ error: 'That body could not be drawn.' });
  }
});

router.post('/surprise', json, drawLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const seed = String(b.seed || `${req.user.id}-${Date.now()}`).slice(0, 80);
    const compiled = await puppet.random(seed, !!b.fantasy);
    sendWithScene(res, payload(null, null, compiled), compiled);
  } catch (e) {
    logger.error(`[kadeAgentBody] surprise failed: ${e.message}`);
    res.status(500).json({ error: 'Surprise me is unavailable right now.' });
  }
});

async function paidDesign(req, res, run, via) {
  if (!takeCredit(req.user.id)) {
    return res.status(429).json({ error: `That's ${DAILY_CAP()} body designs today. It reopens tomorrow.` });
  }
  try {
    const out = await run();
    logKadeUsage({
      userId: req.user.id,
      service: 'openrouter',
      quantity: 1,
      unit: 'body-design',
      costUSD: out.costUSD,
      metadata: { via, inTok: out.inTok, outTok: out.outTok },
    }).catch(() => {});
    logger.info(`[kadeAgentBody] ${via} in=${out.inTok} out=${out.outTok} cost=$${out.costUSD.toFixed(5)} ${out.ms}ms`);
    const compiled = await puppet.compile(out.recipe, { cache: false });
    return sendWithScene(
      res,
      {
        ...payload(null, null, compiled),
        costUSD: Number((out.costUSD * userPriceFactor(req.user)).toFixed(5)),
      },
      compiled,
    );
  } catch (e) {
    // A billed answer that could not be read still costs money.
    if (Number.isFinite(e.costUSD) && e.costUSD > 0) {
      logKadeUsage({ userId: req.user.id, service: 'openrouter', quantity: 1, unit: 'body-design', costUSD: e.costUSD, metadata: { via, failed: true } }).catch(() => {});
    }
    /* Only the service's own errors reach the browser. An upstream 401 or 402 would make the
     * web client refresh its session and replay a paid request, so those become 502. */
    // A creature is an expected answer, not a fault.
    (e.code === 'creature' ? logger.info : logger.error)(
      `[kadeAgentBody] ${via} failed: ${e.message}${e.response ? ` (upstream ${e.response.status})` : ''}`,
    );
    return e.expose
      ? res.status(e.status).json({ error: e.message })
      : res.status(502).json({ error: 'The body designer is having a moment. Try again.' });
  }
}

router.post('/from-words', json, async (req, res) => {
  const b = req.body || {};
  const words = String(b.words || '').trim();
  if (words.length < 3) {
    return res.status(400).json({ error: 'Describe the look in a few words first.' });
  }
  const base = b.base && typeof b.base === 'object' ? await puppet.normalize(b.base) : null;
  return paidDesign(req, res, () => puppet.recipeFromWords(words, base), 'body-from-words');
});

router.get('/:agentId', canView, async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const row = await bodies.getAgentBody(agentId);
    if (!row || !row.recipe) {
      return sendWithScene(res, payload(agentId, null, null), null);
    }
    const compiled = await puppet.compile(row.recipe);
    const etag = `"${row.rev}-${compiled.sceneHash}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    const out = payload(agentId, row, compiled);
    if (req.query.scene === '0') {
      return res.json(out);
    }
    return sendWithScene(res, out, compiled);
  } catch (e) {
    logger.error(`[kadeAgentBody] get ${req.params.agentId} failed: ${e.message}`);
    return res.status(500).json({ error: 'That body could not be loaded.' });
  }
});

router.put('/:agentId', json, canCreate, drawLimit, canEdit, async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const b = req.body || {};
    if (!b.recipe || typeof b.recipe !== 'object') {
      return res.status(400).json({ error: 'A body recipe is required.' });
    }
    const compiled = await puppet.compile(b.recipe);
    const source = ['editor', 'words', 'picture', 'surprise', 'auto'].includes(b.source) ? b.source : 'editor';
    const result = await bodies.saveAgentBody(agentId, {
      recipe: compiled.recipe,
      description: compiled.description,
      source,
      updatedBy: String(req.user.id),
      baseRev: Number.isFinite(Number(b.baseRev)) ? Number(b.baseRev) : 0,
    });
    puppet.forgetBodyNote(agentId);
    if (!result.ok) {
      const latest = result.conflict && result.conflict.recipe ? await puppet.compile(result.conflict.recipe) : null;
      return res.status(409).json({
        error: 'Someone else changed this body a moment ago. Here is their version.',
        latest: withScene(payload(agentId, result.conflict, latest), latest),
      });
    }
    logger.info(`[kadeAgentBody] saved ${agentId} rev=${result.body.rev} by ${req.user.id} (${source})`);
    return sendWithScene(res, payload(agentId, result.body, compiled), compiled);
  } catch (e) {
    logger.error(`[kadeAgentBody] save ${req.params.agentId} failed: ${e.message}`);
    return res.status(500).json({ error: 'That body could not be saved.' });
  }
});

router.delete('/:agentId', canCreate, canEdit, async (req, res) => {
  try {
    await bodies.deleteAgentBody(req.params.agentId);
    puppet.forgetBodyNote(req.params.agentId);
    res.json({ ok: true, agentId: req.params.agentId });
  } catch (e) {
    logger.error(`[kadeAgentBody] delete ${req.params.agentId} failed: ${e.message}`);
    res.status(500).json({ error: 'That body could not be removed.' });
  }
});

router.get('/:agentId/history', canEdit, async (req, res) => {
  try {
    const rows = await bodies.getAgentBodyHistory(req.params.agentId);
    res.json({
      agentId: req.params.agentId,
      history: rows
        .slice()
        .reverse()
        .map((h) => ({ rev: h.rev, description: h.description, source: h.source, at: h.at, recipe: h.recipe })),
    });
  } catch (e) {
    res.status(500).json({ error: 'History is unavailable right now.' });
  }
});

router.post('/:agentId/from-portrait', json, canCreate, canEdit, async (req, res) => {
  const agent = await getAgent({ id: req.params.agentId }).catch(() => null);
  if (!agent || !agent.avatar || !agent.avatar.filepath) {
    return res.status(400).json({ error: 'This character has no portrait to work from.' });
  }
  let url = agent.avatar.filepath;
  if (agent.avatar.source === FileSources.s3) {
    try {
      url = await refreshS3Url(agent.avatar);
    } catch (e) {
      logger.warn(`[kadeAgentBody] avatar refresh failed: ${e.message}`);
    }
  }
  if (!/^https:\/\//i.test(String(url))) {
    return res.status(400).json({ error: 'This portrait is not reachable for the designer.' });
  }
  const hint = [agent.name, agent.description].filter(Boolean).join(': ');
  return paidDesign(req, res, () => puppet.recipeFromPicture(url, hint), 'body-from-portrait');
});

module.exports = router;
