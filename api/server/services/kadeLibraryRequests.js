/**
 * LIBRARY REQUESTS (Sep 24 2026) — anyone asks the librarian for any media;
 * Kade reviews the list on the Library page; the requester hears when it is filled.
 *
 * The rules live in packages/api/src/library/requests.ts. This file wires them
 * to the site: who is asking, which catalog items they can open, and how news
 * reaches people.
 *   - Requesters get ONE grouped alert per burst of changes: the phone app's
 *     push (a requested push, so quiet hours delay it rather than drop it), a
 *     browser push, and, when a request is filled or closed, one merged line
 *     for their next conversation.
 *   - Kade hears about NEW requests in a digest, at most once every twelve
 *     hours (KADE_LIBRARY_REQUEST_DIGEST_HOURS), never one nudge per request.
 *   - Test seats save requests like anyone, but never alert and never reach
 *     her digest.
 *   - Research is owner-started and paid by the platform; see requests.ts.
 */
const mongoose = require('mongoose');
const {
  logger,
  createLibraryRequestModel,
  createLibraryRequestStateModel,
} = require('@librechat/data-schemas');
const {
  libraryRequestService,
  libraryResearchTransport,
  libraryRequestPhoneAlert,
  createRequestNotifier,
  libraryAccess,
  familyLibraryMember,
} = require('@librechat/api');
const { getUserById } = require('~/models');
const { KadeBook } = require('~/models/kadeBook');
/* Loaded on use, as the Library routes do, so requiring this file never changes when the
 * nudge engine loads. */
const nudges = () => require('~/server/services/kadeNudges');

async function requestReader(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  const user = await getUserById(id, 'email name username role kadeAccountType kadeLibraryAccess');
  if (!user) return null;
  const hidden = String(process.env.KADE_LIBRARY_HIDDEN_FROM || 'kadeai.vischeck722@gmail.com')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());
  return {
    id: String(id),
    name: user.name || user.username || 'Library reader',
    admin: user.role === 'ADMIN',
    // The account schema defaults to adult; anything else fails closed.
    child: user.kadeAccountType !== 'adult',
    hidden:
      !familyLibraryMember(user) ||
      hidden.includes(String(id).toLowerCase()) ||
      hidden.includes(String(user.email || '').toLowerCase()),
    testSeat: nudges().isTestUser(String(id)),
  };
}

/** One waiting conversation line per person. The text already covers every outcome they have not
 * read, so newer news replaces the waiting line instead of piling up beside it. */
async function chatNews(userId, text) {
  const { KadePendingNudge } = require('~/models/kadeNudge');
  const replaced = await KadePendingNudge.updateOne(
    { userId, type: 'library-request', channel: 'chat', deliveredAt: null },
    { $set: { text: text.slice(0, 900) } },
  );
  if (replaced.matchedCount) return;
  await KadePendingNudge.create({ userId, text, type: 'library-request', channel: 'chat' });
}

/** They read an outcome on the page or with the librarian: rewrite the waiting line without it, or
 * withdraw it. Never creates a line. */
async function rewriteNews(userId, text) {
  const { KadePendingNudge } = require('~/models/kadeNudge');
  const waiting = { userId, type: 'library-request', channel: 'chat', deliveredAt: null };
  if (text) await KadePendingNudge.updateOne(waiting, { $set: { text: text.slice(0, 900) } });
  else await KadePendingNudge.deleteMany(waiting);
}

const digestHours = Number(process.env.KADE_LIBRARY_REQUEST_DIGEST_HOURS);
const requests = libraryRequestService(
  {
    requests: createLibraryRequestModel(mongoose),
    state: createLibraryRequestStateModel(mongoose),
    reader: requestReader,
    book: async (id, reader) => {
      const book = await KadeBook.findOne({ ...libraryAccess(reader), _id: id })
        .select('title')
        .lean();
      return book ? { id: String(book._id), title: book.title || 'Untitled' } : null;
    },
    notify: createRequestNotifier({
      phone: libraryRequestPhoneAlert,
      browser: (notice) =>
        nudges().sendPushToUser(notice.owner, {
          title: notice.title,
          body: notice.body,
          url: notice.url,
        }),
      chat: chatNews,
    }),
    news: rewriteNews,
    announce: async (text) => {
      const { User } = require('~/db/models');
      const admins = await User.find({ role: 'ADMIN' }, '_id name').lean();
      for (const admin of admins) {
        await nudges().deliverNudge(String(admin._id), text, {
          type: 'reminder',
          userName: admin.name || '',
        });
      }
      logger.info(`[library-requests] digest sent to ${admins.length} owner account(s)`);
    },
    ...libraryResearchTransport,
  },
  Number.isFinite(digestHours) && digestHours > 0 ? { digestGapMs: digestHours * 3600000 } : {},
);

let dispatching = false;
const timer = setInterval(async () => {
  if (dispatching || mongoose.connection.readyState !== 1) return;
  dispatching = true;
  try {
    const alerted = await requests.notifications();
    if (alerted) logger.info(`[library-requests] alerted ${alerted} requester(s)`);
    await requests.digest();
  } catch (error) {
    logger.warn('[library-requests] alert pass failed: ' + error.message);
  } finally {
    dispatching = false;
  }
}, 15000);
timer.unref();

module.exports = { requests, requestReader };
