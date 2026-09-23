const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('test seats cannot send web pushes, telephone nudges, or queued outreach', async () => {
  const source = fs.readFileSync(require.resolve('./kadeNudges'), 'utf8');
  const context = { process: { env: { NOTIFY_TEST_USER_IDS: 'extra-test' } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function isTestUser('), source.indexOf('/** ---- US Central')), context);
  vm.runInContext(source.slice(source.indexOf('async function sendPushToUser('), source.indexOf('/** ---- next-chat')), context);
  // No sender/storage dependencies exist: reaching any would fail the test.
  for (const id of ['6a6125d73939d20b95251078', '6a69074cc74d975de21f5b2a', '6a572e3be680dcdaadca0f04', 'extra-test']) {
    assert.equal(await context.sendPushToUser(id, {}), 0);
    assert.equal(await context.placeNudgeCall(id, 'Test', 'unused', 'unused'), false);
    assert.equal(await context.deliverNudge(id, 'unused'), 'off');
  }
  assert.equal(context.isTestUser('family'), false);
});
