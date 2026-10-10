import { speechAudioFormat, sniffSpeechAudioFormat } from 'librechat-data-provider';

export function speechAudioFile(data: ArrayBuffer, contentType?: string | null) {
  const format = speechAudioFormat(new Uint8Array(data), contentType);
  return { blob: new Blob([data], { type: format.mimeType }), extension: format.extension };
}

export async function speechAudioBlob(blob: Blob): Promise<Blob> {
  return speechAudioFile(await blob.arrayBuffer(), blob.type).blob;
}

type SpeechStream = {
  append: (data: ArrayBuffer) => void;
  close: () => void;
  cancel: () => void;
};

/** Only verified MP3 bytes enter MediaSource; WAV and other containers use a complete Blob. */
export async function consumeSpeechAudio(
  response: Response,
  options: {
    cache: boolean;
    openStream: (type: string) => SpeechStream | null;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Blob | null> {
  if (!response.ok || !response.body) throw new Error('Failed to fetch audio');
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  const prefix = new Uint8Array(12);
  let prefixSize = 0;
  let identified = false;
  let stream: SpeechStream | null = null;
  let format = speechAudioFormat(prefix, response.headers.get('content-type'));
  const cancelStream = () => {
    stream?.cancel();
    stream = null;
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
    cancelStream();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) throw new DOMException('Audio request cancelled', 'AbortError');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Reader promise timed out')),
            options.timeoutMs ?? 15000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (options.signal?.aborted) throw new DOMException('Audio request cancelled', 'AbortError');
      if (value?.length) {
        const data = new Uint8Array(value).buffer;
        if (!identified) {
          parts.push(data);
          const count = Math.min(value.length, prefix.length - prefixSize);
          prefix.set(value.subarray(0, count), prefixSize);
          prefixSize += count;
          if (prefixSize === prefix.length) {
            format = speechAudioFormat(prefix, response.headers.get('content-type'));
            identified = true;
            if (sniffSpeechAudioFormat(prefix)?.mimeType === 'audio/mpeg') {
              stream = options.openStream(format.mimeType);
              if (stream) {
                for (const part of parts) stream.append(part);
                if (!options.cache) parts.length = 0;
              }
            }
          }
        } else {
          if (!stream || options.cache) parts.push(data);
          stream?.append(data);
        }
      }
      if (done) break;
    }
    if (!identified)
      format = speechAudioFormat(
        prefix.subarray(0, prefixSize),
        response.headers.get('content-type'),
      );
    stream?.close();
    return parts.length ? new Blob(parts, { type: format.mimeType }) : null;
  } catch (error) {
    await reader.cancel().catch(() => {});
    cancelStream();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
