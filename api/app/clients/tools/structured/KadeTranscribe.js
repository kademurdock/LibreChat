/**
 * KADE July 18 2026 — kade_transcribe: hand an agent a voice memo, get text.
 * The user attaches/uploads an audio file (any chat upload), then asks the
 * agent to transcribe it. The tool finds the user's newest audio upload,
 * pulls the bytes from file storage, and runs the same Deepgram path the
 * /transcribe page uses (free tier). No auth config — server env key.
 */
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|opus|aac|amr|flac|webm|mp4|3gp)$/i;

class KadeTranscribe extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_transcribe';
    this.userId = fields.userId;
    this.description =
      "Transcribe the user's most recently uploaded audio file (voice memo, recording) into formatted text. " +
      'Use when the user uploads audio and asks what it says, or asks you to transcribe/summarize a voice memo. ' +
      'Returns the full transcript — quote or summarize it as the user asked.';
    this.schema = {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Optional: part of the filename to pick a specific upload instead of the newest one.',
        },
      },
    };
  }

  async _call({ filename } = {}) {
    try {
      const { getFiles } = require('~/models');
      const files = await getFiles({ user: this.userId });
      const audio = (files || [])
        .filter((f) => {
          const t = String(f.type || '');
          const n = String(f.filename || '');
          return t.startsWith('audio/') || t === 'video/mp4' || AUDIO_EXT.test(n);
        })
        .filter((f) => (filename ? String(f.filename || '').toLowerCase().includes(String(filename).toLowerCase()) : true))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      if (!audio.length) {
        return 'No audio uploads found for this user. Ask them to attach the voice memo to the chat (paperclip), or use the upload page at /transcribe.';
      }
      const file = audio[0];
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const { getDownloadStream } = getStrategyFunctions(file.source);
      if (!getDownloadStream) {
        return `That file is stored somewhere I can't reach (${file.source}). Point the user to the /transcribe page instead.`;
      }
      const stream = await getDownloadStream(null, file.storageKey || file.filepath);
      const chunks = [];
      for await (const c of stream) {
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      const { transcribeBuffer } = require('~/server/routes/kadeTranscribe');
      const out = await transcribeBuffer(buf, String(file.type || ''));
      const mins = Math.max(1, Math.round(out.seconds / 60));
      let text = out.transcript;
      let clipped = '';
      if (text.length > 24000) {
        text = text.slice(0, 24000);
        clipped = '\n\n[Transcript trimmed for length — the full text is available on the /transcribe page.]';
      }
      return `Transcript of "${file.filename}" (~${mins} min):\n\n${text}${clipped}`;
    } catch (e) {
      logger.warn('[kade_transcribe] failed: ' + (e && e.message));
      return `Transcription failed: ${e.message}. The user can also try the upload page at kademurdock.com/transcribe.`;
    }
  }
}

module.exports = KadeTranscribe;
