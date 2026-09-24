const mongoose = require('mongoose');
const { createLibraryRequestModel, logger } = require('@librechat/data-schemas');
const {
  libraryRequestService,
  libraryRequestTransport,
  libraryAccess,
  familyLibraryMember,
} = require('@librechat/api');
const { getUserById } = require('~/models');
const { KadeBook } = require('~/models/kadeBook');

async function requestReader(id) {
  if (!id) return null;
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
    child: user.kadeAccountType !== 'adult',
    hidden:
      !familyLibraryMember(user) ||
      hidden.includes(String(id).toLowerCase()) ||
      hidden.includes(String(user.email || '').toLowerCase()),
  };
}

const requests = libraryRequestService({
  requests: createLibraryRequestModel(mongoose),
  reader: requestReader,
  book: async (id, reader) => {
    const book = await KadeBook.findOne({ ...libraryAccess(reader), _id: id })
      .select('title')
      .lean();
    return book ? { id: String(book._id), title: book.title } : null;
  },
  ...libraryRequestTransport,
});
let dispatching = false;
const timer = setInterval(async () => {
  if (dispatching || mongoose.connection.readyState !== 1) return;
  dispatching = true;
  try {
    await requests.notifications();
  } catch (error) {
    logger.warn('[library-requests] Notification dispatch failed: ' + error.message);
  } finally {
    dispatching = false;
  }
}, 15000);
timer.unref();

module.exports = { requests, requestReader };
