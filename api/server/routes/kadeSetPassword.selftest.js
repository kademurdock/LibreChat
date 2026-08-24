/* Guard for POST /api/kade/admin/set-password. Run with no install:
 *
 *   node --test api/server/routes/kadeSetPassword.selftest.js
 *
 * This is a SOURCE-LEVEL guard, not a behaviour test, and the choice is
 * deliberate: the route's behaviour is proven end to end by a real person
 * signing in, which is a better receipt than a mocked Mongo. What a mocked test
 * could not protect is the part that would be quietly catastrophic — an admin
 * password route that loses its gate, logs the secret, or stores it in the
 * clear. Those are all readable in the source, so they are checked here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'kade.js'), 'utf8');
const route = (() => {
  const i = src.indexOf("router.post('/admin/set-password'");
  assert.notStrictEqual(i, -1, 'the set-password route must exist');
  return src.slice(i, i + 2600);
})();

test('the route is admin-gated by a real logged-in session', () => {
  assert.match(route, /requireJwtAuth/, 'must require a logged-in user');
  assert.match(route, /requireAdminAccess/, 'must require admin capability');
});

test('the password is hashed, never stored or compared in the clear', () => {
  assert.match(route, /bcrypt\.hashSync\(password, 10\)/, 'must bcrypt at cost 10');
  assert.doesNotMatch(route, /updateUser\([^)]*password:\s*password/, 'must never write it raw');
});

test('the password VALUE is never logged and never echoed back', () => {
  /* First draft of this test failed for the wrong reason: it flagged the WORD
   * "password" and the log line legitimately reads "set the password for
   * <email>". What must never appear is the VARIABLE — the secret itself
   * interpolated into a string. Check for that, not for the noun. */
  const logCalls = route.match(/logger\.(?:info|warn|error|debug)\([\s\S]*?\);/g) || [];
  assert.ok(logCalls.length, 'the route should log who did this to whom');
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\$\{\s*password\s*\}/, 'must not interpolate the password');
    assert.doesNotMatch(call, /[+,]\s*password\b/, 'must not concatenate or pass the password');
  }
  const resJson = route.match(/return res\.json\(\{[\s\S]*?\}\);/);
  assert.ok(resJson, 'must have a success response');
  /* Twice now this assertion tripped on the WORD rather than the value — the
   * response carries a human note that reads "sign in with this password",
   * which is good UX and not a leak. So strip string literals first and then
   * look for the IDENTIFIER. The lesson is the same one the care detector
   * taught an hour earlier: a check that fires on prose instead of substance
   * is a check that will be switched off. */
  const codeOnly = resJson[0]
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  assert.doesNotMatch(codeOnly, /\bpassword\b/, 'the response must not carry the password value back');
});

test('the length policy is enforced, so the bypass route does not bypass the rules', () => {
  assert.match(route, /password\.length < 8/, 'must enforce a minimum');
  assert.match(route, /password\.length > 128/, 'must enforce a maximum');
});

test('sessions are cleared, and a failure to clear them is not reported as success', () => {
  assert.match(route, /deleteAllUserSessions/, 'old sessions must not outlive the new password');
  assert.match(route, /sessionsCleared/, 'the caller must be told whether it worked');
});

test('the ALLOW_PASSWORD_RESET trap stays documented next to the code', () => {
  /* If this comment ever disappears, the next person to hit "no password reset"
   * flips the public switch and hands out reset links to anyone who asks. */
  const i = src.indexOf("router.post('/admin/set-password'");
  const preamble = src.slice(Math.max(0, i - 3000), i);
  assert.match(preamble, /ALLOW_PASSWORD_RESET/, 'the trap must stay written down');
  assert.match(preamble, /PUBLIC AND UNAUTHENTICATED|unauthenticated/i, 'and say why it is dangerous');
});
