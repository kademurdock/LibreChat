const { chromium, webkit } = require(process.env.KADE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, '../client/public/assets/tasks');
const output = path.join(__dirname, '../test-results/agent-work');
fs.mkdirSync(output, { recursive: true });
const task = (id, status = 'completed') => ({
  taskId: id,
  conversationId: 'chat-' + id,
  status,
  title: id === 'request01' ? '<img src=x onerror=alert(1)> Family plans' : 'A saved conversation',
  createdAt: '2026-09-07T00:00:00.000Z',
  canOpenConversation: true,
});
(async () => {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let mode = 'first',
      requests = 0;
    await page.clock.install();
    await page.route('https://fixture.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/refresh')
        return route.fulfill({ json: { token: 'local-test-token' } });
      if (url.pathname === '/api/kade/work-options')
        return route.fulfill({ json: { codingJobs: true } });
      if (url.pathname.startsWith('/api/agents/chat/tasks/')) {
        requests++;
        assert.equal(route.request().method(), 'GET');
        if (mode === 'missing') return route.fulfill({ status: 404, json: {} });
        return route.fulfill({ json: task('request03', 'interrupted') });
      }
      if (url.pathname === '/api/agents/chat/tasks') {
        requests++;
        if (mode === 'offline') return route.abort('internetdisconnected');
        if (mode === 'expired') return route.fulfill({ status: 401, json: {} });
        if (mode === 'blocked') return route.fulfill({ status: 403, json: {} });
        return route.fulfill({
          json: url.search
            ? { tasks: [task('request01'), task('request03', 'interrupted')], nextCursor: null }
            : { tasks: [task('request01'), task('request02', 'running')], nextCursor: 'request02' },
        });
      }
      const file = url.pathname === '/agent-work' ? 'work.html' : path.basename(url.pathname);
      return route.fulfill({
        body: fs.readFileSync(path.join(dir, file)),
        contentType: file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.css')
            ? 'text/css'
            : 'application/javascript',
      });
    });
    await page.goto('https://fixture.test/agent-work');
    await page.clock.runFor(18000);
    await page.locator('#list li').nth(1).waitFor();
    assert.equal(await page.locator('#list img').count(), 0, 'titles remain text');
    assert.equal(await page.locator('#status').getAttribute('aria-live'), 'polite');
    if (name === 'webkit') await page.locator('.skip').focus();
    else await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').textContent(), 'Skip to your requests');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'requests');
    await page.locator('#more').click();
    await page.clock.runFor(9000);
    await page.locator('#list li').nth(2).waitFor();
    assert.equal(await page.locator('#list li').count(), 3, 'pagination avoids duplicate rows');
    assert.equal(
      await page.locator(':focus').evaluate((e) => e.closest('li').dataset.taskId),
      'request03',
    );
    mode = 'offline';
    await page.locator('#refresh').click();
    await page.clock.runFor(9000);
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.startsWith('Connection lost'),
    );
    assert.equal(await page.locator('#list li').count(), 3, 'offline preserves list');
    mode = 'expired';
    await page.locator('#refresh').click();
    await page.clock.runFor(9000);
    await page.locator('#login').waitFor();
    mode = 'blocked';
    await page.locator('#refresh').click();
    await page.clock.runFor(18000);
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.startsWith('Access was refused'),
    );
    assert.equal(await page.locator('#refresh').isDisabled(), true);
    const blockedCount = requests;
    await page.clock.runFor(60000);
    assert.equal(requests, blockedCount, '403 stops requests and no background polling');
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [390, 320, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        for (const fontSize of ['18px', '36px']) {
          await page.evaluate((size) => (document.documentElement.style.fontSize = size), fontSize);
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${name} no overflow ${scheme}/${width}/${fontSize}`,
          );
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.documentElement.style.fontSize = '18px'));
    await page.screenshot({
      path: path.join(output, `agent-work-${name}-390.png`),
      fullPage: true,
    });
    mode = 'single';
    await page.goto('https://fixture.test/agent-work?requestId=request03');
    await page.clock.runFor(9000);
    await page.locator('#list li').waitFor();
    assert.equal(await page.locator('#list li').count(), 1);
    assert.equal(await page.locator('#list li').getAttribute('data-task-id'), 'request03');
    assert.equal(await page.locator('#requests-heading').textContent(), 'Your selected request');
    assert.equal(await page.locator('#more').isHidden(), true);
    assert.equal(
      await page.getByRole('link', { name: 'All requests', exact: true }).getAttribute('href'),
      '/agent-work',
    );
    mode = 'missing';
    await page.locator('#refresh').click();
    await page.clock.runFor(9000);
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('Nothing was sent again'),
    );
    const singleCount = requests;
    await page.clock.runFor(60000);
    assert.equal(requests, singleCount);
    await page.goto('https://fixture.test/agent-work?requestId=%3Cscript%3E');
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('link is invalid'),
    );
    assert.equal(requests, singleCount, 'invalid link sends no task request');
    assert.deepEqual(errors, []);
    console.log(
      `${name}: navigation, status, pagination, XSS, offline, login expiry, 403 stop, no polling and 12 responsive layouts passed`,
    );
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
