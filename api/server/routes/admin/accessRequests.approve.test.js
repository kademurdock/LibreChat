/**
 * APPROVE MAKES THE ACCOUNT (Part 143, Sep 8 2026).
 *
 * Kade's report, after her sister Destiny knocked: approving handed back a
 * message telling Destiny to go register with code 1336 — "I could have given
 * her that code without her messing with the door." These tests hold the door
 * to the new contract: approve mints the account, or says exactly why it
 * could not, and never silently hands out a signup code instead.
 */
const express = require('express');
const request = require('supertest');

const mockFindUser = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue({});
const mockRegisterUser = jest.fn().mockResolvedValue({ status: 200, message: 'ok' });
const mockFindById = jest.fn();
const mockFindByIdAndUpdate = jest.fn().mockResolvedValue({});
const mockFind = jest.fn();
const mockSendEmail = jest.fn().mockResolvedValue({ id: 'mail-1' });
const mockClaim = jest.fn().mockResolvedValue({});
jest.mock(
  '~/server/utils/sendEmail',
  () =>
    (...args) =>
      mockSendEmail(...args),
);

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin' },
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (req, res, next) => next(),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'admin-1' };
    next();
  },
}));
jest.mock('~/models', () => ({
  findUser: (...a) => mockFindUser(...a),
  updateUser: (...a) => mockUpdateUser(...a),
}));
jest.mock('~/server/services/AuthService', () => ({
  registerUser: (...a) => mockRegisterUser(...a),
}));
jest.mock('~/models/kadeAccessRequest', () => ({
  KadeAccessRequest: {
    findById: (...a) => mockFindById(...a),
    findByIdAndUpdate: (...a) => mockFindByIdAndUpdate(...a),
    find: (...a) => mockFind(...a),
    findOneAndUpdate: (...a) => mockClaim(...a),
  },
}));

const router = require('./accessRequests');

const app = express();
app.use(express.json());
app.use('/api/admin/access-requests', router);

const REQUEST_ID = '64b7f0000000000000000001';
const doorRequest = (contact) => ({
  _id: REQUEST_ID,
  name: 'Destiny',
  contact,
  whoYouAre: "Kade's sister",
  whyHere: 'she told me to knock',
});
/** The model call chains .lean() on findById. */
const leanReturning = (doc) => ({ lean: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUser.mockResolvedValue(null);
  mockUpdateUser.mockResolvedValue({});
  mockRegisterUser.mockResolvedValue({ status: 200, message: 'ok' });
  mockFindByIdAndUpdate.mockResolvedValue({});
  mockClaim.mockResolvedValue({});
  mockSendEmail.mockResolvedValue({ id: 'mail-1' });
  process.env.RESEND_API_KEY = 'test-only-key';
  process.env.EMAIL_FROM = 'accounts@example.com';
  process.env.DOMAIN_CLIENT = 'https://kademurdock.com';
  process.env.KADE_REG_CODE_ADULT = '1336';
  process.env.KADE_REG_CODE_CHILD = '7777';
});

const approve = (body = {}) =>
  request(app).post(`/api/admin/access-requests/${REQUEST_ID}/approve`).send(body);

describe('approving makes the account', () => {
  test('an email in their contact line is all it takes', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('destiny@example.com')));
    /* nobody by that email before the register call, somebody after it */
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'new-user-1' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-1' });

    const res = await approve({ audience: 'adult' });

    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(true);
    expect(res.body.email).toBe('destiny@example.com');
    expect(mockRegisterUser).toHaveBeenCalledTimes(1);
    const [userArg, extraArg] = mockRegisterUser.mock.calls[0];
    expect(userArg.email).toBe('destiny@example.com');
    expect(userArg.name).toBe('Destiny');
    expect(userArg.password).toBe(userArg.confirm_password);
    expect(extraArg).toEqual({ kadeAccountType: 'adult', emailVerified: true });
    /* her approval is the verification */
    expect(mockUpdateUser).toHaveBeenCalledWith('new-user-1', { emailVerified: true });
    /* and what it made is on the record */
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'approved',
          accountEmail: 'destiny@example.com',
          createdUserId: 'new-user-1',
        }),
      }),
    );
  });

  test('the message carries the sign-in, never a signup code', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('destiny@example.com')));
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'new-user-1' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-1' });

    const { body } = await approve({ audience: 'adult' });

    expect(body.readyMessage).toContain('destiny@example.com');
    expect(body.readyMessage).toContain(body.tempPassword);
    expect(body.readyMessage).toMatch(/account is already made/i);
    expect(body.readyMessage).not.toContain('1336');
    expect(body.readyMessage).not.toMatch(/\/register/);
  });

  test('the temporary password is sayable out loud and long enough to be real', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('destiny@example.com')));
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'new-user-1' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-1' });

    const { body } = await approve({ audience: 'adult' });

    expect(body.tempPassword).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{3}$/);
    expect(body.tempPassword.length).toBeGreaterThanOrEqual(8);
  });

  test('a kid is tagged a kid, the same way the child signup code tags one', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('kid@example.com')));
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'new-user-2' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-2' });

    await approve({ audience: 'child' });

    expect(mockRegisterUser.mock.calls[0][1]).toEqual({
      kadeAccountType: 'child',
      emailVerified: true,
    });
  });

  test('an email typed on the page beats whatever the door collected', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('417-555-0134')));
    /* nobody under that address, nobody under that phone, then the new row */
    mockFindUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'new-user-3' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-3' });

    const res = await approve({ audience: 'adult', email: '  Destiny@Example.COM ' });

    expect(res.body.accountCreated).toBe(true);
    expect(res.body.email).toBe('destiny@example.com');
    expect(mockRegisterUser.mock.calls[0][0].email).toBe('destiny@example.com');
  });
});

