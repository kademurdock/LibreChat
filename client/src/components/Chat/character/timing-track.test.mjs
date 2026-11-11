import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOUTH_PANEL,
  shapePanel,
  readTimingTrack,
  trackFits,
  trackAt,
  trackPanelAt,
  wordAnchors,
  trackMoments,
  faceTimingsAllowed,
} from './timing-track.mjs';

// A WAV the way the voice proxy writes one: RIFF / WAVE / [extra chunks] / data.
function wav(chunks, pcmBytes = 4800) {
  const parts = [];
  const chunk = (id, body) => {
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, body.length, true);
    parts.push(head, body);
    if (body.length % 2) parts.push(new Uint8Array(1));
  };
  const fmt = new Uint8Array(16);
  const v = new DataView(fmt.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, 1, true);
  v.setUint32(4, 24000, true);
  v.setUint32(8, 48000, true);
  v.setUint16(12, 2, true);
  v.setUint16(14, 16, true);
  for (const [id, body] of chunks(fmt)) chunk(id, body);
  chunk('data', new Uint8Array(pcmBytes));
  const size = parts.reduce((n, p) => n + p.length, 4);
  const out = new Uint8Array(8 + size);
  out.set([82, 73, 70, 70]);
  new DataView(out.buffer).setUint32(4, size, true);
  out.set([87, 65, 86, 69], 8);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}
const utf8 = (s) => new TextEncoder().encode(s);
const track = {
  v: 1,
  src: 'inworld',
  set: 'oxr',
  dur: 1000,
  vis: [
    [0, 100, 'sil'],
    [100, 300, 'aa'],
    [300, 310, 'PP'],
    [310, 500, 'aa'],
    [500, 600, 'oh'],
  ],
  w: [
    [100, 300, 'Hello'],
    [310, 480, 'there'],
    [520, 700, '[laugh]'],
  ],
  cov: [[0, 700]],
};
const withTrack = (t = track) =>
  wav((fmt) => [
    ['fmt ', fmt],
    ['kdtm', utf8(JSON.stringify(t))],
  ]);

test('reads kdtm between fmt and data, and after a LIST chunk too', () => {
  assert.deepEqual(readTimingTrack(withTrack()), track);
  const listed = wav((fmt) => [
    ['LIST', utf8('INFOISFT')],
    ['fmt ', fmt],
    ['kdtm', utf8(JSON.stringify(track) + ' ')],
  ]);
  assert.deepEqual(readTimingTrack(listed), track);
  assert.deepEqual(readTimingTrack(new Uint8Array(withTrack())), track);
});

test('null for a missing chunk, broken JSON, another version, too big, unsorted or bad spans', () => {
  assert.equal(readTimingTrack(wav((fmt) => [['fmt ', fmt]])), null);
  assert.equal(
    readTimingTrack(
      wav((fmt) => [
        ['fmt ', fmt],
        ['kdtm', utf8('{"v":1,')],
      ]),
    ),
    null,
  );
  assert.equal(readTimingTrack(withTrack({ ...track, v: 2 })), null);
  assert.equal(
    readTimingTrack(
      withTrack({
        ...track,
        vis: [
          [100, 300, 'aa'],
          [0, 100, 'sil'],
        ],
      }),
    ),
    null,
  );
  assert.equal(readTimingTrack(withTrack({ ...track, vis: [[0, 0, 'aa']] })), null);
  assert.equal(readTimingTrack(withTrack({ ...track, set: 'nope' })), null);
  assert.equal(readTimingTrack(withTrack({ ...track, cov: [] })), null);
  const huge = { ...track, pad: 'x'.repeat(600 * 1024) };
  assert.equal(readTimingTrack(withTrack(huge)), null);
  assert.equal(readTimingTrack(new ArrayBuffer(4)), null);
  assert.equal(readTimingTrack(null), null);
  assert.equal(readTimingTrack(utf8('ID3 not a wav at all').buffer), null);
});

test('a second RIFF joined after the first is never read', () => {
  const first = new Uint8Array(wav((fmt) => [['fmt ', fmt]]));
  const second = new Uint8Array(withTrack());
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  assert.equal(readTimingTrack(joined.buffer), null);
  const joinedTheOtherWay = new Uint8Array(first.length + second.length);
  joinedTheOtherWay.set(second);
  joinedTheOtherWay.set(first, second.length);
  assert.deepEqual(readTimingTrack(joinedTheOtherWay.buffer), track);
});

test('a track belongs to its own take: within 250 ms of the decoded length', () => {
  assert.equal(trackFits(track, 1.0), true);
  assert.equal(trackFits(track, 1.24), true);
  assert.equal(trackFits(track, 1.3), false);
  assert.equal(trackFits(null, 1), false);
});

test('trackAt: boundaries, gaps that are covered silence, and time outside cov', () => {
  assert.deepEqual(trackAt(track, 0), { shape: 'sil', set: 'oxr', covered: true });
  assert.equal(trackAt(track, 100).shape, 'aa');
  assert.equal(trackAt(track, 299.9).shape, 'aa');
  assert.equal(trackAt(track, 300).shape, 'PP');
  assert.equal(trackAt(track, 650).shape, 'sil', 'covered with no span is a closed mouth');
  assert.equal(trackAt(track, 700).covered, false);
  assert.equal(trackAt(track, 900).covered, false);
  assert.equal(trackPanelAt(track, 900), null, 'outside cov the caller uses loudness');
  assert.equal(trackPanelAt(null, 100), null);
});

