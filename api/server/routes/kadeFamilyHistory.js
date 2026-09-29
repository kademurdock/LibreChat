/* /api/kade/family-history (Sep 29 2026): the owner's family research, private to the family.
 * docs/FAMILY_HISTORY.md is the contract; who gets in and every route live in packages/api
 * family/history.ts. This file only wires the private bucket, the Library's signGet and voice,
 * and the User model. The family data lives only in the bucket, never in this public
 * repository. */
const { promisify } = require('node:util');
const { gunzip } = require('node:zlib');
const axios = require('axios');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { logger } = require('@librechat/data-schemas');
const { initializeS3, libraryReviewSeat, familyHistoryRouter } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage } = require('~/models/kadeUsage');
const { signGet, readingVoice } = require('./kadeReadingRoom')._internals;

const unzip = promisify(gunzip);
const BUCKET = () => process.env.KADE_MEDIA_BUCKET || process.env.AWS_BUCKET_NAME || '';
const ACCOUNT_FIELDS =
  '_id name username email role kadeFamilyTreePerson kadeFamilyHistory kadeFamilyHistoryAskedAt';
/** The only fields this route may ever write, whatever it is handed. */
const MATCH_FIELDS = ['kadeFamilyTreePerson', 'kadeFamilyHistory', 'kadeFamilyHistoryAskedAt'];
const DATE_FIELDS = new Set(['kadeFamilyHistoryAskedAt']);
/** The inbox is small; this only keeps a listing from running away. */
const LIST_LIMIT = 10000;

function storage() {
  const client = initializeS3();
  if (!client || !BUCKET()) throw new Error('family history storage is not configured');
  return client;
}

/** The object's bytes, gunzipped for *.gz keys; null when the bucket has no such object. */
async function loadObject(key) {
  const client = storage();
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

/** Notes to the owner and Listen audio: small objects under the family history prefix. */
async function putObject(key, body, mime) {
  await storage().send(
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: body, ContentType: mime }),
  );
}

async function listKeys(prefix) {
  const client = storage();
  const keys = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET(),
        Prefix: prefix,
        MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const item of out.Contents || []) if (item.Key) keys.push(item.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token && keys.length < LIST_LIMIT);
  return keys;
}

/** Listen reads the family's stories in the Library reader's voice, direction and proxy
 * (kadeReadingRoom.js), so they sound like the books do. KADE_FH_LISTEN_VOICE and
 * KADE_FH_LISTEN_STEER may set their own; changing either makes new audio (the cache key
 * covers them). */
function listenVoice() {
  const reading = readingVoice();
  return {
    proxy: reading.proxy,
    voice: process.env.KADE_FH_LISTEN_VOICE || reading.voice,
    steer:
      process.env.KADE_FH_LISTEN_STEER != null ? process.env.KADE_FH_LISTEN_STEER : reading.steer,
  };
}

/** One part of a story, voiced once as a whole WAV (it is kept in the bucket, so no stream).
 * Characters are booked to the account that first asked for the part, as the Library does. */
async function speak(text, { session, userId }) {
  const { proxy, voice, steer } = listenVoice();
  const response = await axios.post(
    `${proxy}/v1/audio/speech`,
    {
      input: (steer ? `${steer} ` : '') + text,
      voice,
      model: 'tts-1',
      speed: 1,
      delivery: 'STABLE',
      response_format: 'wav',
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-kade-tts-session': String(session).slice(0, 64),
      },
      responseType: 'arraybuffer',
      timeout: 120000,
      maxRedirects: 0,
      maxContentLength: 32 * 1024 * 1024,
      validateStatus: () => true,
    },
  );
  if (response.status !== 200) throw new Error(`the voice answered ${response.status}`);
  const mime = String(response.headers['content-type'] || '');
  if (!mime.startsWith('audio/')) throw new Error('the voice did not send audio');
  logKadeUsage({
    userId,
    service: 'tts',
    quantity: text.length,
    unit: 'chars',
    metadata: { path: 'family-history', voice },
  });
  return { audio: Buffer.from(response.data), mime };
}

async function findUsers() {
  const { User } = require('~/db/models');
  return User.find({}, ACCOUNT_FIELDS).limit(5000).lean();
}

/** Null values are removed. The review seat and administrators are refused here too, whatever the
 * caller checked (an administrator's access is set on the server, never matched here). */
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
  putObject,
  listKeys,
  speak,
  voiceTag: () => {
    const { voice, steer } = listenVoice();
    return `${voice}\n${steer}\nSTABLE`;
  },
  now: () => Date.now(),
  log: (message) => logger.warn(`[family-history] ${message}`),
});
