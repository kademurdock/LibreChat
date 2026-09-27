/* ----------------------------------------------------------------------------
 * THE LIBRARY'S SHELF TREE (Part 296, Sep 27 2026)
 *
 * Kade, Sep 27: "I'd like it to work with voiceover kinda like how the regular
 * files app does ... the fact that it takes a minute to load things so it gives
 * misleading item counts at the beginning ... I just feel like I'm getting lost
 * in a stack of shelves and a maze of folders."
 *
 * GET /api/kade/reading-room/tree answers, in one call, every shelf the reader
 * can see with its honest item count, so the phone can show a whole level at
 * once and never says "0 clips" for a shelf that holds a thousand. This file is
 * the pure part: it turns the `{display path: items directly there}` rows of one
 * aggregation into the tree the phone walks, and applies the display rules.
 *
 * EVERY RULE HERE CHANGES ONLY WHAT IS SHOWN. Nothing is moved, renamed or
 * deleted; `path` on every node is the real shelf to pass to GET /archive.
 *   - Empty shelves never appear (a shelf exists only if something is under it).
 *   - A shelf of FLAT_MAX items or fewer is `flat`: the phone lists every item
 *     under it at once (GET /archive?deep=1), with the sub-shelf on each row,
 *     instead of a folder per decade holding one tape each.
 *   - A shelf holding nothing but one other shelf is skipped; the row says both
 *     names ("Ozarks (Springfield Area), Radio Airchecks") and opens the deeper.
 *     A name that only repeats the one before it is dropped
 *     ("American Dad! - Season 02 (2006)" then "Season 2" reads once).
 *   - Names sort ignoring capitals, numbers in number order, so decades run
 *     oldest first; Undated, Multiple decades and "Other ..." go last.
 *   - An archive.org slug reads as words; a lowercase first letter is capitalised.
 *   - The librarian's holding shelves (Needs Filing, Archive Intake, anything
 *     ending "(Review)") are gathered into one "Not filed yet" row, last under
 *     each of Videos, Audio and Books. Its rows open the real holding shelves.
 *   - `local` gathers Springfield and the Ozarks onto one screen: the local
 *     video kinds, local audio, and Missouri's Springfield & Ozarks branch.
 *   - A few shelves whose real names mislead read under a display name
 *     (kadeReadingRoomLabels.js SHELF_NAMES): the described MP3 shelf reads
 *     "Described audio movies and TV", its Movies and TV shelves "Described audio
 *     movies" and "Described audio TV". A display name is a whole name, so the
 *     repeat check never drops it; a display name right after its own parent's
 *     replaces it ("Described audio TV", not "Described audio movies and TV,
 *     Described audio TV").
 *
 * Node shape: { id, name, path, count, direct, shelves, flat, children }
 *   id       the real path, or "#..." for a gathered (virtual) row; unique within `roots`
 *            (a Springfield row repeats the id of the shelf it opens)
 *   path     the real deepest shelf ('' on a virtual row, which has no items of its own)
 *   count    every item underneath
 *   direct   items sitting on `path` itself (what /archive pages through)
 *   shelves  children.length
 *   flat     list everything under it with /archive?deep=1 (children is then [])
 *   virtual  true on a gathered row ("Not filed yet", "Springfield and the Ozarks")
 *   medium   'video' | 'audio' on the Springfield rows
 * -------------------------------------------------------------------------- */

const labels = require('./kadeReadingRoomLabels');

