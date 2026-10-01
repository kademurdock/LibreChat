'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { familyLibraryMember } = require('../../../packages/api/src/library/access.ts');
const {
  reviewedLibraryOriginal,
  libraryOriginalLibrarian,
} = require('../../../packages/api/src/library/original.ts');

const source = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
};
const ID = 'a'.repeat(24);
const OWNER = 'd'.repeat(24);
const item = () => ({
  _id: ID,
  owner: OWNER,
  shared: true,
  state: 'ready',
  kind: 'text',
  format: 'curated-source',
  originalName: 'newsletter.pdf',
  fileKey: `media-library/${ID}/newsletter.pdf`,
  fileBytes: 1234,
  fileSha256: 'b'.repeat(64),
  parserVersion: 1,
  sections: [{ title: 'Reviewed reading edition', chunkCount: 1 }],
  librarian: {
    state: 'done',
    note: 'Reviewed OCR; check the original page where a reading is uncertain.',
    sources: [{ title: 'Repository', url: 'https://repository.example/1' }],
  },
  meta: {
    curatedOriginal: {
      schemaVersion: 1,
      reviewed: true,
      key: `media-library/${ID}/newsletter.pdf`,
      bytes: 1234,
      sha256: 'b'.repeat(64),
      mime: 'application/pdf',
      originalName: 'newsletter.pdf',
    },
  },
});

function harness(book = item()) {
  const handlers = {};
  const log = { signed: [], downloaded: 0, reparsedWrites: 0, ai: 0 };
  const c = {
    router: {
      get: (path, ...args) => {
        handlers['GET ' + path] = args.at(-1);
      },
      post: (path, ...args) => {
        handlers['POST ' + path] = args.at(-1);
      },
    },
    requireJwtAuth() {},
    reviewedLibraryOriginal,
    libraryOriginalLibrarian,
    require: (name) =>
      name === '@librechat/api' ? { familyLibraryMember, readingJacket: (x) => x } : require(name),
    isId: (id) => /^[a-f\d]{24}$/.test(String(id)),
    isAdmin: (req) => req.user.role === 'ADMIN',
    isChild: async (req) => req.user.kadeAccountType === 'child',
    KadeBook: {
      findById: (id) => ({ lean: async () => (id === ID ? structuredClone(book) : null) }),
      updateMany: async () => {
        log.reparsedWrites++;
      },
      updateOne: async () => {
        log.reparsedWrites++;
      },
    },
    KadeReadingProgress: { findOne: () => ({ lean: async () => ({ s: 0, c: 0 }) }) },
    KadeReadingBookmark: { find: () => ({ sort: () => ({ lean: async () => [] }) }) },
    summary: (row) => ({ id: String(row._id), kind: row.kind, title: row.title }),
    isMedia: (row) => row.kind !== 'text',
    DEFAULT_VOICE: () => 'default',
    PARSER_VERSION: 999,
    logger: { warn() {}, info() {}, error() {} },
    getBuffer: async () => {
      log.downloaded++;
      throw new Error('Storage is intentionally absent in this route fixture');
    },
    signGet: async (...args) => {
      log.signed.push(args);
      return `https://storage.example/original?signature=${log.signed.length}`;
    },
    librarian: {
      librarianNotes: async () => {
        log.ai++;
        throw new Error('No AI source lookup should run');
      },
    },
    setImmediate: (callback) => {
      callback();
    },
  };
  vm.runInNewContext(
    slice('function libraryHiddenFrom(req)', 'function listenClock') +
      slice('async function openBook(req, id)', 'function summary(') +
      slice('const reparsing = new Set();', '/** Accounts that must see an EMPTY') +
      slice("router.get('/book/:id',", 'async function chunkAt(') +
      slice("router.post('/book/:id/librarian',", '/** A recap of the last N minutes:'),
    c,
  );
  const call = async (method, user, query = {}) => {
    let status = 200,
      body;
    await handlers[method](
      { user, params: { id: ID }, query },
      {
        status(code) {
          status = code;
          return this;
        },
        json(value) {
          body = JSON.parse(JSON.stringify(value));
          return this;
        },
      },
    );
    return { status, body };
  };
  return { call, log, book };
}

