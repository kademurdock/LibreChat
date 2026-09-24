import type { Interval } from './types';

export const sampleRate = 48000;

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };
const shelf: Biquad = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

function weighted(samples: Float32Array, channels: number, channel: number): Float64Array {
  const frames = Math.floor(samples.length / channels);
  const out = new Float64Array(frames);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0,
    u1 = 0,
    u2 = 0,
    z1 = 0,
    z2 = 0;
  for (let i = 0; i < frames; i++) {
    const x = samples[i * channels + channel];
    const y = shelf.b0 * x + shelf.b1 * x1 + shelf.b2 * x2 - shelf.a1 * y1 - shelf.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    const z =
      highpass.b0 * y + highpass.b1 * u1 + highpass.b2 * u2 - highpass.a1 * z1 - highpass.a2 * z2;
    u2 = u1;
    u1 = y;
    z2 = z1;
    z1 = z;
    out[i] = z * z;
  }
  return out;
}

/** ITU-R BS.1770 integrated loudness (LUFS) of 48 kHz float PCM, mono or interleaved stereo. */
export function loudness(samples: Float32Array, channels: 1 | 2): number {
  const power = Array.from({ length: channels }, (_, channel) =>
    weighted(samples, channels, channel),
  );
  const frames = power[0].length;
  if (!frames) return -Infinity;
  const block = Math.round(sampleRate * 0.4);
  const hop = Math.round(sampleRate * 0.1);
  const prefix = power.map((values) => {
    const sums = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i++) sums[i + 1] = sums[i] + values[i];
    return sums;
  });
  const blocks: number[] = [];
  const length = Math.min(block, frames);
  for (let start = 0; start + length <= frames; start += frames < block ? frames : hop)
    blocks.push(
      prefix.reduce((sum, sums) => sum + (sums[start + length] - sums[start]) / length, 0),
    );
  const level = (value: number) => -0.691 + 10 * Math.log10(value);
  const audible = blocks.filter((value) => value > 0 && level(value) > -70);
  if (!audible.length) return -Infinity;
  const gate = level(audible.reduce((sum, value) => sum + value, 0) / audible.length) - 10;
  const kept = audible.filter((value) => level(value) > gate);
  return level(kept.reduce((sum, value) => sum + value, 0) / kept.length);
}

/**
 * The loudest 3-second stretch (BS.1770 short-term loudness, LUFS) of interleaved stereo between
 * two times, or the integrated loudness of that stretch when it is shorter than 3 seconds.
 */
export function shortTermMax(samples: Float32Array, from: number, to: number): number {
  const frames = Math.floor(samples.length / 2);
  const first = Math.max(0, Math.round(from * sampleRate));
  const last = Math.min(frames, Math.round(to * sampleRate));
  if (last - first < sampleRate * 0.1) return -Infinity;
  const window = sampleRate * 3;
  if (last - first < window) return loudness(samples.subarray(first * 2, last * 2), 2);
  const settle = Math.max(0, first - Math.round(sampleRate * 0.5));
  const slice = samples.subarray(settle * 2, last * 2);
  const sums = [0, 1].map((channel) => {
    const power = weighted(slice, 2, channel);
    const prefix = new Float64Array(power.length + 1);
    for (let i = 0; i < power.length; i++) prefix[i + 1] = prefix[i] + power[i];
    return prefix;
  });
  const hop = Math.round(sampleRate * 0.1);
  let top = 0;
  for (let start = first - settle; start + window <= last - settle; start += hop)
    top = Math.max(
      top,
      sums.reduce((sum, prefix) => sum + (prefix[start + window] - prefix[start]) / window, 0),
    );
  return top > 0 ? -0.691 + 10 * Math.log10(top) : -Infinity;
}

/**
 * How far to lower the soundtrack under one description (dB, 0 or negative), from the loudest
 * 3 seconds of soundtrack under it: EBU TR 084 Method 1, with its thresholds moved 3 dB for this
 * -20 LUFS mix, scaled by the volume choice, and deep enough that the narration stays at least
 * `floor` LU above what remains, never more than 24 dB.
 */
export function duckDepth(level: number, narration: number, scale = 1, floor = 10): number {
  if (!Number.isFinite(level)) return 0;
  const table = level <= -43 ? 0 : level <= -30 ? -3 : level <= -20 ? -9 : -19;
  const needed = Math.min(0, narration - floor - level);
  return Math.max(-24, Math.min(table * scale, needed)) + 0;
}

export const decibels = (gain: number): number => 10 ** (gain / 20);

/** Removes the quiet lead-in and tail that speech engines add, keeping a short natural margin. */
export function trimSilence(
  pcm: Float32Array,
  threshold: number = 0.004,
  head: number = 0.03,
  tail: number = 0.08,
): Float32Array {
  const window = Math.round(sampleRate * 0.01);
  const loud = (index: number) => {
    let peak = 0;
    for (let i = index; i < Math.min(pcm.length, index + window); i++)
      peak = Math.max(peak, Math.abs(pcm[i]));
    return peak > threshold;
  };
  let first = 0;
  while (first < pcm.length && !loud(first)) first += window;
  let last = pcm.length;
  while (last > first && !loud(Math.max(first, last - window))) last -= window;
  if (first >= last) return pcm.subarray(0, 0);
  return pcm.slice(
    Math.max(0, first - Math.round(head * sampleRate)),
    Math.min(pcm.length, last + Math.round(tail * sampleRate)),
  );
}

