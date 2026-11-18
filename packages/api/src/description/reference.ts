/**
 * Describing with a described soundtrack as a guide (Nov 18 2026). Kade has thousands of
 * audio-described soundtracks in her Library: the film's own sound with a human describer mixed in.
 * Paired with the plain video, such a soundtrack tells the describer what happens and when, so the
 * video model only has to look where nobody speaks and the old describer said nothing.
 *
 * Her rules: the copy's lines are Kade-AI's own. The old describer's words are notes for facts and
 * timing only; no line may copy or closely follow one (`copyRun`, `closeness`, and a fact check
 * that names who does what in both). What is made stays private to its owner.
 *
 * The steps, all measured on South Park S01E01 and The Peanuts Movie (F:/KadeAI-work/
 * described-audio-20261117):
 * 1. `alignTracks`: the plain soundtrack against the described one, as stretches with a fixed
 *    offset (a described copy is often a few seconds late and slips at breaks).
 * 2. `narratorScore`: where the described soundtrack holds sound the plain one does not: the
 *    narrator. It also flags music and voices mixed differently, so it only tightens step 3.
 * 3. `listenToReference`: MiMo Flash hears the described soundtrack in 40 s windows every 30 s
 *    and says who speaks when (narrator or dialogue), on zero retention.
 * 4. `notesFrom`: MiMo's narrator lines, moved onto the plain clock and tightened to step 2's
 *    spans; a "narrator" line with no added voice under it is really dialogue and is dropped.
 * 5. `rewriteNotes`: Claude Haiku writes new lines from the notes under her rules.
 * 6. `referenceProviders`: each section's look takes its lines from step 5 and asks the video
 *    model only about quiet stretches that have no line (`gapLook`).
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import axios from 'axios';
import type { Providers } from './engine';
import type { Look } from './providers';
import { userAgent } from './providers';
import { ffmpeg } from './media';
import type { Analysis, Cue, Interval, Line, Meter, VisionCall } from './types';

/** The sample rate both soundtracks are compared at: enough for a voice, small for a long film. */
export const compareRate = 4000;

/** One stretch of the film with a fixed offset: plain time = described time + offset. */
export type Segment = { from: number; offset: number };
export type HeardLine = { start: number; end: number; who: 'narrator' | 'dialogue' | 'credit'; text: string };
/** One of the old describer's lines on the plain video's clock: a note, never spoken as it is. */
export type Note = { id: number; start: number; end: number; text: string };
/** A line written from a note, on the plain video's clock. */
export type ReferenceCue = {
  at: number;
  until: number;
  text: string;
  shortText: string;
  importance: number;
  reading?: boolean;
};
export type Reference = {
  version: 1;
  /** The Library item the soundtrack came from. */
  book: string;
  track: number;
  segments: Segment[];
  /** Spans (plain clock) where the old describer spoke, so a gap there is not looked at again. */
  spoken: Interval[];
  cues: ReferenceCue[];
  notes: number;
  /** Notes left out: too close to their wording even after rewriting, wrong facts, or not a description. */
  left: number;
  costUSD: number;
};

/* ---------- decoding ---------- */

/** A whole soundtrack as mono 16-bit samples at `rate`. */
export async function decodeMono(
  file: string,
  rate: number,
  signal: AbortSignal,
): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg(),
      ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
      { signal, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (error = (error + chunk.toString()).slice(-400)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`The soundtrack could not be read: ${error.trim()}`));
      const all = Buffer.concat(chunks);
      const copy = new Int16Array(Math.floor(all.length / 2));
      for (let i = 0; i < copy.length; i++) copy[i] = all.readInt16LE(i * 2);
      resolve(copy);
    });
  });
}

/* ---------- signal helpers ---------- */

/** In-place radix-2 FFT; `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/**
 * Where `piece` best fits inside `ref`: the start index in `ref` and the normalised correlation
 * there (1 for an exact copy). FFT cross-correlation, normalised by each position's energy.
 */
export function bestFit(ref: Int16Array, piece: Int16Array): { at: number; r: number } {
  const span = ref.length - piece.length + 1;
  if (span < 1) return { at: 0, r: 0 };
  let n = 1;
  while (n < ref.length + piece.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < ref.length; i++) ar[i] = ref[i];
  for (let i = 0; i < piece.length; i++) br[i] = piece[i];
  fft(ar, ai);
  fft(br, bi);
  /* ref × conj(piece), then the inverse through the forward transform of the conjugate. */
  for (let i = 0; i < n; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = re;
    ai[i] = -im;
  }
  fft(ar, ai);
  let pieceEnergy = 0;
  for (let i = 0; i < piece.length; i++) pieceEnergy += piece[i] * piece[i];
  const sums = new Float64Array(ref.length + 1);
  for (let i = 0; i < ref.length; i++) sums[i + 1] = sums[i] + ref[i] * ref[i];
  let best = { at: 0, r: -Infinity };
  for (let k = 0; k < span; k++) {
    const value = ar[k] / n;
    const energy = Math.sqrt((sums[k + piece.length] - sums[k]) * pieceEnergy);
    const r = energy > 0 ? value / energy : 0;
    if (r > best.r) best = { at: k, r };
  }
  return best;
}

function correlation(a: Int16Array, aFrom: number, b: Int16Array, bFrom: number, length: number): number {
  if (aFrom < 0 || bFrom < 0 || aFrom + length > a.length || bFrom + length > b.length) return -1;
  let dot = 0;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < length; i++) {
    const x = a[aFrom + i];
    const y = b[bFrom + i];
    dot += x * y;
    ea += x * x;
    eb += y * y;
  }
  return ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : -1;
}

/* ---------- 1. alignment ---------- */

