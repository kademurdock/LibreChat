/**
 * SIGNING IN WITH A PHONE NUMBER (Part 143, Sep 8 2026).
 *
 * Kade: "you should make it accept a phone as login too. Not everyone has
 * both, one, or the other. It's not like we are texting or emailing them."
 * The login box stays one field called `email` all the way down to passport;
 * what widened is what may be typed into it.
 */
const mockFindUser = jest.fn();
const mockUpdateUser = jest.fn().mockResolvedValue({});
const mockComparePassword = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('librechat-data-provider', () => ({
  errorsToString: (errors) => errors.map((e) => e.message).join('; '),
}));
jest.mock('@librechat/api', () => ({
  isEnabled: () => true,
  checkEmailConfig: () => false,
  comparePassword: (...a) => mockComparePassword(...a),
}));
jest.mock('~/models', () => ({
  findUser: (...a) => mockFindUser(...a),
  updateUser: (...a) => mockUpdateUser(...a),
}));

const { classifyLoginId } = require('~/server/utils/kadeLoginId');
const { loginSchema } = require('./validators');
const localStrategy = require('./localStrategy');

/** Drive the passport verify callback the way passport-local would. */
function login(identifier, password = 'a-real-password') {
  const strategy = localStrategy();
  const verify = strategy._verify;
  const req = { body: { email: identifier, password }, ip: '127.0.0.1' };
  return new Promise((resolve) => {
    verify(req, identifier, password, (err, user, info) => resolve({ err, user, info }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockComparePassword.mockResolvedValue(true);
});

describe('what may be typed into the login box', () => {
  test('an email address, still', () => {
    expect(classifyLoginId('destiny@example.com')).toEqual({
      kind: 'email',
      email: 'destiny@example.com',
    });
    expect(loginSchema.safeParse({ email: 'destiny@example.com', password: 'password1' }).success).toBe(true);
  });

  test('a phone number, however they punctuate it', () => {
    for (const typed of ['4177719958', '417-771-9958', '(417) 771 9958', '1 417 771 9958', '+1 (417) 771-9958']) {
      expect(classifyLoginId(typed)).toEqual({ kind: 'phone', phone: '4177719958' });
      expect(loginSchema.safeParse({ email: typed, password: 'password1' }).success).toBe(true);
    }
  });

  test('and nothing else — a bare word is still refused', () => {
    expect(classifyLoginId('destiny').kind).toBe('unknown');
    const parsed = loginSchema.safeParse({ email: 'destiny', password: 'password1' });
    expect(parsed.success).toBe(false);
    expect(parsed.error.errors[0].message).toMatch(/email address or phone number/i);
  });

  test('a number that is not a US phone is not a phone', () => {
    expect(classifyLoginId('2026').kind).toBe('unknown'); // a year
    expect(classifyLoginId('65807').kind).toBe('unknown'); // a zip code
    expect(classifyLoginId('24177719958').kind).toBe('unknown'); // eleven, wrong lead
  });
});

describe('signing in', () => {
  test('a phone number is looked up on the phone field, not the email field', async () => {
    mockFindUser.mockResolvedValue({
      _id: 'u1',
      password: 'hash',
      emailVerified: true,
      createdAt: new Date(),
    });

    const { user } = await login('417-771-9958');

    expect(mockFindUser).toHaveBeenCalledWith({ kadePhone: '4177719958' }, '+password');
    expect(user).toBeTruthy();
  });

  test('an email address still goes to the email field', async () => {
    mockFindUser.mockResolvedValue({
      _id: 'u1',
      password: 'hash',
      emailVerified: true,
      createdAt: new Date(),
    });

    await login('destiny@example.com');

    expect(mockFindUser).toHaveBeenCalledWith({ email: 'destiny@example.com' }, '+password');
  });

  test('a phone nobody uses is told so in words about phones', async () => {
    mockFindUser.mockResolvedValue(null);

    const { user, info } = await login('417-771-9958');

    expect(user).toBe(false);
    expect(info.message).toBe('No account uses that phone number.');
  });

  test('the wrong password is still the wrong password', async () => {
    mockFindUser.mockResolvedValue({
      _id: 'u1',
      password: 'hash',
      emailVerified: true,
      createdAt: new Date(),
    });
    mockComparePassword.mockResolvedValue(false);

    const { user, info } = await login('417-771-9958');

    expect(user).toBe(false);
    expect(info.message).toBe('Incorrect password.');
  });

  test('a typed identifier that is neither never reaches the database', async () => {
    const { user } = await login('destiny');

    expect(user).toBe(false);
    expect(mockFindUser).not.toHaveBeenCalled();
  });
});
