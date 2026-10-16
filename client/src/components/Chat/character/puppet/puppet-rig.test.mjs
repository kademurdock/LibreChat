import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import AvatarExpression from '../avatar-expression.mjs';
import { EXPRESSIONS } from './puppet-motion.mjs';
import {
  createPuppetRig,
  validPuppetScene,
  puppetExpression,
  PUPPET_EXPRESSIONS,
} from './puppet-rig.mjs';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/scene-golden.json', import.meta.url), 'utf8'),
);
const scene = golden.cases[0].scene;

function fakeCanvas() {
  const calls = [];
  const target = {};
  const ctx = new Proxy(target, {
    get(_, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient')
        return () => ({ addColorStop() {} });
      return (...a) => calls.push([key, ...a]);
    },
    set(_, key, value) {
      target[key] = value;
      return true;
    },
  });
  const attrs = {};
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 200,
    clientHeight: 200,
    hidden: false,
    getContext: () => ctx,
    setAttribute: (k, v) => (attrs[k] = v),
  };
  return { canvas, calls, attrs };
}

const frame = (over = {}) => ({
  characterId: 'agent_a',
  active: true,
  expression: 'neutral',
  mouth: 0,
  viseme: 0,
  ...over,
});
const fills = (calls) => calls.filter(([k]) => k === 'fill').length;

test('every one of the 22 voice expressions maps onto a real engine expression', () => {
  for (const name of AvatarExpression.expressions) {
    assert.ok(PUPPET_EXPRESSIONS[name], name);
    assert.ok(Object.hasOwn(EXPRESSIONS, PUPPET_EXPRESSIONS[name][0]), name);
  }
  assert.deepEqual(puppetExpression('amused', { from: 'smile', to: 'laugh', blend: 0.8 }), [
    'laughing',
    1,
  ]);
  assert.deepEqual(puppetExpression('unknown'), ['neutral', 1]);
});

test('server scenes are validated and bad ones are refused', () => {
  for (const { scene: s } of golden.cases) assert.equal(validPuppetScene(s), true);
  assert.equal(validPuppetScene(null), false);
  assert.equal(validPuppetScene({ ...scene, schema: 'other' }), false);
  const broken = structuredClone(scene);
  broken.shapes[0].d[0].v = [NaN, 1];
  assert.equal(validPuppetScene(broken), false);
  const orphan = structuredClone(scene);
  orphan.groups.push({ id: 'late', parent: 'nobody', pivot: [0, 0] });
  assert.equal(validPuppetScene(orphan), false);
  const morph = structuredClone(scene);
  const withMorph = morph.shapes.find((s) => s.m && s.m.length);
  withMorph.m[0].d = withMorph.m[0].d.slice(1);
  assert.equal(validPuppetScene(morph), false);
});

test('the rig draws at device pixels, stays aria-hidden and hides the fallback picture', () => {
  globalThis.window = { devicePixelRatio: 2 };
  try {
    const { canvas, calls, attrs } = fakeCanvas();
    const shown = [];
    let ready = 0;
    const rig = createPuppetRig(canvas, {
      id: 'agent_a',
      scene,
      onReady: () => ready++,
      onVisibilityChange: (v) => shown.push(v),
    });
    assert.equal(ready, 1);
    assert.equal(attrs['aria-hidden'], 'true');
    assert.equal(canvas.hidden, true);
    rig.render(frame({ mouth: 0.6 }));
    assert.equal(canvas.width, 400);
    assert.equal(canvas.hidden, false);
    assert.deepEqual(shown, [true]);
    assert.ok(fills(calls) > 10);
    rig.dispose();
    assert.equal(canvas.hidden, true);
    assert.deepEqual(shown, [true, false]);
    const before = calls.length;
    rig.render(frame());
    assert.equal(calls.length, before, 'nothing draws after dispose');
  } finally {
    delete globalThis.window;
  }
});

test('an inactive frame (paused, reduced motion) draws one still pose and then nothing', () => {
  const { canvas, calls } = fakeCanvas();
  const rig = createPuppetRig(canvas, { id: 'agent_a', scene });
  rig.render(frame({ active: false }));
  const once = calls.length;
  assert.ok(fills(calls) > 10);
  rig.render(frame({ active: false }));
  rig.render(frame({ active: false }));
  assert.equal(calls.length, once, 'the same still is not redrawn');
  rig.render(frame({ active: false, expression: 'sad' }));
  assert.ok(calls.length > once, 'a new expression redraws the still');
  assert.equal(canvas.hidden, false, 'a puppet stays visible while still');
});

test('another character, a broken scene or a thrown draw never shows the canvas', () => {
  const { canvas } = fakeCanvas();
  const rig = createPuppetRig(canvas, { id: 'agent_a', scene });
  rig.render(frame({ characterId: 'agent_b' }));
  assert.equal(canvas.hidden, true);
  let failures = 0;
  const bad = fakeCanvas();
  createPuppetRig(bad.canvas, {
    id: 'agent_a',
    scene: { schema: 'nope' },
    onFailure: () => failures++,
  }).render(frame());
  assert.equal(failures, 1);
  assert.equal(bad.canvas.hidden, true);
  const throwing = fakeCanvas();
  throwing.canvas.getContext = () => ({
    setTransform() {
      throw new Error('lost context');
    },
  });
  const r = createPuppetRig(throwing.canvas, { id: 'agent_a', scene, onFailure: () => failures++ });
  r.render(frame());
  assert.equal(failures, 2);
  assert.equal(throwing.canvas.hidden, true);
});

test('setScene swaps the drawing and play holds a tried expression', () => {
  const { canvas } = fakeCanvas();
  const rig = createPuppetRig(canvas, { id: 'agent_a', scene });
  assert.equal(rig.setScene(golden.cases[1].scene), true);
  assert.equal(rig.setScene({ schema: 'bad' }), false);
  rig.play('surprised', 1);
  rig.play('not-an-expression', 1);
  rig.render(frame());
  rig.render(frame({ active: false }));
  assert.equal(canvas.hidden, false);
});