/**
 * The offsets between the plain soundtrack and the described one. Every 10 s a 4 s piece of the
 * described soundtrack is found in the plain one (within 8 s of the last offset, or 60 s when that
 * fails); offsets seen at least twice become candidates; then each second takes the candidate that
 * fits it best, smoothed over 15 s. Throws when the two do not match: not the same video.
 */
export function alignTracks(plain: Int16Array, described: Int16Array, rate: number = compareRate): Segment[] {
  const piece = 4 * rate;
  const hits: { at: number; offset: number; r: number }[] = [];
  let last: number | undefined;
  let misses = 0;
  for (let t = 0; t + piece <= described.length; t += 10 * rate) {
    const part = described.subarray(t, t + piece);
    let quiet = 0;
    for (let i = 0; i < part.length; i += 8) quiet += Math.abs(part[i]);
    if (quiet / (part.length / 8) < 30) continue;
    const reach = (last === undefined || misses >= 3 ? 60 : 8) * rate;
    const centre = t + (last ?? 0) * rate;
    const lo = Math.max(0, Math.round(centre - reach));
    const hi = Math.min(plain.length, Math.round(centre + piece + reach));
    if (hi - lo < piece) continue;
    const fit = bestFit(plain.subarray(lo, hi), part);
    if (fit.r >= 0.3) {
      const offset = (lo + fit.at - t) / rate;
      hits.push({ at: t / rate, offset, r: fit.r });
      last = offset;
      misses = 0;
    } else misses++;
  }
  /*
   * Candidates: hits within 0.1 s of each other are one offset (a wrong peak lands a few dozen ms
   * off), at their median; an offset must be seen at least twice, unless it is the only one.
   */
  const groups: { offsets: number[]; r: number }[] = [];
  for (const hit of [...hits].sort((a, b) => a.offset - b.offset)) {
    const group = groups[groups.length - 1];
    if (group && hit.offset - group.offsets[group.offsets.length - 1] < 0.1) {
      group.offsets.push(hit.offset);
      group.r = Math.max(group.r, hit.r);
    } else groups.push({ offsets: [hit.offset], r: hit.r });
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const candidates = groups.filter((group) => group.offsets.length >= 2).map((group) => median(group.offsets));
  if (!candidates.length && groups.length)
    candidates.push(median([...groups].sort((a, b) => b.r - a.r)[0].offsets));
  const seconds = Math.floor(described.length / rate);
  if (!candidates.length || hits.length < Math.min(3, Math.max(1, Math.floor(seconds / 60))))
    throw new Error('The described soundtrack does not match this video’s sound.');
  /* Each second's best candidate, over a 2 s window. */
  const choice: number[] = [];
  let previous = 0;
  for (let s = 0; s < seconds; s++) {
    let best = -1;
    let pick = previous;
    for (let c = 0; c < candidates.length; c++) {
      const r = correlation(described, s * rate, plain, Math.round((s + candidates[c]) * rate), 2 * rate);
      if (r > best) {
        best = r;
        pick = c;
      }
    }
    if (best < 0.05) pick = previous;
    choice.push(pick);
    previous = pick;
  }
  const smooth = choice.map((_, i) => {
    const window = choice.slice(Math.max(0, i - 7), i + 8).sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)];
  });
  const segments: Segment[] = [];
  smooth.forEach((c, s) => {
    if (!segments.length || segments[segments.length - 1].offset !== candidates[c])
      segments.push({ from: s, offset: candidates[c] });
  });
  return segments.length ? segments : [{ from: 0, offset: candidates[0] }];
}

export function offsetAt(segments: Segment[], time: number): number {
  let offset = segments[0]?.offset ?? 0;
  for (const segment of segments) if (time >= segment.from) offset = segment.offset;
  return offset;
}

/* ---------- 2. where the narrator is ---------- */

/** One score per `scoreStep` seconds of the described soundtrack. */
export const scoreStep = 0.025;

/**
 * How much of the described soundtrack's voice band (150 to 2,000 Hz) the plain soundtrack cannot
 * explain, 0 to 1, per 25 ms, smoothed over 0.3 s. The plain sound is scaled by the median ratio of
 * the two in its louder bins first, so a describer's ducking of the film does not count.
 */
export function narratorScore(
  plain: Int16Array,
  described: Int16Array,
  segments: Segment[],
  rate: number = compareRate,
): Float32Array {
  const size = 256;
  const hop = Math.round(scoreStep * rate);
  const lo = Math.max(1, Math.round((150 / rate) * size));
  const hi = Math.min(size / 2, Math.round((2000 / rate) * size));
  const window = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const frames = Math.max(0, Math.floor((described.length - size) / hop));
  const raw = new Float32Array(frames);
  const dr = new Float64Array(size);
  const di = new Float64Array(size);
  const pr = new Float64Array(size);
  const pi = new Float64Array(size);
  const D = new Float64Array(hi - lo);
  const P = new Float64Array(hi - lo);
  for (let f = 0; f < frames; f++) {
    const a = f * hop;
    const b = a + Math.round(offsetAt(segments, a / rate) * rate);
    if (b < 0 || b + size > plain.length) continue;
    for (let i = 0; i < size; i++) {
      dr[i] = described[a + i] * window[i];
      pr[i] = plain[b + i] * window[i];
      di[i] = 0;
      pi[i] = 0;
    }
    fft(dr, di);
    fft(pr, pi);
    for (let k = lo; k < hi; k++) {
      D[k - lo] = Math.hypot(dr[k], di[k]);
      P[k - lo] = Math.hypot(pr[k], pi[k]);
    }
    const sorted = Array.from(P).sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const ratios: number[] = [];
    for (let k = 0; k < P.length; k++) if (P[k] > median) ratios.push(D[k] / (P[k] + 1e-6));
    ratios.sort((x, y) => x - y);
    const gain = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
    let left = 0;
    let all = 0;
    for (let k = 0; k < D.length; k++) {
      const rest = Math.max(0, D[k] - gain * P[k] * 1.15);
      left += rest * rest;
      all += D[k] * D[k];
    }
    raw[f] = all > 0 ? left / all : 0;
  }
  const smooth = new Float32Array(frames);
  let sum = 0;
  const width = 12;
  for (let f = 0; f < frames + width / 2; f++) {
    if (f < frames) sum += raw[f];
    if (f - width >= 0) sum -= raw[f - width];
    const centre = f - width / 2;
    if (centre >= 0 && centre < frames) smooth[centre] = sum / width;
  }
  return smooth;
}

