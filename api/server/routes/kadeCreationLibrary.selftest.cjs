const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const { creationsHtml } = require('./kadePages');
const assets = [
  { id: 'one', kind: 'audio', prompt: 'Warm bedtime story', url: '/sound.wav', archived: false },
  { id: 'two', kind: 'document', prompt: 'Shopping list', url: '/list.txt', archived: true },
];
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(creationsHtml.replace('</head>', '<script>getToken=async()=>"fixture";</script></head>'));
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/api/kade/my-assets?')) return res.end(JSON.stringify({ assets }));
  if (req.url.endsWith('/archive')) {
    let raw = ''; req.on('data', (c) => raw += c);
    req.on('end', () => {
      const item = assets.find((a) => req.url.includes('/' + a.id + '/'));
      item.archived = JSON.parse(raw).archived; res.end('{"ok":true}');
    });
    return;
  }
  res.end('{}');
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.asset:visible').count(), 1);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.locator('#status').filter({ hasText: 'Archived.' }).waitFor();
    assert.equal(await page.locator('.asset:visible').count(), 0);
    await page.getByLabel('Show archived creations').check();
    assert.equal(await page.locator('.asset:visible').count(), 2);
    await page.getByLabel('Kind', { exact: true }).selectOption('document');
    assert.equal(await page.locator('.asset:visible').count(), 1);
    await page.getByRole('button', { name: 'Restore to library', exact: true }).click();
    await page.locator('#status').filter({ hasText: 'Restored' }).waitFor();
    await page.getByLabel('Search creations').fill('no match');
    assert.equal(await page.locator('.asset:visible').count(), 0);
    await page.getByLabel('Search creations').fill('shopping');
    assert.equal(await page.locator('.asset:visible').count(), 1);
    assert.deepEqual(errors, []);
    console.log('Library browser checks passed: search, kinds, archive, restore and accessible labels.');
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r));
  }
})().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
