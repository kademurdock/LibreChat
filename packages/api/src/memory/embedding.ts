import axios from 'axios';
import { createHash } from 'node:crypto';

export type EmbeddingLane = {
  provider: 'compatible' | 'gemini' | 'openai';
  model: string;
  identity: string;
  dimensions: number;
  url: string;
  key: string;
};

export type IndexedEmbedding = {
  embedding?: number[] | null;
  embedModel?: string | null;
  embeddingNext?: number[] | null;
  embedNextModel?: string | null;
  embedNextHash?: string | null;
};

export type MemoryEmbeddingPurpose = 'query' | 'document' | 'tools';

/* Oct 16 2026: tool matching asked Qwen3 to "retrieve relevant personal memories" for the
 * person's words and scored that against tool descriptions. Tool selection has its own
 * instruction now; documents are never instructed. */
const queryInstructions: Record<Exclude<MemoryEmbeddingPurpose, 'document'>, string> = {
  query: 'Given a conversation query, retrieve relevant personal memories that answer the query',
  tools: 'Given a user message, retrieve the tool whose description can fulfil the request',
};
const openRouter = 'https://openrouter.ai/api/v1';
const instructed = (lane: EmbeddingLane | null): boolean =>
  !!lane && /qwen3-embedding/i.test(lane.model);

/** The purpose whose input actually differs on this lane: a lane that reads no instruction
 * embeds a tools query and a memory query identically, so a per-turn memo can share them. */
export function memoryEmbeddingPurpose(
  lane: EmbeddingLane | null,
  purpose: MemoryEmbeddingPurpose,
): MemoryEmbeddingPurpose {
  return purpose === 'tools' && !instructed(lane) ? 'query' : purpose;
}

/* Oct 16 2026: one in five Kiana turns sat out the full 8 s embed timeout before tool
 * loading went on. Queries (on the turn path) default to 3 s, KADE_EMBED_TIMEOUT_MS;
 * document embeds (writes, backfills, tool descriptions) keep 8 s, KADE_EMBED_DOC_TIMEOUT_MS. */
export function memoryEmbeddingTimeoutMs(
  purpose: MemoryEmbeddingPurpose = 'document',
  env: NodeJS.ProcessEnv = process.env,
): number {
  const document = purpose === 'document';
  const set = Number(document ? env.KADE_EMBED_DOC_TIMEOUT_MS : env.KADE_EMBED_TIMEOUT_MS);
  if (Number.isFinite(set) && set >= 500 && set <= 60000) return set;
  return document ? 8000 : 3000;
}

export function memoryEmbeddingLane(env: NodeJS.ProcessEnv = process.env): EmbeddingLane | null {
  if (env.KADE_EMBED_MODEL) {
    const model = env.KADE_EMBED_MODEL.trim();
    const dimensions = Number(env.KADE_EMBED_DIMENSIONS || 1536);
    const base = (env.KADE_EMBED_BASE || openRouter).replace(/\/$/, '');
    const key =
      env.KADE_EMBED_KEY ||
      (base === openRouter ? env.OPENROUTER_KEY || env.OPENROUTER_API_KEY : '');
    if (!model || !key || !Number.isInteger(dimensions) || dimensions < 32 || dimensions > 4096)
      return null;
    let url: URL;
    try {
      url = new URL(`${base}/embeddings`);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null;
    return {
      provider: 'compatible',
      model,
      identity: `${model}@${dimensions}:memory-v1`,
      dimensions,
      url: url.href,
      key,
    };
  }
  if (env.KADE_EMBED_GEMINI_KEY) {
    return {
      provider: 'gemini',
      model: 'gemini-embedding-001',
      identity: 'gemini-embedding-001',
      dimensions: 1536,
      key: env.KADE_EMBED_GEMINI_KEY,
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    };
  }
  if (env.KADE_EMBED_OPENAI_KEY) {
    return {
      provider: 'openai',
      model: 'text-embedding-3-small',
      identity: 'text-embedding-3-small',
      dimensions: 1536,
      key: env.KADE_EMBED_OPENAI_KEY,
      url: 'https://api.openai.com/v1/embeddings',
    };
  }
  return null;
}

export function embeddingTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function validEmbedding(
  vector: number[] | null | undefined,
  dimensions: number,
): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === dimensions &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    vector.some((value) => value !== 0)
  );
}

export function indexedEmbedding(
  row: IndexedEmbedding,
  model: string,
  text: string,
  dimensions: number,
): number[] | null {
  if (row.embedModel === model && validEmbedding(row.embedding, dimensions)) return row.embedding;
  if (
    row.embedNextModel === model &&
    row.embedNextHash === embeddingTextHash(text) &&
    validEmbedding(row.embeddingNext, dimensions)
  )
    return row.embeddingNext;
  return null;
}

export function indexedCardEmbedding(
  row: IndexedEmbedding & {
    key: string;
    valueHash: string;
    embedNextValueHash?: string | null;
  },
  model: string,
  dimensions: number,
  value?: string,
): number[] | null {
  const hash = value === undefined ? row.valueHash : createHash('sha1').update(value).digest('hex');
  if (
    row.embedModel === model &&
    row.valueHash === hash &&
    validEmbedding(row.embedding, dimensions)
  )
    return row.embedding;
  if (
    row.embedNextModel !== model ||
    row.embedNextValueHash !== hash ||
    !validEmbedding(row.embeddingNext, dimensions)
  )
    return null;
  if (
    value !== undefined &&
    row.embedNextHash !== embeddingTextHash(row.key.replace(/_/g, ' ') + ': ' + value)
  )
    return null;
  return row.embeddingNext;
}

type EmbeddingResponse = {
  embedding?: { values?: number[] };
  data?: { index: number; embedding?: number[] }[];
};

export async function requestMemoryEmbedding(
  lane: EmbeddingLane,
  text: string,
  purpose: MemoryEmbeddingPurpose = 'document',
): Promise<number[]> {
  const plain = text.slice(0, 4000);
  const input =
    purpose !== 'document' && instructed(lane)
      ? `Instruct: ${queryInstructions[purpose]}\nQuery: ${plain}`
      : plain;
  const compatible = lane.provider !== 'gemini';
  const response = await axios.post<EmbeddingResponse>(
    lane.url,
    compatible
      ? {
          model: lane.model,
          input,
          dimensions: lane.dimensions,
          encoding_format: 'float',
          ...(lane.url.startsWith(`${openRouter}/`)
            ? { provider: { max_price: { prompt: 0.02 } } }
            : {}),
        }
      : {
          model: `models/${lane.model}`,
          content: { parts: [{ text: plain }] },
          outputDimensionality: lane.dimensions,
        },
    {
      headers: compatible
        ? { Authorization: `Bearer ${lane.key}`, 'Content-Type': 'application/json' }
        : { 'x-goog-api-key': lane.key, 'Content-Type': 'application/json' },
      timeout: memoryEmbeddingTimeoutMs(purpose),
      maxRedirects: 0,
      maxContentLength: 256 * 1024,
    },
  );
  const vector = compatible
    ? response.data.data?.find((item) => item.index === 0)?.embedding
    : response.data.embedding?.values;
  if (!validEmbedding(vector, lane.dimensions))
    throw new Error('The embedding provider returned an invalid vector.');
  return vector;
}