/* ---------- 3. hearing the described soundtrack ---------- */

const listenPrompt = (seconds: number) =>
  `This is a ${seconds}-second piece of a film soundtrack that has audio description: a narrator who describes what is on screen, mixed in with the film's own dialogue, music and sound.
List every stretch of speech in order. For each, give the start and end time in seconds from the start of this piece (to one decimal place), who speaks ("narrator" for the audio describer, "dialogue" for anyone in the film), and the exact words.
The narrator speaks calmly in the present tense about what happens, like "Charlie Brown walks to the door." Characters talk to each other. Songs with lyrics count as dialogue.
Return only JSON: {"lines":[{"start":1.2,"end":3.4,"who":"narrator","text":"..."}]}`;
/** MiMo v2.6 Flash's price per million tokens, with room (OpenRouter `max_price`). */
const mimoPrice = { prompt: 0.25, completion: 0.45 };
/** Makora hears audio on zero retention; after two failures any zero-retention host is asked. */
const mimoHosts = [['Makora'], undefined];
export type Window = { start: number; length: number; lines: HeardLine[] };

/** Cuts a stretch of a sound file to 16 kHz mono MP3 in memory. */
async function soundPiece(file: string, start: number, length: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg(),
      ['-v', 'error', '-nostdin', '-ss', String(start), '-t', String(length), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3', '-'],
      { signal, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('A piece of the soundtrack could not be cut.')),
    );
  });
}

type ChatReply = {
  provider?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    cost_details?: { upstream_inference_cost?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};
const costOf = (reply: ChatReply): number =>
  Number(reply.usage?.cost_details?.upstream_inference_cost || reply.usage?.cost || 0);
async function chat(body: object, signal: AbortSignal, timeout: number): Promise<ChatReply> {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('The describer has no OpenRouter key.');
  const { data } = await axios.post<ChatReply>('https://openrouter.ai/api/v1/chat/completions', body, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
    signal,
    timeout,
    maxRedirects: 0,
    maxContentLength: 4 * 1024 * 1024,
  });
  return data;
}

function readLines(text: string, length: number): HeardLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    return [];
  }
  const lines = (parsed as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return [];
  const out: HeardLine[] = [];
  for (const item of lines) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    const words = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !words) continue;
    const who = item?.who === 'narrator' ? 'narrator' : 'dialogue';
    out.push({ start, end: Math.min(end, length), who, text: words.slice(0, 600) });
  }
  return out;
}

/** One window, through the meter, on zero retention; tried on each host twice. */
async function listenWindow(
  file: string,
  start: number,
  length: number,
  signal: AbortSignal,
  meter: Meter,
): Promise<Window> {
  const sound = await soundPiece(file, start, length, signal);
  const maxTokens = 1800;
  const reserve = ((length * 30 + 400) * mimoPrice.prompt + maxTokens * mimoPrice.completion) / 1e6;
  let lines: HeardLine[] | undefined;
  let problem = '';
  for (let attempt = 0; attempt < 4 && !lines; attempt++) {
    const host = mimoHosts[Math.min(mimoHosts.length - 1, Math.floor(attempt / 2))];
    await meter(
      'transcription',
      reserve,
      async () => {
        const reply = await chat(
          {
            model: 'xiaomi/mimo-v2.6-flash',
            reasoning: { enabled: false },
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: maxTokens,
            provider: {
              ...(host ? { only: host, allow_fallbacks: false } : { order: ['Makora'], allow_fallbacks: true }),
              zdr: true,
              data_collection: 'deny',
              max_price: mimoPrice,
            },
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: listenPrompt(Math.round(length)) },
                  { type: 'input_audio', input_audio: { data: sound.toString('base64'), format: 'mp3' } },
                ],
              },
            ],
          },
          signal,
          90000,
        );
        /* A host that never heard the audio counts only the prompt's text. */
        if ((reply.usage?.prompt_tokens ?? 0) < 48 + 3 * length) problem = 'the host did not hear the sound';
        else {
          const got = readLines(reply.choices?.[0]?.message?.content ?? '', length);
          if (got.length || reply.choices?.[0]?.finish_reason === 'stop') lines = got;
          else problem = 'no lines came back';
        }
        return { costUSD: costOf(reply) };
      },
      'looks',
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      problem = (error as Error).message;
    });
  }
  if (!lines) throw new Error(`MiMo could not hear the described soundtrack at ${Math.round(start)} s: ${problem}`);
  return { start, length, lines };
}

