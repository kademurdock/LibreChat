/* /api/kade/family-history (Sep 29 2026): the owner's family research, private to the family.
 * docs/FAMILY_HISTORY.md is the contract; who gets in and every route live in packages/api
 * family/history.ts. This file only wires the private bucket, the Library's signGet and the
 * User model. The family data lives only in the bucket, never in this public repository. */
const { promisify } = require('node:util');
const { gunzip } = require('node:zlib');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { logger } = require('@librechat/data-schemas');
const { initializeS3, libraryReviewSeat, familyHistoryRouter } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { signGet } = require('./kadeReadingRoom')._internals;

const unzip = promisify(gunzip);
const BUCKET = () => process.env.KADE_MEDIA_BUCKET || process.env.AWS_BUCKET_NAME || '';
const ACCOUNT_FIELDS =
  '_id name username email role kadeFamilyTreePerson kadeFamilyHistory kadeFamilyHistoryAskedAt';
/** The only fields this route may ever write, whatever it is handed. */
const MATCH_FIELDS = ['kadeFamilyTreePerson', 'kadeFamilyHistory', 'kadeFamilyHistoryAskedAt'];
const DATE_FIELDS = new Set(['kadeFamilyHistoryAskedAt']);

/** The object's bytes, gunzipped for *.gz keys; null when the bucket has no such object. */
async function loadObject(key) {
  const client = initializeS3();
  if (!client || !BUCKET()) throw new Error('family history storage is not configured');
  let out;
  try {
    out = await client.send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  } catch (e) {
    if (
      e &&
      (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)
    )
      return null;
    throw e;
  }
  const body = Buffer.from(await out.Body.transformToByteArray());
  const zipped = key.endsWith('.gz') && body.length > 1 && body[0] === 0x1f && body[1] === 0x8b;
  return zipped ? unzip(body) : body;
}

async function findUsers() {
  const { User } = require('~/db/models');
  return User.find({}, ACCOUNT_FIELDS).limit(5000).lean();
}

/** Null values are removed. The review seat and administrators are refused here too, whatever the
 * caller checked (an admin always sees the family history as its owner). */
async function setUserFields(id, fields) {
  const { User } = require('~/db/models');
  const account = await User.findById(id, '_id email role').lean();
  if (!account) return null;
  if (libraryReviewSeat({ ...account, id: String(account._id) })) {
    throw new Error(`refused to change the review seat ${id}`);
  }
  const $set = {};
  const $unset = {};
  for (const name of MATCH_FIELDS) {
    if (!(name in fields)) continue;
    if (fields[name] == null) $unset[name] = '';
    else if (DATE_FIELDS.has(name)) {
      const at = new Date(fields[name]);
      if (Number.isNaN(at.getTime())) throw new Error(`refused a bad date for ${name}`);
      $set[name] = at;
    } else $set[name] = String(fields[name]);
  }
  const update = {
    ...(Object.keys($set).length ? { $set } : {}),
    ...(Object.keys($unset).length ? { $unset } : {}),
  };
  if (!Object.keys(update).length) return User.findById(id, ACCOUNT_FIELDS).lean();
  return User.findOneAndUpdate({ _id: id, role: { $ne: 'ADMIN' } }, update, {
    new: true,
    projection: ACCOUNT_FIELDS,
  }).lean();
}

module.exports = familyHistoryRouter({
  auth: requireJwtAuth,
  loadObject,
  signGet: (key, mime, seconds) => signGet(key, mime, seconds),
  findUsers,
  setUserFields,
  now: () => Date.now(),
  log: (message) => logger.warn(`[family-history] ${message}`),
});
