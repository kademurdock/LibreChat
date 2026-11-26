/**
 * Nov 26 2026 (Part 460): an unknown account and a wrong password look the
 * same from outside. Same status, same body bytes, and about the same wait,
 * because a missing account still runs one bcrypt check (cost 10, like real
 * stored passwords). Run through passport and requireLocalAuth, the way
 * POST /api/auth/login runs them.
 */
const mockFindUser = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('librechat-data-provider', () => ({
  errorsToString: (errors) => errors.map((e) => e.message).join('; '),
}));
jest.mock('@librechat/api', () => ({
  isEnabled: () => true,
  checkEmailConfig: () => false,
  comparePassword: async (user, candidate, { compare }) => compare(candidate, user.password),
}));
jest.mock('~/models', () => ({
  findUser: (...a) => mockFindUser(...a),
  updateUser: jest.fn().mockResolvedValue({}),
}));

const bcrypt = require('bcryptjs');
const passport = require('passport');
const localStrategy = require('./localStrategy');
const requireLocalAuth = require('~/server/middleware/requireLocalAuth');

passport.use('local', localStrategy());

const REAL_HASH = bcrypt.hashSync('the-right-password', 10);

/** One POST /login through passport and requireLocalAuth; resolves with what the caller saw. */
function postLogin(email, password) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const out = { status: 200, body: undefined };
    const finish = () => resolve({ ...out, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    const res = {
      status(code) {
        out.status = code;
        return res;
      },
      send(body) {
        out.body = JSON.stringify(body);
        finish();
        return res;
      },
      json(body) {
        return res.send(body);
      },
    };
    const req = { body: { email, password }, ip: '127.0.0.1', headers: {} };
    requireLocalAuth(req, res, (err) => {
      out.status = err ? 500 : 'next';
      out.user = req.user;
      finish();
    });
  });
}

beforeEach(() => {
  mockFindUser.mockReset();
});

describe('a failed sign-in does not say whether the account exists', () => {
  test('unknown email and wrong password: same status and same body bytes', async () => {
    mockFindUser.mockResolvedValue(null);
    const missing = await postLogin('nobody@example.com', 'the-wrong-password');

    mockFindUser.mockResolvedValue({
      _id: 'u1',
      password: REAL_HASH,
      emailVerified: true,
      createdAt: new Date(),
    });
    const wrong = await postLogin('kade@example.com', 'the-wrong-password');

    expect(missing.status).toBe(404);
    expect(wrong.status).toBe(404);
    expect(missing.body).toBe(wrong.body);
    expect(JSON.parse(missing.body)).toEqual({
      message: 'That email and password do not match an account.',
    });
  });

  test('unknown phone and wrong password: same status and same body bytes', async () => {
    mockFindUser.mockResolvedValue(null);
    const missing = await postLogin('417-555-0100', 'the-wrong-password');

    mockFindUser.mockResolvedValue({
      _id: 'u1',
      password: REAL_HASH,
      emailVerified: true,
      createdAt: new Date(),
    });
    const wrong = await postLogin('417-555-0101', 'the-wrong-password');

    expect(missing.status).toBe(wrong.status);
    expect(missing.body).toBe(wrong.body);
  });

  test('an account with no password answers like any other failure', async () => {
    mockFindUser.mockResolvedValue({ _id: 'u2', emailVerified: true, createdAt: new Date() });
    const noPassword = await postLogin('social@example.com', 'anything-at-all');
    mockFindUser.mockResolvedValue(null);
    const missing = await postLogin('nobody@example.com', 'anything-at-all');
    expect(noPassword.status).toBe(missing.status);
    expect(noPassword.body).toBe(missing.body);
  });

  test('an unknown account still spends a bcrypt check, so it is not the fast answer', async () => {
    await localStrategy.dummyHash();
    const time = async (user) => {
      mockFindUser.mockResolvedValue(user);
      const runs = [];
      for (let i = 0; i < 5; i++) {
        runs.push((await postLogin('someone@example.com', 'the-wrong-password')).ms);
      }
      runs.sort((a, b) => a - b);
      return runs[2];
    };
    const missingMs = await time(null);
    const wrongMs = await time({
      _id: 'u1',
      password: REAL_HASH,
      emailVerified: true,
      createdAt: new Date(),
    });
    // Same cost, so the medians sit close together; before this change the missing one was ~0 ms.
    expect(missingMs).toBeGreaterThan(wrongMs * 0.5);
    expect(missingMs).toBeLessThan(wrongMs * 2);
  });

  test('the right password still signs in', async () => {
    mockFindUser.mockResolvedValue({
      _id: 'u1',
      password: REAL_HASH,
      emailVerified: true,
      createdAt: new Date(),
    });
    const ok = await postLogin('kade@example.com', 'the-right-password');
    expect(ok.status).toBe('next');
    expect(ok.user && ok.user._id).toBe('u1');
  });
});