/** The described soundtrack heard in 40 s windows every 30 s, six at a time. */
export async function listenToReference(
  file: string,
  seconds: number,
  signal: AbortSignal,
  meter: Meter,
): Promise<HeardLine[]> {
  const step = 30;
  const width = 40;
  const starts: number[] = [];
  for (let s = 0; s < seconds - 1; s += step) starts.push(s);
  const windows: Window[] = new Array(starts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, starts.length) }, async () => {
      while (next < starts.length) {
        const i = next++;
        windows[i] = await listenWindow(file, starts[i], Math.min(width, seconds - starts[i]), signal, meter);
      }
    }),
  );
  return mergeWindows(windows, seconds, step);
}

const characterWords = /\b(I|I'm|I've|I'll|me|my|mine|we|we're|us|our|you|you're|your|yours)\b|[?!]/i;
const creditWords =
  /audio descri|described by|descriptive video|description (was|is) (written|provided|produced)|narrated by|dvs/i;

/**
 * Overlapping windows joined into one list on the described soundtrack's clock: each window keeps
 * the lines that start in its middle; a line cut off by its window's end is taken from the next.
 * Short "narrator" lines that sound like a character become dialogue, and the describer's own
 * credit is marked.
 */
export function mergeWindows(windows: Window[], seconds: number, step: number = 30): HeardLine[] {
  const ordered = windows.filter(Boolean).sort((a, b) => a.start - b.start);
  const absolute = (w: Window) =>
    w.lines.map((line) => ({ ...line, start: w.start + line.start, end: w.start + Math.min(line.end, w.length) }));
  const lines: HeardLine[] = [];
  ordered.forEach((w, i) => {
    const next = ordered[i + 1];
    const lo = i === 0 ? 0 : w.start + (w.length - step) / 2;
    const hi = next ? w.start + step + (w.length - step) / 2 : seconds + 1;
    for (let line of absolute(w)) {
      if (line.start < lo || line.start >= hi) continue;
      if (next && line.end >= w.start + w.length - 0.8) {
        const better = absolute(next).find((m) => m.who === line.who && Math.abs(m.start - line.start) < 2);
        if (better) line = better;
      }
      lines.push(line);
    }
  });
  lines.sort((a, b) => a.start - b.start);
  const clean: HeardLine[] = [];
  for (const line of lines) {
    const last = clean[clean.length - 1];
    if (
      last &&
      last.who === line.who &&
      line.start < last.end - 0.3 &&
      last.text.slice(0, 12).toLowerCase() === line.text.slice(0, 12).toLowerCase()
    ) {
      if (line.text.length > last.text.length) clean[clean.length - 1] = line;
      continue;
    }
    clean.push(line);
  }
  for (const line of clean) {
    if (line.who !== 'narrator') continue;
    if (creditWords.test(line.text)) line.who = 'credit';
    else if (characterWords.test(line.text) && line.text.split(/\s+/).length <= 6) line.who = 'dialogue';
  }
  return clean;
}

/* ---------- 4. notes on the plain clock ---------- */

/**
 * The old describer's lines as notes on the plain video's clock. Each narrator line is tightened
 * to where the score shows an added voice within 1.2 s of MiMo's times; a line with none under it
 * is not the describer (MiMo mislabelled a character) and is left out. Lines that run on with no
 * dialogue between are joined, up to 45 words.
 */
export function notesFrom(
  heard: HeardLine[],
  score: Float32Array,
  segments: Segment[],
  threshold: number = 0.4,
): Note[] {
  const notes: Note[] = [];
  const dialogue = heard.filter((line) => line.who === 'dialogue');
  let previous: (HeardLine & { at: number; until: number }) | undefined;
  for (const line of heard) {
    if (line.who !== 'narrator') continue;
    const first = Math.max(0, Math.floor((line.start - 1.2) / scoreStep));
    const last = Math.min(score.length, Math.ceil((line.end + 1.2) / scoreStep));
    let a = -1;
    let b = -1;
    for (let f = first; f < last; f++)
      if (score[f] > threshold) {
        if (a < 0) a = f;
        b = f;
      }
    if (a < 0) continue;
    const start = a * scoreStep;
    const end = (b + 1) * scoreStep;
    const offset = offsetAt(segments, start);
    const at = start + offset;
    const until = end + offset;
    const joined = previous;
    const between =
      joined && dialogue.some((d) => d.start >= joined.end && d.start < line.start);
    const note = notes[notes.length - 1];
    if (
      joined &&
      note &&
      line.start - joined.end < 0.5 &&
      !between &&
      `${note.text} ${line.text}`.split(/\s+/).length <= 45
    ) {
      note.end = Math.max(note.end, until);
      note.text = `${note.text} ${line.text}`;
    } else notes.push({ id: notes.length, start: at, end: until, text: line.text });
    previous = { ...line, at, until };
  }
  return notes;
}

/* ---------- 5. her own words ---------- */

const stopWords = new Set(
  'a an the and or but of to in on at by for with from up down into onto off out over under as is are his her its their he she they it him them then while who that this'.split(
    ' ',
  ),
);
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * How copying is measured: words in lower case, with names and the phrases the old describer
 * keeps repeating (a character's usual tag) each folded into "N", so a name may repeat freely.
 */
export type Guard = { normal: (text: string) => string[]; notes: string[][] };
export function guardFor(notes: Note[]): Guard {
  const names = new Set<string>();
  for (const note of notes)
    for (const match of note.text.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z']+)/g)) names.add(match[1].toLowerCase());
  const counts = new Map<string, number>();
  for (const note of notes) {
    const words = wordsOf(note.text);
    for (const n of [2, 3, 4])
      for (let i = 0; i + n <= words.length; i++) {
        const key = words.slice(i, i + n).join(' ');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  }
  const phrases = [...counts]
    .filter(([key, count]) => count >= 6 && !key.split(' ').every((w) => stopWords.has(w)))
    .map(([key]) => key.split(' '))
    .sort((a, b) => b.length - a.length);
  const normal = (text: string): string[] => {
    const words = wordsOf(text).map((w) => (names.has(w) ? 'N' : w));
    const out: string[] = [];
    for (let i = 0; i < words.length; ) {
      const hit = phrases.find((p) => p.every((w, k) => words[i + k] === w));
      if (hit) {
        out.push('N');
        i += hit.length;
      } else out.push(words[i++]);
    }
    return out.filter((w, i) => !(w === 'N' && out[i - 1] === 'N'));
  };
  return { normal, notes: notes.map((note) => normal(note.text)) };
}

/** The first run of 5 words (2 of them real words, not names) that `text` shares with any note. */
export function copyRun(guard: Guard, text: string, n: number = 5): string {
  const runs = new Set<string>();
  for (const words of guard.notes) for (let i = 0; i + n <= words.length; i++) runs.add(words.slice(i, i + n).join(' '));
  const words = guard.normal(text);
  for (let i = 0; i + n <= words.length; i++) {
    const run = words.slice(i, i + n);
    if (runs.has(run.join(' ')) && run.filter((w) => !stopWords.has(w) && w !== 'N').length >= 2) return run.join(' ');
  }
  return '';
}

/** Python difflib's ratio (Ratcliff/Obershelp) on two word lists: 1 for the same words in order. */
export function closeness(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const matched = (aLo: number, aHi: number, bLo: number, bHi: number): number => {
    let best = 0;
    let at = [0, 0];
    for (let i = aLo; i < aHi; i++)
      for (let j = bLo; j < bHi; j++) {
        let k = 0;
        while (i + k < aHi && j + k < bHi && a[i + k] === b[j + k]) k++;
        if (k > best) {
          best = k;
          at = [i, j];
        }
      }
    if (!best) return 0;
    return best + matched(aLo, at[0], bLo, at[1]) + matched(at[0] + best, aHi, at[1] + best, bHi);
  };
  return (2 * matched(0, a.length, 0, b.length)) / (a.length + b.length);
}

type Written = { id: number; text: string; shortText: string; importance: number; reading: boolean };

/** Why a written line may not be used, or '' when it may. */
export function tooClose(guard: Guard, notes: Note[], line: Written | undefined): string {
  if (!line) return 'missing';
  if (!line.text.trim() || line.reading) return '';
  const me = notes.find((note) => note.id === line.id);
  for (const [field, value] of [
    ['text', line.text],
    ['shortText', line.shortText],
  ] as const) {
    const run = copyRun(guard, value);
    if (run) return `its ${field} copies the notes ("${run}"); describe it in your own words`;
    const mine = guard.normal(value).filter((w) => !stopWords.has(w));
    if (mine.filter((w) => w !== 'N').length < 2) continue;
    for (const note of notes) {
      if (!me || Math.abs(note.start - me.start) > 30) continue;
      const theirs = guard.notes[note.id].filter((w) => !stopWords.has(w));
      if (closeness(theirs, mine) >= 0.7)
        return `its ${field} follows the note too closely; describe it in your own words and sentence shape`;
    }
  }
  return '';
}

const rules = `You write audio description for a blind listener who watches a film with sighted family. Below are lines an earlier describer spoke, with their times. Treat them as notes about what is on screen. Write NEW lines from those facts, in your own words.

1. Facts, not wording. The notes are a reference only: they tell you what happens and when. Picture the moment, then describe it as you would yourself, in your own words: your own verbs, your own sentence shapes, your own choice of what to mention first. Never copy a note or follow its sentence closely, not even a short one: change the verb, the order or the structure every time. Never reuse 5 or more words in a row from the notes. Names of people, places and titles may repeat. You may use what you know about this film for the names of characters, places and things, but never to add an event the notes do not support. Rewording must never change the facts: keep exactly who does what to whom (if the note says "He pushes her away", he pushes her, not the other way round), and where they are.
2. Say only what the notes say happens, or what the dialogue makes plain. Never add a detail, a name or a guess. Leave out nothing that matters.
3. Present tense, third person, plain words. No "we see", no opinions, no thoughts or motives the notes do not give. When a line starts a new moment, name who acts.
4. One line per id, in order. "text": at most F words (F is given for each id). "shortText": at most S words, a whole sentence with the most important fact. A note may be cut off or hold a few words of a character's speech: describe only what happens on screen, never what a character says.
5. Words shown on screen (titles, signs, credits, writing) are read exactly, after "Text reads," with "reading": true. Only words really on screen.
6. Never say a fact before its id's time.
7. The dialogue is context only. Never describe what is said or heard.
8. A note that is really a character speaking, or only a fragment with no fact in it, gets an empty "text" and "shortText".
9. "importance": 3 for what the story needs (a new person, a key action, words on screen), 2 for useful context, 1 for small details.
Return only JSON: {"lines":[{"id":41,"text":"...","shortText":"...","importance":2,"reading":false}]}`;
const checkRules =
  'You check audio description. For each id you get the NOTE (what an earlier describer said happens; BEFORE gives the lines just before it, so you can tell who "he", "she" or "they" is) and the NEW line. ' +
  'First work out, for the NOTE and for the NEW line, who does each action and to whom, naming the people. Then compare. ' +
  'Answer "wrong" when NEW has anyone doing something the NOTE has someone else doing, swaps who acts and who is acted on, changes a place or object, or adds an event the NOTE does not give. Otherwise "ok" (leaving small details out is ok). ' +
  'Return only JSON: {"lines":[{"id":4,"noteActors":"Linus pushes Sally","newActors":"Sally pushes Linus","verdict":"wrong","reason":"swaps who pushes whom"}]}';
/** Claude Haiku 5.5 on OpenRouter, per million tokens, with room. */
const haikuPrice = { prompt: 0.11, completion: 0.55 };
const writerModel = () => process.env.KADE_REFERENCE_WRITER_MODEL || 'anthropic/claude-haiku-5.5';
const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/** Every {"id": …} object in a reply, even when the whole reply is not valid JSON. */
export function objectsIn(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const match of text.matchAll(/\{\s*"id"\s*:\s*\d+[^{}]*\}/g))
    try {
      found.push(JSON.parse(match[0]));
    } catch {
      /* a broken object is skipped */
    }
  return found;
}

async function ask(system: string, prompt: string, maxTokens: number, signal: AbortSignal, meter: Meter): Promise<string> {
  let text = '';
  const reserve = ((prompt.length + system.length) / 3 * haikuPrice.prompt + maxTokens * haikuPrice.completion) / 1e6;
  let problem: unknown;
  for (let attempt = 0; attempt < 3 && !text; attempt++)
    await meter(
      'vision',
      reserve,
      async () => {
        const reply = await chat(
          {
            model: writerModel(),
            max_tokens: maxTokens,
            temperature: system === rules ? 0.4 : 0,
            reasoning: { enabled: false },
            provider: { zdr: true, data_collection: 'deny', max_price: haikuPrice },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
          },
          signal,
          240000,
        );
        text = reply.choices?.[0]?.message?.content ?? '';
        return { costUSD: costOf(reply) };
      },
      'looks',
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      problem = error;
    });
  if (!text) throw problem instanceof Error ? problem : new Error('The writer sent nothing back.');
  return text;
}

function partPrompt(title: string, part: Note[], dialogue: HeardLine[], header: string = ''): string {
  const a = part[0].start;
  const b = part[part.length - 1].end;
  const out = [header, `Film: ${title}. ${clock(a)} to ${clock(b)}.`, 'Notes to rewrite:'];
  for (const note of part) {
    const words = note.text.split(/\s+/).length;
    out.push(
      `[${note.id}] ${clock(note.start)}, ${(note.end - note.start).toFixed(1)} s long, text up to ${Math.max(4, words)} words, short up to ${Math.max(3, Math.round(words * 0.55))}: "${note.text}"`,
    );
  }
  out.push('Dialogue around them, context only:');
  for (const line of dialogue) if (line.start >= a - 5 && line.start <= b + 5) out.push(`[${clock(line.start)}] "${line.text}"`);
  return out.filter(Boolean).join('\n');
}

function writtenFrom(text: string): Written[] {
  return objectsIn(text)
    .filter((item) => Number.isInteger(item.id))
    .map((item) => ({
      id: Number(item.id),
      text: String(item.text ?? '').replace(/\s+/g, ' ').trim(),
      shortText: String(item.shortText ?? '').replace(/\s+/g, ' ').trim(),
      importance: Math.min(3, Math.max(1, Math.round(Number(item.importance) || 2))),
      reading: item.reading === true,
    }));
}

/**
 * New lines from the notes. Parts of about ten minutes are written at once; lines that copy or
 * follow a note too closely are written again (four rounds in batches of 30, then a last round of
 * one short sentence each); then a fact check that names who does what in both lines, twice, and
 * a line still wrong is left out. `dialogue` is on the plain clock too.
 */
export async function rewriteNotes(
  notes: Note[],
  dialogue: HeardLine[],
  title: string,
  signal: AbortSignal,
  meter: Meter,
): Promise<{ cues: ReferenceCue[]; left: number }> {
  if (!notes.length) return { cues: [], left: 0 };
  const guard = guardFor(notes);
  const byId = new Map(notes.map((note) => [note.id, note]));
  const written = new Map<number, Written>();
  const keep = (lines: Written[], only?: Set<number>) => {
    for (const line of lines)
      if (byId.has(line.id) && (!only || only.has(line.id)) && !tooClose(guard, notes, line)) written.set(line.id, line);
  };
  const parts: Note[][] = [];
  for (const note of notes) {
    const part = parts[parts.length - 1];
    if (part && note.start - part[0].start <= 600) part.push(note);
    else parts.push([note]);
  }
  let k = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, parts.length) }, async () => {
      while (k < parts.length) {
        const part = parts[k++];
        const before = notes.filter((note) => note.id < part[0].id).slice(-3);
        const header = before.length
          ? `Notes just before this part, for continuity only: ${before.map((note) => `"${note.text}"`).join(' ')}`
          : '';
        const lines = writtenFrom(await ask(rules, partPrompt(title, part, dialogue, header), 12000, signal, meter));
        for (const line of lines) if (byId.has(line.id)) written.set(line.id, line);
      }
    }),
  );
  const failing = () => notes.filter((note) => tooClose(guard, notes, written.get(note.id)));
  for (let round = 0; round < 4; round++) {
    const redo = failing();
    if (!redo.length) break;
    for (let i = 0; i < redo.length; i += 30) {
      const batch = redo.slice(i, i + 30);
      const why = batch.map((note) => `id ${note.id}: ${tooClose(guard, notes, written.get(note.id))}`).join('; ');
      keep(writtenFrom(await ask(rules, partPrompt(title, batch, dialogue, `These lines need writing again. ${why}`), 12000, signal, meter)));
    }
  }
  const last = failing();
  for (let i = 0; i < last.length; i += 30) {
    const batch = last.slice(i, i + 30);
    keep(
      writtenFrom(
        await ask(
          rules,
          partPrompt(
            title,
            batch,
            dialogue,
            'These notes still came back too close to their wording. For each id, write ONE short new sentence of at most 8 words that keeps the main fact, with a different verb and a different order from the note. Example: note "Charlie Brown crashes into Lucy." -> "Lucy gets knocked over by Charlie Brown." Keep exactly who does what to whom.',
          ),
          12000,
          signal,
          meter,
        ),
      ),
    );
  }
  const check = async (ids: number[]): Promise<Map<number, string>> => {
    const wrong = new Map<number, string>();
    for (let i = 0; i < ids.length; i += 40) {
      const rows = ids.slice(i, i + 40).map((id) => {
        const note = byId.get(id) as Note;
        const before = notes.filter((other) => other.start < note.start).slice(-2).map((other) => other.text).join(' ').slice(-300);
        return `[${id}] BEFORE: ${before}\nNOTE: "${note.text}"\nNEW: "${written.get(id)?.text}"`;
      });
      for (const item of objectsIn(await ask(checkRules, rows.join('\n\n'), 6000, signal, meter)))
        if (String(item.verdict).toLowerCase() === 'wrong') wrong.set(Number(item.id), String(item.reason || 'changes the facts'));
    }
    return wrong;
  };
  let wrong = new Map<number, string>();
  for (let round = 0; round < 2; round++) {
    const ids = notes
      .map((note) => note.id)
      .filter((id) => {
        const line = written.get(id);
        return line && line.text && !tooClose(guard, notes, line) && (round === 0 || wrong.has(id));
      });
    if (!ids.length) break;
    wrong = await check(ids);
    if (!wrong.size) break;
    const batch = [...wrong.keys()].map((id) => byId.get(id) as Note);
    const why = [...wrong].map(([id, reason]) => `id ${id}: ${reason}`).join('; ');
    keep(
      writtenFrom(
        await ask(rules, partPrompt(title, batch, dialogue, `These lines changed the facts of their notes. Write them again in your own words, keeping exactly who does what to whom. ${why}`), 12000, signal, meter),
      ),
      new Set(wrong.keys()),
    );
  }
  const stillWrong = wrong.size ? await check([...wrong.keys()]) : new Map<number, string>();
  const cues: ReferenceCue[] = [];
  for (const note of notes) {
    const line = written.get(note.id);
    if (!line || !line.text || tooClose(guard, notes, line) || stillWrong.has(note.id)) continue;
    cues.push({
      at: note.start,
      until: note.end,
      text: line.text,
      shortText: line.shortText || line.text,
      importance: line.importance,
      ...(line.reading ? { reading: true } : {}),
    });
  }
  return { cues, left: notes.length - cues.length };
}

