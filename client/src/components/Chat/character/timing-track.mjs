// Nov 11 2026: the face track Inworld's own timing data gives (inworld-tts-proxy timing-track.js).
// The proxy puts a small JSON "timing track" inside the WAV as a `kdtm` chunk between `fmt ` and
// `data`, only when the website asked for it (a face is on screen). It says which mouth shape shows
// at every moment of the clip (Inworld's lip-sync, derived from the audio, laughs included) and when
// each spoken word starts. Integer ms from the first sample of `data`, which is audio.currentTime 0:
//   { v: 1, src: 'inworld', set: 'oxr' | 'iw11', dur, vis: [[start, end, shape]], w?: [[start, end, text]],
//     cov: [[start, end]] }
// Fish voices, scenes, and messages cached before the track existed have none: every caller falls
// back to the loudness method then, unchanged. Pure: no DOM, no clock. The iPhone and Android ports
// copy MOUTH_PANEL and the pick below line for line.
import AvatarExpression from './avatar-expression.mjs';

export const TRACK_VERSION = 1;
const MAX_TRACK_BYTES = 512 * 1024;
/** Lips move just ahead of the sound they make. */
export const LEAD_MS = 40;
/** Half a frame: each frame shows the shape that fills most of it. The portraits draw at most 24
 *  frames a second, which on a 60 Hz screen is one frame every 50 ms, so the window is 50 ms wide
 *  and consecutive frames leave no moment unseen. */
const HALF_FRAME_MS = 25;
/** A closed lip (p, b, m) or teeth on lip (f, v) wins the frame it sits in when it fills 10 ms of it,
 *  or half of itself when it is shorter than 20 ms: some frame always holds that half, so a closure
 *  never vanishes between frames. */
const CLOSURE_MS = 10;

/**
 * The mouth sheet (face-sheet-rig.mjs): 0 closed, 1 slightly open, 2 open, 3 round "oh", 4 pursed
 * "oo", 5 spread "ee", 6 pressed, 7 teeth nearly together, 8 wide open. The puppet VISEMES nudges,
 * Angel's mouthRoles and the native CharacterMotion viseme use the same index, so this one table
 * serves every rig. A pair is [quiet-or-normal, loud] / a triple is [quiet, normal, loud].
 */
export const MOUTH_PANEL = Object.freeze({
  oxr: Object.freeze({
    sil: 0,
    PP: 6,
    FF: 7,
    TH: 1,
    DD: 1,
    kk: [1, 1, 2],
    CH: 7,
    SS: 7,
    nn: 1,
    RR: 4,
    aa: [2, 2, 8],
    E: 5,
    ih: [1, 5, 5],
    oh: 3,
    ou: 4,
  }),
  iw11: Object.freeze({
    sil: 0,
    bmp: 6,
    aei: [2, 2, 8],
    o: 3,
    ee: 5,
    fv: 7,
    th: 1,
    l: 1,
    r: 4,
    qw: 4,
    u: 4,
    chjsh: 7,
    cdgknstxyz: 1,
  }),
});
const CLOSURES = new Set(['PP', 'FF', 'bmp', 'fv']);
const LOUD = 0.55;
const QUIET = 0.25;

/** The panel for one shape at a given loudness (the same 0..1 strength voiceMessagePose computes). */
export function shapePanel(shape, set, strength = 0.4) {
  const entry = (MOUTH_PANEL[set] || MOUTH_PANEL.oxr)[shape];
  if (entry == null) return null;
  if (typeof entry === 'number') return entry;
  if (strength >= LOUD) return entry[2];
  return strength < QUIET ? entry[0] : entry[1];
}

const isSpan = (s) =>
  Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0] && s[0] >= 0;

