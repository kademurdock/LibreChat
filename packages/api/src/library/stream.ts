import { createHash } from 'node:crypto';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client, CompletedPart } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/** What was stored: its size and the SHA-256 of its bytes, taken while they streamed (Sep 25 2026,
 * the Library's one-file rule: a DAISY clip's multipart ETag cannot be compared, its hash can). */
export type StoredAudio = { bytes: number; sha256: string };

/** Bounded-memory multipart transfer, with cleanup on read or storage failure. */
export async function storeAudioStream(client: S3Client, bucket: string, key: string, body: Readable, mime: string): Promise<StoredAudio> {
  const base = { Bucket: bucket, Key: key };
  const hash = createHash('sha256');
  let total = 0;
  const created = await client.send(new CreateMultipartUploadCommand({ ...base, ContentType: mime })).catch((error: Error) => { body.destroy(); throw error; });
  const upload = { ...base, UploadId: created.UploadId };
  const parts: CompletedPart[] = [];
  let pending: Buffer[] = [], bytes = 0;
  const send = async (): Promise<void> => {
    const part = parts.length + 1;
    const buffer = Buffer.concat(pending, bytes);
    pending = []; bytes = 0;
    const result = await client.send(new UploadPartCommand({ ...upload, PartNumber: part, Body: buffer }));
    parts.push({ PartNumber: part, ETag: result.ETag });
  };
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer); total += buffer.length;
      pending.push(buffer); bytes += buffer.length;
      if (bytes >= 8 * 1024 ** 2) await send();
    }
    if (bytes) await send();
    if (!parts.length) {
      await client.send(new AbortMultipartUploadCommand(upload));
      await client.send(new PutObjectCommand({ ...base, ContentType: mime, Body: Buffer.alloc(0) }));
      return { bytes: 0, sha256: hash.digest('hex') };
    }
    await client.send(new CompleteMultipartUploadCommand({ ...upload, MultipartUpload: { Parts: parts } }));
    return { bytes: total, sha256: hash.digest('hex') };
  } catch (error) {
    body.destroy();
    await client.send(new AbortMultipartUploadCommand(upload)).catch(() => {});
    throw error;
  }
}
