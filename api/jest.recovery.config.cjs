const base = require('./jest.config.js');
module.exports = { ...base, rootDir: __dirname, setupFiles: [],
  testMatch: ['**/server/services/AuthService.spec.js'] };