/* ---------- 6. the looks ---------- */

/** Gemini 4 Argon on zero-retention Vertex, per million tokens, with room. */
const gapPrice = { prompt: 2.2, completion: 11 };
const gapModel = () => process.env.KADE_REFERENCE_GAP_MODEL || 'google/gemini-4-argon';
/** A quiet stretch at least this long with no line is looked at. */
export const gapSeconds = 3;

/** Quiet stretches (section clock) of at least `gapSeconds` with no dialogue and no line. */
export function quietGaps(seconds: number, lines: Line[], taken: Interval[]): Interval[] {
  const busy = [...lines.map((line) => ({ start: line.start, end: line.end })), ...taken]
    .filter((span) => span.end > 0 && span.start < seconds)
    .sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let t = 0;
  for (const span of [...busy, { start: seconds, end: seconds }]) {
    if (span.start - t >= gapSeconds) gaps.push({ start: t + 0.3, end: span.start - 0.3 });
    t = Math.max(t, span.end);
  }
  return gaps;
}

/** A stretch of a look clip, re-cut small (3 pictures a second, 512 wide, quiet speech-band sound). */
async function clipPiece(file: string, start: number, length: number, target: string, signal: AbortSignal): Promise<Buffer> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpeg(),
      ['-v', 'error', '-nostdin', '-y', '-ss', String(start), '-t', String(length), '-i', file, '-vf', 'fps=3,scale=512:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', target],
      { signal, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('A quiet stretch could not be cut.'))));
  });
  try {
    return await readFile(target);
  } finally {
    await rm(target, { force: true });
  }
}

