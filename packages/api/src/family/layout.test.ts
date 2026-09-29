/* Family history tree layout (Sep 29 2026, docs/FAMILY_HISTORY.md): the server's port of the web
 * page's layoutTree must lay out every slice exactly as the page does, in box units, on the
 * invented family in __fixtures__/history, and the timeline's lanes must never overlap.
 * THE REPOSITORY IS PUBLIC: every person here is made up.
 * Run from the repo root:
 * node --require <tsx cjs register> --test packages/api/src/family/layout.test.ts */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { FamilyBundle, FamilyView } from './history';
import { familyTreeSlice } from './history';
import { familyChooseParents, familyLanes, familyLayoutTree } from './layout';

const FIXTURES = join(__dirname, '__fixtures__', 'history');
const BUNDLE: FamilyBundle = JSON.parse(readFileSync(join(FIXTURES, 'bundle.json'), 'utf8'));
const VIEW: FamilyView = JSON.parse(readFileSync(join(FIXTURES, 'views', 'I100.json'), 'utf8'));

interface WebBox {
  key: string;
  id: string;
  gen: number;
  x: number;
  row: number;
  role: string;
  repeat: boolean;
}
interface WebLayout {
  focus: WebBox;
  boxes: WebBox[];
  lines: { kind: string; from: WebBox; to: WebBox }[];
  extraParents: { child: string; id: string; kind: string }[];
  siblings: string[];
  unplaced: { id: string }[];
}
/* The web page's script exports its pure parts under Node (history.js, "parts"). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web: { layoutTree: (tree: unknown, options: unknown) => WebLayout | null } = require('../../../../client/public/assets/family/history.js');

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function compare(bundle: FamilyBundle, focus: string, up: number, down: number): number {
  const tree = familyTreeSlice(bundle, VIEW, focus, up, down);
  assert.ok(tree, focus);
  const mine = familyLayoutTree(tree, { up, down });
  const theirs = web.layoutTree(tree, { up, down });
  assert.ok(mine && theirs, `${focus} ${up}/${down}`);
  const minX = Math.min(...theirs.boxes.map((box) => box.x));
  const expected = theirs.boxes.map((box) => ({
    key: box.key,
    id: box.id,
    gen: box.gen,
    row: box.row,
    x: box.x - minX,
    role: box.role,
    repeat: box.repeat,
  }));
  assert.deepEqual(mine.boxes, expected, `boxes ${focus} ${up}/${down}`);
  assert.equal(mine.focusKey, theirs.focus.key);
  assert.deepEqual(
    mine.edges,
    theirs.lines.filter((line) => line.kind !== 'couple').map((line) => ({ from: line.from.key, to: line.to.key, kind: line.kind })),
    `edges ${focus}`,
  );
  assert.deepEqual(
    mine.couples,
    theirs.lines.filter((line) => line.kind === 'couple').map((line) => [line.from.key, line.to.key]),
    `couples ${focus}`,
  );
  assert.deepEqual(
    mine.extraParents.map(({ child, id, kind }) => ({ child, id, kind })),
    theirs.extraParents,
  );
  assert.deepEqual(mine.siblings, theirs.siblings);
  assert.deepEqual(mine.unplaced, theirs.unplaced.map((node) => node.id));
  return mine.boxes.length;
}

test('the tree layout matches the web page box for box, for every person and depth', () => {
  let boxes = 0;
  for (const focus of Object.keys(BUNDLE.people)) {
    if (BUNDLE.people[focus].duplicateOf) continue;
    for (const [up, down] of [[0, 0], [1, 1], [3, 1], [4, 2], [8, 4]])
      boxes += compare(BUNDLE, focus, up, down);
  }
  assert.ok(boxes > 200, 'the comparison covered the whole invented family');
});

test('cousins who married: one person drawn twice gets two box keys, and the chart matches the page', () => {
  const cousins = clone(BUNDLE);
  /* invent a marriage of second cousins: the child's parents share the grandparent Hugo */
  cousins.people['@I600@'] = {
    id: '@I600@', name: 'Uma Example', label: 'Uma Example (1934-2000)', sex: 'F', lifespan: '1934-2000',
    parents: [{ id: '@I400@', kind: 'birth' }], spouses: ['@I610@'], children: ['@I601@'],
  };
  cousins.people['@I610@'] = { id: '@I610@', name: 'Vic Example', label: 'Vic Example', sex: 'M', lifespan: '', spouses: ['@I600@'], children: ['@I601@'] };
  cousins.people['@I601@'] = {
    id: '@I601@', name: 'Wren Example', label: 'Wren Example (1961-2019)', sex: 'F', lifespan: '1961-2019',
    parents: [{ id: '@I600@', kind: 'birth' }, { id: '@I610@', kind: 'birth' }], spouses: ['@I210@'], children: ['@I602@'],
  };
  cousins.people['@I400@'].children = ['@I300@', '@I600@'];
  cousins.people['@I210@'].spouses = ['@I211@', '@I601@'];
  cousins.people['@I210@'].children = ['@I602@'];
  cousins.people['@I602@'] = {
    id: '@I602@', name: 'Xan Example', label: 'Xan Example (born 1990)', sex: 'M', lifespan: 'born 1990',
    parents: [{ id: '@I210@', kind: 'birth' }, { id: '@I601@', kind: 'birth' }, { id: '@I110@', kind: 'step' }],
  };
  compare(cousins, '@I602@', 4, 0);
  const tree = familyTreeSlice(cousins, VIEW, '@I602@', 4, 0);
  const layout = tree ? familyLayoutTree(tree, { up: 4, down: 0 }) : null;
  const hugo = (layout?.boxes || []).filter((box) => box.id === '@I400@');
  assert.equal(hugo.length, 2, 'the shared great-grandfather is drawn on both lines');
  assert.deepEqual(hugo.map((box) => box.repeat).sort(), [false, true]);
  assert.notEqual(hugo[0].key, hugo[1].key);
  assert.deepEqual(layout?.extraParents.map((e) => [e.child, e.id, e.kind]), [['@I602@', '@I110@', 'step']], 'a stepfather is listed under the child, not drawn as a second father');
});

