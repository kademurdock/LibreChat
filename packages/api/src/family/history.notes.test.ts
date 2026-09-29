/* Family history notes and Listen (Sep 29 2026, docs/FAMILY_HISTORY.md): notes to the owner
 * (a memory, who is in a picture, a photo to restore) and stories read aloud in the Library's
 * voice, each part voiced once and kept, on the invented family in __fixtures__/history.
 * THE REPOSITORY IS PUBLIC: every person, story and account here is made up.
 * Run from the repo root:
 * node --require <tsx cjs register> --test packages/api/src/family/history.notes.test.ts */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { FamilyBundle, FamilyHistoryAccount, FamilyHistoryDependencies } from './history';
import { FAMILY_HISTORY_OWNER_ONLY, familyHistoryRouter } from './history';
import { FAMILY_NOTE_MAX, FAMILY_NOTES_PER_DAY, familyNoteId, familyNoteIdValid } from './inbox';
import { FAMILY_LISTEN_AT_ONCE } from './listen';

process.env.KADE_APP_REVIEW_USER_IDS = 'aaaaaaaaaaaaaaaaaaaaaa05';
delete process.env.KADE_FAMILY_HISTORY_PREFIX;
delete process.env.KADE_FH_OWNER_USER_ID;
delete process.env.KADE_FH_DNA_FINDINGS;

const FIXTURES = join(__dirname, '__fixtures__', 'history');
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BUNDLE: FamilyBundle = JSON.parse(fixtureText('bundle.json'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/* A story long enough for three parts. */
const PARAGRAPH = (n: number): string =>
  `Part ${n} of an invented story. ` +
  Array.from({ length: 4 }, (_, i) => `Sentence ${i + 1} tells more of the invented farm and the bees that lived there.`).join(' ');
const STORY = `# The farm on Example Road\n\n${PARAGRAPH(1)}\n\n${PARAGRAPH(2)}\n\n${PARAGRAPH(3)}\n`;

const ACCOUNTS: Record<string, FamilyHistoryAccount> = {
  owner: { id: 'aaaaaaaaaaaaaaaaaaaaaa01', name: 'Owner Account', role: 'ADMIN' },
  ben: { id: 'aaaaaaaaaaaaaaaaaaaaaa02', name: 'Ben Account', kadeFamilyTreePerson: '@I200@' },
  guest: { id: 'aaaaaaaaaaaaaaaaaaaaaa04', name: 'Guest Friend', kadeFamilyHistory: 'guest' },
  stranger: { id: 'aaaaaaaaaaaaaaaaaaaaaa07', name: 'Bob Stranger' },
  helper: { id: 'aaaaaaaaaaaaaaaaaaaaaa26', name: 'Helper Admin', role: 'ADMIN' },
};

function bucket(bundle: FamilyBundle = BUNDLE, story: string = STORY): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ['family-history/current.json', Buffer.from(JSON.stringify({ version: 'v1' }))],
    ['family-history/v1/bundle.json.gz', gzipSync(Buffer.from(JSON.stringify(bundle)))],
    ['family-history/v1/views/I100.json.gz', Buffer.from(fixtureText('views/I100.json'))],
    ['family-history/v1/views/I200.json.gz', Buffer.from(fixtureText('views/I200.json'))],
    ['family-history/v1/stories/the-farm.md', Buffer.from(story)],
  ]);
}

