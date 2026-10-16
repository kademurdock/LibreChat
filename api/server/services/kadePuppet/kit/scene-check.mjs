// Structural check for a compiled scene (schema kade-puppet-scene/1). Returns a list of
// problems; an empty list means every renderer can draw it.
const LENS = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const HEX = /^#[0-9a-f]{6}$/i;

export function checkScene(scene) {
  const problems = [];
  const fail = (m) => {
    if (problems.length < 50) problems.push(m);
  };
  if (!scene || scene.schema !== 'kade-puppet-scene/1') fail('schema');
  if (!Array.isArray(scene?.size) || scene.size.length !== 2) fail('size');
  if (!Array.isArray(scene?.view) || scene.view.length !== 4) fail('view');
  const grads = scene?.gradients || {};
  for (const [id, g] of Object.entries(grads)) {
    if (!Array.isArray(g.stops) || g.stops.length < 2) fail(`gradient ${id} stops`);
    for (const st of g.stops || []) if (!HEX.test(st.color) || !(st.at >= 0 && st.at <= 1)) fail(`gradient ${id} stop`);
    // Points are exactly two finite numbers: the web and iPhone renderers reject anything else.
    const pt = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
    if (g.kind === 'linear' && !(pt(g.start) && pt(g.end))) fail(`gradient ${id} linear`);
    if (g.kind === 'radial' && !(pt(g.center) && Number.isFinite(g.radius) && g.radius > 0
      && (g.focal === undefined || pt(g.focal)))) fail(`gradient ${id} radial`);
    if (g.kind !== 'linear' && g.kind !== 'radial') fail(`gradient ${id} kind`);
  }
  const groups = new Set();
  for (const g of scene?.groups || []) {
    if (groups.has(g.id)) fail(`group ${g.id} duplicate`);
    if (g.parent && !groups.has(g.parent)) fail(`group ${g.id} parent ${g.parent} not earlier`);
    if (!Array.isArray(g.pivot) || g.pivot.length !== 2 || !g.pivot.every(Number.isFinite)) fail(`group ${g.id} pivot`);
    for (const k of ['tx', 'ty', 'r', 'sx', 'sy']) {
      if (g[k] !== undefined && (!Array.isArray(g[k]) || g[k].some((p) => typeof p[0] !== 'string' || !Number.isFinite(p[1])))) fail(`group ${g.id} drive ${k}`);
    }
    groups.add(g.id);
  }
  const shapes = new Set();
  const paint = (v) => v === undefined || v === 'none' || HEX.test(v) || Object.hasOwn(grads, v);
  const pathOk = (d) => Array.isArray(d) && d.length >= 2 && d[0].op === 'M' && d.every((c) => Object.hasOwn(LENS, c.op) && Array.isArray(c.v) && c.v.length === LENS[c.op] && c.v.every((n) => Number.isFinite(n) && n > -400 && n < 1400));
  let commands = 0;
  for (const s of scene?.shapes || []) {
    if (shapes.has(s.id)) fail(`shape ${s.id} duplicate`);
    if (!groups.has(s.g)) fail(`shape ${s.id} group ${s.g}`);
    if (!pathOk(s.d)) fail(`shape ${s.id} path`);
    commands += (s.d || []).length * (1 + (s.m || []).length);
    for (const m of s.m || []) {
      if (typeof m.c !== 'string' || !pathOk(m.d) || m.d.length !== s.d.length || m.d.some((c, i) => c.op !== s.d[i].op)) fail(`shape ${s.id} morph ${m.c}`);
    }
    if (!paint(s.fill) || !paint(s.stroke)) fail(`shape ${s.id} paint`);
    if (s.clip && !shapes.has(s.clip)) fail(`shape ${s.id} clip ${s.clip} not earlier`);
    if (s.op !== undefined && !(s.op >= 0 && s.op <= 1)) fail(`shape ${s.id} opacity`);
    shapes.add(s.id);
  }
  if ((scene?.shapes || []).length > 900) fail('too many shapes');
  if (commands > 60000) fail('too many path commands');
  return problems;
}
