const axios = require('axios');
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
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
const refused = (message, status) => Object.assign(new Error(message), { status });
/** Cuts by characters, never through the middle of an emoji. */
const cut = (value, max) =>
  Array.from(String(value || ''))
    .slice(0, max)
    .join('');

/* Same delivery as the Sound Booth's "your song is ready": a requested phone push through the
 * bridge, plus a browser push for anyone who turned those on. `route` makes the bridge send a
 * KADE_ROUTE push, so a tap on the phone opens the described-video screen instead of a new chat;
 * the job id travels as runId, which the bridge accepts (today it forwards runId only for
 * agent-work pushes). Returns what happened, including the bridge's receipt, for the log. */
async function notify(userId, title, body, url, detail = {}) {
  const result = { browser: 0, bridge: 'off' };
  try {
    const { sendPushToUser } = require('~/server/services/kadeNudges');
    result.browser = Number(await sendPushToUser(userId, { title, body, url })) || 0;
  } catch (e) {
    logger.warn(`[described-video] browser push: ${e.message}`);
    result.browser = -1;
  }
  if (!process.env.BRIDGE_SECRET) return result;
  const base = (
    process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app'
  ).replace(/\/$/, '');
  try {
    const response = await axios.post(
      `${base}/notify`,
      {
        userId,
        agentId: 'described-video',
        agentName: 'Video describer',
        title,
        body,
        requested: true,
        urgent: false,
        route: 'described-video',
        ...(detail.job ? { runId: detail.job } : {}),
      },
      {
        headers: { 'x-bridge-secret': process.env.BRIDGE_SECRET, 'User-Agent': UA },
        timeout: 20000,
      },
    );
    const receipt = response.data || {};
    result.bridge = response.status;
    result.sent = Number(receipt.sent) || 0;
    if (receipt.deferred === true) result.deferred = true;
    const blocked = receipt.blocked || receipt.error || receipt.note;
    if (blocked) result.blocked = String(blocked).slice(0, 120);
  } catch (e) {
    result.bridge = `failed ${(e.response && e.response.status) || e.code || 'network'}`;
  }
  return result;
}

/** What the Library already knows about an item, as plain facts the describer may use to recognise it. */
function catalogFacts(book) {
  const meta = book.meta || {};
  const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
  const station = [text(meta.callSign), text(meta.network)].filter(Boolean).join(', ');
  const librarian = book.librarian || {};
  return [
    text(book.path) && `Shelf: ${text(book.path)}`,
    text(book.category) && `Category: ${text(book.category)}`,
    (text(meta.year) || text(meta.decade)) && `Year: ${text(meta.year) || text(meta.decade)}`,
    station && `Station: ${station}`,
    text(meta.brand) && `Brand: ${text(meta.brand)}`,
    text(meta.market) && `Market: ${text(meta.market)}`,
    text(librarian.identified) &&
      !/^low/i.test(text(librarian.confidence)) &&
      `The librarian identified it as: ${text(librarian.identified)}`,
  ]
    .filter(Boolean)
    .join('. ')
    .slice(0, 600);
}

/** The described transcript as a readable Library text item beside the audio, found by the same search. */
async function saveTranscript({
  id,
  owner,
  ownerName,
  title,
  path,
  share,
  grownUpsOnly,
  transcript,
}) {
  const { KadeBook, KadeBookText } = require('~/models/kadeBook');
  const { parseBook, PARSER_VERSION } = require('./kadeReadingRoomParse');
  const textId = new mongoose.Types.ObjectId(
    createHash('sha256').update(`${id}:transcript`).digest('hex').slice(0, 24),
  );
  if (await KadeBook.exists({ _id: textId })) return;
  const name = `${title}, transcript`;
  const parsed = await parseBook(Buffer.from(transcript, 'utf8'), `${name}.txt`);
  if (!parsed.sections.length) return;
  await KadeBookText.updateOne(
    { book: textId },
    {
      $set: {
        sections: parsed.sections.map((section) => ({ chunks: section.chunks })),
        skipped: parsed.skipped.map((section) => ({ chunks: section.chunks })),
      },
    },
    { upsert: true },
  );
  const book = new KadeBook({
    _id: textId,
    owner,
    ownerName,
    kind: 'text',
    category: 'other',
    path,
    title: name,
    description: 'The descriptions and dialogue of the described copy, in playback order.',
    originalName: `${name}.txt`,
    format: 'txt',
    jacket: parsed.jacket,
    sections: parsed.sections.map((section) => ({
      title: section.title,
      chunkCount: section.chunks.length,
      chars: section.chars,
      kind: section.kind,
    })),
    skipped: parsed.skipped.map((section) => ({
      title: section.title,
      reason: section.reason,
      chunkCount: section.chunks.length,
      chars: section.chars,
    })),
    stats: { chunks: parsed.stats.chunks, chars: parsed.stats.chars, listen: parsed.stats.listen },
    shared: share,
    ...(share ? { sharedAt: new Date() } : {}),
    grownUpsOnly,
    parserVersion: PARSER_VERSION,
    state: 'ready',
    meta: { describedTranscriptOf: String(id) },
  });
  await book.save().catch((e) => {
    if (!e || e.code !== 11000) throw e;
  });
}