test('a 10 ms lip closure between two open vowels shows as pressed for at least one frame', () => {
  const frames = [];
  for (let ms = 0; ms < 700; ms += 1000 / 24) frames.push(trackPanelAt(track, ms, 0.4));
  assert.ok(frames.includes(6), frames.join(' '));
  assert.ok(frames.includes(2) && frames.includes(3));
  // and a frame that only grazes it (under 10 ms of overlap) keeps the vowel
  assert.equal(trackPanelAt(track, 279, 0.4), 2); // [254, 304]: 4 ms of a 10 ms PP
  // whatever the frame phase, at 24 fps or at the 50 ms frames a 60 Hz screen gives, some frame shows it
  for (const step of [1000 / 24, 50]) {
    for (let phase = 0; phase < step; phase += 0.5) {
      let seen = false;
      for (let ms = phase; ms < 700 && !seen; ms += step) seen = trackPanelAt(track, ms, 0.4) === 6;
      assert.ok(seen, `step ${step} phase ${phase}`);
    }
  }
});

test('the full tables: every OpenXR and iw11 shape, with the loud and quiet variants', () => {
  const oxr = {
    sil: [0, 0, 0],
    PP: [6, 6, 6],
    FF: [7, 7, 7],
    TH: [1, 1, 1],
    DD: [1, 1, 1],
    kk: [1, 1, 2],
    CH: [7, 7, 7],
    SS: [7, 7, 7],
    nn: [1, 1, 1],
    RR: [4, 4, 4],
    aa: [2, 2, 8],
    E: [5, 5, 5],
    ih: [1, 5, 5],
    oh: [3, 3, 3],
    ou: [4, 4, 4],
  };
  const iw11 = {
    sil: [0, 0, 0],
    bmp: [6, 6, 6],
    aei: [2, 2, 8],
    o: [3, 3, 3],
    ee: [5, 5, 5],
    fv: [7, 7, 7],
    th: [1, 1, 1],
    l: [1, 1, 1],
    r: [4, 4, 4],
    qw: [4, 4, 4],
    u: [4, 4, 4],
    chjsh: [7, 7, 7],
    cdgknstxyz: [1, 1, 1],
  };
  for (const [set, table] of [
    ['oxr', oxr],
    ['iw11', iw11],
  ]) {
    assert.deepEqual(Object.keys(MOUTH_PANEL[set]).sort(), Object.keys(table).sort());
    for (const [shape, [quiet, normal, loud]] of Object.entries(table)) {
      assert.equal(shapePanel(shape, set, 0.1), quiet, `${set} ${shape} quiet`);
      assert.equal(shapePanel(shape, set, 0.4), normal, `${set} ${shape} normal`);
      assert.equal(shapePanel(shape, set, 0.8), loud, `${set} ${shape} loud`);
    }
  }
  assert.equal(shapePanel('unknown', 'oxr'), null);
});

test('word anchors step over fillers the voice added and a word the writer changed', () => {
  const t = {
    ...track,
    w: [
      [0, 100, 'Well'],
      [120, 200, 'um'],
      [200, 300, 'I'],
      [300, 500, 'finally'],
      [520, 700, 'planted'],
      [700, 760, '[laugh]'],
      [800, 900, 'the'],
      [900, 990, 'garden'],
    ],
  };
  const text = '%%%warm%%% Well, I finally got the garden.';
  const anchors = wordAnchors(t, text);
  const at = (word) => anchors.find((a) => text.slice(a.offset).startsWith(word))?.ms;
  assert.equal(at('Well'), 0);
  assert.equal(at('I '), 200, 'the filler "um" was skipped');
  assert.equal(at('finally'), 300);
  assert.equal(at('got'), undefined, '"got" became "planted": no anchor, no harm');
  assert.equal(at('the'), 800);
  assert.equal(at('garden'), 900);
  assert.ok(anchors.every((a, i) => i === 0 || a.ms > anchors[i - 1].ms));
  assert.deepEqual(wordAnchors({ ...track, w: undefined }, text), []);
});

test('bracketed sounds become face moments; [silence] and unknown sounds do not', () => {
  assert.deepEqual(trackMoments(track), [{ ms: 520, expression: 'amused' }]);
  const t = {
    ...track,
    w: [
      [0, 10, '[sigh]'],
      [10, 20, '[chuckle]'],
      [20, 30, '[breath]'],
      [30, 40, 'word'],
    ],
  };
  assert.deepEqual(trackMoments(t), [
    { ms: 0, expression: 'concerned' },
    { ms: 10, expression: 'amused' },
  ]);
});

test('one browser can switch the tracks off; storage that throws counts as on', () => {
  const saved = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: (k) => (k === 'kadeFaceTimings' ? '0' : null) };
    assert.equal(faceTimingsAllowed(), false);
    globalThis.localStorage = { getItem: () => null };
    assert.equal(faceTimingsAllowed(), true);
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    assert.equal(faceTimingsAllowed(), true);
  } finally {
    globalThis.localStorage = saved;
  }
});
