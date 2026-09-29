const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { createCommunityModels } = require('@librechat/data-schemas');
const { createCommunityRouter } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeBook } = require('~/models/kadeBook');
const { openBook, isChild, signGet } = require('./kadeReadingRoom')._internals;

module.exports = createCommunityRouter({
  ...createCommunityModels(mongoose),
  books: KadeBook,
  auth: requireJwtAuth,
  actor: req => req.user,
  child: isChild,
  openBook,
  sign: signGet,
  room: req => {
    try {
      const proof = req.get('X-Clubhouse-Token');
      if (!proof || proof.length > 4096) return null;
      const claims = jwt.verify(proof, process.env.LIVEKIT_API_SECRET, {
        algorithms: ['HS256'], audience: 'clubhouse-media',
      });
      return claims.uid === String(req.user.id) && typeof claims.room === 'string' ? claims.room : null;
    } catch (_) { return null; }
  },
  log: message => console.warn('[community] ' + message),
});
