const { chromium, webkit } = require(process.env.KADE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const assets = path.join(__dirname, '../client/public/assets/tasks');
(async () => {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.clock.install();
    let mode = 'done', allowed = true, calls = 0;
    await page.route('https://fixture.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'fixture' } });
      if (url.pathname === '/api/kade/work-options') return route.fulfill({ json: { codingJobs: allowed } });
      if (url.pathname.startsWith('/api/kade/harness/jobs')) {
        calls++;
        assert.equal(route.request().method(), 'GET');
        if (mode === 'missing') return route.fulfill({ status: 404, json: {} });
        if (mode === 'offline') return route.abort('internetdisconnected');
        return route.fulfill({ json: { runId: 'r123456789', task: '<script>evil</script>', state: mode,
          needsAttention: true, answer: 'Exact saved result', branch: 'held/job', baseSha: 'a'.repeat(40),
          spending: { limitUsd: 1, confirmedUsd: 0.02, reservedUsd: 0.04, complete: false, entries: [] } } });
      }
      const file = url.pathname === '/agent-work' ? 'work.html' : path.basename(url.pathname);
      return route.fulfill({ body: fs.readFileSync(path.join(assets, file)), contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript' });
    });
    await page.goto('https://fixture.test/agent-work?runId=r123456789');
    await page.clock.runFor(18000);
    await page.locator('#list li').waitFor();
    assert.equal(await page.locator('#list script').count(), 0);
    assert.match(await page.locator('#list').innerText(), /Waiting on you/);
    assert.match(await page.locator('#list').innerText(), /Cost is incomplete/);
    await page.getByText('Result', { exact: true }).click();
    assert.match(await page.locator('#list').innerText(), /Exact saved result/);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.documentElement.style.fontSize = '36px');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    mode = 'interrupted'; await page.locator('#refresh').click(); await page.clock.runFor(9000);
    await page.getByText('Interrupted', { exact: true }).first().waitFor();
    mode = 'offline'; await page.locator('#refresh').click(); await page.clock.runFor(9000);
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Connection lost'));
    assert.equal(await page.locator('#list li').count(), 1);
    allowed = false; const before = calls;
    await page.reload(); await page.clock.runFor(18000);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('not available to this account'));
    assert.equal(calls, before);
    await browser.close();
    console.log(name + ': exact job, interruption, unknown cost, permissions and large text passed');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
