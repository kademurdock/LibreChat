const bcrypt = require('bcryptjs');

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  comparePassword: jest.fn(async (user, candidate, { compare }) => compare(candidate, user.password)),
}));
jest.mock('~/models', () => ({ findUser: jest.fn(), updateUser: jest.fn() }));
jest.mock('~/server/services/kadeFunding', () => ({ isReviewSeat: jest.fn((u) => !!u && u.id === 'review') }));

const { findUser, updateUser } = require('~/models');
const { changePasswordController } = require('./ChangePasswordController');

function run(body, user = { id: 'u1' }) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return changePasswordController({ user, body, ip: '1.2.3.4' }, res).then(() => res);
}

describe('changePasswordController', () => {
  const stored = bcrypt.hashSync('old-password-1', 4);
  beforeEach(() => {
    jest.clearAllMocks();
    findUser.mockResolvedValue({ _id: 'u1', password: stored });
    updateUser.mockResolvedValue({});
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
});
