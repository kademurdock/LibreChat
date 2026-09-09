/**
 * SETTING SOMEBODY'S PASSWORD (Part 143, Sep 8 2026).
 *
 * Kade asked to set her sister's password and there was no way to do it:
 * ALLOW_PASSWORD_RESET is off here, so the ordinary reset route answers
 * "Password reset is not allowed", while the front door's own welcome message
 * promises "tell me and I'll reset it for you". These hold that promise, and
 * hold the floor that made the whole thing worth catching: MIN_PASSWORD_LENGTH
 * gates the LOGIN box, so a short password stores fine and then locks the
 * person out of their own account.
 */
const express = require('express');
const request = require('supertest');

const mockFindUser = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue({});
const mockDeleteAllUserSessions = jest.fn().mockResolvedValue({ deletedCount: 1 });

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin', READ_USERS: 'read:users' },
}));
jest.mock('@librechat/api', () => ({
  createAdminUsersHandlers: () => ({ listUsers: jest.fn(), searchUsers: jest.fn() }),
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
  deleteAllUserSessions: (...a) => mockDeleteAllUserSessions(...a),
  findUsers: jest.fn(),
  countUsers: jest.fn(),
  deleteUserById: jest.fn(),
  deleteConfig: jest.fn(),
  deleteAclEntries: jest.fn(),
}));

const router = require('./users');
const app = express();
app.use(express.json());
app.use('/api/admin/users', router);

const setPassword = (body) => request(app).post('/api/admin/users/set-password').send(body);
const destiny = {
  _id: 'u-destiny',
  name: 'Destiny',
  email: 'destinymurdock8@gmail.com',
  kadePhone: '4177719958',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateUser.mockResolvedValue({});
  mockDeleteAllUserSessions.mockResolvedValue({ deletedCount: 1 });
});

test('sets a password by email, and never says it back', async () => {
  mockFindUser.mockResolvedValue(destiny);

  const res = await setPassword({ identifier: 'destinymurdock8@gmail.com', password: 'Des12345' });

  expect(res.status).toBe(200);
  expect(mockFindUser).toHaveBeenCalledWith(
    { email: 'destinymurdock8@gmail.com' },
    'email _id name kadePhone',
  );
  const [id, update] = mockUpdateUser.mock.calls[0];
  expect(id).toBe('u-destiny');
  expect(update.password).toEqual(expect.any(String));
  expect(update.password).not.toBe('Des12345'); // hashed, not stored raw
  expect(JSON.stringify(res.body)).not.toContain('Des12345');
  expect(res.body.signsInWith).toEqual(['destinymurdock8@gmail.com', '4177719958']);
});

test('finds them by phone number too', async () => {
  mockFindUser.mockResolvedValue(destiny);

  await setPassword({ identifier: '417-771-9958', password: 'Des12345' });

  expect(mockFindUser).toHaveBeenCalledWith({ kadePhone: '4177719958' }, 'email _id name kadePhone');
});

test('a changed password ends their old sessions', async () => {
  mockFindUser.mockResolvedValue(destiny);

  await setPassword({ identifier: 'destinymurdock8@gmail.com', password: 'Des12345' });

  expect(mockDeleteAllUserSessions).toHaveBeenCalledWith({ userId: 'u-destiny' });
});

test('a password the login box would refuse is refused HERE, with the reason', async () => {
  mockFindUser.mockResolvedValue(destiny);

  const res = await setPassword({ identifier: 'destinymurdock8@gmail.com', password: 'Des123' });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/lock them out/i);
  expect(mockUpdateUser).not.toHaveBeenCalled();
});

test('nobody by that name is a 404, not a silent no-op', async () => {
  mockFindUser.mockResolvedValue(null);

  const res = await setPassword({ identifier: 'nobody@example.com', password: 'Des12345' });

  expect(res.status).toBe(404);
  expect(mockUpdateUser).not.toHaveBeenCalled();
});

test('asking without saying who is a 400', async () => {
  const res = await setPassword({ password: 'Des12345' });

  expect(res.status).toBe(400);
  expect(mockFindUser).not.toHaveBeenCalled();
});
