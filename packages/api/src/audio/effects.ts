import axios from 'axios';
import type { Router } from 'express';
import type { Hooks, Input, InputBody, Provider, Take } from './jobs';
import { createAudioRouter } from './jobs';

type Variant = { name: string; model: string; price: number };
export const effectsVariants: Record<NonNullable<Input['soundModel']>, Variant> = {
  '3_medium': {
    name: 'Stable Audio 3 Medium',
    model: 'fal-ai/stable-audio-3/medium/text-to-audio',
    price: 0.0376,
  },
  '3_small_sfx': {
    name: 'Stable Audio 3 Small SFX',
    model: 'fal-ai/stable-audio-3/small/sfx/text-to-audio',
    price: 0.0206,
  },
};
export const effectsModel: string = effectsVariants['3_medium'].model;
export const effectsPrice: number = effectsVariants['3_medium'].price;
export function effectsVariant(input?: Pick<Input, 'soundModel'> | null): Variant {
  return effectsVariants[input?.soundModel || '3_small_sfx'] || effectsVariants['3_small_sfx'];
}
export const effectsCost =
  'Provider cost: 3 Medium is 3.76 cents per recording, or 15.04 cents for four. 3 Small SFX is 2.06 cents per recording, or 8.24 cents for four. This trial does not deduct from your credit balance; Kade pays the provider cost. Each press starts generation without another confirmation.';
const queue = 'https://queue.fal.run';
export const effectsGuide = {
  name: 'Stable Audio',
  tagline: 'Stereo sound effects and layered ambience, saved as lossless WAV.',
  where:
    'Stable Audio 3 Medium is the default; the original 3 Small SFX remains available in Sound settings. Both run on fal. Your description is sent to fal.',
  cost: effectsCost as string,
  bestFor: [
    'nature and room ambience',
    'foley, machines and environmental effects',
    'trying inexpensive soundscape variations',
  ],
  notFor: [
    'spoken dialogue or exact lyrics',
    'separate editable layers or guaranteed seamless loops',
  ],
  howToWrite: [
    'Describe the foreground sound, then the quieter background layers, their distance and the space around them.',
    'For ambience, ask for a continuous natural recording. Say no music or speech if you want only environmental sound.',
    'Listen to several takes. Complex layers and precise timing may need separate recordings and mixing.',
  ],
  settings: [
    {
      key: 'soundModel',
      label: 'Sound model',
      hint: '3 Medium is the larger model and our recommended starting point for detailed ambience: 3.76 cents per take. 3 Small SFX is the original option: 2.06 cents per take. Stereo width and layer accuracy still vary between recordings.',
      kind: 'choice',
      options: ['3_medium', '3_small_sfx'],
      default: '3_medium',
    },
    {
      key: 'duration',
      label: 'Duration in seconds',
      hint: '1 to 120 seconds in Sound Booth for either model. Provider pricing is per recording.',
      kind: 'number',
      min: 1,
      max: 120,
      step: 1,
      default: 30,
    },
    {
      key: 'count',
      label: 'Number of takes',
      hint: '1 to 4 variations, submitted together with different seeds. Each costs Kade 3.76 cents with Medium or 2.06 cents with Small SFX.',
      kind: 'number',
      min: 1,
      max: 4,
      step: 1,
      default: 1,
    },
    {
      key: 'steps',
      label: 'Inference steps',
      hint: '8 is the recommended default for both distilled models. More steps take longer and do not guarantee better sound.',
      kind: 'number',
      min: 1,
      max: 100,
      step: 1,
      default: 8,
    },
    {
      key: 'seed',
      label: 'Optional seed',
      hint: 'Leave blank for a new starting point. A batch uses consecutive seeds.',
      kind: 'number',
      min: 0,
      max: 2147483647,
    },
  ],
} as const;
type Result = {
  request_id?: string;
  status?: string;
  status_url?: string;
  response_url?: string;
  cancel_url?: string;
  error?: string;
  error_type?: string;
  detail?: string | { msg?: string }[];
  audio?: { url?: string; file_size?: number };
};

export function effectsInput(body: InputBody): Input {
  const soundModel = body.soundModel ?? '3_medium';
  if (soundModel !== '3_medium' && soundModel !== '3_small_sfx')
    throw new Error('Choose 3 Medium or 3 Small SFX as the sound model.');
  if (typeof body.script !== 'string' || body.script.trim().length < 3 || body.script.length > 3000)
    throw new Error('Describe your sounds in 3 to 3000 characters.');
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 80))
    throw new Error('Use a title up to 80 characters.');
  const number = (
    value: number | undefined,
    fallback: number,
    low: number,
    high: number,
    label: string,
  ) => {
    if (value == null) return fallback;
    if (!Number.isInteger(value) || value < low || value > high)
      throw new Error(`${label} must be a whole number from ${low} to ${high}.`);
    return value;
  };
  return {
    soundModel,
    style: body.script.trim(),
    title: body.title?.trim() || body.script.trim().split(/\s+/).slice(0, 7).join(' ').slice(0, 80),
    count: number(body.count, 1, 1, 4, 'Number of takes'),
    duration: number(body.duration, 30, 1, 120, 'Duration in seconds'),
    steps: number(body.steps, 8, 1, 100, 'Inference steps'),
    seed: number(body.seed, Math.floor(Math.random() * 2147483647), 0, 2147483647, 'Seed'),
  };
}

