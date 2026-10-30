/**
 * Oct 29 2026: the fork side of the welcome call. It asks the bridge, never
 * throws, says why when it cannot, and turns Twilio's answer into a plain
 * sentence for Kade's page.
 */
const {
  placeWelcomeCall,
  checkWelcomeCall,
  welcomeCallOutcome,
  callResult,
  isSettled,
  describeOutcome,
} = require('./kadeWelcomeCall');

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
  global.fetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
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
    json: async () => ({ status: 'completed', duration: 81, answeredBy: 'human', played: 'full' }),
  });
  const sid = 'CA' + 'b'.repeat(32);
  expect(await welcomeCallOutcome(sid)).toEqual({
    status: 'completed',
    duration: 81,
    answeredBy: 'human',
    played: 'full',
  });
  expect(global.fetch.mock.calls[0][0]).toBe(`https://bridge.example.test/account-welcome-call/${sid}`);
});

test('the outcome in plain words', () => {
  expect(describeOutcome({ status: 'completed', duration: 81, answeredBy: 'human' })).toMatch(
    /answered and the call ran 81 seconds/,
  );
  expect(describeOutcome({ status: 'completed', duration: 95, answeredBy: 'machine_end_beep' })).toMatch(
    /voicemail.*no password/,
  );
  expect(
    describeOutcome({ status: 'completed', duration: 95, answeredBy: 'machine_end_beep', played: 'full' }),
  ).toMatch(/password included/);
  expect(describeOutcome({ status: 'completed', duration: 40, answeredBy: 'human', played: 'lost' })).toMatch(
    /restarted/,
  );
  expect(describeOutcome({ status: 'completed', duration: 6, answeredBy: null })).toMatch(
    /before the password/,
  );
  expect(describeOutcome({ status: 'no-answer', duration: 0 })).toMatch(/Nobody answered/);
  expect(describeOutcome({ status: 'busy', duration: 0 })).toMatch(/busy/);
  expect(describeOutcome(null)).toBe('');
});

test('the dry run asks the bridge to check without calling, and believes only a bridge that says so', async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, dryRun: true }) });
  expect(await checkWelcomeCall({ phone: '417-770-4722', name: 'David', password: PW })).toEqual({
    status: 'ready',
  });
  const [, init] = global.fetch.mock.calls[0];
  expect(JSON.parse(init.body)).toEqual({ to: '+14177704722', name: 'David', password: PW, dryRun: true });
  /* an old bridge would ignore dryRun and really call: never treated as ready */
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, sid: 'CA1' }) });
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).status).toBe('failed');
});

test("the bridge's reasons come through in plain words", async () => {
  const refuse = (status, reason) =>
    global.fetch.mockResolvedValueOnce({ ok: false, status, json: async () => ({ reason }) });
  refuse(429, 'gap');
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(/last minute or two/);
  refuse(429, 'number-day');
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(/3 calls today/);
  refuse(429, 'platform-day');
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(/all the calls/);
  refuse(503, 'not-configured');
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(/not set up/);
  global.fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => { throw new Error('html'); } });
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).reason).toMatch(/not been updated/);
  process.env.KADE_WELCOME_CALL = '0';
  expect((await checkWelcomeCall({ phone: '4177704722', password: PW })).status).toBe('off');
});

test('only a person on the line for 20 seconds, or "already signed in", settles a call', () => {
  expect(callResult({ status: 'completed', duration: 20, answeredBy: 'human', played: 'full' })).toBe('answered');
  expect(callResult({ status: 'completed', duration: 19, answeredBy: 'human' })).toBe('short');
  expect(callResult({ status: 'completed', duration: 60, answeredBy: 'machine_end_beep', played: null })).toBe('voicemail');
  expect(callResult({ status: 'completed', duration: 60, answeredBy: 'unknown', played: 'voicemail' })).toBe('voicemail');
  expect(callResult({ status: 'ringing', duration: 0 })).toBe('going');
  expect(callResult(null)).toBe('');
  expect(isSettled({ welcomeCallStatus: 'placed', welcomeCallResult: 'answered' })).toBe(true);
  expect(isSettled({ welcomeCallStatus: 'not-needed', welcomeCallResult: '' })).toBe(true);
  for (const r of ['voicemail', 'voicemail-full', 'short', 'no-answer', 'busy', 'failed', 'lost', 'going', '']) {
    expect(isSettled({ welcomeCallStatus: 'placed', welcomeCallResult: r })).toBe(false);
  }
  expect(isSettled({ welcomeCallStatus: 'failed', welcomeCallResult: '' })).toBe(false);
  expect(isSettled({ welcomeCallStatus: 'off', welcomeCallResult: '' })).toBe(false);
  expect(isSettled({ welcomeCallStatus: '', welcomeCallResult: '' })).toBe(false);
});
