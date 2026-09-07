const { chromium, webkit } = require(process.env.KADE_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
(async () => {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await page.clock.install();
    let correction, excluded = false, revision = 1;
    const project = () => ({ revision, instructions: 'Shared instructions', files: [{ id: 'file-one', name: 'draft.md', kind: 'document', content: '# Existing draft', versions: [{ revision: 1 }] }] });
    await page.route('https://fixture.test/**', async (route) => {
      const url = new URL(route.request().url()), pathname = url.pathname;
      if (pathname === '/api/auth/refresh') return route.fulfill({ json: { token: 'test' } });
      if (pathname.startsWith('/api/memories/controls/source/')) return route.fulfill({ json: { memory: { key: '<script>not executed</script>', value: 'Old belief' }, sources: [{ conversationId: 'source-chat' }], related: [{ _id: 'memory-one', key: 'pet', value: 'Old belief' }, { _id: 'memory-two', key: 'pet', value: 'Related old belief' }] } });
      if (pathname === '/api/memories/controls/correct') { correction = route.request().postDataJSON(); return route.fulfill({ json: { corrected: correction.ids.length } }); }
      if (pathname.startsWith('/api/memories/controls/conversation/')) { if (route.request().method() === 'PATCH') excluded = route.request().postDataJSON().excluded; return route.fulfill({ json: { excluded } }); }
      if (pathname.startsWith('/api/kade/capabilities/')) return route.fulfill({ json: { agents: [{ agentId: 'friend', checkedAt: new Date().toISOString(), available: ['read_file'], discoverable: [] }], note: 'Verified for the latest reply.' } });
      if (pathname.startsWith('/api/projects/')) {
        if (pathname.endsWith('/files') && route.request().method() === 'POST') { const body = route.request().postDataJSON(); assert.equal(body.id, 'file-one'); assert.equal(body.expectedRevision, revision); assert.equal(body.content, '# Revised draft'); revision++; return route.fulfill({ json: project() }); }
        if (pathname.endsWith('/file-one/1')) return route.fulfill({ body: '# Existing draft', contentType: 'text/plain' });
        return route.fulfill({ json: project() });
      }
      const file = path.join(__dirname, '../client/public', pathname); const ext = path.extname(file);
      return route.fulfill({ body: fs.readFileSync(file), contentType: ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript' });
    });
    await page.goto('https://fixture.test/assets/memory/index.html?memoryId=memory-one'); await page.clock.runFor(18000); await page.locator('#source:not([hidden])').waitFor();
    assert.equal(await page.locator('#key script').count(), 0); assert.equal(await page.locator('#related input:checked').count(), 1);
    await page.locator('#corrected').fill('Corrected belief'); await page.getByRole('button', { name: 'Save selected corrections' }).click(); await page.clock.runFor(9000);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('1 memories corrected'));
    assert.deepEqual(correction, { ids: ['memory-one'], value: 'Corrected belief' });
    await page.goto('https://fixture.test/assets/memory/index.html?conversationId=source-chat'); await page.clock.runFor(27000); await page.locator('#toggle:not([disabled])').waitFor();
    await page.locator('#toggle').click(); await page.clock.runFor(9000); await page.waitForFunction(() => document.getElementById('status').textContent.includes('Remembering is off'));
    assert.equal(excluded, true);
    await page.goto('https://fixture.test/assets/projects/index.html?projectId=project-one'); await page.clock.runFor(18000); await page.getByRole('button', { name: 'Revise', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Revise', exact: true }).click(); assert.equal(await page.locator('#content').inputValue(), '# Existing draft');
    await page.locator('#content').fill('# Revised draft'); await page.getByRole('button', { name: 'Save a new version' }).click(); await page.clock.runFor(9000);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('New version saved'));
    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download version 1' }).click(); await page.clock.runFor(9000);
    const download = await downloadEvent; assert.equal(download.suggestedFilename(), 'draft.md'); assert.equal(fs.readFileSync(await download.path(), 'utf8'), '# Existing draft');
    for (const width of [320, 390, 1280]) { await page.setViewportSize({ width, height: 844 }); await page.evaluate(() => document.documentElement.style.fontSize = '36px'); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.style.fontSize = '18px');
    await page.screenshot({ path: path.join(__dirname, '../../../outputs/project-' + name + '.png'), fullPage: true });
    await browser.close(); console.log(name + ': sources, correction selection, exclusion, revision, download, large text and escaping passed');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