const FLAT_MAX = 20;
const TREE_VERSION = 1;
/** The three first-screen shelves, always present and always in this order. */
const ROOTS = ['Videos', 'Audio', 'Books'];
/** The librarian's holding shelves (the media sweep's intake names that are not real shelves). */
const HOLDING = /^(?:needs filing|archive intake)$|\(review\)$/i;
/** Loose decade shelves sitting beside the kinds of a local shelf. */
const DECADE = /^(?:\d{4}s|undated|multiple decades)$/i;
const LOCAL_VIDEO = 'Videos/Ozarks (Springfield Area)';
const LOCAL_AUDIO = 'Audio/Ozarks (Springfield Area)';
const LOCAL_MISSOURI = 'Videos/Missouri/Springfield & Ozarks';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** How a shelf's name is read. Display only: the shelf keeps its real name in `path`. */
function tidyName(segment) {
  let s = String(segment == null ? '' : segment).trim();
  if (!s) return 'Untitled shelf';
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}$/.test(s)) s = s.replace(/-/g, ' ');
  return s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** Words for the repeat check: case, punctuation and leading zeros ignored ("Season 02" = "season 2"). */
function nameWords(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/^0+(?=\d)/, ''));
}

/** One part of a row's name: a real shelf's display name ({ text, shown: true }) or its raw segment. */
function partFor(path, segment) {
  const shown = labels.shelfName(path);
  return shown ? { text: shown, shown: true } : segment;
}

/** How a folder is named in an /archive answer: the display name, or the real segment as before. */
function folderName(path, segment) {
  return labels.shelfName(path) || segment;
}

/**
 * "A, B, C" for a skipped chain, leaving out a part that only repeats the one before it.
 * A part may be a display name ({ text, shown: true }): it is never dropped, and it replaces a
 * display name right before it (its own parent's), so the row reads the deeper, truer name.
 */
function joinNames(parts) {
  const kept = [];
  for (const raw of parts) {
    const shown = !!(raw && typeof raw === 'object' && raw.shown);
    const part = shown ? String(raw.text) : tidyName(raw);
    const prev = kept[kept.length - 1];
    if (prev && shown && prev.shown) {
      kept[kept.length - 1] = { text: part, shown };
      continue;
    }
    if (prev && !shown) {
      const words = nameWords(part);
      const before = new Set(nameWords(prev.text));
      if (words.length && words.every((w) => before.has(w))) continue;
    }
    kept.push({ text: part, shown });
  }
  return kept.map((k) => k.text).join(', ');
}

/** 0 ordinary, then Undated, Multiple decades, "Other ..." at the end. */
function tailRank(name) {
  const n = String(name).trim().toLowerCase();
  if (n === 'undated' || n.startsWith('undated,')) return 1;
  if (n === 'multiple decades' || n.startsWith('multiple decades,')) return 2;
  if (/^other\b/.test(n)) return 3;
  return 0;
}

/** The one order every shelf list uses (stable: a plain comparison breaks every tie). */
function compareNames(a, b) {
  const x = String(a);
  const y = String(b);
  return tailRank(x) - tailRank(y) || collator.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
}

const sortNodes = (nodes) => nodes.sort((a, b) => compareNames(a.name, b.name));

/** Where an item sits below the shelf it was listed from, as words ("Bumpers, 1990s"); '' when on it. */
function subShelf(at, itemPath) {
  const base = String(at || '');
  const p = String(itemPath || '');
  if (p === base) return '';
  const inside = base && p.startsWith(base + '/');
  const rest = base ? (inside ? p.slice(base.length + 1) : p) : p;
  if (!rest) return '';
  let real = inside ? base : '';
  return joinNames(rest.split('/').map((seg) => {
    real = real ? real + '/' + seg : seg;
    return partFor(real, seg);
  }));
}

/** The shelves above and at `at`, each with the name it reads under and its real path (for breadcrumbs). */
function crumbs(at) {
  const out = [];
  let real = '';
  for (const seg of String(at || '').split('/').filter(Boolean)) {
    real = real ? real + '/' + seg : seg;
    out.push({ name: labels.shelfName(real) || tidyName(seg), path: real });
  }
  return out;
}

/* ── the raw tree: one node per real shelf, with the items directly on it ── */
function rawNode(segment, path) {
  return { seg: segment, path, direct: 0, count: 0, pulled: false, kids: new Map() };
}

