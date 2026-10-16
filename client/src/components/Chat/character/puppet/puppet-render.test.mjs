import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  groupMatrices,
  morphPath,
  shapeOpacity,
  drawScene,
  createSceneCache,
} from './puppet-render.mjs';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/scene-golden.json', import.meta.url), 'utf8'),
);
const near = (actual, expected, tol, where) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${where}: ${actual} vs ${expected}`);

test('the scene fixture is the one this renderer is held to', () => {
  assert.equal(golden.schema, 'kade-puppet-scene-golden/1');
  assert.equal(golden.tolerance, 1e-6);
  assert.ok(golden.cases.length >= 2);
  for (const { scene } of golden.cases) assert.equal(scene.schema, 'kade-puppet-scene/1');
});

test('every group world matrix matches the golden values', () => {
  let checked = 0;
  golden.cases.forEach(({ scene, expect }, c) => {
    for (const [e, set] of expect.entries()) {
      const mats = groupMatrices(scene, set.channels);
      assert.deepEqual(Object.keys(mats).sort(), Object.keys(set.groups).sort());
      for (const [id, m] of Object.entries(set.groups)) {
        for (let i = 0; i < 6; i++)
          near(mats[id][i], m[i], golden.tolerance, `case ${c} set ${e} ${id}[${i}]`);
        checked++;
      }
    }
  });
  assert.ok(checked > 20);
});

test('every listed morphed path matches the golden values', () => {
  let checked = 0;
  golden.cases.forEach(({ scene, expect }, c) => {
    const byId = new Map(scene.shapes.map((s) => [s.id, s]));
    for (const [e, set] of expect.entries()) {
      for (const [id, path] of Object.entries(set.shapes)) {
        const got = morphPath(byId.get(id), set.channels);
        assert.equal(got.length, path.length, `case ${c} set ${e} ${id} length`);
        path.forEach((cmd, k) => {
          assert.equal(got[k].op, cmd.op);
          assert.equal(got[k].v.length, cmd.v.length);
          cmd.v.forEach((v, j) =>
            near(got[k].v[j], v, golden.tolerance, `case ${c} set ${e} ${id} ${k}.${j}`),
          );
        });
        checked++;
      }
    }
  });
  assert.ok(checked > 20);
});

test('every channel-driven opacity matches the golden values', () => {
  let checked = 0;
  golden.cases.forEach(({ scene, expect }, c) => {
    const byId = new Map(scene.shapes.map((s) => [s.id, s]));
    for (const [e, set] of expect.entries()) {
      for (const [id, alpha] of Object.entries(set.alpha)) {
        near(
          shapeOpacity(byId.get(id), set.channels),
          alpha,
          golden.tolerance,
          `case ${c} set ${e} ${id}`,
        );
        checked++;
      }
    }
  });
  assert.ok(checked > 0);
});

// A canvas stand-in that records what was drawn.
function recorder() {
  const calls = [];
  const target = {};
  const ctx = new Proxy(target, {
    get(_, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient')
        return (...a) => {
          calls.push([key, ...a]);
          return { addColorStop: (...s) => calls.push(['stop', ...s]) };
        };
      return (...a) => calls.push([key, ...a]);
    },
    set(_, key, value) {
      target[key] = value;
      calls.push(['set', key, value]);
      return true;
    },
  });
  return { ctx, calls };
}

test('drawing builds each gradient once per scene and context when cached', () => {
  const { scene } = golden.cases[0];
  const { ctx, calls } = recorder();
  const cache = createSceneCache();
  drawScene(ctx, scene, {}, { x: 0, y: 0, w: 512, h: 512 }, cache);
  const first = calls.filter(([k]) => k.startsWith('create')).length;
  assert.ok(first > 0);
  drawScene(ctx, scene, { 'mouth.open': 0.5 }, { x: 0, y: 0, w: 512, h: 512 }, cache);
  assert.equal(calls.filter(([k]) => k.startsWith('create')).length, first);
  // Without a cache every frame rebuilds them, exactly as the reference renderer does.
  drawScene(ctx, scene, {}, { x: 0, y: 0, w: 512, h: 512 });
  assert.equal(calls.filter(([k]) => k.startsWith('create')).length, first * 2);
});

test('cached outlines are built once as Path2D objects, which have no beginPath', () => {
  const { scene } = golden.cases[0];
  let built = 0;
  globalThis.Path2D = class {
    constructor() {
      built++;
    }
    moveTo() {}
    lineTo() {}
    quadraticCurveTo() {}
    bezierCurveTo() {}
    closePath() {}
  };
  try {
    const { ctx, calls } = recorder();
    const cache = createSceneCache();
    drawScene(ctx, scene, {}, { x: 0, y: 0, w: 64, h: 64 }, cache);
    const first = built;
    assert.ok(first > 10);
    drawScene(ctx, scene, {}, { x: 0, y: 0, w: 64, h: 64 }, cache);
    assert.equal(built, first, 'a resting face rebuilds no outlines');
    assert.ok(calls.some(([k, p]) => k === 'fill' && p instanceof globalThis.Path2D));
  } finally {
    delete globalThis.Path2D;
  }
});

test('hidden shapes are skipped and every drawn shape saves and restores its state', () => {
  const { scene } = golden.cases[0];
  const { ctx, calls } = recorder();
  drawScene(ctx, scene, { 'eye.blink': 1, 'mouth.open': 1 }, { x: 0, y: 0, w: 100, h: 100 });
  const saves = calls.filter(([k]) => k === 'save').length;
  assert.equal(saves, calls.filter(([k]) => k === 'restore').length);
  const hidden = scene.shapes.filter(
    (s) => s.hide && s.hide.some(([n, a]) => ({ 'eye.blink': 1, 'mouth.open': 1 })[n] > a),
  );
  assert.equal(saves, scene.shapes.length - hidden.length);
});
