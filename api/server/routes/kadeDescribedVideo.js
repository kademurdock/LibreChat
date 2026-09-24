const axios = require('axios');
const mongoose = require('mongoose');
const {
  initializeS3,
  describedVideoPage,
  registerShutdownTask,
  createDescriptionRouter,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage } = require('~/models/kadeUsage');
const { SHARED_HEAD } = require('./kadePages');

const MEDIA_PREFIX = () => process.env.KADE_MEDIA_PREFIX || 'media-library';
/* Described copies made here get their own shelf beside her professionally described films. */
const SHELF = 'Audio/Described Movies & TV/Described by Kade-AI';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CATEGORY = {
  'commercial or promo': 'commercials',
  'music video': 'music',
  'logo, ident or bumper': 'vhs',
};
/** Commercials, music and logos keep their kind; long stories go with films, short ones with TV. */
function categoryFor(kind, seconds) {
  if (CATEGORY[kind]) return CATEGORY[kind];
  if (seconds >= 60 * 60) return 'movie';
  return kind === 'film or TV' || kind === 'animation' ? 'tv' : 'other';
}

/* Same delivery as the Sound Booth's "your song is ready": a requested phone push through the
 * bridge, plus a browser push for anyone who turned those on. */
async function notify(userId, title, body, url) {
  try {
    const { sendPushToUser } = require('~/server/services/kadeNudges');
    await sendPushToUser(userId, { title, body, url });
  } catch (e) {
    logger.warn(`[described-video] browser push: ${e.message}`);
  }
  if (!process.env.BRIDGE_SECRET) return;
  const base = (
    process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app'
  ).replace(/\/$/, '');
  await axios.post(
    `${base}/notify`,
    {
      userId,
      agentId: 'described-video',
      agentName: 'Video describer',
      title,
      body,
      requested: true,
      urgent: false,
    },
    { headers: { 'x-bridge-secret': process.env.BRIDGE_SECRET, 'User-Agent': UA }, timeout: 20000 },
  );
}

const library = {
  open: async (req, bookId, index) => {
    const { _internals } = require('./kadeReadingRoom');
    const book = await _internals.openBook(req, bookId);
    const track = book && (book.tracks || [])[index];
    if (!book || !track || !track.key) throw new Error('That library video was not found.');
    if (!/^video\//.test(track.mime || '')) throw new Error('That library item is not a video.');
    const title =
      book.tracks.length > 1 && track.title ? `${book.title} — ${track.title}` : book.title;
    return {
      key: track.key,
      bytes: track.bytes || 0,
      title: String(title || 'Library video').slice(0, 200),
      about: String(book.description || '').slice(0, 1500),
    };
  },
  save: async ({ owner, title, seconds, bytes, share, kind, copy }) => {
    const { KadeBook } = require('~/models/kadeBook');
    const { User } = require('~/db/models');
    const { _internals } = require('./kadeReadingRoom');
    const id = new mongoose.Types.ObjectId();
    const key = `${MEDIA_PREFIX()}/${id}/${Date.now().toString(36)}-described.m4a`;
    await copy(key);
    const user = await User.findById(owner, 'name username')
      .lean()
      .catch(() => null);
    const book = new KadeBook({
      _id: id,
      owner,
      ownerName: String((user && (user.name || user.username)) || '').split(' ')[0] || 'someone',
      kind: 'audio',
      category: categoryFor(kind, seconds),
      path: SHELF,
      title,
      originalName: `${title}.m4a`,
      fileBytes: bytes,
      shared: share,
      state: 'ready',
      tracks: [{ key, bytes, seconds, mime: 'audio/mp4', title, originalName: `${title}.m4a` }],
    });
    _internals.refreshListen(book);
    await book.save();
    logger.info(`[described-video] saved ${id} to ${SHELF}${share ? ' (shared)' : ''}`);
    return { id: String(id), path: SHELF };
  },
};

const { router, close } = createDescriptionRouter({
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
  notify,
  library,
});
/* A redeploy stops the process: running work is marked to continue from its saved sections. */
registerShutdownTask('described video', close);

router.page = (_req, res) => res.type('html').send(describedVideoPage(SHARED_HEAD));
module.exports = router;