/**
 * Part 143, second half. Kade: "you should make it accept a phone as login
 * too. Not everyone has both, one, or the other. It's not like we are texting
 * or emailing them." Destiny's own request carried a phone number and nothing
 * else, which is the case that has to work.
 */
describe('a phone number is enough on its own', () => {
  test('a phone-only request still becomes a real account', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('4177719958')));
    mockFindUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'new-user-5' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-5' });

    const res = await approve({ audience: 'adult' });

    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(true);
    expect(res.body.usesPhoneLogin).toBe(true);
    expect(res.body.loginId).toBe('417-771-9958');
    /* filed under a name that can never receive mail, and says so */
    expect(mockRegisterUser.mock.calls[0][0].email).toBe('p4177719958@phone.kade-ai.invalid');
    /* and the phone is what they type into the login box */
    expect(mockRegisterUser.mock.calls[0][1]).toEqual({
      kadeAccountType: 'adult',
      kadePhone: '4177719958',
      emailVerified: true,
    });
  });

  test('the message tells them to sign in with the number, not the placeholder', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('(417) 771-9958')));
    mockFindUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'new-user-6' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-6' });

    const { body } = await approve({ audience: 'adult' });

    expect(body.readyMessage).toContain('417-771-9958');
    expect(body.readyMessage).not.toContain('invalid');
    expect(body.readyMessage).not.toContain('1336');
  });

  test('someone with both signs in with either', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('destiny@example.com / 417-771-9958')));
    mockFindUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'new-user-7' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-7' });

    const { body } = await approve({ audience: 'adult' });

    expect(body.email).toBe('destiny@example.com');
    expect(body.phone).toBe('4177719958');
    expect(body.usesPhoneLogin).toBe(false);
    expect(body.readyMessage).toContain('destiny@example.com');
    expect(body.readyMessage).toContain('417-771-9958');
    expect(mockRegisterUser.mock.calls[0][1]).toEqual({
      kadeAccountType: 'adult',
      kadePhone: '4177719958',
      emailVerified: true,
    });
  });

  test('a phone typed on the page is used when the request had nothing', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('ask my brother')));
    mockFindUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'new-user-8' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-8' });

    const res = await approve({ audience: 'adult', phone: '(417) 771 9958' });

    expect(res.body.accountCreated).toBe(true);
    expect(res.body.loginId).toBe('417-771-9958');
  });

  test('a phone already signing somebody else in is not handed out twice', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('4177719958')));
    mockFindUser
      .mockResolvedValueOnce(null) // nobody under the placeholder address
      .mockResolvedValueOnce({
        _id: 'existing-2',
        email: 'someone@else.com',
        kadePhone: '4177719958',
      });

    const res = await approve({ audience: 'adult' });

    expect(res.body.alreadyHadAccount).toBe(true);
    expect(mockRegisterUser).not.toHaveBeenCalled();
    expect(res.body.readyMessage).toContain('417-771-9958');
  });
});

