import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { speechAudioFormat } from 'librechat-data-provider';
import type { ServerResponse } from 'node:http';
import type { Readable, TransformCallback } from 'node:stream';

/** Preserve the streamed bytes while labeling the first container from its header. */
export async function pipeSpeechAudio(
  source: Readable,
  response: ServerResponse,
  contentType?: string,
  end = true,
): Promise<void> {
  let pending = Buffer.alloc(0);
  let identified = false;
  const start = (target: Transform) => {
    if (!response.headersSent) {
      response.setHeader('Content-Type', speechAudioFormat(pending, contentType).mimeType);
    }
    identified = true;
    target.push(pending);
    pending = Buffer.alloc(0);
  };
  const identify = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      if (identified) {
        callback(null, chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 12) start(this);
      callback();
    },
    flush(callback: TransformCallback) {
      if (!identified && pending.length) start(this);
      callback();
    },
  });
  const fail = (error: Error) => {
    identify.destroy(error);
  };
  const disconnected = () => {
    identify.destroy(new Error('Audio response closed'));
  };
  source.once('error', fail);
  response.once('error', fail);
  response.once('close', disconnected);
  try {
    const complete = finished(identify, { cleanup: true });
    source.pipe(identify).pipe(response, { end });
    await complete;
  } catch (error) {
    if (response.headersSent && !response.destroyed) response.destroy();
    throw error;
  } finally {
    source.off('error', fail);
    response.off('error', fail);
    response.off('close', disconnected);
    source.unpipe(identify);
    identify.unpipe(response);
    if (!source.readableEnded) source.destroy();
  }
}