/** Scales a mono narration clip so it measures `target` LUFS, never above -1 dBFS sample peak. */
export function level(pcm: Float32Array, target: number): Float32Array {
  const measured = loudness(pcm, 1);
  let gain = Number.isFinite(measured)
    ? decibels(Math.max(-30, Math.min(30, target - measured)))
    : 1;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak * gain > 0.89) gain = 0.89 / peak;
  return pcm.map((value) => value * gain);
}

/** A frozen pause in source seconds, with its own fade lengths when words sit close to it. */
export type Pause = { at: number; length: number; fadeOut?: number; fadeIn?: number };
export type Clip = { at: number; pcm: Float32Array };

const eased = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/**
 * Lays the section's own soundtrack onto the output timeline: silence during each frozen pause,
 * a very short fade out ending at the freeze and a quick fade back in, so nothing clicks. With
 * no pauses the soundtrack is returned as it is, without a copy.
 */
export function pauseProgram(
  program: Float32Array,
  pauses: Pause[],
  outputFrames: number,
  fadeOut = 0.035,
  fadeIn = 0.06,
): Float32Array {
  if (!pauses.length && program.length === outputFrames * 2) return program;
  const out = new Float32Array(outputFrames * 2);
  const inputFrames = program.length / 2;
  const ordered = [...pauses].sort((a, b) => a.at - b.at);
  let source = 0;
  let target = 0;
  const copy = (until: number, head: number, tail: number) => {
    const frames = Math.max(0, Math.min(until, inputFrames) - source);
    const count = Math.min(frames, outputFrames - target);
    const outLength = Math.round(tail * sampleRate);
    const inLength = Math.round(head * sampleRate);
    for (let i = 0; i < count; i++) {
      let gain = 1;
      if (i < inLength) gain *= eased(i / inLength);
      if (count - i <= outLength) gain *= eased((count - i) / outLength);
      out[(target + i) * 2] = program[(source + i) * 2] * gain;
      out[(target + i) * 2 + 1] = program[(source + i) * 2 + 1] * gain;
    }
    source += frames;
    target += count;
  };
  let head = 0;
  for (const pause of ordered) {
    copy(Math.round(pause.at * sampleRate), head, pause.fadeOut ?? fadeOut);
    target = Math.min(outputFrames, target + Math.round(pause.length * sampleRate));
    head = pause.fadeIn ?? fadeIn;
  }
  copy(inputFrames, head, 0);
  return out;
}

/** A stretch of narration in output seconds, the soundtrack gain under it, and its own ramps. */
export type Duck = Interval & { gain: number; attack?: number; release?: number };

/**
 * Multiplies interleaved samples by the ducking gain: it eases down before each narration, holds
 * while it speaks and eases back afterwards, taking the lowest gain where two overlap. Ramps are
 * squeezed to fit inside the buffer, so a section always starts and ends at full level.
 */
export function applyDuck(
  target: Float32Array,
  channels: number,
  spans: Duck[],
  attack = 0.25,
  release = 0.5,
): void {
  const frames = Math.floor(target.length / channels);
  const shaped = spans
    .filter((span) => span.gain < 1 && span.end > span.start)
    .map((span) => {
      const down = Math.min(frames, Math.max(0, Math.round(span.start * sampleRate)));
      const up = Math.min(frames, Math.max(down, Math.round(span.end * sampleRate)));
      return {
        gain: Math.max(0, span.gain),
        from: Math.max(0, Math.round((span.start - (span.attack ?? attack)) * sampleRate)),
        down,
        up,
        to: Math.min(frames, Math.round((span.end + (span.release ?? release)) * sampleRate)),
      };
    })
    .sort((a, b) => a.from - b.from);
  let i = 0;
  while (i < shaped.length) {
    const group = [shaped[i]];
    let to = shaped[i].to;
    while (++i < shaped.length && shaped[i].from < to) {
      group.push(shaped[i]);
      to = Math.max(to, shaped[i].to);
    }
    for (let frame = group[0].from; frame < to; frame++) {
      let gain = 1;
      for (const span of group) {
        if (frame < span.from || frame >= span.to) continue;
        const depth = 1 - span.gain;
        const value =
          frame < span.down
            ? 1 - depth * eased((frame - span.from) / Math.max(1, span.down - span.from))
            : frame < span.up
              ? span.gain
              : span.gain + depth * eased((frame - span.up) / Math.max(1, span.to - span.up));
        if (value < gain) gain = value;
      }
      if (gain === 1) continue;
      for (let c = 0; c < channels; c++) target[frame * channels + c] *= gain;
    }
  }
}

/** The ducking gain as its own curve, one value per frame. */
export function duckCurve(
  frames: number,
  spans: Duck[],
  attack = 0.25,
  release = 0.5,
): Float32Array {
  const curve = new Float32Array(frames).fill(1);
  applyDuck(curve, 1, spans, attack, release);
  return curve;
}

/**
 * Mixes in place: the paused soundtrack is scaled and ducked, and the centred narration clips
 * are added, so a long section needs no second full-length buffer.
 */
export function mix(
  program: Float32Array,
  programGain: number,
  spans: Duck[],
  clips: Clip[],
): Float32Array {
  const frames = Math.floor(program.length / 2);
  if (programGain !== 1) for (let i = 0; i < frames * 2; i++) program[i] *= programGain;
  applyDuck(program, 2, spans);
  for (const clip of clips) {
    const offset = Math.round(clip.at * sampleRate);
    for (let i = Math.max(0, -offset); i < clip.pcm.length && offset + i < frames; i++) {
      program[(offset + i) * 2] += clip.pcm[i];
      program[(offset + i) * 2 + 1] += clip.pcm[i];
    }
  }
  return program;
}

export const pcmSeconds = (pcm: Float32Array): number => pcm.length / sampleRate;
