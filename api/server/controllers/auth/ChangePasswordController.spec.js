const bcrypt = require('bcryptjs');

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  comparePassword: jest.fn(async (user, candidate, { compare }) => compare(candidate, user.password)),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
  findSession: jest.fn(),
  deleteAllUserSessions: jest.fn(),
}));
jest.mock('~/server/services/kadeFunding', () => ({ isReviewSeat: jest.fn((u) => !!u && u.id === 'review') }));

const { findUser, updateUser, findSession, deleteAllUserSessions } = require('~/models');
const { changePasswordController } = require('./ChangePasswordController');

function run(body, user = { id: 'u1' }, headers = {}) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return changePasswordController({ user, body, ip: '1.2.3.4', headers }, res).then(() => res);
}

describe('changePasswordController', () => {
  const stored = bcrypt.hashSync('old-password-1', 4);
  beforeEach(() => {
    jest.clearAllMocks();
    findUser.mockResolvedValue({ _id: 'u1', password: stored });
    updateUser.mockResolvedValue({});
    findSession.mockResolvedValue(null);
    deleteAllUserSessions.mockResolvedValue({ deletedCount: 0 });
  });

  it('changes the password when the current one matches', async () => {
    const res = await run({ currentPassword: 'old-password-1', newPassword: 'new-password-2' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(updateUser).toHaveBeenCalledTimes(1);
    const [id, update] = updateUser.mock.calls[0];
    expect(id).toBe('u1');
    expect(bcrypt.compareSync('new-password-2', update.password)).toBe(true);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const res = await run({ currentPassword: 'guess', newPassword: 'new-password-2' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses a short new password before reading the account', async () => {
    const res = await run({ currentPassword: 'old-password-1', newPassword: 'short' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(findUser).not.toHaveBeenCalled();
  });

  it('refuses without a signed-in user', async () => {
    const res = await run({ currentPassword: 'a', newPassword: 'new-password-2' }, null);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('keeps the App Review seat\'s password', async () => {
    const res = await run({ currentPassword: 'old-password-1', newPassword: 'new-password-2' }, { id: 'review' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(findUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('says so when the account has no password', async () => {
    findUser.mockResolvedValue({ _id: 'u1' });
    const res = await run({ currentPassword: 'old-password-1', newPassword: 'new-password-2' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateUser).not.toHaveBeenCalled();
  });
  /* Nov 26 2026 (Part 460): a changed password ends every other sign-in. */
  describe('sessions after a change', () => {
    const body = { currentPassword: 'old-password-1', newPassword: 'new-password-2' };

    it('ends every other session and keeps the one making the change', async () => {
      findSession.mockResolvedValue({ _id: 'session-here' });
      deleteAllUserSessions.mockResolvedValue({ deletedCount: 3 });
      const res = await run(body, { id: 'u1' }, { cookie: 'refreshToken=this-device; token_provider=librechat' });
      expect(findSession).toHaveBeenCalledWith({ userId: 'u1', refreshToken: 'this-device' });
      expect(deleteAllUserSessions).toHaveBeenCalledWith(
        { userId: 'u1' },
        { excludeCurrentSession: true, currentSessionId: 'session-here' },
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, message: 'Password changed.', signedOut: 3 });
    });

    it('with no refresh cookie, every session ends', async () => {
      await run(body);
      expect(findSession).not.toHaveBeenCalled();
      expect(deleteAllUserSessions).toHaveBeenCalledWith({ userId: 'u1' }, {});
    });

    it('a cookie that matches no session ends every session', async () => {
      findSession.mockResolvedValue(null);
      await run(body, { id: 'u1' }, { cookie: 'refreshToken=stale' });
      expect(deleteAllUserSessions).toHaveBeenCalledWith({ userId: 'u1' }, {});
    });

    it('if the sessions cannot be ended, the change still stands and says so in the log only', async () => {
      deleteAllUserSessions.mockRejectedValue(new Error('db down'));
      const res = await run(body);
      expect(updateUser).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, message: 'Password changed.', signedOut: null });
    });

    it('a refused change ends nothing', async () => {
      await run({ currentPassword: 'guess', newPassword: 'new-password-2' });
      expect(deleteAllUserSessions).not.toHaveBeenCalled();
    });
  });
});
