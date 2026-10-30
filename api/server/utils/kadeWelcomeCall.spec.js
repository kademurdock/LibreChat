/**
 * Oct 29 2026: the fork side of the welcome call. It asks the bridge, never
 * throws, says why when it cannot, and turns Twilio's answer into a plain
 * sentence for Kade's page.
 */
const { placeWelcomeCall, welcomeCallOutcome, describeOutcome } = require('./kadeWelcomeCall');

const PW = 'amber-cedar-otter-482';
const saved = { ...process.env };

beforeEach(() => {
  process.env.BRIDGE_SECRET = 'bridge-test';
  process.env.BRIDGE_URL = 'https://bridge.example.test/';
  delete process.env.KADE_WELCOME_CALL;
  global.fetch = jest.fn();
});
afterAll(() => {
  process.env = saved;
});

test('asks the bridge with the secret in a header, a +1 number and the password', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, sid: 'CA9' }) });
  const out = await placeWelcomeCall({ phone: '417-770-4722', name: 'David', password: PW });
  expect(out).toEqual({ status: 'placed', sid: 'CA9' });
  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe('https://bridge.example.test/account-welcome-call');
  expect(init.headers['x-bridge-secret']).toBe('bridge-test');
  expect(JSON.parse(init.body)).toEqual({ to: '+14177704722', name: 'David', password: PW });
  /* the secret never rides in the URL or body */
  expect(url).not.toContain('bridge-test');
  expect(init.body).not.toContain('bridge-test');
});

test('never throws: an unreachable bridge, an old bridge, a busy number', async () => {
  global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  expect(await placeWelcomeCall({ phone: '4177704722', password: PW })).toEqual({
    status: 'failed',
    reason: 'the phone line could not be reached',
  });
  global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
  expect((await placeWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(
    /not been updated/,
  );
  global.fetch.mockResolvedValueOnce({ ok: false, status: 429 });
  expect((await placeWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(
    /called very recently/,
  );
});

test('no secret or no number: no call is attempted', async () => {
  delete process.env.BRIDGE_SECRET;
  expect((await placeWelcomeCall({ phone: '4177704722', password: PW })).status).toBe('failed');
  process.env.BRIDGE_SECRET = 'bridge-test';
  expect((await placeWelcomeCall({ phone: 'none', password: PW })).status).toBe('failed');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('KADE_WELCOME_CALL=0 switches calls off', async () => {
  process.env.KADE_WELCOME_CALL = '0';
  expect((await placeWelcomeCall({ phone: '4177704722', password: PW })).status).toBe('off');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('outcome lookups only go out for a real call id', async () => {
  expect(await welcomeCallOutcome('../../admin')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'completed', duration: 81, answeredBy: 'human' }),
  });
  const sid = 'CA' + 'b'.repeat(32);
  expect(await welcomeCallOutcome(sid)).toEqual({
    status: 'completed',
    duration: 81,
    answeredBy: 'human',
  });
  expect(global.fetch.mock.calls[0][0]).toBe(`https://bridge.example.test/account-welcome-call/${sid}`);
});

test('the outcome in plain words', () => {
  expect(describeOutcome({ status: 'completed', duration: 81, answeredBy: 'human' })).toMatch(
    /answered and the call ran 81 seconds/,
  );
  expect(describeOutcome({ status: 'completed', duration: 95, answeredBy: 'machine_end_beep' })).toMatch(
    /voicemail/,
  );
  expect(describeOutcome({ status: 'completed', duration: 6, answeredBy: null })).toMatch(
    /before the password/,
  );
  expect(describeOutcome({ status: 'no-answer', duration: 0 })).toMatch(/Nobody answered/);
  expect(describeOutcome({ status: 'busy', duration: 0 })).toMatch(/busy/);
  expect(describeOutcome(null)).toBe('');
});
