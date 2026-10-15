import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { writingCost } from '../utils/writing';

type Completion = {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    delta?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: Parameters<typeof writingCost>[0];
  error?: { message?: string };
};

const incomplete = (message: string): Error & { status: number } =>
  Object.assign(new Error(message), { status: 502 });

/** Collect one streamed completion; reasoning and heartbeat events never become lyrics. */
export async function readWritingCompletion(data: Readable | Completion): Promise<Completion> {
  if (!(data instanceof Readable)) return data;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let bytes = 0;
  let done = false;
  let text = '';
  let refusal = '';
  let finish: string | null | undefined;
  let usage: Completion['usage'];
  const event = (block: string): void => {
    const payload = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    if (done) throw incomplete('The lyric writer sent data after its completion marker.');
    const reply = JSON.parse(payload) as Completion;
    if (reply.error) throw incomplete('The lyric writer ended with a provider error.');
    const choice = reply.choices?.[0];
    text += choice?.delta?.content ?? choice?.message?.content ?? '';
    refusal += choice?.delta?.refusal ?? choice?.message?.refusal ?? '';
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (reply.usage) usage = reply.usage;
  };
  try {
    for await (const chunk of data) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > 8 * 1024 * 1024)
        throw incomplete('The lyric writer response exceeded its safe size.');
      pending = (pending + decoder.write(buffer)).replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        event(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf('\n\n');
      }
    }
    pending += decoder.end();
    if (pending.trimStart().startsWith('{')) {
      const reply = JSON.parse(pending) as Completion;
      if (reply.error || !reply.choices?.[0]?.finish_reason)
        throw incomplete('The lyric writer returned an incomplete response.');
      return reply;
    }
    if (pending.trim()) event(pending);
    if (!done || !finish || !['stop', 'length', 'content_filter'].includes(finish)) {
      throw incomplete('The lyric writer connection ended before a complete response.');
    }
    return {
      choices: [
        { message: { content: text, refusal: refusal || undefined }, finish_reason: finish },
      ],
      usage,
    };
  } finally {
    if (!data.destroyed) data.destroy();
  }
}