function rawTree(rows) {
  const roots = new Map(ROOTS.map((r) => [r, rawNode(r, r)]));
  for (const row of rows) {
    const path = String(row[0] == null ? '' : row[0]);
    const n = Number(row[1]) || 0;
    if (!path || n <= 0) continue;
    const parts = path.split('/');
    let cur = roots.get(parts[0]);
    if (!cur) {
      // libraryPath always starts Videos, Audio or Books; anything else is still shown, never lost
      cur = rawNode(parts[0], parts[0]);
      roots.set(parts[0], cur);
    }
    for (let i = 1; i < parts.length; i++) {
      let next = cur.kids.get(parts[i]);
      if (!next) {
        next = rawNode(parts[i], cur.path + '/' + parts[i]);
        cur.kids.set(parts[i], next);
      }
      cur = next;
    }
    cur.direct += n;
  }
  return roots;
}

function recount(node) {
  node.count = node.direct;
  for (const kid of node.kids.values()) node.count += recount(kid);
  return node.count;
}

/** Lift every holding shelf out of a root (the topmost one of a nest), marking the shelves it left. */
function pullHolding(root) {
  const pulled = [];
  const walk = (node, trail, above) => {
    for (const [segment, kid] of [...node.kids]) {
      if (HOLDING.test(String(segment).trim())) {
        node.kids.delete(segment);
        pulled.push({ node: kid, trail: [...trail, segment] });
        for (const a of above) a.pulled = true;
        node.pulled = true;
      } else {
        walk(kid, [...trail, segment], [...above, node]);
      }
    }
  };
  walk(root, [], []);
  return pulled;
}

const visibleKids = (node) => [...node.kids.values()].filter((k) => k.count > 0);
/** A shelf whose holding shelves were lifted out is never flat: /archive?deep=1 would list them again. */
const isFlat = (node) => node.count <= FLAT_MAX && !node.pulled;

function shapeNode(node, parts) {
  const flat = isFlat(node);
  const children = flat ? [] : sortNodes(visibleKids(node).map((k) => shapeChild(k, [partFor(k.path, k.seg)])));
  return { id: node.path, name: joinNames(parts), path: node.path, count: node.count, direct: node.direct, shelves: children.length, flat, children };
}

/** A child row, skipping down a chain of shelves that each hold only one shelf. */
function shapeChild(node, parts) {
  let cur = node;
  const names = [...parts];
  for (;;) {
    if (isFlat(cur) || cur.direct > 0) break;
    const kids = visibleKids(cur);
    if (kids.length !== 1) break;
    cur = kids[0];
    names.push(partFor(cur.path, cur.seg));
  }
  return shapeNode(cur, names);
}

function gathered(id, name, children, count, extra) {
  return { id, name, path: '', count, direct: 0, shelves: children.length, flat: false, virtual: true, children, ...(extra || {}) };
}

function findRaw(roots, path) {
  const parts = String(path).split('/');
  let cur = roots.get(parts[0]);
  for (let i = 1; cur && i < parts.length; i++) cur = cur.kids.get(parts[i]);
  return cur && cur.count > 0 ? cur : null;
}

