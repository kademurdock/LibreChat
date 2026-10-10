export class MediaSourceAppender {
  private readonly mediaSource = new MediaSource();
  private readonly audioChunks: ArrayBuffer[] = [];
  private readonly url = URL.createObjectURL(this.mediaSource);
  private finished = false;
  private cancelled = false;

  private sourceBuffer?: SourceBuffer;

  constructor(type: string) {
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.cancelled) return;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(type);

      this.sourceBuffer.addEventListener('updateend', () => {
        this.tryAppendNextChunk();
      });
      this.tryAppendNextChunk();
    });
  }

  private tryAppendNextChunk() {
    if (this.cancelled || !this.sourceBuffer || this.sourceBuffer.updating) return;
    if (this.audioChunks.length > 0) {
      this.sourceBuffer.appendBuffer(this.audioChunks.shift()!);
      return;
    }
    if (this.finished && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
  }

  public addBase64Data(base64Data: string) {
    this.addData(
      Uint8Array.from(atob(base64Data), (char) => char.charCodeAt(0)).buffer as ArrayBuffer,
    );
  }

  public addData(data: ArrayBuffer) {
    if (this.cancelled || this.finished) return;
    this.audioChunks.push(data);
    this.tryAppendNextChunk();
  }

  public close() {
    this.finished = true;
    this.tryAppendNextChunk();
  }

  public cancel() {
    this.cancelled = true;
    this.audioChunks.length = 0;
    if (this.mediaSource.readyState === 'open' && this.sourceBuffer?.updating)
      this.sourceBuffer.abort();
    URL.revokeObjectURL(this.url);
  }

  public get mediaSourceUrl() {
    return this.url;
  }
}
