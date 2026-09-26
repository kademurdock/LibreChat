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

/* Part 293: the Family feature pack. Without it (only while Kade limits jukebox links to the
 * pack) the link box and both fetch buttons are greyed out with the reason as visible text they
 * are described by; never hidden. lockLinks runs from the delivered page. */
test('loungeHtml: jukebox links greyed out with "Part of the Family feature pack", never hidden', () => {
  assert.match(loungeHtml, /<label class="blk" for="jb-link">Or paste a link/);
  assert.match(loungeHtml, /<p class="muted" id="jb-link-lock" hidden>Part of the Family feature pack\. Ask Kade to add it to your account\.<\/p>/);
  const from = loungeHtml.indexOf('function lockLinks(features){');
  const to = loungeHtml.indexOf('      lockLinks(cfg.features);', from);
  assert.ok(from > 0 && to > from, 'lockLinks is in the served script');
  const make = () => {
    const els = {};
    const $ = (id) => (els[id] ||= {
      id, hidden: id === 'jb-link-lock', disabled: false, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    });
    return { els, $ };
  };
  const run = (features) => {
    const world = make();
    vm.runInNewContext(loungeHtml.slice(from, to) + '\nlockLinks(features);', { $: world.$, features });
    return world.els;
  };
  const locked = run({ jukeboxLinks: false });
  assert.equal(locked['jb-link-lock'].hidden, false, 'the reason is visible');
  for (const id of ['jb-link', 'jb-link-cutin', 'jb-link-queue']) {
    assert.equal(locked[id].disabled, true, id);
    assert.equal(locked[id].attrs['aria-describedby'], 'jb-link-lock', id);
    assert.equal(locked[id].hidden, false, `${id} is never hidden`);
  }
  for (const features of [{ jukeboxLinks: true }, undefined]) {
    const open = run(features);
    assert.equal(open['jb-link-lock'].hidden, true);
    for (const id of ['jb-link', 'jb-link-cutin', 'jb-link-queue']) {
      assert.equal(open[id].disabled, false, id);
      assert.equal(open[id].attrs['aria-describedby'], undefined, `${id}: a hidden note is never referenced`);
    }
  }
});
