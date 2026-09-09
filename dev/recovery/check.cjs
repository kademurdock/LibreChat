const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
(async () => {
  const root = path.join(__dirname, 'out'), out = process.env.CHARACTER_RECEIPTS;
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0], file = path.join(root, name === '/app.js' ? 'app.js' : name === '/app.css' ? 'app.css' : 'index.html');
    res.setHeader('Content-Type', name === '/app.js' ? 'text/javascript' : name === '/app.css' ? 'text/css' : 'text/html');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [], payloads = [];
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https:\/\//, route => route.abort());
    let mode = 'fail', release;
    await page.route('**/api/auth/requestPasswordReset', route => {
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ status: mode === 'fail' ? 500 : 200,
        json: mode === 'fail' ? { message: 'mail unavailable' } : { message: 'generic', link: 'https://evil.invalid/reset' } });
    });
    await page.goto(base + '/forgot-password?email=off');
    assert.equal(await page.locator('input').count(), 0);
    assert.match(await page.locator('main').textContent(), /Email recovery is unavailable/);
    await page.goto(base + '/forgot-password');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('User@Example.com');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'We could not complete' }).waitFor();
    assert.doesNotMatch(await page.locator('h1').textContent(), /sent/i);
    mode = 'ok';
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Check your inbox and spam folder.', { exact: false }).waitFor();
    assert.equal(await page.locator('a[href*="evil.invalid"]').count(), 0);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].email, 'user@example.com');
    await page.screenshot({ path: path.join(out, 'recovery-request-mobile.png') });
    await page.goto(base + '/reset-password');
    await page.getByRole('link', { name: 'Request a new reset link' }).waitFor();
    assert.equal(await page.locator('input').count(), 0);
    await page.route('**/api/auth/resetPassword', async route => {
      payloads.push(route.request().postDataJSON());
      await new Promise(resolve => { release = resolve; });
      return route.fulfill({ status: mode === 'expired' ? 400 : 200, json: { message: 'result' } });
    });
    for (const result of ['expired', 'ok']) {
      mode = result;
      await page.goto(base + '/reset-password?token=synthetic-token&userId=synthetic-user');
      const password = page.locator('#password'), confirm = page.locator('#confirm_password');
      assert.equal(await password.getAttribute('autocomplete'), 'new-password');
      await password.fill('Example-long-password'); await confirm.fill('Example-long-password');
      const submit = page.getByRole('button', { name: 'Reset your password', exact: true });
      await submit.click();
      await page.waitForTimeout(100);
      assert.equal(await submit.isDisabled(), true);
      release();
      if (result === 'expired') await page.getByRole('link', { name: 'Request a new reset link' }).waitFor();
      else await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'recovery-browser.json'), JSON.stringify({
      cases: ['no email', 'failed request', 'retry', 'ignore returned credential', 'missing token', 'expired token', 'pending submit', 'success', 'mobile overflow'],
      requests: payloads.length, errors, shell: 'fixture layout; actual recovery components and React Query mutations' }, null, 2));
    console.log('Account recovery browser checks passed');
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
