/* Run from the repo root:
 * node --import tsx --test packages/api/src/library/imports.test.ts
 * The book import lane and the one-file rule (Sep 25 2026): the server hashes the stored bytes as
 * they download and hands the hash to the import, and a client that sends the file's SHA-256 hears
 * before uploading that a copy it can open is exactly this file (the id always comes back). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { bookImportRouter } from './imports';

let mongo: MongoMemoryServer;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const BYTES = Buffer.from('A book, exactly as it was stored on the shelf.');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const KNOWN = 'a'.repeat(64);

function harness() {
  const stored = new Map<string, Buffer>();
  const removed: string[] = [];
  const imported: Array<{ sha256?: string; _id: string }> = [];
  const prechecks: Array<[string, string, number]> = [];
  const app = express();
  app.use(express.json());
  app.use('/imports', bookImportRouter({
    auth: (req, _res, next) => { (req as unknown as { user: { id: string } }).user = { id: 'reader-1' }; next(); },
    actor: (req) => ({ id: (req as unknown as { user: { id: string } }).user.id }),
    sign: async (key) => `https://storage.invalid/${key}`,
    head: async (key) => {
      const body = stored.get(key);
      if (!body) throw new Error('absent');
      return { ContentLength: body.length };
    },
    download: async (key) => Readable.from([stored.get(key) as Buffer]),
    remove: async (key) => { removed.push(key); stored.delete(key); },
    existing: async () => null,
    importFile: async (job) => {
      imported.push({ _id: job._id, sha256: job.sha256 });
      return { ok: true, book: { id: job._id, title: 'The Stored Book' }, skipped: [], jacket: '' };
    },
    precheck: async (actor, sha256, bytes) => {
      prechecks.push([actor.id, sha256, bytes]);
      return sha256 === KNOWN ? { ok: true, duplicate: true, same: 'file', book: { id: 'known-book', title: 'Already Here' }, skipped: [], jacket: '' } : null;
    },
    log: () => {},
  }));
  return { app, stored, removed, imported, prechecks };
}

test('a file the reader can already open is answered before any byte moves, with the job id', async () => {
  const h = harness();
  const r = await request(h.app).post('/imports').send({ requestId: 'precheck-request-0001', fileName: 'book.zip', bytes: 1234, sha256: KNOWN });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.id, 'string', 'the iPhone decodes the id as required');
  assert.equal(r.body.state, 'ready');
  assert.equal(r.body.uploadRequired, false);
  assert.equal(r.body.url, undefined, 'no upload was signed');
  assert.deepEqual(r.body.result.book, { id: 'known-book', title: 'Already Here' });
  assert.equal(r.body.result.same, 'file');
  assert.deepEqual(h.prechecks, [['reader-1', KNOWN, 1234]]);
  assert.equal(h.imported.length, 0);
});

test('an unknown or malformed hash changes nothing: the upload is signed as before', async () => {
  const h = harness();
  let r = await request(h.app).post('/imports').send({ requestId: 'precheck-request-0002', fileName: 'book.epub', bytes: 99, sha256: 'b'.repeat(64) });
  assert.equal(r.body.uploadRequired, true);
  assert.match(r.body.url, /^https:\/\/storage\.invalid\//);
  r = await request(h.app).post('/imports').send({ requestId: 'precheck-request-0003', fileName: 'book.epub', bytes: 99, sha256: 'NOT-A-HASH' });
  assert.equal(r.body.uploadRequired, true);
  assert.equal(h.prechecks.length, 1, 'a malformed hash is never looked up');
});

test('the server hashes the stored bytes as they download and passes the hash to the import', async () => {
  const h = harness();
  const first = await request(h.app).post('/imports').send({ requestId: 'download-request-0001', fileName: 'book.txt', bytes: BYTES.length });
  assert.equal(first.body.uploadRequired, true);
  h.stored.set(`book-imports/reader-1/${first.body.id}`, BYTES);
  const committed = await request(h.app).post(`/imports/${first.body.id}/commit`).send({});
  assert.equal(committed.status, 202);
  let state = '';
  for (let i = 0; i < 100 && state !== 'ready'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = (await request(h.app).get(`/imports/${first.body.id}`)).body.state;
  }
  assert.equal(state, 'ready');
  assert.deepEqual(h.imported, [{ _id: first.body.id, sha256: SHA }]);
  assert.ok(h.removed.includes(`book-imports/reader-1/${first.body.id}`), 'the scratch copy goes after the import');
});