test('parents are chosen birth first, then adoptive, probable, doubtful and step; unknown sex fills the gaps', () => {
  const nodes = new Map([
    ['m1', { id: 'm1', sex: 'M' }],
    ['m2', { id: 'm2', sex: 'M' }],
    ['f1', { id: 'f1', sex: 'F' }],
    ['u1', { id: 'u1', sex: 'U' }],
  ]);
  assert.deepEqual(
    familyChooseParents([{ id: 'm1', kind: 'step' }, { id: 'm2', kind: 'birth' }, { id: 'f1', kind: 'doubtful' }], nodes),
    { chosen: [{ id: 'm2', kind: 'birth' }, { id: 'f1', kind: 'doubtful' }], extra: [{ id: 'm1', kind: 'step' }] },
  );
  assert.deepEqual(familyChooseParents([{ id: 'u1', kind: 'birth' }], nodes).chosen, [{ id: 'u1', kind: 'birth' }]);
  assert.deepEqual(familyChooseParents(undefined, nodes), { chosen: [], extra: [] });
});

test('timeline lanes: lifelines pack into as few lanes as possible and never overlap in a lane', () => {
  const bars = [
    { id: 'a', from: 1850, to: 1920 },
    { id: 'b', from: 1855, to: 1900 },
    { id: 'c', from: 1901, to: 1950 },
    { id: 'd', from: 1921, to: 1990 },
    { id: 'e', from: 1920, to: 1930 },
  ];
  const packed = familyLanes(bars);
  assert.equal(packed.lanes, 3);
  for (const x of bars)
    for (const y of bars) {
      if (x.id >= y.id || packed.lane.get(x.id) !== packed.lane.get(y.id)) continue;
      assert.ok(x.to < y.from || y.to < x.from, `${x.id} and ${y.id} share a lane without overlapping`);
    }
  assert.deepEqual(familyLanes([]), { lanes: 0, lane: new Map() });
});