const library = {
  folders: async (req) => {
    const { KadeBook } = require('~/models/kadeBook');
    const owner = String(req.user.id || req.user._id);
    return KadeBook.distinct('path', { owner, state: 'ready', path: { $ne: '' } });
  },
  open: async (req, bookId, index) => {
    const { _internals } = require('./kadeReadingRoom');
    const book = await _internals.openBook(req, bookId);
    const track = book && (book.tracks || [])[index];
    if (!book || !track || !track.key) throw refused('That library video was not found.', 404);
    if (!/^video\//.test(track.mime || '')) throw refused('That library item is not a video.', 400);
    const title =
      book.tracks.length > 1 && track.title ? `${book.title} — ${track.title}` : book.title;
    return {
      key: track.key,
      bytes: track.bytes || 0,
      title: cut(title || 'Library video', 200),
      about: cut(book.description, 1500),
      shared: !!book.shared,
      grownUpsOnly: !!book.grownUpsOnly,
      ownerIsActor: String(book.owner) === String(req.user.id || req.user._id),
      context: catalogFacts(book),
      path: String(book.path || ''),
    };
  },
  /* The router hands a book id it stored before calling, so a retry after a crash finds the
   * book it already made instead of making a second one. */
  save: async ({
    id,
    owner,
    title,
    seconds,
    bytes,
    share,
    grownUpsOnly,
    kind,
    path = SHELF,
    transcript,
    sourceBook,
    sourceTrack,
    description,
    copy,
  }) => {
    const { KadeBook } = require('~/models/kadeBook');
    const { User } = require('~/db/models');
    const { _internals } = require('./kadeReadingRoom');
    if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('The library save had no valid id.');
    const existing = await KadeBook.findById(id, 'path').lean();
    if (existing) return { id: String(id), path: existing.path };
    const key = `${MEDIA_PREFIX()}/${id}/described.m4a`;
    await copy(key);
    const user = await User.findById(owner, 'name username')
      .lean()
      .catch(() => null);
    const ownerName =
      String((user && (user.name || user.username)) || '').split(' ')[0] || 'someone';
    const source =
      sourceBook && mongoose.Types.ObjectId.isValid(sourceBook)
        ? await KadeBook.findById(sourceBook, 'meta tags author copyrightYear')
            .lean()
            .catch(() => null)
        : null;
    const book = new KadeBook({
      _id: id,
      owner,
      ownerName,
      kind: 'audio',
      category: categoryFor(kind, seconds),
      path,
      title,
      description: [cut(description, 1900), 'Audio-described copy made by Kade-AI.']
        .filter(Boolean)
        .join('\n\n'),
      ...(source
        ? {
            meta: {
              ...(source.meta || {}),
              describedFrom: { book: String(sourceBook), track: Number(sourceTrack) || 0 },
            },
            tags: source.tags || [],
            author: source.author || '',
            copyrightYear: source.copyrightYear || '',
          }
        : {}),
      originalName: `${title}.m4a`,
      fileBytes: bytes,
      shared: share,
      ...(share ? { sharedAt: new Date() } : {}),
      grownUpsOnly: !!grownUpsOnly,
      state: 'ready',
      tracks: [{ key, bytes, seconds, mime: 'audio/mp4', title, originalName: `${title}.m4a` }],
    });
    _internals.refreshListen(book);
    try {
      await book.save();
    } catch (e) {
      if (!e || e.code !== 11000) throw e;
      return { id: String(id), path };
    }
    if (source)
      await KadeBook.updateOne(
        { _id: sourceBook },
        { $set: { 'meta.describedCopy': String(id) } },
      ).catch((e) => logger.warn(`[described-video] link to the original: ${e.message}`));
    if (transcript)
      await saveTranscript({
        id,
        owner,
        ownerName,
        title,
        path,
        share,
        grownUpsOnly: !!grownUpsOnly,
        transcript,
      }).catch((e) => logger.warn(`[described-video] transcript item: ${e.message}`));
    logger.info(
      `[described-video] saved ${id} to ${path}${share ? ' (shared)' : ''}${grownUpsOnly ? ' (grown-ups only)' : ''}`,
    );
    return { id: String(id), path };
  },
};

const { router, close } = createDescriptionRouter({
  auth: requireJwtAuth,
  actor: (req) => ({
    id: String(req.user.id || req.user._id),
    role: req.user.role,
    child: req.user.kadeAccountType === 'child',
  }),
  storage: () => initializeS3(),
  log: (message) => logger.info(`[described-video] ${message}`),
  warn: (message) => logger.warn(`[described-video] ${message}`),
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
/* Railway may give an old deployment only seconds, and the HTTP drain runs first. So stop
 * describing at the first signal; the registered task then finds the work already set aside.
 * When nothing else handles the signal, exit as the default handler would. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.prependListener(signal, () => {
    void close().finally(() => {
      if (process.listenerCount(signal) <= 1) process.exit(0);
    });
  });
}

router.page = (_req, res) => res.type('html').send(describedVideoPage(SHARED_HEAD));
module.exports = router;
