import axios from 'axios';
import type { Router } from 'express';
import type { Hooks, Input, Provider } from '../audio/jobs';
import { createAudioRouter } from '../audio/jobs';

export const yueCost =
  'No reliable per-song cost estimate yet. YuE2 currently does not deduct from your credit balance. Kade pays GPU time at about $1.22 per hour per GPU, including startup and ten minutes awake after the last job. Up to two GPUs can run together; extra takes and higher settings use more GPU time.';

/* Trained styles (Part 235): each is an AR LoRA Kade trained from her own folders, kept in the
 * private bucket and folded in by the worker for one song. The lead sentence is the caption the
 * LoRA was trained under, trigger word first, so it has to open the style text. They were trained
 * score-free, so a new song in a trained style asks the worker for cot off. Her ear picked the
 * checkpoints: kids step 1200, soul step 800, both on the stock decoder. */
export const yueStyles: Record<string, { key: string; scale: number; lead: string }> = {
  kids_choir: {
    key: 'yue2-loras/kids-step1200.pt',
    scale: 1,
    lead: "kdkids, in the style of kdkids. English, children's choir, a group of young voices singing together, bright and clear.",
  },
  soul: {
    key: 'yue2-loras/soul-step800.pt',
    scale: 1,
    lead: 'kdsoul, in the style of kdsoul. English, soulful, heartfelt expressive lead vocal with rich harmonies, warm groove.',
  },
};
export function yueStylesEnabled(): boolean {
  return process.env.YUE_STYLES_ENABLED === '1';
}

export function yueInput(body: {
  title?: string;
  count?: number;
  weirdness?: number;
  steps?: number;
  guidance?: number;
  script?: string;
  lyrics?: string;
  abc?: string;
  cot?: string;
  band?: string;
  seed?: number;
  reference_voice_url?: string;
  referenceExpected?: boolean;
}): Input {
  if (typeof body.script !== 'string' || body.script.trim().length < 3 || body.script.length > 3000)
    throw new Error('Describe the music in 3 to 3000 characters.');
  if (typeof body.lyrics !== 'string' || !body.lyrics.trim() || body.lyrics.length > 8000)
    throw new Error('Add the words to sing in Lyrics, up to 8000 characters.');
  if (body.abc != null && (typeof body.abc !== 'string' || body.abc.length > 40000))
    throw new Error('The score must be ABC text, up to 40000 characters.');
  if (
    body.seed != null &&
    (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647)
  )
    throw new Error('Seed must be a whole number from 0 to 2147483647.');
  if (body.referenceExpected && !body.reference_voice_url)
    throw new Error(
      'Wait for the cover recording to finish importing, or discard the failed import.',
    );
  if (
    body.reference_voice_url &&
    (typeof body.reference_voice_url !== 'string' ||
      !body.reference_voice_url.startsWith('https://') ||
      body.reference_voice_url.length > 12000)
  )
    throw new Error('Import the source recording again.');
  if (body.reference_voice_url && body.abc)
    throw new Error(
      'Use an imported recording or a composition score. Remove one before generating.',
    );
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 80))
    throw new Error('Use a title up to 80 characters.');
  const band = body.band && body.band !== 'none' ? body.band : undefined;
  if (band && (!yueStylesEnabled() || !Object.prototype.hasOwnProperty.call(yueStyles, band)))
    throw new Error('That trained style is not available. Choose None or another style.');
  const trained = band ? yueStyles[band] : undefined;
  function number(
    value: number | undefined,
    fallback: number,
    low: number,
    high: number,
    label: string,
    integer = true,
  ): number {
    if (value == null) return fallback;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < low ||
      value > high ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(
        `${label} must be ${integer ? 'a whole number ' : ''}from ${low} to ${high}.`,
      );
    return value;
  }
  return {
    style: trained ? `${trained.lead} ${body.script.trim()}`.slice(0, 3000) : body.script.trim(),
    title: body.title?.trim() || body.script.trim().split(/\s+/).slice(0, 7).join(' ').slice(0, 80),
    count: number(body.count, 1, 1, 4, 'Number of takes'),
    weirdness: number(body.weirdness, 50, 0, 100, 'Creative variation'),
    steps: number(body.steps, 32, 16, 64, 'Inference steps'),
    guidance: number(body.guidance, 1, 1, 3, 'Prompt guidance', false),
    lyrics: body.lyrics.trim(),
    abc: body.abc || undefined,
    reference_voice_url: body.reference_voice_url || undefined,
    cot:
      body.reference_voice_url || (body.abc && body.cot !== 'full')
        ? 'melody'
        : trained && !body.abc
          ? 'off'
          : 'full',
    band,
    lora_key: trained?.key,
    lora_scale: trained?.scale,
    seed: body.seed ?? Math.floor(Math.random() * 2147483647),
  };
}
export function yueConfigured(): boolean {
  return !!(process.env.YUE_ENDPOINT_ID && process.env.RUNPOD_API_KEY);
}
async function provider(
  path: string,
  data?: { input: Input; policy: { executionTimeout: number; ttl: number } },
): Promise<Provider> {
  const base = `https://api.runpod.ai/v2/${process.env.YUE_ENDPOINT_ID}`;
  const response = await axios.request<Provider>({
    url: `${base}/${path}`,
    method: data || path.startsWith('cancel/') ? 'POST' : 'GET',
    data,
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    timeout: 30000,
  });
  return response.data;
}

export function createYueRouter(hooks: Hooks): Router {
  return createAudioRouter(hooks, {
    engine: 'yue2',
    prefix: 'yue_',
    model: 'KadeYueJob',
    name: 'YuE2',
    configured: yueConfigured,
    parse: yueInput,
    estimate: (input) => ({
      spoken: `${input.count} take${input.count === 1 ? '' : 's'}. ${yueCost}`,
    }),
    submit: (input) =>
      provider('run', { input, policy: { executionTimeout: 1200000, ttl: 7200000 } }),
    status: async (take) => {
      const result = await provider(`status/${encodeURIComponent(take.providerId || '')}`);
      /* RunPod reports how long the job waited for a GPU (delayTime) and how long
       * it ran. Keeping both beside the take is what tells a cold wake from a
       * slow run; the booth used to discard them. */
      const output = result.output && {
        ...result.output,
        queue_ms: result.delayTime,
        execution_ms: result.executionTime,
      };
      return { ...result, output, costUSD: ((result.executionTime || 0) / 3600000) * 1.22 };
    },
    cancel: async (take) => {
      await provider(`cancel/${encodeURIComponent(take.providerId || '')}`);
    },
    working: 'YuE2 is composing. Up to two takes can run together when GPUs are available.',
    stopping:
      'Stop requested for unfinished takes. Finished takes are kept. GPU time already used is still billed to Kade.',
  });
}
