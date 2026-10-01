import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LibraryOriginalBook } from './original';
import { libraryOriginalLibrarian, reviewedLibraryOriginal } from './original';

const ID = 'a'.repeat(24);
const SHA = 'b'.repeat(64);
const book = (extension = 'pdf'): LibraryOriginalBook => ({
  _id: ID,
  kind: 'text',
  state: 'ready',
  format: 'curated-source',
  fileKey: `media-library/${ID}/source.${extension}`,
  fileBytes: 1234,
  fileSha256: SHA,
  originalName: `source.${extension}`,
  meta: {
    curatedOriginal: {
      schemaVersion: 1,
      reviewed: true,
      key: `media-library/${ID}/source.${extension}`,
      bytes: 1234,
      sha256: SHA,
      mime: extension === 'pdf' ? 'application/pdf' : 'image/jpeg',
      originalName: `source.${extension}`,
    },
  },
  librarian: {
    state: 'done',
    note: 'A reviewed description, with uncertain OCR identified in the text.',
    confidence: 'reviewed source',
    sources: [{ title: 'Repository', url: 'https://repository.example/item/1' }],
  },
});

test('reviewed PDF and JPEG editions retain one exact Library-owned original', () => {
  for (const extension of ['pdf', 'jpg', 'jpeg']) {
    const item = book(extension);
    const original = reviewedLibraryOriginal(item);
    assert.equal(original?.key, item.fileKey);
    assert.equal(original?.bytes, item.fileBytes);
    assert.equal(original?.sha256, item.fileSha256);
  }
  const shortcut = { ...book(), _id: 'c'.repeat(24), fileId: ID };
  assert.equal(reviewedLibraryOriginal(shortcut)?.key, book().fileKey);
});

