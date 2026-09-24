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

export type Pause = { at: number; length: number };
export type Clip = { at: number; pcm: Float32Array };

const eased = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/**
 * Lays the section's own soundtrack onto the output timeline: silence during each frozen pause,
 * a short fade out before it and a quicker fade back in, so nothing clicks or cuts off hard.
 */
export function pauseProgram(
  program: Float32Array,
  pauses: Pause[],
  outputFrames: number,
  fadeOut = 0.15,
  fadeIn = 0.06,
): Float32Array {
  const out = new Float32Array(outputFrames * 2);
  const inputFrames = program.length / 2;
  const ordered = [...pauses].sort((a, b) => a.at - b.at);
  let source = 0;
  let target = 0;
  const copy = (until: number, fadeHead: boolean, fadeTail: boolean) => {
    const frames = Math.max(0, Math.min(until, inputFrames) - source);
    const count = Math.min(frames, outputFrames - target);
    const outLength = Math.round(fadeOut * sampleRate);
    const inLength = Math.round(fadeIn * sampleRate);
    for (let i = 0; i < count; i++) {
      let gain = 1;
      if (fadeHead && i < inLength) gain *= eased(i / inLength);
      if (fadeTail && count - i <= outLength) gain *= eased((count - i) / outLength);
      out[(target + i) * 2] = program[(source + i) * 2] * gain;
      out[(target + i) * 2 + 1] = program[(source + i) * 2 + 1] * gain;
    }
    source += frames;
    target += count;
  };
  let resumed = false;
  for (const pause of ordered) {
    copy(Math.round(pause.at * sampleRate), resumed, true);
    target = Math.min(outputFrames, target + Math.round(pause.length * sampleRate));
    resumed = true;
  }
  copy(inputFrames, resumed, false);
  return out;
}

/**
 * Gain curve for the soundtrack in output time: it eases down just before each narration,
 * holds while it speaks, and eases back afterwards.
 */
export function duckCurve(
  frames: number,
  spans: Interval[],
  duck: number,
  attack = 0.25,
  release = 0.5,
): Float32Array {
  const curve = new Float32Array(frames).fill(1);
  for (const span of spans) {
    const start = Math.round((span.start - attack) * sampleRate);
    const down = Math.round(span.start * sampleRate);
    const up = Math.round(span.end * sampleRate);
    const end = Math.round((span.end + release) * sampleRate);
    for (let i = Math.max(0, start); i < Math.min(frames, end); i++) {
      let gain = duck;
      if (i < down) gain = 1 - (1 - duck) * eased((i - start) / Math.max(1, down - start));
      else if (i >= up) gain = duck + (1 - duck) * eased((i - up) / Math.max(1, end - up));
      if (gain < curve[i]) curve[i] = gain;
    }
  }
  return curve;
}

/** Sums the paused, ducked soundtrack with centred narration clips into interleaved stereo. */
export function mix(
  program: Float32Array,
  programGain: number,
  curve: Float32Array,
  clips: Clip[],
): Float32Array {
  const frames = curve.length;
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const gain = programGain * curve[i];
    out[i * 2] = (program[i * 2] || 0) * gain;
    out[i * 2 + 1] = (program[i * 2 + 1] || 0) * gain;
  }
  for (const clip of clips) {
    const offset = Math.round(clip.at * sampleRate);
    for (let i = 0; i < clip.pcm.length && offset + i < frames; i++) {
      if (offset + i < 0) continue;
      out[(offset + i) * 2] += clip.pcm[i];
      out[(offset + i) * 2 + 1] += clip.pcm[i];
    }
  }
  return out;
}

export const pcmSeconds = (pcm: Float32Array): number => pcm.length / sampleRate;