export function effectsConfigured(): boolean {
  return !!process.env.FAL_KEY;
}

function queueUrl(value: string | undefined, id: string): string {
  const url = new URL(value || '');
  if (
    url.origin !== queue ||
    !url.pathname.startsWith('/fal-ai/stable-audio-3/') ||
    !url.pathname.includes(`/requests/${encodeURIComponent(id)}`) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid provider queue address');
  return url.href;
}

async function request(url: string, method: 'GET' | 'POST' | 'PUT' = 'GET', data?: object) {
  return axios.request<Result>({
    url,
    method,
    data,
    timeout: 30000,
    maxRedirects: 0,
    headers: { Authorization: `Key ${process.env.FAL_KEY}` },
    validateStatus: (status) => (status >= 200 && status < 300) || [400, 404, 422].includes(status),
  });
}

async function submit(input: Input): Promise<Provider> {
  const response = await request(`${queue}/${effectsVariant(input).model}`, 'POST', {
    prompt: `TrackType: SFX, ${input.style}`,
    duration: input.duration,
    seed: input.seed,
    num_inference_steps: input.steps,
    output_format: 'wav',
    enable_prompt_expansion: false,
    enable_safety_checker: true,
  });
  const result = response.data,
    id = result.request_id;
  if (!id || response.status >= 400) throw new Error('Provider did not accept the request');
  return {
    id,
    statusUrl: queueUrl(result.status_url, id),
    responseUrl: queueUrl(result.response_url, id),
    cancelUrl: queueUrl(result.cancel_url, id),
  };
}

function failure(result: Result): string {
  const detail =
    typeof result.detail === 'string'
      ? result.detail
      : result.detail
          ?.map((item) => item.msg)
          .filter(Boolean)
          .join(' ');
  return (
    result.error ||
    detail ||
    'Stable Audio could not finish this take. Your description is saved.'
  ).slice(0, 500);
}

async function status(take: Take, input: Input): Promise<Provider> {
  const id = take.providerId || '';
  const response = await request(queueUrl(take.statusUrl, id));
  const result = response.data;
  if (response.status >= 400 || result.error || result.error_type)
    return { status: 'FAILED', error: failure(result) };
  if (result.status !== 'COMPLETED') return { status: result.status };
  const finished = await request(queueUrl(take.responseUrl, id));
  if (finished.status >= 400 || finished.data.error || !finished.data.audio?.url)
    return { status: 'FAILED', error: failure(finished.data) };
  return {
    status: 'COMPLETED',
    costUSD: effectsVariant(input).price,
    output: {
      url: finished.data.audio.url,
      wav_url: finished.data.audio.url,
      bytes: finished.data.audio.file_size,
    },
  };
}

async function cancel(take: Take): Promise<void> {
  const response = await request(queueUrl(take.cancelUrl, take.providerId || ''), 'PUT');
  if (response.status >= 400 && response.data.status !== 'ALREADY_COMPLETED')
    throw new Error('Provider did not confirm cancellation');
}

export async function downloadEffects(url: string): Promise<Buffer> {
  const address = new URL(url);
  if (
    address.protocol !== 'https:' ||
    address.username ||
    address.password ||
    !(address.hostname === 'fal.media' || address.hostname.endsWith('.fal.media'))
  )
    throw new Error('Invalid provider audio address');
  const response = await axios.get<Buffer>(address.href, {
    responseType: 'arraybuffer',
    timeout: 90000,
    maxRedirects: 0,
    maxContentLength: 50 * 1024 * 1024,
  });
  const buffer = Buffer.from(response.data);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Provider did not return a WAV recording');
  return buffer;
}

export function createEffectsRouter(hooks: Hooks): Router {
  return createAudioRouter(hooks, {
    engine: 'stable',
    prefix: 'sfx_',
    model: 'KadeEffectsJob',
    name: 'Stable Audio',
    configured: effectsConfigured,
    parse: effectsInput,
    submit,
    status,
    cancel,
    estimate: (input) => ({
      costUSD: Number((input.count * effectsVariant(input).price).toFixed(4)),
      spoken: `${effectsVariant(input).name}, ${input.count} take${input.count === 1 ? '' : 's'}: ${(input.count * effectsVariant(input).price * 100).toFixed(2)} cents provider cost. No deduction from your credit balance during this trial.`,
    }),
    working:
      'Stable Audio is generating your sounds. Takes are submitted together; fal controls available parallel capacity.',
    stopping:
      'Stop requested for unfinished takes. A take already running may still finish and incur its provider charge. Finished recordings are kept.',
  });
}
