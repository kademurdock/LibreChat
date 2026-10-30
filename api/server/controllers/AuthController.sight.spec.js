/**
 * Oct 29 2026: the signup-code form asks "Will you be looking at the screen,
 * or listening?" Only a brand-new account takes the answer; an existing
 * account is never touched, "I'd rather not say" stores nothing, and a
 * failure to save it never fails the signup.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));
jest.mock('~/server/services/AuthService', () => ({
  requestPasswordReset: jest.fn(),
  setOpenIDAuthTokens: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));
jest.mock('~/strategies', () => ({ getOpenIdConfig: jest.fn(), getOpenIdEmail: jest.fn() }));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('~/models', () => ({
  deleteAllUserSessions: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn().mockResolvedValue(null),
}));
jest.mock('@librechat/api', () => ({
  math: jest.fn((value, fallback) => fallback),
  isEnabled: jest.fn(),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(),
  buildOpenIDRefreshParams: jest.fn(() => ({})),
}));
const mockSetSight = jest.fn().mockResolvedValue({ sight: 'nonvisual', liveFaces: true });
jest.mock('~/models/kadeSight', () => ({
  ...jest.requireActual('~/models/kadeSight'),
  setSight: (...a) => mockSetSight(...a),
}));

const { registerUser } = require('~/server/services/AuthService');
const { registrationController } = require('./AuthController');

function fakeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const body = (extra) => ({
  name: 'David',
  email: 'david@example.com',
  password: 'longenough1',
  confirm_password: 'longenough1',
  passcode: '1336',
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.KADE_REG_CODE_ADULT = '1336';
  process.env.KADE_REG_CODE_CHILD = '7777';
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

test('a new account takes the answer, marked as coming from signup', async () => {
  registerUser.mockResolvedValue({ status: 200, message: 'ok', createdUserId: 'u-new' });
  const res = fakeRes();
  await registrationController({ body: body({ sight: 'nonvisual' }) }, res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(mockSetSight).toHaveBeenCalledWith('u-new', { sight: 'nonvisual' }, 'signup');
});

test('"I\'d rather not say" and an unknown answer store nothing', async () => {
  registerUser.mockResolvedValue({ status: 200, message: 'ok', createdUserId: 'u-new' });
  await registrationController({ body: body({ sight: 'unsaid' }) }, fakeRes());
  await registrationController({ body: body({ sight: 'x-ray vision' }) }, fakeRes());
  await registrationController({ body: body() }, fakeRes());
  expect(mockSetSight).not.toHaveBeenCalled();
});

test('an email that already has an account is never touched', async () => {
  /* registerUser answers 200 without a createdUserId when the email exists */
  registerUser.mockResolvedValue({ status: 200, message: 'ok' });
  await registrationController({ body: body({ sight: 'sighted' }) }, fakeRes());
  expect(mockSetSight).not.toHaveBeenCalled();
});

test('a failure saving it never fails the signup', async () => {
  registerUser.mockResolvedValue({ status: 200, message: 'ok', createdUserId: 'u-new' });
  mockSetSight.mockRejectedValueOnce(new Error('database away'));
  const res = fakeRes();
  await registrationController({ body: body({ sight: 'sighted' }) }, res);
  expect(res.status).toHaveBeenCalledWith(200);
});