const invalid: Array<[string, (item: LibraryOriginalBook) => void]> = [
  [
    'unreviewed edition',
    (item) => {
      item.meta!.curatedOriginal!.reviewed = false;
    },
  ],
  [
    'unknown marker version',
    (item) => {
      item.meta!.curatedOriginal!.schemaVersion = 2;
    },
  ],
  [
    'missing marker',
    (item) => {
      delete item.meta;
    },
  ],
  [
    'ordinary parsed book',
    (item) => {
      item.format = 'txt';
    },
  ],
  [
    'pending edition',
    (item) => {
      item.state = 'pending';
    },
  ],
  [
    'audio is not a document',
    (item) => {
      item.kind = 'audio';
    },
  ],
  [
    'invalid catalog id',
    (item) => {
      item._id = 'someone';
    },
  ],
  [
    'another book key',
    (item) => {
      item.meta!.curatedOriginal!.key = `media-library/${'c'.repeat(24)}/source.pdf`;
    },
  ],
  [
    'family key bypass',
    (item) => {
      item.meta!.curatedOriginal!.key = 'family-history/murdock/media/source.pdf';
    },
  ],
  [
    'directory traversal',
    (item) => {
      item.meta!.curatedOriginal!.key = `media-library/${ID}/../source.pdf`;
    },
  ],
  [
    'nested attachment',
    (item) => {
      item.meta!.curatedOriginal!.key = `media-library/${ID}/nested/source.pdf`;
    },
  ],
  [
    'encoded key',
    (item) => {
      item.meta!.curatedOriginal!.key = `media-library/${ID}/source%2f.pdf`;
    },
  ],
  [
    'MIME disagreement',
    (item) => {
      item.meta!.curatedOriginal!.mime = 'image/jpeg';
    },
  ],
  [
    'original name disagreement',
    (item) => {
      item.meta!.curatedOriginal!.originalName = 'different.pdf';
    },
  ],
  [
    'original name MIME disagreement',
    (item) => {
      item.meta!.curatedOriginal!.originalName = item.originalName = 'source.jpg';
    },
  ],
  [
    'unsafe download name',
    (item) => {
      item.meta!.curatedOriginal!.originalName = item.originalName = 'source\r\n.pdf';
    },
  ],
  [
    'zero bytes',
    (item) => {
      item.meta!.curatedOriginal!.bytes = item.fileBytes = 0;
    },
  ],
  [
    'negative bytes',
    (item) => {
      item.meta!.curatedOriginal!.bytes = item.fileBytes = -1;
    },
  ],
  [
    'fractional bytes',
    (item) => {
      item.meta!.curatedOriginal!.bytes = item.fileBytes = 1.5;
    },
  ],
  [
    'unsafe byte integer',
    (item) => {
      item.meta!.curatedOriginal!.bytes = item.fileBytes = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'byte field disagreement',
    (item) => {
      item.fileBytes = 1235;
    },
  ],
  [
    'hash field disagreement',
    (item) => {
      item.fileSha256 = 'c'.repeat(64);
    },
  ],
  [
    'malformed hash',
    (item) => {
      item.meta!.curatedOriginal!.sha256 = item.fileSha256 = 'not-a-hash';
    },
  ],
  [
    'uppercase hash',
    (item) => {
      item.meta!.curatedOriginal!.sha256 = item.fileSha256 = SHA.toUpperCase();
    },
  ],
  [
    'key field disagreement',
    (item) => {
      item.fileKey = `media-library/${ID}/different.pdf`;
    },
  ],
];
for (const [name, change] of invalid) {
  test(`refuses ${name}`, () => {
    const item = book();
    change(item);
    assert.equal(reviewedLibraryOriginal(item), null);
  });
}

test('source links are signed afresh and never mutate saved notes, fields or sources', async () => {
  const item = book();
  const before = JSON.stringify(item);
  const calls: Array<[string, string, number, string]> = [];
  const sign = async (key: string, mime: string, expiresIn: number, name: string) => {
    calls.push([key, mime, expiresIn, name]);
    return `https://storage.example/original?signature=${calls.length}`;
  };
  const first = await libraryOriginalLibrarian(item, sign);
  const second = await libraryOriginalLibrarian(item, sign);
  assert.equal(JSON.stringify(item), before);
  assert.equal(first?.note, item.librarian?.note);
  assert.equal(first?.confidence, item.librarian?.confidence);
  assert.deepEqual(first?.sources?.[0], item.librarian?.sources?.[0]);
  assert.equal(first?.sources?.[1].title, 'Download original PDF');
  assert.notEqual(first?.sources?.[1].url, second?.sources?.[1].url);
  assert.deepEqual(calls, [
    [item.fileKey, 'application/pdf', 43200, item.originalName],
    [item.fileKey, 'application/pdf', 43200, item.originalName],
  ]);
});

test('ordinary or invalid rows never ask storage to sign a file', async () => {
  const item = book();
  item.fileSha256 = '';
  let calls = 0;
  const result = await libraryOriginalLibrarian(item, async () => {
    calls++;
    return 'https://storage.example';
  });
  assert.equal(calls, 0);
  assert.equal(result, item.librarian);
});

test('a signing failure preserves readable text and existing source notes', async () => {
  const item = book('jpg');
  let failures = 0;
  const result = await libraryOriginalLibrarian(
    item,
    async () => {
      throw new Error('Storage unavailable');
    },
    () => failures++,
  );
  assert.equal(result, item.librarian);
  assert.equal(failures, 1);
});

test('a malformed or insecure signed URL is never emitted', async () => {
  for (const url of [
    'not a URL',
    'http://storage.example/file',
    'https://user:password@storage.example/file',
  ]) {
    const item = book();
    assert.equal(await libraryOriginalLibrarian(item, async () => url), item.librarian);
  }
});

test('the existing native source pane receives an image link as a completed note', async () => {
  const item = book('jpeg');
  delete item.librarian;
  const result = await libraryOriginalLibrarian(item, async () => 'https://storage.example/file');
  assert.equal(result?.state, 'done');
  assert.equal(result?.sources?.[0].title, 'Download original image');
});
