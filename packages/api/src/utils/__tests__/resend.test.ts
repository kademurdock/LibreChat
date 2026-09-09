import { sendAccountEmail } from '../resend';

describe('account mail HTTP delivery', () => {
  const original = process.env.RESEND_API_KEY;
  const mail = {
    from: 'App <accounts@example.com>',
    to: 'person@example.net',
    subject: 'Reset',
    html: '<a href="https://example.com/reset?token=PRIVATE">Reset</a>',
    replyTo: 'support@example.com',
  };
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-only';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = original;
  });
  it('requires configuration before making a request', async () => {
    delete process.env.RESEND_API_KEY;
    const f = jest.spyOn(global, 'fetch');
    await expect(sendAccountEmail(mail)).rejects.toThrow('not configured');
    expect(f).not.toHaveBeenCalled();
  });
  it('uses stable deduplication for the same reset token and keeps reply routing', async () => {
    const f = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'accepted' })));
    await expect(sendAccountEmail(mail)).resolves.toEqual({ id: 'accepted' });
    f.mockResolvedValue(new Response(JSON.stringify({ id: 'accepted' })));
    await sendAccountEmail(mail);
    expect(f.mock.calls[0][1]?.headers).toEqual(f.mock.calls[1][1]?.headers);
    expect(JSON.parse(String(f.mock.calls[0][1]?.body)).reply_to).toBe('support@example.com');
  });
  it.each([400, 429, 500])(
    'fails on provider refusal %s without leaking message contents',
    async (status) => {
      const f = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('PRIVATE', { status }));
      await expect(sendAccountEmail(mail)).rejects.toThrow(`(${status})`);
      expect(f).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry an uncertain delivery or expose its cause', async () => {
    const f = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('PRIVATE'));
    await expect(sendAccountEmail(mail)).rejects.toThrow('could not be confirmed');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('requires a provider receipt', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    await expect(sendAccountEmail(mail)).rejects.toThrow('no delivery receipt');
  });
});