/** A WAV of `seconds` of silence, 24 kHz mono 16-bit, streamed with unknown sizes as the proxy does. */
function wav(seconds: number): Buffer {
  const data = 48000 * seconds;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(0xffffffff, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(0xffffffff, 40);
  return Buffer.concat([head, Buffer.alloc(data)]);
}

type Harness = {
  base: string;
  close: () => Promise<void>;
  objects: Map<string, Buffer>;
  spoken: { text: string; session: string; userId: string }[];
  voice: { fail: boolean; delay: number };
  clock: { at: number };
};

async function harness(
  objects: Map<string, Buffer> = bucket(),
  extra: Partial<FamilyHistoryDependencies> = {},
  voiced: boolean = true,
): Promise<Harness> {
  const spoken: Harness['spoken'] = [];
  const voice = { fail: false, delay: 0 };
  const clock = { at: Date.parse('2026-03-05T12:00:00Z') };
  const auth: RequestHandler = (req, res, next) => {
    const user = ACCOUNTS[req.get('x-user') || ''];
    if (!user) {
      res.status(401).json({ error: 'Sign in first.' });
      return;
    }
    (req as { user?: FamilyHistoryAccount }).user = user;
    next();
  };
  const router = familyHistoryRouter({
    auth,
    loadObject: async (key) => objects.get(key) || null,
    signGet: async (key) => `https://bucket.example/${key}?signature=test`,
    findUsers: async () => Object.values(ACCOUNTS),
    setUserFields: async () => null,
    now: () => clock.at,
    log: () => undefined,
    putObject: async (key, body) => {
      objects.set(key, body);
    },
    listKeys: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    ...(voiced
      ? {
          speak: async (text: string, options: { session: string; userId: string }) => {
            spoken.push({ text, ...options });
            if (voice.delay) await new Promise((go) => setTimeout(go, voice.delay));
            if (voice.fail) throw new Error('the invented voice is down');
            return { audio: wav(2), mime: 'audio/wav' };
          },
          voiceTag: () => 'Invented Voice',
        }
      : {}),
    ...extra,
  });
  const app = express();
  app.use('/api/kade/family-history', router);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kade/family-history`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    objects,
    spoken,
    voice,
    clock,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(h: Harness, path: string, who: string, body?: object): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'x-user': who };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${h.base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    redirect: 'manual',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') && text ? JSON.parse(text) : text };
}

const inbox = (h: Harness): string[] => [...h.objects.keys()].filter((key) => key.startsWith('family-history/inbox/'));

/* ── notes to the owner ───────────────────────────────────────────────── */

test('note ids sort by time and are safe in a key', () => {
  const id = familyNoteId(Date.parse('2026-03-05T12:00:00Z'), '1a2b3c4d');
  assert.equal(id, '20260305T120000Z-1a2b3c4d');
  assert.equal(familyNoteIdValid(id), true);
  for (const bad of ['../x', '20260305T120000Z-1a2b3c4', '20260305T120000Z-1a2b3c4d.json', ''])
    assert.equal(familyNoteIdValid(bad), false, bad);
});

test('POST /note: a memory, who is in a picture, or a photo to restore, each checked before it is kept', async () => {
  const h = await harness();
  try {
    let r = await call(h, '/note', 'ben', { kind: 'memory', about: { personId: '@I300@' }, text: '  Dad kept invented bees.  ' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.text], [true, 'Sent to Ada. Thank you.']);
    assert.equal(familyNoteIdValid(r.body.id), true);
    const stored = JSON.parse(String(h.objects.get(`family-history/inbox/${r.body.id}.json`)));
    assert.deepEqual(stored, {
      id: r.body.id,
      at: '2026-03-05T12:00:00.000Z',
      from: { userId: ACCOUNTS.ben.id, name: 'Ben Account', personId: '@I200@', mode: 'family' },
      kind: 'memory',
      about: { personId: '@I300@' },
      text: 'Dad kept invented bees.',
      done: false,
      doneAt: null,
    });

    r = await call(h, '/note', 'guest', { kind: 'who', about: { mediaId: 'm-grave1' }, text: 'That is an invented stone carver.' });
    assert.equal(r.status, 200, 'guests may send a note too');
    r = await call(h, '/note', 'ben', { kind: 'restore-request', about: { mediaId: 'm-grave1' } });
    assert.deepEqual([r.status, r.body.text], [200, 'Asked. Ada will see your request.']);
    assert.equal(JSON.parse(String(h.objects.get(`family-history/inbox/${r.body.id}.json`))).text, 'Please restore this photo');

    const refusals: [object, string][] = [
      [{ kind: 'gossip', text: 'x' }, 'Choose a memory, who is in a picture, or a photo to restore.'],
      [{ kind: 'memory' }, 'Write the note first.'],
      [{ kind: 'memory', text: 42 }, 'Write the note as text.'],
      [{ kind: 'memory', text: 'x'.repeat(FAMILY_NOTE_MAX + 1) }, 'Keep the note to 2,000 characters.'],
      [{ kind: 'memory', about: { personId: '@I999@' }, text: 'x' }, 'That person is not in the family tree.'],
      [{ kind: 'who', text: 'Who?' }, 'Choose the picture this is about.'],
      [{ kind: 'who', about: { mediaId: 'm-none' }, text: 'x' }, 'That picture is not in the family history.'],
      [{ kind: 'restore-request', about: { mediaId: 'm-rec1' } }, 'Records and documents are kept as they are, never restored.'],
      [{ kind: 'restore-request', about: { mediaId: 'm-tree1' } }, 'This photo has been restored already.'],
      [{ kind: 'restore-request' }, 'Choose the photo to restore.'],
    ];
    for (const [body, error] of refusals) {
      r = await call(h, '/note', 'ben', body);
      assert.deepEqual([r.status, r.body.error], [400, error], JSON.stringify(body).slice(0, 60));
    }
    r = await call(h, '/note', 'guest', { kind: 'who', about: { mediaId: 'm-held' }, text: 'x' });
    assert.deepEqual([r.status, r.body.error], [400, 'That picture is not in the family history.'], 'a held picture is not the guest\'s to see');
    r = await call(h, '/note', 'stranger', { kind: 'memory', text: 'x' });
    assert.deepEqual([r.status, r.body.reason], [403, 'unmatched']);
    assert.equal(inbox(h).length, 3, 'nothing refused was kept');
  } finally {
    await h.close();
  }
});

test('POST /note: at most twenty a day for each account; without a bucket to write to, none', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < FAMILY_NOTES_PER_DAY; i++)
      assert.equal((await call(h, '/note', 'ben', { text: `Memory ${i}` })).status, 200);
    const r = await call(h, '/note', 'ben', { text: 'One more' });
    assert.deepEqual([r.status, r.body.error], [429, 'That is 20 notes today. Send more tomorrow.']);
    assert.equal((await call(h, '/note', 'guest', { text: 'Another account' })).status, 200);
    h.clock.at += 24 * 60 * 60 * 1000;
    assert.equal((await call(h, '/note', 'ben', { text: 'The next day' })).status, 200);
  } finally {
    await h.close();
  }
  const none = await harness(bucket(), { putObject: undefined });
  try {
    const r = await call(none, '/note', 'ben', { text: 'x' });
    assert.deepEqual([r.status, r.body.error], [503, 'Notes cannot be sent yet.']);
  } finally {
    await none.close();
  }
});

test('GET /notes and POST /notes/:id/done: only the owner reads them, newest first, with who and what they are about', async () => {
  const h = await harness();
  try {
    const first = (await call(h, '/note', 'ben', { kind: 'memory', about: { personId: '@I300@' }, text: 'A first memory.' })).body.id;
    h.clock.at += 60000;
    const second = (await call(h, '/note', 'guest', { kind: 'who', about: { mediaId: 'm-grave1' }, text: 'A carver.' })).body.id;
    for (const who of ['ben', 'guest']) {
      const r = await call(h, '/notes', who);
      assert.deepEqual([r.status, r.body], [403, { error: FAMILY_HISTORY_OWNER_ONLY }], who);
    }
    let r = await call(h, '/notes', 'owner');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((n: Json) => n.id), [second, first]);
    assert.deepEqual(r.body[1].from, { userId: ACCOUNTS.ben.id, name: 'Ben Account' });
    assert.equal(r.body[1].kindText, 'A memory');
    assert.equal(r.body[1].about.person.term, 'your grandfather', 'said from the owner\'s place');
    assert.equal(r.body[0].kindText, 'Who is in this picture');
    assert.equal(r.body[0].about.image.id, 'm-grave1');
    assert.equal((await call(h, '/home', 'owner')).body.owner.notes, 2);

    r = await call(h, `/notes/${first}/done`, 'owner', {});
    assert.deepEqual(r.body, { ok: true, id: first, done: true });
    assert.equal(JSON.parse(String(h.objects.get(`family-history/inbox/${first}.json`))).doneAt, new Date(h.clock.at).toISOString());
    assert.equal((await call(h, '/home', 'owner')).body.owner.notes, 1);
    r = await call(h, `/notes/${first}/done`, 'owner', { done: false });
    assert.equal(r.body.done, false);
    assert.equal((await call(h, `/notes/${first}/done`, 'ben', {})).status, 403);
    assert.equal((await call(h, '/notes/20260305T120000Z-ffffffff/done', 'owner', {})).status, 404);
    assert.equal((await call(h, '/notes/..%2F..%2Fbundle/done', 'owner', {})).status, 404);

    process.env.KADE_FH_OWNER_USER_ID = ACCOUNTS.owner.id as string;
    try {
      assert.equal((await call(h, '/notes', 'helper')).status, 403, 'once the owner account is set, only it');
      assert.equal((await call(h, '/notes', 'owner')).status, 200);
    } finally {
      delete process.env.KADE_FH_OWNER_USER_ID;
    }
  } finally {
    await h.close();
  }
});

test('notes survive a restart: the inbox is read back from the bucket', async () => {
  const objects = bucket();
  const one = await harness(objects);
  let id = '';
  try {
    id = (await call(one, '/note', 'ben', { text: 'Kept in the bucket.' })).body.id;
  } finally {
    await one.close();
  }
  const two = await harness(objects);
  try {
    const r = await call(two, '/notes', 'owner');
    assert.deepEqual(r.body.map((n: Json) => [n.id, n.text]), [[id, 'Kept in the bucket.']]);
  } finally {
    await two.close();
  }
});

/* ── Listen ───────────────────────────────────────────────────────────── */

test('Listen: each part is voiced once in the Library voice, kept under hashes, signed, with sentence cues in seconds', async () => {
  const h = await harness();
  try {
    let r = await call(h, '/story/the-farm/listen', 'ben');
    assert.equal(r.status, 200);
    assert.equal(r.body.listen, true);
    assert.equal(r.body.count, 3);
    assert.deepEqual(r.body.parts.map((p: Json) => [p.i, p.audio, p.ready]), [
      [0, '/story/the-farm/audio/0', false],
      [1, '/story/the-farm/audio/1', false],
      [2, '/story/the-farm/audio/2', false],
    ]);
    assert.ok(r.body.parts.every((p: Json) => p.text.length <= 600));

    r = await call(h, '/story/the-farm/audio/0', 'ben');
    assert.equal(r.status, 200);
    assert.equal(r.body.duration, 2, 'the length comes from the WAV itself');
    assert.equal(r.body.mime, 'audio/wav');
    assert.equal(r.body.next, 1);
    assert.match(r.body.url, /^https:\/\/bucket\.example\/family-history\/audio\/[0-9a-f]{20}\/[0-9a-f]{20}\.wav\?signature=test$/);
    assert.equal(r.body.url.includes('farm'), false, 'no slug or title in a key');
    assert.equal(r.body.cues[0].start, 0);
    assert.equal(r.body.cues[r.body.cues.length - 1].end, 2);
    assert.equal(r.body.cues[0].text, 'Part 1 of an invented story.');
    assert.equal(h.spoken[0].text, r.body.text);
    assert.equal(h.spoken[0].userId, ACCOUNTS.ben.id);
    assert.match(h.spoken[0].session, /^family:[0-9a-f]{20}$/);
    await new Promise((go) => setTimeout(go, 50));
    assert.equal(h.spoken.length, 2, 'the next part is voiced ahead');
    const kept = [...h.objects.keys()].filter((key) => key.startsWith('family-history/audio/'));
    assert.equal(kept.filter((key) => key.endsWith('.wav')).length, 2);
    const wavKey = kept.find((key) => key.endsWith('.wav')) as string;
    const file = h.objects.get(wavKey) as Buffer;
    assert.equal(file.readUInt32LE(4), file.length - 8, 'a streamed WAV is mended before it is kept');

    await call(h, '/story/the-farm/audio/0', 'owner');
    await call(h, '/story/the-farm/audio/1', 'guest');
    await new Promise((go) => setTimeout(go, 50));
    assert.equal(h.spoken.length, 3, 'nothing is voiced twice (part 2 was voiced ahead once)');
    r = await call(h, '/story/the-farm/listen', 'ben');
    assert.deepEqual(r.body.parts.map((p: Json) => p.ready), [true, true, true]);
    r = await call(h, '/story/the-farm/audio/0?redirect=1', 'ben');
    assert.equal(r.status, 302);
    assert.equal((await call(h, '/story/the-farm/audio/3', 'ben')).status, 404);
    assert.equal((await call(h, '/story/the-farm/audio/-1', 'ben')).status, 404);
    assert.equal((await call(h, '/story/escape/audio/0', 'ben')).status, 404);
    assert.equal((await call(h, '/story/the-farm/audio/0', 'stranger')).status, 403);
  } finally {
    await h.close();
  }
});

test('Listen: audio already in the bucket is never voiced again, even after a restart; a new voice makes new audio', async () => {
  const objects = bucket();
  const one = await harness(objects);
  try {
    await call(one, '/story/the-farm/audio/2', 'ben');
  } finally {
    await one.close();
  }
  const two = await harness(objects);
  try {
    const r = await call(two, '/story/the-farm/audio/2', 'owner');
    assert.equal(r.status, 200);
    assert.equal(two.spoken.length, 0, 'read back from the bucket');
  } finally {
    await two.close();
  }
  const three = await harness(objects, { voiceTag: () => 'Another Invented Voice' });
  try {
    await call(three, '/story/the-farm/audio/2', 'owner');
    assert.equal(three.spoken.length, 1);
  } finally {
    await three.close();
  }
});

test('Listen: the voice failing answers 502 and keeps nothing; asking twice at once voices once; at most two at a time', async () => {
  const h = await harness();
  try {
    h.voice.fail = true;
    let r = await call(h, '/story/the-farm/audio/0', 'ben');
    assert.deepEqual([r.status, r.body.error], [502, 'The voice did not answer. Try that part again.']);
    await new Promise((go) => setTimeout(go, 50));
    assert.equal([...h.objects.keys()].some((key) => key.includes('/audio/')), false);
    h.voice.fail = false;
    h.spoken.length = 0;
    h.voice.delay = 60;
    const answers = await Promise.all([0, 0, 0].map(() => call(h, '/story/the-farm/audio/0', 'ben')));
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200]);
    assert.equal(h.spoken.filter((s) => s.text === answers[0].body.text).length, 1, 'one voicing for three asks');
    assert.equal(FAMILY_LISTEN_AT_ONCE, 2);
    r = await call(h, '/story/the-farm/audio/0', 'ben');
    assert.equal(r.status, 200);
  } finally {
    await h.close();
  }
});

test('Listen is off without a voice, and a sensitive story follows the family-mysteries switch', async () => {
  const quiet = await harness(bucket(), {}, false);
  try {
    assert.equal((await call(quiet, '/story/the-farm/listen', 'ben')).body.listen, false);
    assert.equal((await call(quiet, '/story/the-farm?v=2', 'ben')).body.listen, false);
    const r = await call(quiet, '/story/the-farm/audio/0', 'ben');
    assert.deepEqual([r.status, r.body.error], [503, 'Listening is not set up yet.']);
  } finally {
    await quiet.close();
  }
  const sensitive = clone(BUNDLE);
  sensitive.stories[0].sensitive = true;
  const h = await harness(bucket(sensitive));
  try {
    assert.equal((await call(h, '/story/the-farm?v=2', 'ben')).body.listen, true);
    assert.equal((await call(h, '/story/the-farm/audio/0', 'guest')).status, 404, 'never to a guest');
    process.env.KADE_FH_DNA_FINDINGS = 'off';
    assert.equal((await call(h, '/story/the-farm/listen', 'owner')).status, 404);
  } finally {
    delete process.env.KADE_FH_DNA_FINDINGS;
    await h.close();
  }
});