/** Springfield and the Ozarks on one screen. Each row opens its real shelf. */
function localNode(roots) {
  const rows = [];
  let count = 0;
  for (const [medium, path, other, all] of [
    ['video', LOCAL_VIDEO, 'Other local video', 'All local video'],
    ['audio', LOCAL_AUDIO, 'Other local audio', 'All local audio'],
  ]) {
    const node = findRaw(roots, path);
    if (!node) continue;
    count += node.count;
    const kinds = [];
    const loose = [];
    for (const kid of visibleKids(node)) (DECADE.test(String(kid.seg).trim()) ? loose : kinds).push(kid);
    rows.push(...sortNodes(kinds.map((k) => ({ ...shapeChild(k, [partFor(k.path, k.seg)]), medium }))));
    if (node.direct > 0) {
      // items sit on the local shelf itself: the only honest way to reach them is the whole shelf
      rows.push({ ...shapeNode(node, [all]), medium });
    } else if (loose.length === 1) {
      rows.push({ ...shapeChild(loose[0], [other, partFor(loose[0].path, loose[0].seg)]), medium });
    } else if (loose.length) {
      const kids = sortNodes(loose.map((k) => ({ ...shapeChild(k, [partFor(k.path, k.seg)]), medium })));
      rows.push(gathered(`#local/${medium}`, other, kids, kids.reduce((n, k) => n + k.count, 0), { medium }));
    }
  }
  const missouri = findRaw(roots, LOCAL_MISSOURI);
  if (missouri) {
    count += missouri.count;
    rows.push({ ...shapeChild(missouri, ['Missouri', partFor(missouri.path, missouri.seg)]), medium: 'video' });
  }
  return rows.length ? gathered('#local', 'Springfield and the Ozarks', rows, count) : null;
}

/**
 * rows: [displayPath, itemsDirectlyThere] pairs (the /tree aggregation's output).
 * options.local: include the Springfield screen (the family library only).
 */
function buildTree(rows, options = {}) {
  const roots = rawTree(rows || []);
  const out = [];
  let total = 0;
  const pulledByRoot = new Map();
  for (const root of roots.values()) {
    recount(root);
    pulledByRoot.set(root, pullHolding(root));
    recount(root);
  }
  for (const root of roots.values()) {
    const pulled = pulledByRoot.get(root);
    const node = shapeNode(root, [partFor(root.path, root.seg)]);
    if (pulled.length) {
      const kids = sortNodes(pulled.map((p) => shapeChild(p.node, p.trail.map((seg, i) => partFor([root.path, ...p.trail.slice(0, i + 1)].join('/'), seg)))));
      const n = kids.reduce((sum, k) => sum + k.count, 0);
      const group = kids.length === 1
        ? { ...kids[0], name: 'Not filed yet' }
        : gathered(`#not-filed/${root.path}`, 'Not filed yet', kids, n);
      node.children.push(group);
      node.shelves = node.children.length;
      node.count += n;
      node.flat = false;
    }
    total += node.count;
    out.push(node);
  }
  return {
    treeVersion: TREE_VERSION,
    flatMax: FLAT_MAX,
    total,
    roots: out,
    local: options.local ? localNode(roots) : null,
  };
}

/* ── the cache: one tree per (scope, reader kind), cleared by any library write ── */
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 300;
const cache = new Map();
/** Bumped by every forget(): a tree counted while a write landed is answered but never kept. */
let generation = 0;
const currentGeneration = () => generation;

function cached(key, now = Date.now()) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

/** `counted` is currentGeneration() from before the tree's aggregation started. */
function remember(key, body, now = Date.now(), counted = generation) {
  if (counted !== generation) return body;
  cache.delete(key);
  cache.set(key, { at: now, body });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return body;
}

/** Any write that can move, add, share or remove an item empties every cached tree. */
function forget() {
  generation++;
  cache.clear();
}

/** Library POSTs that never change what is on a shelf (a reader's place, bookmarks, questions, playlists). */
const QUIET_WRITES = /^\/book\/[^/]+\/(?:progress|bookmarks|ask|recap)(?:\/|$)|^\/collections(?:\/|$)/;
function writeClears(method, path) {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !QUIET_WRITES.test(String(path || ''));
}

module.exports = {
  FLAT_MAX,
  TREE_VERSION,
  buildTree,
  tidyName,
  joinNames,
  compareNames,
  subShelf,
  crumbs,
  folderName,
  typeLabel: labels.typeLabel,
  shelfName: labels.shelfName,
  cached,
  remember,
  forget,
  currentGeneration,
  writeClears,
};
