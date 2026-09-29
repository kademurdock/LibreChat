import { familyYear } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY LAYOUT (docs/FAMILY_HISTORY.md, "Tree layout")
 *
 * The family tree chart in box units, so the iPhone only multiplies by its box
 * size: a TypeScript port of layoutTree, chooseParents and byYear from the web
 * page (client/public/assets/family/history.js); layout.test.ts checks both give
 * the same boxes on the invented fixture family. Ancestors fan upward (the
 * father's line on the left), siblings stand left of the focus person, spouses
 * right, descendants below. Also the timeline's lanes.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyLayoutRole = 'focus' | 'ancestor' | 'sibling' | 'spouse' | 'descendant';

export interface FamilyLayoutNode {
  id: string;
  sex?: string | null;
  lifespan?: string;
}

export interface FamilyLayoutInput {
  focus: string;
  nodes: FamilyLayoutNode[];
  links: { parent: string; child: string; kind?: string }[];
  couples: [string, string][];
}

export interface FamilyLayoutBox {
  /** "<id>#<n>": a person drawn twice (cousins who married) has two boxes. */
  key: string;
  id: string;
  /** Generations above the focus person (negative below). */
  gen: number;
  /** Row from the top, 0 for the oldest generation shown. */
  row: number;
  /** Left edge in box units (a box and its gap are one unit wide). */
  x: number;
  role: FamilyLayoutRole;
  repeat: boolean;
}

export interface FamilyLayoutEdge {
  from: string;
  to: string;
  kind: string;
}

export interface FamilyLayoutExtraParent {
  /** The child's box (its first box). */
  childKey: string;
  child: string;
  id: string;
  kind: string;
}

export interface FamilyLayout {
  focusKey: string;
  boxes: FamilyLayoutBox[];
  edges: FamilyLayoutEdge[];
  couples: [string, string][];
  extraParents: FamilyLayoutExtraParent[];
  /** Box units across and rows down. */
  width: number;
  rows: number;
  siblings: string[];
  unplaced: string[];
}

const KIND_ORDER: Readonly<Record<string, number>> = {
  birth: 0,
  adopted: 1,
  probable: 2,
  doubtful: 3,
  step: 4,
};

interface Link {
  id: string;
  kind: string;
}

interface RawBox {
  key: string;
  id: string;
  gen: number;
  x: number;
  role: FamilyLayoutRole;
  repeat: boolean;
}

/** One father and one mother per person for the chart: birth first, then adoptive, probable,
 * doubtful, step. The rest are listed under the child as extra parents. */
export function familyChooseParents(
  list: Link[] | undefined,
  nodes: Map<string, FamilyLayoutNode>,
): { chosen: Link[]; extra: Link[] } {
  const rank = (kind: string): number => (KIND_ORDER[kind] == null ? 9 : KIND_ORDER[kind]);
  const sorted = (list || []).slice().sort((a, b) => rank(a.kind) - rank(b.kind));
  let father: Link | null = null;
  let mother: Link | null = null;
  const unknown: Link[] = [];
  for (const parent of sorted) {
    const sex = nodes.get(parent.id)?.sex;
    if (sex === 'M' && !father) father = parent;
    else if (sex === 'F' && !mother) mother = parent;
    else if (sex !== 'M' && sex !== 'F') unknown.push(parent);
  }
  for (const parent of unknown) {
    if (!father) father = parent;
    else if (!mother) mother = parent;
  }
  const chosen = [father, mother].filter((p): p is Link => !!p);
  return { chosen, extra: sorted.filter((p) => !chosen.includes(p)) };
}

function byYear(nodes: Map<string, FamilyLayoutNode>): (a: string, b: string) => number {
  return (a, b) => {
    const ya = familyYear(nodes.get(a)?.lifespan);
    const yb = familyYear(nodes.get(b)?.lifespan);
    if (ya == null && yb == null) return 0;
    if (ya == null) return 1;
    if (yb == null) return -1;
    return ya - yb;
  };
}

/** The tree slice laid out in box units; null when the focus person is not in the slice. */
export function familyLayoutTree(
  tree: FamilyLayoutInput,
  options: { up: number; down: number },
): FamilyLayout | null {
  const o = options;
  const nodes = new Map<string, FamilyLayoutNode>();
  for (const node of tree.nodes || []) nodes.set(node.id, node);
  if (!nodes.has(tree.focus)) return null;
  const parentsOf = new Map<string, Link[]>();
  const childrenOf = new Map<string, Link[]>();
  const push = (map: Map<string, Link[]>, key: string, value: Link): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const link of tree.links || []) {
    if (!nodes.has(link.parent) || !nodes.has(link.child) || link.parent === link.child) continue;
    push(parentsOf, link.child, { id: link.parent, kind: link.kind || 'birth' });
    push(childrenOf, link.parent, { id: link.child, kind: link.kind || 'birth' });
  }
  const boxes: RawBox[] = [];
  const edges: { from: RawBox; to: RawBox; kind: string }[] = [];
  const couples: { a: RawBox; b: RawBox }[] = [];
  const seen = new Set<string>();
  const extraParents: { child: string; id: string; kind: string }[] = [];
  const addBox = (id: string, gen: number, x: number, role: FamilyLayoutRole): RawBox => {
    const box: RawBox = { key: `${id}#${boxes.length}`, id, gen, x, role, repeat: seen.has(id) };
    seen.add(id);
    boxes.push(box);
    return box;
  };

  const placeUp = (
    id: string,
    gen: number,
    left: number,
    path: Set<string>,
  ): { width: number; box: RawBox } => {
    const pick =
      gen < o.up && !path.has(id)
        ? familyChooseParents(parentsOf.get(id), nodes)
        : { chosen: [] as Link[], extra: [] as Link[] };
    for (const parent of pick.extra)
      extraParents.push({ child: id, id: parent.id, kind: parent.kind });
    if (!pick.chosen.length)
      return { width: 1, box: addBox(id, gen, left + 0.5, gen ? 'ancestor' : 'focus') };
    const next = new Set(path);
    next.add(id);
    let cur = left;
    const placed = pick.chosen.map((parent) => {
      const result = placeUp(parent.id, gen + 1, cur, next);
      cur += result.width;
      return { box: result.box, kind: parent.kind };
    });
    const x = placed.reduce((sum, p) => sum + p.box.x, 0) / placed.length;
    const box = addBox(id, gen, x, gen ? 'ancestor' : 'focus');
    for (const p of placed) edges.push({ from: p.box, to: box, kind: p.kind });
    return { width: cur - left, box };
  };

  const focusBox = placeUp(tree.focus, 0, 0, new Set()).box;
  const parentBoxes = new Map<string, RawBox>();
  for (const edge of edges) if (edge.to === focusBox) parentBoxes.set(edge.from.id, edge.from);

  const siblingIds: string[] = [];
  for (const parent of parentsOf.get(tree.focus) || []) {
    for (const child of childrenOf.get(parent.id) || []) {
      if (child.id !== tree.focus && !siblingIds.includes(child.id)) siblingIds.push(child.id);
    }
  }
  siblingIds.sort(byYear(nodes));
  siblingIds.forEach((id, i) => {
    const box = addBox(id, 0, focusBox.x - (siblingIds.length - i), 'sibling');
    for (const parent of parentsOf.get(id) || []) {
      const from = parentBoxes.get(parent.id);
      if (from) edges.push({ from, to: box, kind: parent.kind });
    }
  });

  const spouseBoxes: RawBox[] = [];
  for (const pair of tree.couples || []) {
    if (!Array.isArray(pair) || !pair.includes(tree.focus)) continue;
    const other = pair[0] === tree.focus ? pair[1] : pair[0];
    if (!nodes.has(other) || other === tree.focus || siblingIds.includes(other)) continue;
    if (spouseBoxes.some((b) => b.id === other)) continue;
    const box = addBox(other, 0, focusBox.x + spouseBoxes.length + 1, 'spouse');
    spouseBoxes.push(box);
    couples.push({ a: focusBox, b: box });
  }

  const kidsOf = (id: string): string[] =>
    (childrenOf.get(id) || [])
      .map((c) => c.id)
      .filter((c, i, all) => all.indexOf(c) === i && c !== tree.focus && !siblingIds.includes(c))
      .sort(byYear(nodes));
  const widths = new Map<string, number>();
  const widthDown = (id: string, level: number, path: Set<string>): number => {
    const key = `${id}@${level}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const kids = level < o.down && !path.has(id) ? kidsOf(id) : [];
    const next = new Set(path);
    next.add(id);
    const width = Math.max(
      1,
      kids.reduce((sum, k) => sum + widthDown(k, level + 1, next), 0),
    );
    widths.set(key, width);
    return width;
  };
  const placeDown = (
    id: string,
    level: number,
    left: number,
    parentList: RawBox[] | null,
    path: Set<string>,
  ): RawBox => {
    const kids = level < o.down && !path.has(id) ? kidsOf(id) : [];
    const next = new Set(path);
    next.add(id);
    let cur = left;
    const placedKids: { id: string; left: number }[] = [];
    for (const kid of kids) {
      const width = widthDown(kid, level + 1, next);
      placedKids.push({ id: kid, left: cur });
      cur += width;
    }
    let x = left + 0.5;
    const childBoxes = placedKids.map((k) => placeDown(k.id, level + 1, k.left, null, next));
    if (childBoxes.length) x = childBoxes.reduce((sum, b) => sum + b.x, 0) / childBoxes.length;
    const box = addBox(id, -level, x, 'descendant');
    for (const child of childBoxes) {
      const link = (parentsOf.get(child.id) || []).find((p) => p.id === id);
      edges.push({ from: box, to: child, kind: link ? link.kind : 'birth' });
    }
    for (const parent of parentList || []) {
      const link = (parentsOf.get(id) || []).find((l) => l.id === parent.id);
      if (link) edges.push({ from: parent, to: box, kind: link.kind });
    }
    return box;
  };
  const kids = o.down > 0 ? kidsOf(tree.focus) : [];
  if (kids.length) {
    const total = kids.reduce((sum, k) => sum + widthDown(k, 1, new Set([tree.focus])), 0);
    const coParent = spouseBoxes.find((s) =>
      kids.some((k) => (parentsOf.get(k) || []).some((p) => p.id === s.id)),
    );
    const centre = coParent ? (focusBox.x + coParent.x) / 2 : focusBox.x;
    let cur = centre - total / 2;
    for (const kid of kids) {
      const width = widthDown(kid, 1, new Set([tree.focus]));
      placeDown(kid, 1, cur, [focusBox, ...spouseBoxes], new Set([tree.focus]));
      cur += width;
    }
  }

  let maxGen = 0;
  let minGen = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const box of boxes) {
    maxGen = Math.max(maxGen, box.gen);
    minGen = Math.min(minGen, box.gen);
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x);
  }
  const firstKey = new Map<string, string>();
  for (const box of boxes) if (!firstKey.has(box.id)) firstKey.set(box.id, box.key);
  const out: FamilyLayoutBox[] = boxes.map((box) => ({
    key: box.key,
    id: box.id,
    gen: box.gen,
    row: maxGen - box.gen,
    x: box.x - minX,
    role: box.role,
    repeat: box.repeat,
  }));
  out.sort((a, b) => a.row - b.row || a.x - b.x);
  return {
    focusKey: focusBox.key,
    boxes: out,
    edges: edges.map((edge) => ({ from: edge.from.key, to: edge.to.key, kind: edge.kind })),
    couples: couples.map((pair): [string, string] => [pair.a.key, pair.b.key]),
    extraParents: extraParents.map((extra) => ({
      childKey: firstKey.get(extra.child) || '',
      child: extra.child,
      id: extra.id,
      kind: extra.kind,
    })),
    width: boxes.length ? maxX - minX + 1 : 0,
    rows: maxGen - minGen + 1,
    siblings: siblingIds,
    unplaced: [...nodes.keys()].filter((id) => !seen.has(id)),
  };
}

export interface FamilyLaneBar {
  id: string;
  from: number;
  to: number;
}

/** Lifelines packed into as few lanes as possible, oldest first, a year apart at least. */
export function familyLanes(bars: FamilyLaneBar[]): { lanes: number; lane: Map<string, number> } {
  const sorted = bars
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ends: number[] = [];
  const lane = new Map<string, number>();
  for (const bar of sorted) {
    let at = ends.findIndex((end) => end < bar.from);
    if (at === -1) {
      at = ends.length;
      ends.push(bar.to);
    } else ends[at] = bar.to;
    lane.set(bar.id, at);
  }
  return { lanes: ends.length, lane };
}