/**
 * One short look at a quiet stretch: the stretch with 4 s before it, asking for one line that fits
 * it, or nothing when nothing new happens. Low effort; it reports no reasoning, so the engine never
 * looks at the section a second time.
 */
export async function gapLook(
  look: Look,
  gap: Interval,
  context: { title: string; before: string[] },
  signal: AbortSignal,
  meter: Meter,
): Promise<{ cue?: Cue; call?: VisionCall }> {
  const from = Math.max(0, gap.start - 4);
  const length = Math.min(look.seconds, gap.end + 1) - from;
  if (length < 1) return {};
  const video = await clipPiece(look.file, from, length, `${look.file}.gap-${Math.round(gap.start * 10)}.mp4`, signal);
  const words = Math.max(4, Math.floor((gap.end - gap.start) * 2.4));
  const prompt =
    `This is a ${Math.round(length)}-second clip from "${context.title}". Nobody speaks from second ${(gap.start - from).toFixed(1)} to second ${(gap.end - from).toFixed(1)} of the clip. ` +
    `Write audio description for a blind viewer to be spoken in that quiet stretch: what is seen on screen that matters, present tense, plain words, at most ${words} words, names of characters where known. ` +
    `Do not repeat or describe what anyone says. The last description spoken before this was: ${context.before.join(' / ') || 'none'}. ` +
    'If nothing new happens that matters, reply with an empty line. Return only JSON: {"line":"...","short":"the same in at most half the words"}';
  const maxTokens = 1500;
  const reserve = ((length * 110 + 600) * gapPrice.prompt + maxTokens * gapPrice.completion) / 1e6;
  let result: { cue?: Cue; call?: VisionCall } = {};
  await meter('vision', reserve, async () => {
    const began = Date.now();
    const reply = await chat(
      {
        model: gapModel(),
        reasoning: { effort: 'low' },
        max_tokens: maxTokens,
        provider: {
          only: ['google-vertex'],
          ignore: ['google-ai-studio'],
          allow_fallbacks: true,
          zdr: true,
          data_collection: 'deny',
          max_price: gapPrice,
        },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'video_url', video_url: { url: `data:video/mp4;base64,${video.toString('base64')}` } },
            ],
          },
        ],
      },
      signal,
      180000,
    );
    const costUSD = costOf(reply);
    const text = reply.choices?.[0]?.message?.content ?? '';
    const said = /"line"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? '';
    const short = /"short"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? '';
    const line = said.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
    const call: VisionCall = {
      model: gapModel(),
      provider: reply.provider,
      promptTokens: reply.usage?.prompt_tokens,
      outputTokens: reply.usage?.completion_tokens,
      costUSD,
      seconds: (Date.now() - began) / 1000,
    };
    result = {
      call,
      ...(line && line.split(/\s+/).length <= words + 4
        ? {
            cue: {
              at: gap.start,
              until: gap.end,
              text: line,
              shortText: short.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim() || line,
              importance: 2,
            },
          }
        : {}),
    };
    return { costUSD };
  });
  return result;
}

