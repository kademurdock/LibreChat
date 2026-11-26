/* Nov 26 2026 (Part 460): a password reset through an emailed link ends every
 * session of that account, and a failure to end them does not turn a saved
 * new password into a "failed" answer. */
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
  findUser: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  math: jest.fn((value, fallback) => fallback),
  isEnabled: jest.fn(),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(),
  buildOpenIDRefreshParams: jest.fn(() => ({})),
}));

const { resetPasswordController } = require('./AuthController');
const { resetPassword } = require('~/server/services/AuthService');
const { deleteAllUserSessions } = require('~/models');

function run(body) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return resetPasswordController({ body }, res).then(() => res);
}

const BODY = { userId: '6a3cba4d0b0afa92194e42aa', token: 'tok', password: 'new-password-2' };

beforeEach(() => jest.clearAllMocks());

test('a successful reset ends every session of that account', async () => {
  resetPassword.mockResolvedValue({ message: 'Password reset was successful' });
  deleteAllUserSessions.mockResolvedValue({ deletedCount: 4 });
  const res = await run(BODY);
  expect(deleteAllUserSessions).toHaveBeenCalledWith({ userId: BODY.userId });
  expect(res.status).toHaveBeenCalledWith(200);
});

test('a refused reset ends nothing', async () => {
  resetPassword.mockResolvedValue(new Error('Invalid or expired password reset token'));
  const res = await run(BODY);
  expect(deleteAllUserSessions).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(400);
});

test('if the sessions cannot be ended, the saved reset still answers 200', async () => {
  resetPassword.mockResolvedValue({ message: 'Password reset was successful' });
  deleteAllUserSessions.mockRejectedValue(new Error('db down'));
  const res = await run(BODY);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ message: 'Password reset was successful' });
});
