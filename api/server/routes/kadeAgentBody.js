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
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { PermissionBits, FileSources } = require('librechat-data-provider');
const { refreshS3Url } = require('@librechat/api');
const { requireJwtAuth, canAccessAgentResource } = require('~/server/middleware');
const { getAgent } = require('~/models');
const { logKadeUsage } = require('~/models/kadeUsage');
const { userPriceFactor } = require('~/server/services/kadeRealCost');
const bodies = require('~/models/kadeAgentBody');
const puppet = require('~/server/services/kadePuppet');

const router = express.Router();
router.use(requireJwtAuth);

const json = express.json({ limit: '64kb' });
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
    scene: compiled ? compiled.scene : null,
  };
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

router.post('/preview', json, async (req, res) => {
  try {
    const compiled = await puppet.compile((req.body && req.body.recipe) || {});
    res.json(payload(null, null, compiled));
  } catch (e) {
    logger.error(`[kadeAgentBody] preview failed: ${e.message}`);
    res.status(400).json({ error: 'That body could not be drawn.' });
  }
});

router.post('/surprise', json, async (req, res) => {
  try {
    const b = req.body || {};
    const seed = String(b.seed || `${req.user.id}-${Date.now()}`).slice(0, 80);
    res.json(payload(null, null, await puppet.random(seed, !!b.fantasy)));
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
    const compiled = await puppet.compile(out.recipe);
    return res.json({
      ...payload(null, null, compiled),
      costUSD: Number((out.costUSD * userPriceFactor(req.user && req.user.role)).toFixed(5)),
    });
  } catch (e) {
    const status = e.status || (e.response && e.response.status >= 500 ? 502 : 500);
    logger.error(`[kadeAgentBody] ${via} failed: ${e.message}`);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: e.status ? e.message : 'The body designer is having a moment. Try again.' });
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
      return res.json(payload(agentId, null, null));
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
      delete out.scene;
    }
    return res.json(out);
  } catch (e) {
    logger.error(`[kadeAgentBody] get ${req.params.agentId} failed: ${e.message}`);
    return res.status(500).json({ error: 'That body could not be loaded.' });
  }
});

router.put('/:agentId', json, canEdit, async (req, res) => {
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
        latest: payload(agentId, result.conflict, latest),
      });
    }
    logger.info(`[kadeAgentBody] saved ${agentId} rev=${result.body.rev} by ${req.user.id} (${source})`);
    return res.json(payload(agentId, result.body, compiled));
  } catch (e) {
    logger.error(`[kadeAgentBody] save ${req.params.agentId} failed: ${e.message}`);
    return res.status(500).json({ error: 'That body could not be saved.' });
  }
});

router.delete('/:agentId', canEdit, async (req, res) => {
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

router.post('/:agentId/from-portrait', json, canEdit, async (req, res) => {
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
