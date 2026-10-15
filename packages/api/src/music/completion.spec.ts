import { Readable } from 'node:stream';
import { readWritingCompletion } from './completion';

const event = (value: object): string => `data: ${JSON.stringify(value)}\r\n\r\n`;
const stop = event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n';

describe('lyric writer stream collection', () => {
  it('keeps heartbeat traffic alive, joins split UTF-8 and CRLF, omits reasoning, and preserves usage', async () => {
    const bytes = Buffer.from(
      ': keep-alive\r\n\r\n' +
        event({ choices: [{ delta: { reasoning: 'private thought' } }] }) +
        event({ choices: [{ delta: { content: 'A café\n' } }] }) +
        event({ choices: [{ delta: { content: 'The chorus' } }] }) +
        event({ usage: { cost: 0.02, prompt_tokens: 50, completion_tokens: 20 } }) +
        stop,
    );
    const stream = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
    const reply = await readWritingCompletion(stream);
    expect(reply.choices?.[0].message?.content).toBe('A café\nThe chorus');
    expect(reply.choices?.[0].finish_reason).toBe('stop');
    expect(reply.usage?.cost).toBe(0.02);
  });
  it.each([
    event({ choices: [{ delta: { content: 'Half a song' } }] }),
    event({ choices: [{ delta: { content: 'Half a song' }, finish_reason: 'error' }] }) +
      'data: [DONE]\n\n',
    event({ error: { message: 'provider error' } }),
  ])(
    'rejects incomplete or failed responses without accepting or retrying partial lyrics',
    async (body) => {
      await expect(readWritingCompletion(Readable.from([body]))).rejects.toThrow(/lyric writer/);
    },
  );
  it('retains length and refusal metadata for the existing output/refusal gates', async () => {
    const reply = await readWritingCompletion(
      Readable.from([
        event({ choices: [{ delta: { refusal: 'No' }, finish_reason: 'length' }] }) +
          'data: [DONE]\n\n',
      ]),
    );
    expect(reply.choices?.[0]).toEqual({
      message: { content: '', refusal: 'No' },
      finish_reason: 'length',
    });
  });
  it('accepts a complete gateway JSON fallback', async () => {
    const reply = { choices: [{ message: { content: 'A whole song' }, finish_reason: 'stop' }] };
    expect(await readWritingCompletion(Readable.from([JSON.stringify(reply)]))).toEqual(reply);
  });
});
