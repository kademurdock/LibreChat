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

const queryInstruction =
  'Given a conversation query, retrieve relevant personal memories that answer the query';
const openRouter = 'https://openrouter.ai/api/v1';

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
  purpose: 'query' | 'document' = 'document',
): Promise<number[]> {
  const plain = text.slice(0, 4000);
  const input =
    purpose === 'query' && /qwen3-embedding/i.test(lane.model)
      ? `Instruct: ${queryInstruction}\nQuery: ${plain}`
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
      timeout: 8000,
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