describe('when it cannot make one', () => {
  test('neither an email nor a phone approves, says why, and carries the code as the fallback', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('find me on facebook')));

    const res = await approve({ audience: 'adult' });

    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(false);
    expect(res.body.needsEmail).toBe(true);
    expect(mockRegisterUser).not.toHaveBeenCalled();
    /* the phone front desk shows this text and nothing else — it has to
       explain itself there, and leave her a way through either way */
    expect(res.body.readyMessage).toMatch(/could not make the account/i);
    expect(res.body.readyMessage).toContain('/access-requests');
    expect(res.body.readyMessage).toContain('1336');
  });

  test('a typed email that is not an email is refused, not quietly replaced', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('4177719958')));

    const res = await approve({ audience: 'adult', email: 'destiny at example dot com' });

    expect(res.status).toBe(400);
    expect(res.body.needsEmail).toBe(true);
    expect(mockRegisterUser).not.toHaveBeenCalled();
  });

  test('somebody who already has an account is told to sign in, not signed up twice', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('destiny@example.com')));
    mockFindUser.mockResolvedValue({ _id: 'existing-1', email: 'destiny@example.com' });

    const res = await approve({ audience: 'adult' });

    expect(res.body.alreadyHadAccount).toBe(true);
    expect(res.body.accountCreated).toBe(false);
    expect(mockRegisterUser).not.toHaveBeenCalled();
    expect(res.body.readyMessage).toMatch(/already have an account/i);
    expect(res.body.readyMessage).not.toContain('1336');
  });

  test('a registration that fails leaves the request waiting so she can retry', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('destiny@example.com')));
    mockRegisterUser.mockResolvedValue({ status: 403, message: 'That email cannot be used.' });
    mockFindUser.mockResolvedValue(null); // before AND after: nothing was made

    const res = await approve({ audience: 'adult' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('That email cannot be used.');
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled(); // still pending
  });

  test('a request that is not there is a 404, not a half-made account', async () => {
    mockFindById.mockReturnValue(leanReturning(null));

    const res = await approve({ audience: 'adult' });

    expect(res.status).toBe(404);
    expect(mockRegisterUser).not.toHaveBeenCalled();
  });
});

describe('re-approving one she already approved', () => {
  test('makes the account the first approval never made', async () => {
    mockFindById.mockReturnValue(
      leanReturning({
        ...doorRequest('destiny@example.com'),
        status: 'approved',
        audience: 'adult',
      }),
    );
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'new-user-4' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'new-user-4' });

    const res = await approve({ audience: 'adult' });

    expect(res.body.accountCreated).toBe(true);
    expect(mockRegisterUser).toHaveBeenCalledTimes(1);
  });
});

describe('approval email', () => {
  function created() {
    mockFindById.mockReturnValue(leanReturning(doorRequest('joiner@example.com')));
    mockFindUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'created' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'created' });
  }
  test('sends the actual new credentials after saving approval', async () => {
    created();
    const { body } = await approve();
    expect(body.emailStatus).toBe('accepted');
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'joiner@example.com',
        payload: expect.objectContaining({
          password: body.tempPassword,
          loginId: 'joiner@example.com',
        }),
      }),
    );
    expect(mockFindByIdAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendEmail.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(mockFindByIdAndUpdate.mock.calls)).not.toContain(body.tempPassword);
  });
  test('mail failure keeps the account and its manual sign-in message', async () => {
    created();
    mockSendEmail.mockRejectedValue(new Error('network outcome unknown'));
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(true);
    expect(res.body.emailStatus).toBe('unconfirmed');
    expect(res.body.readyMessage).toContain(res.body.tempPassword);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
  test('mail claim database failure retains the account and manual password', async () => {
    created();
    mockClaim.mockRejectedValue(new Error('database unavailable'));
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(true);
    expect(res.body.emailStatus).toBe('unavailable');
    expect(res.body.readyMessage).toContain(res.body.tempPassword);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
  test('a repeated approval cannot send twice or reset the existing password', async () => {
    mockFindById.mockReturnValue(
      leanReturning({ ...doorRequest('joiner@example.com'), emailStatus: 'accepted' }),
    );
    mockFindUser.mockResolvedValue({ _id: 'existing', email: 'joiner@example.com' });
    mockClaim.mockResolvedValue(null);
    const { body } = await approve();
    expect(body.emailStatus).toBe('accepted');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRegisterUser).not.toHaveBeenCalled();
    expect(body.tempPassword).toBeUndefined();
  });
  test('an existing account receives sign-in help without a made-up password', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('joiner@example.com')));
    mockFindUser.mockResolvedValue({
      _id: 'existing',
      email: 'actual@example.com',
      kadePhone: '4175550101',
    });
    const { body } = await approve();
    expect(body.emailStatus).toBe('accepted');
    expect(mockSendEmail.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: 'actual@example.com',
        payload: expect.objectContaining({ password: '', loginId: '417-555-0101' }),
      }),
    );
  });
  test('registration returning an existing account cannot send an invented password', async () => {
    created();
    mockRegisterUser.mockResolvedValue({ status: 200, message: 'Already exists' });
    const res = await approve();
    expect(res.status).toBe(500);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
  test('phone-only accounts never attempt to email the placeholder', async () => {
    mockFindById.mockReturnValue(leanReturning(doorRequest('4175550101')));
    mockFindUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'created' });
    mockRegisterUser.mockResolvedValue({ status: 200, createdUserId: 'created' });
    const { body } = await approve();
    expect(body.emailStatus).toBe('phone-only');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