/**
 * The engine's providers with each section's look taken from the reference: its lines in that
 * section, plus a short look at every quiet stretch with no line. `Look.start` is the section's
 * start on the video's clock. Everything else (dialogue, voice, mix, follow along) is the
 * engine's own.
 */
export function referenceProviders(base: Providers, reference: Reference, title: string): Providers {
  return {
    ...base,
    expected: () => 0.01,
    analyze: async (look, signal, meter): Promise<Analysis> => {
      const start = look.start ?? 0;
      const end = start + look.seconds;
      const inside = reference.cues.filter((cue) => cue.at >= start && cue.at < end);
      const cues: Cue[] = inside.map((cue) => ({
        at: cue.at - start,
        until: Math.min(look.seconds, Math.max(cue.until, cue.at + 0.5) - start),
        text: cue.text,
        shortText: cue.shortText,
        importance: cue.importance,
        ...(cue.reading ? { reading: true } : {}),
      }));
      const spoken = reference.spoken
        .filter((span) => span.end > start && span.start < end)
        .map((span) => ({ start: span.start - start, end: span.end - start }));
      const gaps = quietGaps(look.seconds, look.lines, [...cues.map((cue) => ({ start: cue.at, end: cue.until })), ...spoken]);
      const vision: VisionCall[] = [];
      for (const gap of gaps) {
        const before = cues.filter((cue) => cue.until <= gap.start).slice(-2).map((cue) => cue.text);
        const found = await gapLook(look, gap, { title, before }, signal, meter);
        if (found.call) vision.push(found.call);
        if (found.cue) cues.push(found.cue);
      }
      cues.sort((a, b) => a.at - b.at);
      look.log?.(
        `Reference: ${inside.length} line${inside.length === 1 ? '' : 's'} from the described soundtrack, ${gaps.length} quiet stretch${gaps.length === 1 ? '' : 'es'} looked at.`,
      );
      return { kind: '', setting: '', people: [], speakers: [], cues, protectedSounds: [], vision };
    },
  };
}

