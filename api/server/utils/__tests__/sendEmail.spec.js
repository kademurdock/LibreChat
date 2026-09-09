const nodemailer = require('nodemailer');
const { readFileAsString } = require('@librechat/api');

jest.mock('nodemailer');
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  isEnabled: jest.fn((val) => val === 'true' || val === true),
  readFileAsString: jest.fn(),
}));

const savedEnv = { ...process.env };

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  process.env.EMAIL_HOST = 'smtp.example.com';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_FROM = 'noreply@example.com';
  process.env.APP_TITLE = 'TestApp';
  delete process.env.EMAIL_USERNAME;
  delete process.env.EMAIL_PASSWORD;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.EMAIL_SERVICE;
  delete process.env.EMAIL_ENCRYPTION;
  delete process.env.EMAIL_ENCRYPTION_HOSTNAME;
  delete process.env.EMAIL_ALLOW_SELFSIGNED;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_REPLY_TO;

  readFileAsString.mockResolvedValue({ content: '<p>{{name}}</p>' });
  nodemailer.createTransport.mockReturnValue({ sendMail: mockSendMail });
});

afterAll(() => {
  process.env = savedEnv;
});

/** Loads a fresh copy of sendEmail so process.env reads are re-evaluated. */
function loadSendEmail() {
  jest.resetModules();
  jest.mock('nodemailer', () => ({
    createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
  }));
  jest.mock('@librechat/data-schemas', () => ({
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.mock('@librechat/api', () => ({
    logAxiosError: jest.fn(),
    isEnabled: jest.fn((val) => val === 'true' || val === true),
    readFileAsString: jest.fn().mockResolvedValue({ content: '<p>{{name}}</p>' }),
    sendAccountEmail: jest.fn().mockResolvedValue({ id: 'resend-receipt' }),
  }));
  return require('../sendEmail');
}

const baseParams = {
  email: 'user@example.com',
  subject: 'Test',
  payload: { name: 'User' },
  template: 'test.handlebars',
};

describe('account email dispatch', () => {
  it('uses the existing template and configured reply address with Resend', async () => {
    process.env.RESEND_API_KEY = 'test-only';
    process.env.EMAIL_REPLY_TO = 'reply@example.com';
    const sendEmail = loadSendEmail();
    const { sendAccountEmail } = require('@librechat/api');
    const { createTransport } = require('nodemailer');
    await expect(sendEmail(baseParams)).resolves.toEqual({ id: 'resend-receipt' });
    expect(sendAccountEmail).toHaveBeenCalledWith({
      from: '"TestApp" <noreply@example.com>',
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>User</p>',
      replyTo: 'reply@example.com',
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('propagates delivery failure without sending a duplicate through SMTP', async () => {
    process.env.RESEND_API_KEY = 'test-only';
    const sendEmail = loadSendEmail();
    const { sendAccountEmail } = require('@librechat/api');
    const { createTransport } = require('nodemailer');
    sendAccountEmail.mockRejectedValue(new Error('Account email delivery could not be confirmed'));
    await expect(sendEmail(baseParams)).rejects.toThrow('could not be confirmed');
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe('sendEmail SMTP auth assembly', () => {
  it('includes auth when both EMAIL_USERNAME and EMAIL_PASSWORD are set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toEqual({
      user: 'smtp_user',
      pass: 'smtp_pass',
    });
  });

  it('omits auth when both EMAIL_USERNAME and EMAIL_PASSWORD are absent', async () => {
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
  });

  it('omits auth and logs a warning when only EMAIL_USERNAME is set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
    expect(freshLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
    );
  });

  it('omits auth and logs a warning when only EMAIL_PASSWORD is set', async () => {
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
    expect(freshLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
    );
  });

  it('does not log a warning when both credentials are properly set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    expect(freshLogger.warn).not.toHaveBeenCalled();
  });

  it('does not log a warning when both credentials are absent', async () => {
    const sendEmail = loadSendEmail();
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    expect(freshLogger.warn).not.toHaveBeenCalled();
  });
});