function validTrack(track) {
  if (!track || typeof track !== 'object' || track.v !== TRACK_VERSION) return false;
  if (!(track.set in MOUTH_PANEL) || !Number.isFinite(track.dur) || track.dur <= 0) return false;
  if (
    !Array.isArray(track.vis) ||
    !track.vis.length ||
    !Array.isArray(track.cov) ||
    !track.cov.length
  )
    return false;
  for (let i = 0; i < track.vis.length; i++) {
    const s = track.vis[i];
    if (!isSpan(s) || typeof s[2] !== 'string') return false;
    if (i && s[0] < track.vis[i - 1][1]) return false; // sorted, no overlap
  }
  for (let i = 0; i < track.cov.length; i++) {
    const c = track.cov[i];
    if (!isSpan(c) || (i && c[0] < track.cov[i - 1][1])) return false;
  }
  if (track.w !== undefined) {
    if (!Array.isArray(track.w)) return false;
    for (let i = 0; i < track.w.length; i++) {
      const w = track.w[i];
      if (!isSpan(w) && !(Array.isArray(w) && w[0] === w[1])) return false;
      if (typeof w[2] !== 'string' || (i && w[0] < track.w[i - 1][0])) return false;
    }
  }
  return true;
}

/**
 * The track a WAV carries, or null. Walks the chunks of the FIRST RIFF in the buffer only (auto-read
 * can join several proxy WAVs; the track then covers the first). Never throws.
 */
export function readTimingTrack(buffer) {
  try {
    let bytes = null;
    if (buffer instanceof Uint8Array) bytes = buffer;
    else if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
    if (!bytes || bytes.length < 12) return null;
    const ascii = (at) =>
      String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return null;
    const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
    for (let at = 12; at + 8 <= end; ) {
      const id = ascii(at);
      const size = view.getUint32(at + 4, true);
      if (id === 'kdtm') {
        if (size > MAX_TRACK_BYTES || at + 8 + size > end) return null;
        const track = JSON.parse(new TextDecoder().decode(bytes.subarray(at + 8, at + 8 + size)));
        return validTrack(track) ? track : null;
      }
      if (id === 'data') return null; // the track always sits before the audio
      at += 8 + size + (size % 2);
    }
  } catch {
    /* not a track */
  }
  return null;
}

/** The track only if it belongs to audio of this length (seconds): a mismatch means it is not this take. */
export function trackFits(track, seconds) {
  return !!track && Number.isFinite(seconds) && Math.abs(track.dur - seconds * 1000) <= 250;
}

function firstAtOrAfter(spans, ms) {
  let lo = 0,
    hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid][1] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo; // first span that ends after ms
}

const coveredAt = (track, ms) => {
  const i = firstAtOrAfter(track.cov, ms);
  return i < track.cov.length && track.cov[i][0] <= ms;
};

/** The shape at one instant: { shape, set, covered }. Covered time with no span is `sil`. */
export function trackAt(track, ms) {
  if (!track || !Number.isFinite(ms)) return { shape: null, set: null, covered: false };
  if (!coveredAt(track, ms)) return { shape: null, set: track.set, covered: false };
  const i = firstAtOrAfter(track.vis, ms);
  const span = track.vis[i];
  return { shape: span && span[0] <= ms ? span[2] : 'sil', set: track.set, covered: true };
}

/**
 * The mouth panel for the frame around `ms`, or null when the track does not speak for this moment
 * (no track, outside `cov`): the caller then uses its loudness method. The frame shows the shape
 * that fills most of it, except that a lip closure of 10 ms or more wins the frame.
 */