/**
 * Steps 1 to 5 for one video: `plainFile` is the video (or its soundtrack) and `describedFile` the
 * described soundtrack. Throws, before anything is paid, when the two are not the same video.
 */
export async function prepareReference(input: {
  plainFile: string;
  describedFile: string;
  title: string;
  book: string;
  track: number;
  signal: AbortSignal;
  meter: Meter;
  log?: (message: string) => void;
  progress?: (stage: string) => Promise<void>;
}): Promise<Reference> {
  const { signal, meter } = input;
  const log = input.log ?? (() => {});
  await input.progress?.('Lining up the described soundtrack with the video');
  const plain = await decodeMono(input.plainFile, compareRate, signal);
  const described = await decodeMono(input.describedFile, compareRate, signal);
  const segments = alignTracks(plain, described);
  log(`Reference: lined up in ${segments.length} stretch${segments.length === 1 ? '' : 'es'}, offsets ${segments.map((s) => s.offset.toFixed(3)).join(', ')} s.`);
  const score = narratorScore(plain, described, segments);
  const seconds = described.length / compareRate;
  let cost = 0;
  const counted: Meter = (kind, reserve, action, part) =>
    meter(kind, reserve, async () => {
      const result = await action();
      cost += result.costUSD;
      return result;
    }, part);
  await input.progress?.('Listening to the described soundtrack');
  const heard = await listenToReference(input.describedFile, seconds, signal, counted);
  const notes = notesFrom(heard, score, segments);
  const dialogue = heard
    .filter((line) => line.who === 'dialogue')
    .map((line) => {
      const offset = offsetAt(segments, line.start);
      return { ...line, start: line.start + offset, end: line.end + offset };
    });
  log(`Reference: ${heard.length} lines heard, ${notes.length} describer notes.`);
  await input.progress?.('Writing new descriptions from the described soundtrack');
  const { cues, left } = await rewriteNotes(notes, dialogue, input.title, signal, counted);
  log(`Reference: ${cues.length} lines written, ${left} left out, $${cost.toFixed(4)}.`);
  return {
    version: 1,
    book: input.book,
    track: input.track,
    segments,
    spoken: notes.map((note) => ({ start: note.start, end: note.end })),
    cues,
    notes: notes.length,
    left,
    costUSD: cost,
  };
}
