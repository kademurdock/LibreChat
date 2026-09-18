const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.REVERIE_RECEIPTS || path.join(__dirname, 'receipts');
fs.mkdirSync(out, { recursive: true });
const base = 'http://127.0.0.1:' + (process.env.REVERIE_PORT || 8205);
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const checks = [],
    errors = [];
  const check = (value, label) => {
    assert(value, label);
    checks.push(label);
    console.log('PASS', label);
  };
  try {
    const make = async (fixture) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: 'reduce',
      });
      await context.addCookies([{ name: 'fixture', value: fixture, url: base }]);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.addEventListener('reverie-stage-ready', () => {
          const Original = window.ReverieStage.Stage;
          window.ReverieStage.Stage = class extends Original {
            constructor(...args) {
              super(...args);
              window.stageForTest = this;
            }
          };
        });
        const NativeAudio = window.Audio;
        window.audioForTest = [];
        window.Audio = function (...args) {
          const a = new NativeAudio(...args);
          window.audioForTest.push(a);
          return a;
        };
      });
      await page.goto(base + '/world');
      await page.waitForFunction(
        () =>
          window.stageForTest?.model && document.querySelector('#m-live').textContent === 'live',
      );
      return page;
    };
    const a = await make('alex'),
      b = await make('mira');
    const ready = (p) =>
      p.waitForFunction(
        () => document.querySelector('#cmdForm').getAttribute('aria-busy') !== 'true',
      );
    const send = async (p, cmd) => {
      await p.locator('#cmdInput').fill(cmd);
      await p.locator('#cmdInput').press('Enter');
      await ready(p);
    };
    await send(a, 'go to ferry_dock_hook');
    await send(b, 'go to ferry_dock_hook');
    await send(a, 'hair blue short hair');
    await a.locator('[data-quick="wardrobe"]').click();
    await ready(a);
    check(
      await a.evaluate(() => document.activeElement?.dataset.key === 'hair'),
      'opening wardrobe focuses its first choice without a keyboard',
    );
    await a.locator('#choices [data-key="hair"]').click();
    await ready(a);
    await a.locator('#choices [data-key="hair pink curls"]').click();
    await ready(a);
    await a.waitForFunction(
      () => window.stageForTest.model.people.find((p) => p.self).appearance.hair === 'pink curls',
    );
    check(
      await a.evaluate(() => document.activeElement.id !== 'cmdInput'),
      'choosing hair does not summon phone keyboard',
    );
    check(
      await a.evaluate(() =>
        window.stageForTest.figures
          .find((p) => p.id === 'browser-alex')
          .head.children.some((p) => p.material?.color?.getHex() === 0xe888b8),
      ),
      'pink curls actually render pink',
    );
    await b.waitForFunction(
      () =>
        window.stageForTest.model.people.find((p) => p.id === 'browser-alex')?.appearance?.hair ===
        'pink curls',
    );
    check(true, 'another player receives the changed appearance through shared state');
    await a.locator('#cmdInput').fill('draft kept');
    await a.locator('[data-quick="places"]').click();
    await ready(a);
    check(
      (await a.locator('#cmdInput').inputValue()) === 'draft kept',
      'place picker preserves a command draft',
    );
    await a.locator('#choices [data-key="places hook"]').click();
    await ready(a);
    await a.locator('#choices [data-key="go to ropewalk"]').click();
    await ready(a);
    check(
      await a.evaluate(() => window.stageForTest.model.id === 'ropewalk'),
      'destination buttons travel through the actual game',
    );
    await a.waitForFunction(() =>
      window.audioForTest.some((x) => x.src.includes('amb.ropewalk.water') && x.readyState >= 2),
    );
    check(true, 'new room audio loads and decodes after a gesture');
    await a.locator('#reverieIllustration').scrollIntoViewIfNeeded();
    const point = await a.evaluate(async () => {
      const T = await import('/assets/reverie/vendor/three.module.js');
      const stage = window.stageForTest;
      const sign = stage.world.children.find((x) => x.userData.interaction?.direction === 'e');
      stage.scene.updateMatrixWorld(true);
      const p = sign.getWorldPosition(new T.Vector3()).project(stage.camera);
      const r = stage.canvas.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) * r.width) / 2, y: r.top + ((1 - p.y) * r.height) / 2 };
    });
    await a.mouse.click(point.x, point.y);
    await ready(a);
    await a.waitForFunction(() => window.stageForTest.model.id === 'net_loft');
    check(true, 'tapping a rendered exit sign moves into the real Net Loft');
    check(
      await a.evaluate(() => document.querySelector('#scene').dataset.wx === 'clear'),
      'sheltered rooms suppress the old rain overlay',
    );
    await a.locator('#reverieIllustration').screenshot({ path: path.join(out, 'net-loft.png') });
    await send(b, 'go to net_loft');
    await a.waitForFunction(() =>
      window.stageForTest.model.people.some((p) => p.id === 'browser-mira'),
    );
    await a.locator('#reverieIllustration').scrollIntoViewIfNeeded();
    const person = await a.evaluate(async () => {
      const T = await import('/assets/reverie/vendor/three.module.js');
      const stage = window.stageForTest;
      stage.scene.updateMatrixWorld(true);
      const g = stage.figures.find((p) => p.id === 'browser-mira').g;
      const p = g.localToWorld(new T.Vector3(0, 0.8, 0)).project(stage.camera);
      const r = stage.canvas.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) * r.width) / 2, y: r.top + ((1 - p.y) * r.height) / 2 };
    });
    await a.mouse.click(person.x, person.y);
    await a.locator('#personMenu').waitFor({ state: 'visible' });
    check(
      (await a.locator('#personMenu').innerText()).includes('Mira Example'),
      'tapping a person opens the same named interaction menu',
    );
    await a.locator('#personMenu').getByRole('button', { name: 'Close', exact: true }).click();
    const before = await a.locator('#log').innerText();
    await a.locator('#reverieIllustration').scrollIntoViewIfNeeded();
    const box = await a.locator('canvas').boundingBox();
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await a.mouse.down();
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 70, { steps: 5 });
    await a.mouse.up();
    check(
      await a.evaluate(
        () =>
          window.stageForTest.model.id === 'net_loft' &&
          document.querySelector('#personMenu').hidden,
      ),
      'dragging the picture does not activate a person or exit',
    );
    check((await a.locator('#log').innerText()) === before, 'drag creates no game command');
    await send(a, 'go to reed_pavilion');
    await a.locator('#reverieIllustration').screenshot({ path: path.join(out, 'pavilion.png') });
    await a.locator('#hereActs [data-key="listen to the reeds"]').click();
    await ready(a);
    check(
      (await a.locator('#log').innerText()).includes('Close water makes a low, irregular rhythm'),
      'visible props have equivalent accessible action buttons',
    );
    for (const width of [320, 390, 667]) {
      await a.setViewportSize({ width, height: 844 });
      check(
        await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'no overflow at ' + width,
      );
    }
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: path.join(out, 'waterfront-mobile.png'), fullPage: true });
    check(
      await a.evaluate(() => !window.stageForTest.running),
      'reduced motion still stops all scene animation',
    );
    await a.locator('details.settings summary').click();
    await a.getByRole('button', { name: 'Room picture: on', exact: true }).click();
    check((await a.locator('canvas').count()) === 0, 'picture off disposes the interactive canvas');
    await a.locator('[data-quick="wardrobe"]').click();
    await ready(a);
    check(
      await a.locator('#choices [data-key="hair"]').isVisible(),
      'wardrobe works with pictures off',
    );
    check(
      (await a.locator('[role=log]').count()) === 1,
      'one live region carries all game announcements',
    );
    check(errors.length === 0, 'no page errors across both players');
    fs.writeFileSync(
      path.join(out, 'waterfront-browser.json'),
      JSON.stringify(
        {
          checks,
          errors,
          scope:
            'Local disposable World router/Mongo, two browser sessions. Not physical screen-reader or listening acceptance.',
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