export function trackPanelAt(track, ms, strength = 0.4) {
  if (!track || !Number.isFinite(ms) || !coveredAt(track, ms)) return null;
  const a = ms - HALF_FRAME_MS,
    b = ms + HALF_FRAME_MS;
  const weights = new Map();
  let spoken = 0,
    closure = null,
    closureMs = 0;
  for (let i = firstAtOrAfter(track.vis, a); i < track.vis.length && track.vis[i][0] < b; i++) {
    const [s, e, shape] = track.vis[i];
    const overlap = Math.min(b, e) - Math.max(a, s);
    if (overlap <= 0) continue;
    spoken += overlap;
    weights.set(shape, (weights.get(shape) || 0) + overlap);
    if (
      CLOSURES.has(shape) &&
      overlap >= Math.min(CLOSURE_MS, (e - s) / 2) &&
      overlap > closureMs
    ) {
      closure = shape;
      closureMs = overlap;
    }
  }
  if (closure) return shapePanel(closure, track.set, strength);
  // Covered time with no span is a closed mouth (the seam between two pieces).
  const gap = Math.max(0, b - a - spoken);
  if (gap > 0) weights.set('sil', (weights.get('sil') || 0) + gap);
  let best = 'sil',
    most = -1;
  for (const [shape, weight] of weights) {
    if (weight > most) {
      best = shape;
      most = weight;
    }
  }
  const panel = shapePanel(best, track.set, strength);
  return panel == null ? 0 : panel;
}

const UNSPOKEN = /%%%[^%\n]{1,160}%%%|\[(?:sound|table):[^\]\n]{0,120}\]|[*_`#>~|]+/g;
const norm = (word) =>
  word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const BRACKETED = /^\[([^\]\n]{1,40})\]$/;

/** Spoken words of the chat text with where each starts in it, skipping %%%directions%%% and cues. */
function textWords(text) {
  const out = [];
  const hidden = [];
  for (const m of text.matchAll(UNSPOKEN)) hidden.push([m.index, m.index + m[0].length]);
  let h = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    while (h < hidden.length && hidden[h][1] <= m.index) h++;
    if (h < hidden.length && hidden[h][0] <= m.index) continue;
    const n = norm(m[0]);
    if (n) out.push({ offset: m.index, n });
  }
  return out;
}

/**
 * Word anchors: [{ offset, ms }] where `offset` is a character offset in the chat text and `ms` the
 * time that word starts in the audio. The track's words follow the text the proxy SENT (writer edits,
 * spoken fillers, little sounds), so the two are walked in order, looking up to six words ahead on
 * either side to step over a filler or a changed word. Bracketed sounds are not anchors (trackMoments).
 */
export function wordAnchors(track, text) {
  if (!track || !Array.isArray(track.w) || typeof text !== 'string' || !text) return [];
  const said = track.w
    .filter((w) => !BRACKETED.test(w[2]))
    .map((w) => ({ ms: w[0], n: norm(w[2]) }));
  const written = textWords(text);
  const anchors = [];
  let i = 0,
    j = 0;
  while (i < written.length && j < said.length) {
    if (written[i].n === said[j].n) {
      anchors.push({ offset: written[i].offset, ms: said[j].ms });
      i++;
      j++;
      continue;
    }
    let moved = false;
    for (let k = 1; k <= 6 && !moved; k++) {
      if (j + k < said.length && said[j + k].n === written[i].n) {
        j += k; // the audio has words the text does not (a filler)
        moved = true;
      } else if (i + k < written.length && written[i + k].n === said[j].n) {
        i += k; // the text has words the audio does not (a writer edit)
        moved = true;
      }
    }
    if (!moved) {
      i++;
      j++;
    }
  }
  return anchors;
}

/** The little sounds the proxy added ([laugh], [sigh]...) as face moments: [{ ms, expression }]. */
export function trackMoments(track) {
  if (!track || !Array.isArray(track.w)) return [];
  const out = [];
  for (const [ms, , text] of track.w) {
    const m = BRACKETED.exec(text);
    if (!m) continue;
    const cue = AvatarExpression.cue(m[1]);
    if (cue.kind === 'moment' && cue.expression) out.push({ ms, expression: cue.expression });
  }
  return out;
}

/** Off for this browser: localStorage kadeFaceTimings = '0'. Read inside try/catch (storage may throw). */
export function faceTimingsAllowed() {
  try {
    return globalThis.localStorage?.getItem('kadeFaceTimings') !== '0';
  } catch {
    return true;
  }
}
