/* GET /api/kade/features (Part 293, Sep 25 2026): the signed-in person's
 * Family feature pack map, { familyPack, name, note, refusal, features:
 * { mediaLinks, describerLinks, jukeboxLinks, familyLibrary } }, so a client
 * greys out a pack control without an app build. The rule lives in
 * packages/api family/pack.ts. */
const { familyFeaturesRouter } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');

module.exports = familyFeaturesRouter(requireJwtAuth);
