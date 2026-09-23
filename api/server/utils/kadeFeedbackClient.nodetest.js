'use strict';
/* node --test api/server/utils/kadeFeedbackClient.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { feedbackClientFields } = require('./kadeFeedbackClient');

test('a body without the new fields stores nothing new', () => {
  assert.deepEqual(feedbackClientFields({ detail: 'It broke', category: 'bug' }), {});
  assert.deepEqual(feedbackClientFields(null), {});
  assert.deepEqual(feedbackClientFields('nonsense'), {});
});

test('known platforms pass, unknown ones are dropped', () => {
  assert.equal(feedbackClientFields({ platform: 'android' }).platform, 'android');
  assert.equal(feedbackClientFields({ platform: 'ios' }).platform, 'ios');
  assert.equal(feedbackClientFields({ platform: 'web' }).platform, 'web');
  assert.equal(feedbackClientFields({ platform: 'windows phone' }).platform, undefined);
  assert.equal(feedbackClientFields({ platform: ['android'] }).platform, undefined);
});

test('version and device are cleaned and cut', () => {
  const f = feedbackClientFields({ appVersion: ' 2.15.1 (118)\n', device: '<b>Pixel</b>\t8 ' + 'x'.repeat(200) });
  assert.equal(f.appVersion, '2.15.1 (118)');
  assert.ok(!/[<>\t]/.test(f.device));
  assert.ok(f.device.length <= 80);
  assert.equal(feedbackClientFields({ appVersion: '   ' }).appVersion, undefined);
});

test('the how-its-going entry names itself on the board; other entries are ignored', () => {
  assert.equal(feedbackClientFields({ entry: 'how-its-going' }).agent, "How it's going");
  assert.equal(feedbackClientFields({ entry: 'admin' }).agent, undefined);
  assert.equal(feedbackClientFields({ entry: 'constructor' }).agent, undefined);
});

test('the /feedback page is wired and accessible', () => {
  const root = path.join(__dirname, '..');
  const pages = fs.readFileSync(path.join(root, 'routes', 'kadePages.js'), 'utf8');
  const start = pages.indexOf('const feedbackFormHtml');
  assert.ok(start > 0, 'feedbackFormHtml exists');
  const page = pages.slice(start, pages.indexOf('</html>`;', start));
  assert.match(page, /<fieldset[\s\S]*<legend[^>]*>How&rsquo;s it going\?<\/legend>/);
  assert.equal((page.match(/type="radio" name="how"/g) || []).length, 3);
  assert.match(page, /<label[^>]*for="detail">/);
  assert.match(page, /role="status"/);
  assert.match(page, /\/api\/kade\/feedback/);
  assert.match(page, /entry:'how-its-going'/);
  assert.match(pages, /\n\s+feedbackFormHtml,\n/);
  const kade = fs.readFileSync(path.join(root, 'routes', 'kade.js'), 'utf8');
  assert.match(kade, /router\.feedbackFormPage = sendHtml\(require\('\.\/kadePages'\)\.feedbackFormHtml\)/);
  assert.match(kade, /\.\.\.feedbackClientFields\(req\.body\)/);
  const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(index, /app\.get\('\/feedback', routes\.kade\.feedbackFormPage\)/);
  const model = fs.readFileSync(path.join(root, '..', 'models', 'kadeFeedback.js'), 'utf8');
  assert.match(model, /platform: \{ type: String, enum: \['android', 'ios', 'web'\] \}/);
});