test('normal book access is checked before any original URL is signed', async () => {
  const allowed = [
    { id: OWNER },
    { id: 'c'.repeat(24), kadeLibraryAccess: 'family' },
    { id: 'c'.repeat(24), role: 'ADMIN' },
  ];
  for (const user of allowed) {
    const h = harness();
    const result = await h.call('GET /book/:id', user);
    assert.equal(result.status, 200);
    assert.equal(result.body.librarian.sources.at(-1).title, 'Download original PDF');
    assert.equal(h.log.signed.length, 1);
    assert.equal(h.log.downloaded, 0, 'a reviewed edition is never reparsed from its PDF');
    assert.equal(h.log.reparsedWrites, 0);
  }
  const refused = [
    { id: 'c'.repeat(24) },
    { id: 'c'.repeat(24), kadeLibraryAccess: 'none' },
    { id: '6a6125d73939d20b95251078', kadeLibraryAccess: 'family' },
    { id: '6a572e3be680dcdaadca0f04' },
    { id: '6a69074cc74d975de21f5b2a' },
    { id: 'c'.repeat(24), name: 'Test Guest' },
  ];
  for (const user of refused) {
    const h = harness();
    for (const method of ['GET /book/:id', 'GET /book/:id/librarian', 'POST /book/:id/librarian']) {
      assert.equal((await h.call(method, user)).status, 404);
    }
    assert.equal(h.log.signed.length, 0);
    assert.equal(h.log.downloaded, 0);
    assert.equal(h.log.reparsedWrites, 0);
  }
});

test('private and grown-ups-only originals follow existing shelf restrictions', async () => {
  const member = { id: 'c'.repeat(24), kadeLibraryAccess: 'family' };
  const privateItem = item();
  privateItem.shared = false;
  const h = harness(privateItem);
  assert.equal((await h.call('GET /book/:id', member)).status, 404);
  assert.equal(h.log.signed.length, 0);
  const adultItem = item();
  adultItem.grownUpsOnly = true;
  const child = harness(adultItem);
  assert.equal(
    (await child.call('GET /book/:id', { ...member, kadeAccountType: 'child' })).status,
    404,
  );
  assert.equal(child.log.signed.length, 0);
});

test('book and librarian responses renew original links and preserve reviewed credits', async () => {
  const h = harness();
  const before = JSON.stringify(h.book);
  const urls = [];
  for (const method of ['GET /book/:id', 'GET /book/:id/librarian', 'POST /book/:id/librarian']) {
    const result = await h.call(method, { id: OWNER }, { again: '1' });
    assert.equal(result.status, 200);
    assert.equal(result.body.librarian.note, h.book.librarian.note);
    assert.deepEqual(result.body.librarian.sources[0], h.book.librarian.sources[0]);
    urls.push(result.body.librarian.sources[1].url);
  }
  assert.equal(new Set(urls).size, 3);
  assert.equal(
    h.log.ai,
    0,
    'refreshing the reviewed source does not replace it with an AI web guess',
  );
  assert.equal(h.log.reparsedWrites, 0);
  assert.equal(JSON.stringify(h.book), before);
});

test('an invalid marker does not bypass the normal parser and never signs an original', async () => {
  const bad = item();
  bad.fileSha256 = 'c'.repeat(64);
  const h = harness(bad);
  const result = await h.call('GET /book/:id', { id: OWNER });
  assert.equal(result.status, 200);
  assert.equal(h.log.downloaded, 1);
  assert.equal(h.log.reparsedWrites, 1);
  assert.equal(h.log.signed.length, 0);
  assert.equal(result.body.librarian.sources.length, 1);
});

test('ordinary librarian status retains partial notes and sources without a state', async () => {
  const ordinary = item();
  ordinary.format = 'txt';
  ordinary.librarian = {
    note: 'An older partial catalog note.',
    sources: [{ title: 'Existing source', url: 'https://repository.example/old' }],
  };
  const h = harness(ordinary);
  const result = await h.call('GET /book/:id/librarian', { id: OWNER });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.librarian, ordinary.librarian);
  assert.equal(h.log.signed.length, 0);
  assert.equal(h.log.reparsedWrites, 0);
});

test('existing web and native source controls can display the new original link', () => {
  const web = fs.readFileSync(require.resolve('./kadeReadingRoomPage'), 'utf8');
  const native = fs.readFileSync(
    require('node:path').resolve(__dirname, '../../../../native/Sources/ReadingRoomLibrary.swift'),
    'utf8',
  );
  assert.match(web, /l\.sources[\s\S]{0,320}a\.href = src\.url/);
  assert.match(native, /note\?\.sources[\s\S]{0,250}Link\(s\.title \?\? u, destination: url\)/);
});
