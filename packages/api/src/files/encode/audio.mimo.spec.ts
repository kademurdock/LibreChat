import { encodeAndFormatAudios } from './audio';
import { Providers } from '@librechat/agents';
jest.mock('@librechat/agents', () => ({ Providers: { OPENROUTER: 'OpenRouter', GOOGLE: 'google', VERTEXAI: 'vertexai' } }));
jest.mock('librechat-data-provider', () => ({ isDocumentSupportedProvider: () => true }));
jest.mock('./utils', () => ({
  getFileStream: jest.fn(async (_req, file) => ({ file, content: 'U1lOVEhFVElD', metadata: { id: file.file_id } })),
  getConfiguredFileSizeLimit: () => 20000000,
}));
jest.mock('~/files/validation', () => ({ validateAudio: async () => ({ isValid: true }) }));
const file = { file_id: 'fixture', filename: 'fixture.wav', type: 'audio/wav' };
const run = (model: string, provider = Providers.OPENROUTER) => encodeAndFormatAudios({} as never, [file] as never,
  { provider, model }, (() => ({})) as never);
describe('MiMo native audio attachments', () => {
  const prior = process.env.KADE_OPENROUTER_AUDIO_INPUT;
  beforeEach(() => { delete process.env.KADE_OPENROUTER_AUDIO_INPUT; });
  afterEach(() => {
    if (prior === undefined) delete process.env.KADE_OPENROUTER_AUDIO_INPUT;
    else process.env.KADE_OPENROUTER_AUDIO_INPUT = prior;
  });
  it('sends the original encoded audio to MiMo and retains file metadata', async () => {
    const out = await run('xiaomi/mimo-v2.6-pro');
    expect(out.audios).toEqual([{ type: 'input_audio', input_audio: { data: 'U1lOVEhFVElD', format: 'wav' } }]);
    expect(out.files).toEqual([{ id: 'fixture' }]);
  });
  it('leaves unsupported and absent models off, retaining the file for tools', async () => {
    for (const model of ['', 'openai/gpt-6.1-sol', 'deepseek/deepseek-v4-flash']) {
      const out = await run(model);
      expect(out.audios).toEqual([]);
      expect(out.files).toHaveLength(1);
    }
  });
  it('keeps the explicit opt-in and the native Google payload unchanged', async () => {
    process.env.KADE_OPENROUTER_AUDIO_INPUT = '1';
    expect((await run('other')).audios).toHaveLength(1);
    expect((await run('google-model', Providers.GOOGLE)).audios).toEqual([{ type: 'media', mimeType: 'audio/wav', data: 'U1lOVEhFVElD' }]);
  });
});
