const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loungeHtml, engineHtml } = require('./pages');

for (const [name, html] of Object.entries({ loungeHtml, engineHtml })) {
  test(`${name}: every rendered inline script parses`, () => {
    // Test the delivered HTML, not merely the Node module that contains it.
    // A JavaScript string inside a template previously turned '\\n' into a
    // literal line break and prevented both clients from starting at all.
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
      .map(match => match[1]).filter(script => script.trim());
    assert.ok(scripts.length > 0);
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
    assert.ok(!html.includes('<!-- KADE_CLIENT_SCRIPT -->'));
    assert.ok(!html.includes('<!-- KADE_SHARED_HEAD -->'));
    assert.equal((html.match(/livekit-client\.umd\.min\.js/g) || []).length, 1);
  });
}
