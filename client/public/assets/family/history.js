/* Family history (Sep 29 2026). Contract: docs/FAMILY_HISTORY.md.
 *
 * One page, hash routes so Back works: #/ (start), #/tree/<id>, #/person/<id>,
 * #/people, #/stories, #/story/<slug>, #/findings, and #/accounts for the
 * owner. Every word about the family comes from /api/kade/family-history;
 * nothing here is family data.
 *
 * Relationship words are always relative to the VIEWER: the API sends bare
 * terms ("grandmother", "husband of your great-aunt, ...") and relText()
 * turns them into "your grandmother". A guest, or a family member whose own
 * view is not built yet, sees the tree from the owner's place, and the words
 * say whose place it is.
 *
 * Nothing is built with innerHTML: every name, caption and story line is set
 * with textContent, so a record transcription or a story can never inject
 * markup. Links in stories are limited to http(s), mailto and in-page routes.
 *
 * The pure helpers at the top (layout, relationship words, markdown parsing)
 * are also loaded by api/server/routes/kadeFamilyHistoryPage.nodetest.js. */
(function () {
  'use strict';

  /* ── pure helpers ─────────────────────────────────────────────────────── */

  var KIND_ORDER = { birth: 0, adopted: 1, probable: 2, doubtful: 3, step: 4 };
  var KIND_WORD = {
    adopted: 'adoptive',
    step: 'step',
    probable: 'probable, a research finding',
    doubtful: 'doubtful, a research finding',
  };
  var PARENT_WORD = {
    adopted: 'adoptive parent',
    step: 'step-parent',
    probable: 'probable parent, a research finding',
    doubtful: 'doubtful parent, a research finding',
  };
  var CHILD_WORD = {
    adopted: 'adopted child',
    step: 'stepchild',
    probable: 'probable child, a research finding',
    doubtful: 'doubtful child, a research finding',
  };
  var SIBLING_WORD = {
    half: 'half-sibling',
    step: 'step-sibling',
    adopted: 'adoptive sibling',
    probable: 'probable sibling, a research finding',
    doubtful: 'doubtful sibling, a research finding',
  };

  /* The word for how a family member on a person's page is linked:
   * "stepchild", "half-sibling", "doubtful parent, a research finding". */
  function memberWord(group, kind) {
    var words = { parents: PARENT_WORD, children: CHILD_WORD, siblings: SIBLING_WORD }[group] || KIND_WORD;
    return kind && Object.prototype.hasOwnProperty.call(words, kind) ? words[kind] : '';
  }
  var SIDE_TAG = {
    self: 'You',
    father: 'Father’s side',
    mother: 'Mother’s side',
    both: 'Both parents’ side',
    marriage: 'By marriage',
    research: 'Research finding',
    descendant: 'Descendant',
    blood: 'Blood relative',
    none: 'No known link',
  };

  function ordinal(n) {
    var v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }

  function generationName(gen) {
    if (gen === 1) return 'Parents';
    if (gen === 2) return 'Grandparents';
    if (gen === 3) return 'Great-grandparents';
    return ordinal(gen - 2) + ' great-grandparents';
  }

  function descendantName(level) {
    if (level === 1) return 'Children';
    if (level === 2) return 'Grandchildren';
    if (level === 3) return 'Great-grandchildren';
    return ordinal(level - 2) + ' great-grandchildren';
  }

  function nameOf(item) {
    if (!item) return 'Someone';
    if (item.name) return String(item.name);
    var label = String(item.label || item.id || 'Someone');
    var span = item.lifespan ? ' (' + item.lifespan + ')' : '';
    if (span && label.slice(-span.length) === span) return label.slice(0, -span.length);
    return label;
  }

  function firstName(name) {
    var n = String(name || '').trim().split(/\s+/)[0];
    return n || 'Someone';
  }

  function yearOf(text) {
    var m = /(\d{4})/.exec(String(text || ''));
    return m ? Number(m[1]) : null;
  }

  function relOf(x) {
    if (!x) return null;
    if (typeof x === 'string') return { term: x };
    if (typeof x === 'object' && x.term) return x;
    return null;
  }

  /* "grandmother" -> "your grandmother", or "Ada's grandmother" when the
   * tree is seen from someone else's place (anchor). */
  function relText(relation, anchor) {
    var r = relOf(relation);
    if (!r) return '';
    var term = String(r.term).trim();
    if (!term) return '';
    if (/^you$/i.test(term) || r.group === 'self') return anchor || 'you';
    if (anchor) {
      var poss = anchor + '’s';
      if (/(^|\s)your\s/i.test(term)) return term.replace(/(^|\s)your(?=\s)/gi, function (m, lead) { return lead + poss; });
      return poss + ' ' + term;
    }
    if (/(^|\s)your\s/i.test(term)) return term;
    return 'your ' + term;
  }

  function capital(text) {
    var s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /* The owner's view file writes a line as "your mother Ada -> ...", but a
   * family member's own view writes it with their name ("Cora Example's
   * mother Ada -> ..."). Said to that family member, it is "your mother". */
  function ownWords(text, selfName) {
    var t = String(text || '');
    var n = String(selfName || '');
    if (!n || t.slice(0, n.length) !== n) return t;
    var rest = t.slice(n.length);
    return /^['’]s\s/.test(rest) ? 'your ' + rest.slice(3) : t;
  }

  /* Which side of the family: from the path's first step (the viewer's
   * father or mother), falling back to the path text the export writes. */
  function sideOf(relation, sides) {
    var r = relOf(relation);
    if (!r) return 'none';
    if (r.group === 'self' || /^you$/i.test(r.term)) return 'self';
    if (r.group === 'marriage') return 'marriage';
    if (r.group === 'descendant') return 'descendant';
    var path = Array.isArray(r.path) ? r.path : [];
    var f = sides && sides.father;
    var m = sides && sides.mother;
    var a = path[1];
    var b = path[2];
    if (a && f && m && ((a === f && b === m) || (a === m && b === f))) return 'both';
    if (a && f && a === f) return 'father';
    if (a && m && a === m) return 'mother';
    var text = ownWords(r.pathText, sides && sides.selfName);
    if (/^your father\b/i.test(text)) return 'father';
    if (/^your mother\b/i.test(text)) return 'mother';
    if (r.term === 'father') return 'father';
    if (r.term === 'mother') return 'mother';
    if (r.group === 'ancestor' || r.group === 'blood') return 'blood';
    return 'none';
  }

  function isResearch(relation, node) {
    var r = relOf(relation);
    var notes = (r && Array.isArray(r.notes)) ? r.notes : [];
    for (var i = 0; i < notes.length; i++) {
      if (/^research finding/i.test(String(notes[i]))) return true;
    }
    return !!(node && node.virtual);
  }

  function categoryOf(relation, node, sides) {
    return isResearch(relation, node) ? 'research' : sideOf(relation, sides);
  }

  /* One father and one mother per person for the chart: birth first, then
   * adoptive, probable, doubtful, step. The rest go to the text version. */
  function chooseParents(list, nodes) {
    var sorted = (list || []).slice().sort(function (a, b) {
      return (KIND_ORDER[a.kind] == null ? 9 : KIND_ORDER[a.kind]) - (KIND_ORDER[b.kind] == null ? 9 : KIND_ORDER[b.kind]);
    });
    var father = null;
    var mother = null;
    var unknown = [];
    sorted.forEach(function (p) {
      var sex = (nodes.get(p.id) || {}).sex;
      if (sex === 'M' && !father) father = p;
      else if (sex === 'F' && !mother) mother = p;
      else if (sex !== 'M' && sex !== 'F') unknown.push(p);
    });
    unknown.forEach(function (p) {
      if (!father) father = p;
      else if (!mother) mother = p;
    });
    var chosen = [father, mother].filter(Boolean);
    var extra = sorted.filter(function (p) { return chosen.indexOf(p) === -1; });
    return { chosen: chosen, extra: extra };
  }

  function byYear(nodes) {
    return function (a, b) {
      var ya = yearOf((nodes.get(a) || {}).lifespan);
      var yb = yearOf((nodes.get(b) || {}).lifespan);
      if (ya == null && yb == null) return 0;
      if (ya == null) return 1;
      if (yb == null) return -1;
      return ya - yb;
    };
  }

  /* Lays the /tree answer out in rows: ancestors fan upward (father's line
   * on the left), siblings to the left of the focus person, spouses to the
   * right, descendants below. Positions are in box-width units first, so no
   * two boxes in a row can overlap, then turned into pixels. */
  function layoutTree(tree, options) {
    var o = Object.assign({ up: 4, down: 2, boxW: 184, boxH: 88, gapX: 18, rowH: 136, margin: 24 }, options || {});
    var nodes = new Map();
    (tree.nodes || []).forEach(function (n) { nodes.set(n.id, n); });
    var parentsOf = new Map();
    var childrenOf = new Map();
    function push(map, key, value) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    }
    (tree.links || []).forEach(function (l) {
      if (!nodes.has(l.parent) || !nodes.has(l.child) || l.parent === l.child) return;
      push(parentsOf, l.child, { id: l.parent, kind: l.kind || 'birth' });
      push(childrenOf, l.parent, { id: l.child, kind: l.kind || 'birth' });
    });
    var boxes = [];
    var edges = [];
    var couples = [];
    var seen = new Set();
    var extraParents = [];
    function addBox(id, gen, x, role) {
      var box = { key: id + '#' + boxes.length, id: id, gen: gen, x: x, role: role, node: nodes.get(id), repeat: seen.has(id) };
      seen.add(id);
      boxes.push(box);
      return box;
    }
    function placeUp(id, gen, left, path) {
      var pick = gen < o.up && !path.has(id) ? chooseParents(parentsOf.get(id), nodes) : { chosen: [], extra: [] };
      pick.extra.forEach(function (p) { extraParents.push({ child: id, id: p.id, kind: p.kind }); });
      if (!pick.chosen.length) return { width: 1, box: addBox(id, gen, left + 0.5, gen ? 'ancestor' : 'focus') };
      var next = new Set(path);
      next.add(id);
      var cur = left;
      var placed = pick.chosen.map(function (p) {
        var r = placeUp(p.id, gen + 1, cur, next);
        cur += r.width;
        return { box: r.box, kind: p.kind };
      });
      var x = placed.reduce(function (s, p) { return s + p.box.x; }, 0) / placed.length;
      var box = addBox(id, gen, x, gen ? 'ancestor' : 'focus');
      placed.forEach(function (p) { edges.push({ from: p.box, to: box, kind: p.kind }); });
      return { width: cur - left, box: box };
    }
    if (!nodes.has(tree.focus)) return null;
    var focusBox = placeUp(tree.focus, 0, 0, new Set()).box;
    var parentBoxes = new Map();
    edges.forEach(function (e) { if (e.to === focusBox) parentBoxes.set(e.from.id, e.from); });

    var siblingIds = [];
    (parentsOf.get(tree.focus) || []).forEach(function (p) {
      (childrenOf.get(p.id) || []).forEach(function (c) {
        if (c.id !== tree.focus && siblingIds.indexOf(c.id) === -1) siblingIds.push(c.id);
      });
    });
    siblingIds.sort(byYear(nodes));
    siblingIds.forEach(function (id, i) {
      var box = addBox(id, 0, focusBox.x - (siblingIds.length - i), 'sibling');
      (parentsOf.get(id) || []).forEach(function (p) {
        if (parentBoxes.has(p.id)) edges.push({ from: parentBoxes.get(p.id), to: box, kind: p.kind });
      });
    });

    var spouseBoxes = [];
    (tree.couples || []).forEach(function (pair) {
      if (!Array.isArray(pair) || pair.indexOf(tree.focus) === -1) return;
      var other = pair[0] === tree.focus ? pair[1] : pair[0];
      if (!nodes.has(other) || other === tree.focus || siblingIds.indexOf(other) !== -1) return;
      if (spouseBoxes.some(function (b) { return b.id === other; })) return;
      var box = addBox(other, 0, focusBox.x + spouseBoxes.length + 1, 'spouse');
      spouseBoxes.push(box);
      couples.push({ a: focusBox, b: box });
    });

    function kidsOf(id) {
      return (childrenOf.get(id) || []).map(function (c) { return c.id; })
        .filter(function (c, i, all) { return all.indexOf(c) === i && c !== tree.focus && siblingIds.indexOf(c) === -1; })
        .sort(byYear(nodes));
    }
    var widths = new Map();
    function widthDown(id, level, path) {
      var key = id + '@' + level;
      if (widths.has(key)) return widths.get(key);
      var kids = level < o.down && !path.has(id) ? kidsOf(id) : [];
      var next = new Set(path);
      next.add(id);
      var w = Math.max(1, kids.reduce(function (s, k) { return s + widthDown(k, level + 1, next); }, 0));
      widths.set(key, w);
      return w;
    }
    function placeDown(id, level, left, parentList, path) {
      var kids = level < o.down && !path.has(id) ? kidsOf(id) : [];
      var next = new Set(path);
      next.add(id);
      var cur = left;
      var placedKids = [];
      kids.forEach(function (k) {
        var w = widthDown(k, level + 1, next);
        placedKids.push({ id: k, left: cur });
        cur += w;
      });
      var x = left + 0.5;
      var childBoxes = placedKids.map(function (k) { return placeDown(k.id, level + 1, k.left, null, next); });
      if (childBoxes.length) x = childBoxes.reduce(function (s, b) { return s + b.x; }, 0) / childBoxes.length;
      var box = addBox(id, -level, x, 'descendant');
      childBoxes.forEach(function (c) {
        var link = (parentsOf.get(c.id) || []).filter(function (p) { return p.id === id; })[0];
        edges.push({ from: box, to: c, kind: link ? link.kind : 'birth' });
      });
      (parentList || []).forEach(function (p) {
        var link = (parentsOf.get(id) || []).filter(function (l) { return l.id === p.id; })[0];
        if (link) edges.push({ from: p, to: box, kind: link.kind });
      });
      return box;
    }
    var kids = o.down > 0 ? kidsOf(tree.focus) : [];
    if (kids.length) {
      var total = kids.reduce(function (s, k) { return s + widthDown(k, 1, new Set([tree.focus])); }, 0);
      var coParent = spouseBoxes.filter(function (s) {
        return kids.some(function (k) { return (parentsOf.get(k) || []).some(function (p) { return p.id === s.id; }); });
      })[0];
      var centre = coParent ? (focusBox.x + coParent.x) / 2 : focusBox.x;
      var cur = centre - total / 2;
      kids.forEach(function (k) {
        var w = widthDown(k, 1, new Set([tree.focus]));
        placeDown(k, 1, cur, [focusBox].concat(spouseBoxes), new Set([tree.focus]));
        cur += w;
      });
    }

    var maxGen = 0;
    var minX = Infinity;
    var maxX = -Infinity;
    var minGen = 0;
    boxes.forEach(function (b) {
      if (b.gen > maxGen) maxGen = b.gen;
      if (b.gen < minGen) minGen = b.gen;
      if (b.x < minX) minX = b.x;
      if (b.x > maxX) maxX = b.x;
    });
    var unit = o.boxW + o.gapX;
    boxes.forEach(function (b) {
      b.row = maxGen - b.gen;
      b.left = o.margin + (b.x - minX) * unit;
      b.top = o.margin + b.row * o.rowH;
      b.cx = b.left + o.boxW / 2;
      b.cy = b.top + o.boxH / 2;
    });
    var lines = edges.map(function (e) {
      var childTop = e.to.top;
      var parentBottom = e.from.top + o.boxH;
      var mid = childTop - (o.rowH - o.boxH) / 2;
      return {
        kind: e.kind,
        from: e.from,
        to: e.to,
        d: 'M' + e.to.cx + ' ' + childTop + 'V' + mid + 'H' + e.from.cx + 'V' + parentBottom,
      };
    });
    couples.forEach(function (c) {
      var y = c.a.top + o.boxH / 2;
      lines.push({ kind: 'couple', from: c.a, to: c.b, d: 'M' + (c.a.left + o.boxW) + ' ' + y + 'H' + c.b.left });
    });
    var unplaced = [];
    nodes.forEach(function (n, id) { if (!seen.has(id)) unplaced.push(n); });
    boxes.sort(function (a, b) { return a.row - b.row || a.x - b.x; });
    return {
      focus: focusBox,
      boxes: boxes,
      lines: lines,
      extraParents: extraParents,
      unplaced: unplaced,
      siblings: siblingIds,
      maxGen: maxGen,
      depth: -minGen,
      width: o.margin * 2 + (maxX - minX) * unit + o.boxW,
      height: o.margin * 2 + (maxGen - minGen) * o.rowH + o.boxH,
      box: { w: o.boxW, h: o.boxH },
    };
  }

  /* Whose child a box in the chart is, in words, from the lines the chart
   * draws to it: "daughter of Cora Example and Jon Partner (step)". The text
   * version says it so a listener knows which child a grandchild belongs to
   * and which spouse is a child's other parent. */
  function parentWords(b, layout) {
    var ups = layout.lines.filter(function (l) { return l.kind !== 'couple' && l.to === b; });
    if (!ups.length) return '';
    var sex = (b.node || {}).sex;
    var word = sex === 'M' ? 'son' : sex === 'F' ? 'daughter' : 'child';
    return word + ' of ' + ups.map(function (l) {
      return nameOf(l.from.node) + (KIND_WORD[l.kind] ? ' (' + KIND_WORD[l.kind] + ')' : '');
    }).join(' and ');
  }

  /* ── safe markdown: text only, never raw HTML ─────────────────────────── */

  var FILE_END = /\.(json|md|txt|pdf|jpe?g|png|gif|webp|tiff?|html?|csv|ged|xml|docx?)$/i;

  function isSourcePath(inner) {
    var t = String(inner || '').trim();
    if (!t || t.length > 400 || /^\s*[xX ]\s*$/.test(t)) return false;
    return t.split(/\s*;\s*/).every(function (p) {
      return !!p && !/\s{2,}/.test(p) && (/[\/\\]/.test(p) || FILE_END.test(p)) && !/^https?:/i.test(p);
    });
  }

  function safeHref(href) {
    var h = String(href || '').trim();
    if (/[\u0000-\u001f\u007f]/.test(h)) return null;
    if (/^https?:\/\/[^\s]+$/i.test(h)) return h;
    if (/^mailto:[^\s]+$/i.test(h)) return h;
    if (/^#\/[^\s]*$/.test(h)) return h;
    return null;
  }

  /* Record and memorial addresses come from scraped pages: only a web
   * address ever becomes a link. */
  function webHref(href) {
    var h = safeHref(href);
    return h && /^https?:\/\//i.test(h) ? h : null;
  }

  function closingBracket(src, open) {
    var depth = 0;
    for (var i = open; i < src.length; i++) {
      var c = src.charAt(i);
      if (c === '\\') { i++; continue; }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) return i;
    }
    return -1;
  }

  function emphasisEnd(src, from, mark) {
    if (from >= src.length || /\s/.test(src.charAt(from))) return -1;
    for (var j = from + 1; j < src.length; j++) {
      if (src.charAt(j) === '\\') { j++; continue; }
      if (src.charAt(j) !== mark || /\s/.test(src.charAt(j - 1))) continue;
      if (src.charAt(j + 1) === mark) { j++; continue; }
      if (mark === '_' && /\w/.test(src.charAt(j + 1))) continue;
      return j;
    }
    return -1;
  }

  function parseInline(text) {
    var src = String(text == null ? '' : text);
    var out = [];
    var buf = '';
    var i = 0;
    function flush() {
      if (buf) out.push({ t: 'text', v: buf });
      buf = '';
    }
    while (i < src.length) {
      var c = src.charAt(i);
      var next = src.charAt(i + 1);
      if (c === '\\' && next && /[\\`*_\[\]()#+\-.!>|~]/.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
      if (c === '`') {
        var endCode = src.indexOf('`', i + 1);
        if (endCode > i + 1) {
          flush();
          out.push({ t: 'code', v: src.slice(i + 1, endCode) });
          i = endCode + 1;
          continue;
        }
      }
      if (c === '[') {
        var close = closingBracket(src, i);
        if (close > i) {
          var inner = src.slice(i + 1, close);
          if (src.charAt(close + 1) === '(') {
            var paren = src.indexOf(')', close + 2);
            if (paren > close) {
              var href = safeHref(src.slice(close + 2, paren).trim().split(/\s+/)[0]);
              flush();
              out.push(href ? { t: 'link', href: href, c: parseInline(inner) } : { t: 'span', c: parseInline(inner) });
              i = paren + 1;
              continue;
            }
          }
          if (isSourcePath(inner)) {
            flush();
            inner.trim().split(/\s*;\s*/).forEach(function (p) { out.push({ t: 'source', v: p }); });
            i = close + 1;
            continue;
          }
        }
      }
      if ((c === '*' || c === '_') && next === c) {
        var endStrong = src.indexOf(c + c, i + 2);
        if (endStrong > i + 2 && !/\s/.test(src.charAt(i + 2))) {
          flush();
          out.push({ t: 'strong', c: parseInline(src.slice(i + 2, endStrong)) });
          i = endStrong + 2;
          continue;
        }
      }
      if (c === '*' || (c === '_' && !/\w/.test(src.charAt(i - 1)))) {
        var endEm = emphasisEnd(src, i + 1, c);
        if (endEm > i + 1) {
          flush();
          out.push({ t: 'em', c: parseInline(src.slice(i + 1, endEm)) });
          i = endEm + 1;
          continue;
        }
      }
      if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(src.slice(i, i + 8)) && !/[\w\/]/.test(src.charAt(i - 1))) {
        var m = /^https?:\/\/[^\s<>"]*[^\s<>".,;:!?)'\]]/i.exec(src.slice(i));
        if (m) {
          flush();
          out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
          i += m[0].length;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.slice(-1) === '|' && t.slice(-2) !== '\\|') t = t.slice(0, -1);
    var cells = [];
    var cur = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (c === '\\' && t.charAt(i + 1) === '|') { cur += '\\|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells.map(function (cell) { return parseInline(cell.trim()); });
  }

  function parseMarkdown(md) {
    var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var para = [];
    var list = null;
    function endPara() {
      if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
      para = [];
    }
    function endList() {
      if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
      list = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();
      if (!t) { endPara(); endList(); continue; }
      var fence = /^(```|~~~)/.exec(t);
      if (fence) {
        endPara(); endList();
        var code = [];
        for (i++; i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0; i++) code.push(lines[i]);
        blocks.push({ type: 'code', text: code.join('\n') });
        continue;
      }
      var heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
      if (heading) {
        endPara(); endList();
        blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
        continue;
      }
      if (/^([-*_])(\s*\1){2,}$/.test(t)) {
        endPara(); endList();
        blocks.push({ type: 'rule' });
        continue;
      }
      if (t.charAt(0) === '|' && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[i + 1].trim())) {
        endPara(); endList();
        var head = splitRow(t);
        var rows = [];
        for (i += 2; i < lines.length && lines[i].trim().charAt(0) === '|'; i++) rows.push(splitRow(lines[i]));
        i--;
        blocks.push({ type: 'table', head: head, rows: rows });
        continue;
      }
      var item = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
      if (item) {
        endPara();
        var ordered = /\d/.test(item[1]);
        if (!list || list.ordered !== ordered) { endList(); list = { ordered: ordered, items: [] }; }
        list.items.push(item[2]);
        continue;
      }
      var quote = /^>\s?(.*)$/.exec(t);
      if (quote) {
        endPara(); endList();
        var said = [quote[1]];
        while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) said.push(lines[++i].trim().replace(/^>\s?/, ''));
        blocks.push({ type: 'quote', inline: parseInline(said.join(' ').trim()) });
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + t;
        continue;
      }
      endList();
      para.push(t);
    }
    endPara();
    endList();
    return blocks;
  }

  var parts = {
    ordinal: ordinal,
    generationName: generationName,
    descendantName: descendantName,
    nameOf: nameOf,
    relText: relText,
    sideOf: sideOf,
    ownWords: ownWords,
    categoryOf: categoryOf,
    chooseParents: chooseParents,
    layoutTree: layoutTree,
    parentWords: parentWords,
    memberWord: memberWord,
    parseInline: parseInline,
    parseMarkdown: parseMarkdown,
    safeHref: safeHref,
    webHref: webHref,
    isSourcePath: isSourcePath,
  };
  if (typeof module === 'object' && module && module.exports) module.exports = parts;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  /* ── the page ─────────────────────────────────────────────────────────── */

  var API = '/api/kade/family-history';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ZOOMS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
  var PHONE_WIDTH = 600;
  var PHONE_UP = 2;
  var view = document.getElementById('fh-view');
  var statusEl = document.getElementById('fh-status');
  var nav = document.getElementById('fh-nav');
  var token = null;
  var me = null;
  var anchor = null;
  var sides = { father: null, mother: null };
  var navSeq = 0;
  var firstRender = true;
  var treeDepth = { up: 4, down: 2 };
  var peopleGroup = 'ancestor';
  var cache = { person: new Map(), people: null, stories: null, findings: null };
  var mediaUrls = new Map();

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  var sayTimer = null;
  function say(text, isError) {
    clearTimeout(sayTimer);
    statusEl.classList.toggle('err', !!isError);
    statusEl.textContent = '';
    if (!text) return;
    sayTimer = setTimeout(function () { statusEl.textContent = text; }, 30);
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    setAttrs(node, attrs);
    for (var i = 2; i < arguments.length; i++) add(node, arguments[i]);
    return node;
  }

  function svg(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    setAttrs(node, attrs);
    for (var i = 2; i < arguments.length; i++) add(node, arguments[i]);
    return node;
  }

  function setAttrs(node, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.setAttribute('class', v);
      else if (k === 'text') node.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
  }

  function add(node, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(node, k); }); return; }
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }

  function enc(v) {
    return encodeURIComponent(String(v));
  }

  function num(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  function plural(n, one, many) {
    return num(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));
  }

  function personHref(id) {
    return '#/person/' + enc(id);
  }

  function treeHref(id) {
    return '#/tree/' + enc(id);
  }

  /* A link to another site, or the plain words when the address is not a
   * web address (a javascript: or data: address never becomes a link). */
  function newTab(href, text, extraClass) {
    var safe = webHref(href);
    if (!safe) return document.createTextNode(text);
    return el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', class: extraClass || null },
      text, el('span', { class: 'sr-only' }, ' (opens a new tab)'));
  }

  function learnSides(id, relation) {
    var r = relOf(relation);
    if (!r || !id) return;
    if (r.term === 'father' && (!r.group || r.group === 'ancestor')) sides.father = id;
    if (r.term === 'mother' && (!r.group || r.group === 'ancestor')) sides.mother = id;
  }

  function rel(relation) {
    return relText(relation, anchor);
  }

  function sideWords(category) {
    if (category === 'father' || category === 'mother') {
      var whose = anchor ? anchor + '’s ' : 'Your ';
      return whose + (category === 'father' ? 'father’s side' : 'mother’s side');
    }
    if (category === 'both') return anchor ? 'Through both of ' + anchor + '’s parents' : 'Through both your parents';
    if (category === 'self') return anchor || 'You';
    return SIDE_TAG[category] || '';
  }

  /* "Ada Example (1900-1970) — your grandmother, your father's side" */
  function describe(item, category) {
    var words = [];
    var r = rel(item.relation);
    if (r) words.push(r);
    var cat = category || categoryOf(item.relation, item, sides);
    var term = (relOf(item.relation) || {}).term;
    var ownParent = (cat === 'father' || cat === 'mother') && term === cat;
    if (!ownParent && ['father', 'mother', 'both', 'marriage', 'research'].indexOf(cat) !== -1) {
      var side = sideWords(cat);
      words.push(anchor && side.indexOf(anchor) === 0 ? side : side.charAt(0).toLowerCase() + side.slice(1));
    }
    return words.join(', ');
  }

  /* ── API ──────────────────────────────────────────────────────────────── */

  async function freshToken() {
    if (typeof window.getToken === 'function') return window.getToken();
    try {
      var r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) return null;
      var j = await r.json();
      return j && j.token ? j.token : null;
    } catch (e) {
      return null;
    }
  }

  function signIn() {
    say('Please sign in first. Taking you to the sign-in page…');
    location.replace('/login?redirect_to=' + enc('/family-history'));
  }

  async function api(path, body) {
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!token) token = await freshToken();
      if (!token) { signIn(); throw Object.assign(new Error('Signed out.'), { status: 401, quiet: true }); }
      var init = { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' };
      if (body) {
        init.method = 'POST';
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      var r;
      try {
        r = await fetch(API + path, init);
      } catch (e) {
        throw Object.assign(new Error('Could not reach the site. Check your connection and try again.'), { status: 0 });
      }
      if (r.status === 401 && attempt === 0) { token = null; continue; }
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) {
        var message = (j && j.error) || (r.status === 404 ? 'That was not found in the family tree.' : 'The site answered with an error (' + r.status + ').');
        throw Object.assign(new Error(message), { status: r.status });
      }
      return j;
    }
    throw Object.assign(new Error('Your sign-in ran out. Please sign in again.'), { status: 401 });
  }

  function mediaUrl(id) {
    var hit = mediaUrls.get(id);
    if (hit && Date.now() - hit.at < 45 * 60 * 1000) return hit.promise;
    var promise = api('/media/' + enc(id)).then(function (j) {
      if (!j || !j.url) throw new Error('No picture address came back.');
      return j.url;
    });
    promise.catch(function () { mediaUrls.delete(id); });
    mediaUrls.set(id, { at: Date.now(), promise: promise });
    return promise;
  }

  var lazyQueue = new Map();
  var lazyObserver = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      lazyObserver.unobserve(entry.target);
      var job = lazyQueue.get(entry.target);
      lazyQueue.delete(entry.target);
      if (job) job();
    });
  }, { rootMargin: '400px' }) : null;

  /* An <img> cannot send the Bearer header, so the signed address is fetched
   * with the token first and only then becomes the src. */
  function picture(id, alt, className) {
    var img = el('img', { alt: alt, class: className || null, decoding: 'async' });
    var load = function () {
      mediaUrl(id).then(function (url) { img.src = url; }).catch(function () { pictureFailed(img, alt); });
    };
    img.addEventListener('error', function () { if (img.getAttribute('src')) pictureFailed(img, alt); });
    if (lazyObserver) { lazyQueue.set(img, load); lazyObserver.observe(img); } else load();
    return img;
  }

  function pictureFailed(img, alt) {
    var note = el('span', { class: 'fh-nopic' }, 'Picture not available: ' + alt);
    if (img.parentNode) img.parentNode.replaceChild(note, img);
  }

  /* ── views ────────────────────────────────────────────────────────────── */

  function section(title, docTitle) {
    var h = el('h2', { id: 'fh-view-heading', tabindex: '-1' }, title);
    var s = el('section', { class: 'fh-section', 'aria-labelledby': 'fh-view-heading' }, h);
    s.fhTitle = docTitle || title;
    return s;
  }

  var focusNext = null;
  function mount(s) {
    view.replaceChildren(s);
    document.title = s.fhTitle + ' — Family history — Kade-AI';
    var target = (focusNext && document.getElementById(focusNext)) || s.querySelector('h2');
    focusNext = null;
    if (!firstRender && target) target.focus();
    firstRender = false;
  }

  async function show(render, loadingWords) {
    var seq = ++navSeq;
    var live = function () { return seq === navSeq; };
    say(loadingWords || 'Loading…');
    view.setAttribute('aria-busy', 'true');
    try {
      var s = await render(live);
      if (!live() || !s) return;
      mount(s);
      if (!s.fhKeepStatus) say('');
      if (s.fhAfter) s.fhAfter();
    } catch (e) {
      if (!live() || e.quiet) return;
      mount(errorSection(e, function () { route(); }));
      say(e.message, true);
    } finally {
      if (live()) view.removeAttribute('aria-busy');
    }
  }

  function errorSection(e, retry) {
    if (e.status === 403) return privateSection(e.message);
    var s = section(e.status === 404 ? 'Not found' : 'Something went wrong');
    s.appendChild(el('p', { class: 'status err' }, e.message));
    var row = el('p', { class: 'fh-actions' });
    if (retry && e.status !== 404) row.appendChild(el('button', { type: 'button', class: 'fh-btn', onclick: retry }, 'Try again'));
    if (me && me.access) row.appendChild(el('a', { href: '#/', class: 'fh-btn quiet' }, 'Family history start'));
    else row.appendChild(el('a', { href: '/home', class: 'fh-btn quiet' }, 'Back to Home'));
    s.appendChild(row);
    return s;
  }

  function privateSection(message) {
    var s = section('Private to the family');
    s.appendChild(el('p', { class: 'status' }, message || 'The family history is private to the family.'));
    s.appendChild(el('p', null, 'It opens for family members whose accounts have been matched to their place in the family tree. If you are family and it does not open for you, ask the person who runs this site to match your account.'));
    s.appendChild(el('p', null, el('a', { class: 'fh-btn', href: '/home' }, 'Back to Home')));
    return s;
  }

  function currentRoute() {
    var h = location.hash.replace(/^#\/?/, '');
    var slash = h.indexOf('/');
    var name = slash === -1 ? h : h.slice(0, slash);
    var arg = slash === -1 ? '' : h.slice(slash + 1);
    try { arg = decodeURIComponent(arg); } catch (e) { arg = ''; }
    return { name: name, arg: arg };
  }

  function route() {
    var r = currentRoute();
    var current = { '': '', tree: 'tree', person: 'people', people: 'people', stories: 'stories', story: 'stories', findings: 'findings', accounts: 'accounts' }[r.name];
    Array.prototype.forEach.call(nav.querySelectorAll('a[data-route]'), function (a) {
      if (a.getAttribute('data-route') === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (r.name === '') return show(homeView);
    if (r.name === 'tree') return show(function (live) { return treeView(live, r.arg || me.viewer.personId); }, 'Loading the family tree…');
    if (r.name === 'person' && r.arg) return show(function (live) { return personView(live, r.arg); }, 'Loading this person…');
    if (r.name === 'people') return show(peopleView, 'Loading the people in the tree…');
    if (r.name === 'stories') return show(storiesView, 'Loading the stories…');
    if (r.name === 'story' && r.arg) return show(function (live) { return storyView(live, r.arg); }, 'Loading the story…');
    if (r.name === 'findings') return show(findingsView, 'Loading the research findings…');
    if (r.name === 'accounts' && isOwner()) return show(accountsView, 'Loading the accounts…');
    return show(function () { return Promise.reject(Object.assign(new Error('There is no page at that address.'), { status: 404 })); });
  }

  function isOwner() {
    return !!(me && (me.isOwner || me.mode === 'owner'));
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  function homeView() {
    var v = me.viewer || {};
    var s = section('Start here', 'Start');
    var card = el('div', { class: 'card fh-me' });
    if (me.mode === 'guest') {
      card.appendChild(el('p', { class: 'fh-lead' }, 'You are visiting as a guest.'));
      card.appendChild(el('p', null, 'The tree is shown from ' + nameOf(v) + '’s place, so every relationship is said as ' + firstName(nameOf(v)) + '’s.'));
    } else {
      card.appendChild(el('p', { class: 'fh-lead' }, 'You’re in the tree as ', el('a', { href: personHref(v.personId) }, v.label || nameOf(v)), '.'));
      if (me.mode === 'owner') card.appendChild(el('p', null, 'This is your own tree. Everything here is said from your place in it.'));
      var toOwner = relOf(v.relationToOwner);
      if (me.mode === 'family' && toOwner && toOwner.term && !/^you$/i.test(toOwner.term)) {
        card.appendChild(el('p', null, 'To the person who keeps this tree, you are their ' + toOwner.term.replace(/^your\s+/i, '').replace(/(^|\s)your(?=\s)/gi, '$1their') + '.'));
      }
    }
    if (me.viewNote) card.appendChild(el('p', { class: 'fh-note' }, me.viewNote));
    var c = me.counts || {};
    var counts = [
      [c.people, 'person', 'people'],
      [c.records, 'record'],
      [c.memorials, 'Find a Grave memorial'],
      [c.media, 'picture and scan', 'pictures and scans'],
      [c.stories, 'story', 'stories'],
    ].filter(function (x) { return x[0] != null; });
    if (counts.length) {
      card.appendChild(el('ul', { class: 'fh-counts', role: 'list', 'aria-label': 'What is in the tree' },
        counts.map(function (x) { return el('li', null, plural(x[0], x[1], x[2])); })));
    }
    s.appendChild(card);
    var big = el('nav', { class: 'fh-big', 'aria-label': 'Go to' });
    var whose = anchor ? anchor + '’s' : 'your';
    [
      ['#/tree', 'Family tree', 'A chart of ' + whose + ' ancestors, with a text version under it.'],
      ['#/people', 'People', 'Search for anyone, or browse ancestors by generation.'],
      ['#/stories', 'Stories', 'Family stories written from the research.'],
      ['#/findings', 'Research findings', 'What the research suggests but has not proven.'],
    ].concat(isOwner() ? [['#/accounts', 'Who can see this', 'Match family accounts to their place in the tree.']] : []).forEach(function (b, i) {
      var id = 'fh-big-' + i;
      big.appendChild(el('a', { class: 'fh-bigbtn', href: b[0], 'aria-label': b[1], 'aria-describedby': id }, el('strong', null, b[1]), el('small', { id: id }, b[2])));
    });
    s.appendChild(big);
    s.appendChild(el('h3', null, 'How to use this'));
    s.appendChild(el('p', null, 'Open anyone to see how they are related to ' + (anchor || 'you') + ', their records, graves and pictures. Choose Centre the tree here to move the chart to them. Research findings are marked as not proven.'));
    return s;
  }

  /* ── family tree ──────────────────────────────────────────────────────── */

  function ensureDefs() {
    if (document.getElementById('fh-defs')) return;
    var defs = svg('defs', null,
      svg('clipPath', { id: 'fh-clip', clipPathUnits: 'objectBoundingBox' }, svg('circle', { cx: '0.5', cy: '0.5', r: '0.5' })),
      svg('pattern', { id: 'fh-pat-mother', width: '8', height: '8', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        svg('rect', { width: '8', height: '8', class: 'fh-pat-bg cat-mother' }), svg('rect', { width: '4', height: '8', class: 'fh-pat-ink cat-mother' })),
      svg('pattern', { id: 'fh-pat-both', width: '8', height: '8', patternUnits: 'userSpaceOnUse' },
        svg('rect', { width: '8', height: '8', class: 'fh-pat-bg cat-both' }), svg('rect', { width: '8', height: '4', class: 'fh-pat-ink cat-both' })),
      svg('pattern', { id: 'fh-pat-descendant', width: '6', height: '6', patternUnits: 'userSpaceOnUse' },
        svg('rect', { width: '6', height: '6', class: 'fh-pat-bg cat-descendant' }), svg('circle', { cx: '3', cy: '3', r: '1.6', class: 'fh-pat-ink cat-descendant' })),
      svg('pattern', { id: 'fh-pat-research', width: '6', height: '6', patternUnits: 'userSpaceOnUse' },
        svg('rect', { width: '6', height: '6', class: 'fh-pat-bg cat-research' }), svg('rect', { x: '1', y: '1', width: '2.5', height: '2.5', class: 'fh-pat-ink cat-research' })));
    document.body.appendChild(svg('svg', { id: 'fh-defs', width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false', class: 'fh-defs' }, defs));
  }

  function barFill(category) {
    return { mother: 'url(#fh-pat-mother)', both: 'url(#fh-pat-both)', descendant: 'url(#fh-pat-descendant)', research: 'url(#fh-pat-research)' }[category] || null;
  }

  function fit(text, max) {
    var s = String(text || '');
    return s.length > max ? s.slice(0, Math.max(1, max - 1)).trim() + '…' : s;
  }

  function legend() {
    var cats = ['self', 'father', 'mother', 'both', 'marriage', 'research', 'descendant'];
    var list = el('ul', { class: 'fh-legend', role: 'list', 'aria-label': 'What the colours and patterns mean' });
    cats.forEach(function (cat) {
      var swatch = svg('svg', { width: '34', height: '22', viewBox: '0 0 34 22', 'aria-hidden': 'true', focusable: 'false', class: 'fh-box cat-' + cat },
        svg('rect', { x: '1.5', y: '1.5', width: '31', height: '19', rx: '4', class: 'fh-boxbg' }),
        svg('rect', { x: '1.5', y: '1.5', width: '7', height: '19', rx: '2', class: 'fh-boxbar', fill: barFill(cat) }));
      list.appendChild(el('li', null, swatch, ' ', sideWords(cat) + legendHint(cat)));
    });
    list.appendChild(el('li', null, lineSwatch('kind-birth'), ' Solid line: born to'));
    list.appendChild(el('li', null, lineSwatch('kind-step'), ' Dashed line: step or adoptive parent'));
    list.appendChild(el('li', null, lineSwatch('kind-probable'), ' Dotted line: a research finding, not proven'));
    return list;
  }

  function legendHint(cat) {
    return {
      self: ' (thick border)',
      father: ' (solid bar)',
      mother: ' (striped bar)',
      both: ' (banded bar)',
      marriage: ' (dashed border)',
      research: ' (dotted border, checked bar)',
      descendant: ' (dotted bar)',
    }[cat] || '';
  }

  function lineSwatch(kind) {
    return svg('svg', { width: '34', height: '12', viewBox: '0 0 34 12', 'aria-hidden': 'true', focusable: 'false', class: 'fh-lineswatch' },
      svg('path', { d: 'M2 6H32', class: 'fh-edge ' + kind }));
  }

  function nodeBox(b, layout, focusName) {
    var node = b.node || { id: b.id };
    var category = b.role === 'focus' && relOf(node.relation) == null ? 'none' : categoryOf(node.relation, node, sides);
    var W = layout.box.w;
    var H = layout.box.h;
    var name = nameOf(node);
    var r = rel(node.relation);
    var years = node.lifespan || (node.living ? 'Living' : '');
    var tag = SIDE_TAG[category] || '';
    var spoken = [name, years, r ? capital(r) : 'no known link to ' + (anchor || 'you'), category !== 'self' && tag && category !== 'none' && category !== 'blood' ? tag : '', b.role === 'focus' ? 'centre of the chart' : '', b.repeat ? 'appears more than once in this chart' : '']
      .filter(Boolean).join(', ');
    var textX = node.photo ? 70 : 16;
    var room = W - textX - (b.role === 'focus' ? 10 : 40);
    var chars = Math.floor(room / 7.2);
    function line(y, cls, text, extra) {
      return svg('text', { x: textX, y: y, class: cls, 'data-room': cls === 'fh-name' ? room : room + 22 }, fit(text, chars + extra));
    }
    var g = svg('g', { class: 'fh-box cat-' + category + (b.role === 'focus' ? ' is-focus' : '') + (b.repeat ? ' is-repeat' : ''), transform: 'translate(' + b.left + ' ' + b.top + ')' });
    var link = svg('a', { href: personHref(b.id), class: 'fh-boxlink' },
      svg('title', null, spoken),
      svg('rect', { width: W, height: H, rx: '10', class: 'fh-boxbg' }),
      svg('rect', { width: '8', height: H, rx: '3', class: 'fh-boxbar', fill: barFill(category) }),
      line(24, 'fh-name', name, 6),
      line(43, 'fh-years', years, 10),
      line(61, 'fh-rel', r ? capital(r) : '', 10),
      line(78, 'fh-tag', b.role === 'focus' && (category === 'none' || category === 'self') ? 'Centre of the chart' : tag, 12),
      svg('rect', { x: '-4', y: '-4', width: W + 8, height: H + 8, rx: '13', class: 'fh-ring' }));
    if (node.photo) {
      var image = svg('image', { x: '14', y: '16', width: '48', height: '48', 'clip-path': 'url(#fh-clip)', preserveAspectRatio: 'xMidYMid slice', class: 'fh-photo', 'aria-hidden': 'true' });
      link.insertBefore(image, link.querySelector('text'));
      image.addEventListener('error', function () { image.remove(); });
      mediaUrl(node.photo).then(function (url) { image.setAttribute('href', url); }).catch(function () { image.remove(); });
    }
    g.appendChild(link);
    if (b.role !== 'focus') {
      /* The unpainted 44px circle is the tap target; it stays inside the box. */
      var cx = W - 22;
      g.appendChild(svg('a', { href: treeHref(b.id), class: 'fh-centre' },
        svg('title', null, 'Centre the tree on ' + name),
        svg('circle', { cx: cx, cy: '22', r: '22', fill: 'none', 'pointer-events': 'all', class: 'fh-centrehit' }),
        svg('circle', { cx: cx, cy: '22', r: '12', class: 'fh-centrebg' }),
        svg('path', { d: 'M' + cx + ' 14V30M' + (cx - 8) + ' 22H' + (cx + 8), class: 'fh-centreink' }),
        svg('circle', { cx: cx, cy: '22', r: '4.5', class: 'fh-centreink' })));
    }
    return g;
  }

  /* Shortens any box line that runs past its room, measured in the browser
   * (the spoken name and the text version always carry the whole thing). */
  function trimTexts(root) {
    Array.prototype.forEach.call(root.querySelectorAll('text[data-room]'), function (t) {
      if (typeof t.getComputedTextLength !== 'function') return;
      var room = Number(t.getAttribute('data-room'));
      var full = t.textContent.replace(/…$/, '');
      if (!full || t.getComputedTextLength() <= room) return;
      var lo = 1;
      var hi = full.length;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        t.textContent = full.slice(0, mid).trim() + '…';
        if (t.getComputedTextLength() <= room) lo = mid;
        else hi = mid - 1;
      }
      t.textContent = full.slice(0, lo).trim() + '…';
    });
  }

  function chart(layout, focusName, shortened) {
    ensureDefs();
    var s = svg('svg', {
      viewBox: '0 0 ' + layout.width + ' ' + layout.height,
      width: layout.width,
      height: layout.height,
      role: 'group',
      'aria-label': 'Family tree chart centred on ' + focusName + (shortened ? '. The text version after the chart lists every generation.' : '. The text version after the chart says the same.'),
      class: 'fh-chart',
    });
    var edges = svg('g', { class: 'fh-edges', 'aria-hidden': 'true' });
    layout.lines.forEach(function (l) {
      var kind = l.kind === 'couple' ? 'couple' : (l.kind === 'probable' || l.kind === 'doubtful' ? 'probable' : (l.kind === 'step' || l.kind === 'adopted' ? 'step' : 'birth'));
      edges.appendChild(svg('path', { d: l.d, class: 'fh-edge kind-' + kind }));
    });
    s.appendChild(edges);
    var boxes = svg('g', { class: 'fh-boxes' });
    layout.boxes.forEach(function (b) { boxes.appendChild(nodeBox(b, layout, focusName)); });
    s.appendChild(boxes);
    return s;
  }

  function relationOfChild(parentBox, layout, withChild) {
    var e = layout.lines.filter(function (l) { return l.kind !== 'couple' && l.from === parentBox && l.to.role !== 'sibling'; })[0];
    if (!e) return '';
    var sex = (parentBox.node || {}).sex;
    var word = sex === 'M' ? 'father' : sex === 'F' ? 'mother' : 'parent';
    var kind = KIND_WORD[e.kind] ? ' (' + KIND_WORD[e.kind] + ')' : '';
    return word + (withChild ? ' of ' + nameOf(e.to.node) : '') + kind;
  }

  function textItem(b, extra) {
    var node = b.node || { id: b.id };
    var words = [];
    if (extra) words.push(extra);
    var d = describe(node);
    if (d) words.push(d);
    else words.push('no known link to ' + (anchor || 'you'));
    if (b.repeat) words.push('appears more than once');
    var li = el('li', null, el('a', { href: personHref(b.id) }, nameOf(node) + (node.lifespan ? ' (' + node.lifespan + ')' : '')), ' — ' + words.join('; ') + '. ');
    if (b.role !== 'focus') li.appendChild(el('a', { href: treeHref(b.id), class: 'fh-small', 'aria-label': 'Centre the tree on ' + nameOf(node) }, 'Centre here'));
    return li;
  }

  function textVersion(layout, focusName, isViewer) {
    var box = el('section', { class: 'fh-textversion', id: 'fh-textversion', 'aria-labelledby': 'fh-tv-h' });
    box.appendChild(el('h3', { id: 'fh-tv-h', tabindex: '-1' }, isViewer ? (anchor ? anchor + '’s ancestors, generation by generation' : 'Your ancestors, generation by generation') : focusName + '’s ancestors, generation by generation'));
    var focusNode = layout.focus.node || {};
    var d = describe(focusNode);
    box.appendChild(el('p', null, 'The chart is centred on ', el('a', { href: personHref(layout.focus.id) }, focusName), focusNode.lifespan ? ' (' + focusNode.lifespan + ')' : '', d && !isViewer ? ', ' + d : '', '.'));
    var byGen = new Map();
    layout.boxes.forEach(function (b) {
      if (b.role !== 'ancestor') return;
      if (!byGen.has(b.gen)) byGen.set(b.gen, []);
      byGen.get(b.gen).push(b);
    });
    if (!byGen.size) box.appendChild(el('p', null, 'No parents are recorded for ' + focusName + ' in the tree.'));
    Array.from(byGen.keys()).sort(function (a, b) { return a - b; }).forEach(function (gen) {
      box.appendChild(el('h4', null, generationName(gen) + ' (' + byGen.get(gen).length + ')'));
      box.appendChild(el('ul', { class: 'fh-list' }, byGen.get(gen).map(function (b) {
        return textItem(b, gen === 1 && isViewer ? '' : relationOfChild(b, layout, gen > 1));
      })));
    });
    var groups = [
      ['sibling', 'Brothers and sisters'],
      ['spouse', 'Spouses and partners'],
    ];
    groups.forEach(function (g) {
      var list = layout.boxes.filter(function (b) { return b.role === g[0]; });
      if (!list.length) return;
      box.appendChild(el('h4', null, g[1] + ' (' + list.length + ')'));
      box.appendChild(el('ul', { class: 'fh-list' }, list.map(function (b) { return textItem(b, g[0] === 'sibling' ? parentWords(b, layout) : ''); })));
    });
    for (var level = 1; level <= layout.depth; level++) {
      var gen = layout.boxes.filter(function (b) { return b.role === 'descendant' && b.gen === -level; });
      if (!gen.length) continue;
      box.appendChild(el('h4', null, descendantName(level) + ' (' + gen.length + ')'));
      box.appendChild(el('ul', { class: 'fh-list' }, gen.map(function (b) { return textItem(b, parentWords(b, layout)); })));
    }
    var extra = layout.extraParents.filter(function (p) { return p && p.id; });
    var more = layout.unplaced.filter(function (n) { return !extra.some(function (p) { return p.id === n.id; }); });
    if (extra.length || more.length) {
      box.appendChild(el('h4', null, 'Also in this part of the tree'));
      var ul = el('ul', { class: 'fh-list' });
      var byId = new Map();
      layout.boxes.forEach(function (b) { byId.set(b.id, b.node); });
      layout.unplaced.forEach(function (n) { byId.set(n.id, n); });
      extra.forEach(function (p) {
        var n = byId.get(p.id) || { id: p.id };
        var child = byId.get(p.child) || { id: p.child };
        var kind = KIND_WORD[p.kind] ? KIND_WORD[p.kind] + ' ' : '';
        ul.appendChild(textItem({ id: p.id, node: n, role: 'extra' }, 'also listed as a ' + kind + 'parent of ' + nameOf(child)));
      });
      more.forEach(function (n) { ul.appendChild(textItem({ id: n.id, node: n, role: 'extra' })); });
      box.appendChild(ul);
    }
    return box;
  }

  async function treeView(live, focusId) {
    var data = await api('/tree?focus=' + enc(focusId) + '&up=' + treeDepth.up + '&down=' + treeDepth.down);
    if (!live()) return null;
    (data.nodes || []).forEach(function (n) { learnSides(n.id, n.relation); });
    var fullLayout = layoutTree(data, treeDepth);
    if (!fullLayout) throw Object.assign(new Error('That person is not in the family tree.'), { status: 404 });
    /* On a phone the chart starts at two generations up, so the parents and
     * grandparents sit near the focus; the text version always has them all. */
    var narrow = (view.clientWidth || window.innerWidth || 0) < PHONE_WIDTH;
    var shortLayout = narrow && treeDepth.up > PHONE_UP ? layoutTree(data, { up: PHONE_UP, down: treeDepth.down }) : null;
    var layout = shortLayout || fullLayout;
    var focusNode = layout.focus.node || {};
    var focusName = nameOf(focusNode);
    var isViewer = me.viewer && layout.focus.id === me.viewer.personId;
    var s = section(isViewer ? 'Family tree' : 'Family tree: ' + focusName, isViewer ? 'Family tree' : focusName + ' — family tree');
    var r = rel(focusNode.relation);
    if (!isViewer) {
      s.appendChild(el('p', null, 'Centred on ', el('a', { href: personHref(layout.focus.id) }, focusName), r ? ', ' + r : '', '. ',
        el('a', { href: '#/tree' }, anchor ? 'Centre on ' + anchor : 'Centre on you')));
    }
    s.appendChild(el('p', { class: 'fh-skip' }, el('a', { href: '#fh-textversion', onclick: function (e) { e.preventDefault(); var h = document.getElementById('fh-tv-h'); if (h) { h.scrollIntoView({ block: 'start' }); h.focus(); } } }, 'Skip the chart to its text version')));

    var frame = el('div', { class: 'fh-treeframe', role: 'region', 'aria-label': 'Family tree chart. Scrolls inside its frame.' });
    var chartEl = chart(layout, focusName, !!shortLayout);
    frame.appendChild(chartEl);
    var depthRow = null;
    if (shortLayout) {
      var depthBtn = el('button', { type: 'button', class: 'fh-btn quiet' });
      var depthLabel = function () {
        depthBtn.textContent = layout === shortLayout ? 'Show all ' + treeDepth.up + ' generations in the chart' : 'Show ' + PHONE_UP + ' generations in the chart';
      };
      depthLabel();
      depthBtn.addEventListener('click', function () {
        layout = layout === shortLayout ? fullLayout : shortLayout;
        var next = chart(layout, focusName, layout === shortLayout);
        frame.replaceChild(next, chartEl);
        chartEl = next;
        firstView();
        depthLabel();
        say('The chart now shows ' + (layout === shortLayout ? PHONE_UP : treeDepth.up) + ' generations up: ' + plural(layout.boxes.length, 'person', 'people') + ', centred on ' + focusName + '.');
      });
      depthRow = el('p', { class: 'fh-actions' }, depthBtn);
    }
    var scale = 1;
    function applyScale(next, keep) {
      var cx = keep ? (frame.scrollLeft + frame.clientWidth / 2) / scale : null;
      var cy = keep ? (frame.scrollTop + frame.clientHeight / 2) / scale : null;
      scale = next;
      chartEl.setAttribute('width', Math.round(layout.width * scale));
      chartEl.setAttribute('height', Math.round(layout.height * scale));
      if (keep) centreOn(cx, cy);
    }
    function centreOn(x, y) {
      var left = Math.max(0, x * scale - frame.clientWidth / 2);
      var top = Math.max(0, y * scale - frame.clientHeight / 2);
      if (frame.scrollTo) frame.scrollTo({ left: left, top: top, behavior: 'auto' });
      else { frame.scrollLeft = left; frame.scrollTop = top; }
    }
    function zoom(step) {
      var i = 0;
      while (i < ZOOMS.length - 1 && ZOOMS[i] < scale - 0.001) i++;
      if (step > 0 && ZOOMS[i] <= scale + 0.001) i++;
      if (step < 0) i--;
      i = Math.max(0, Math.min(ZOOMS.length - 1, i));
      applyScale(ZOOMS[i], true);
      say('Zoom ' + Math.round(scale * 100) + ' percent.');
    }
    function pan(dx, dy) {
      var opts = { left: dx * frame.clientWidth * 0.4, top: dy * frame.clientHeight * 0.4, behavior: reducedMotion() ? 'auto' : 'smooth' };
      if (frame.scrollBy) frame.scrollBy(opts);
      else { frame.scrollLeft += opts.left; frame.scrollTop += opts.top; }
    }
    function fitAll() {
      var next = Math.min(1, frame.clientWidth / layout.width, Math.max(frame.clientHeight, 200) / layout.height);
      applyScale(Math.max(0.12, next), false);
      centreOn(layout.width / 2, layout.height / 2);
      say('The whole chart fits the frame, zoom ' + Math.round(scale * 100) + ' percent.');
    }
    function toFocus() {
      centreOn(layout.focus.cx, layout.focus.cy);
      say('Back to ' + focusName + '.');
    }
    function button(label, spoken, fn) {
      return el('button', { type: 'button', class: 'fh-tool', 'aria-label': spoken || null, title: spoken || null, onclick: fn }, label);
    }
    /* Arrowing through a closed menu fires change on every key on Windows, so
     * the tree is fetched again only once the choice has settled. */
    function depthSelect(id, label, value, options, apply) {
      var sel = el('select', { id: id }, options.map(function (n) { return el('option', { value: n, selected: n === value }, String(n)); }));
      var settle = null;
      sel.addEventListener('change', function () {
        clearTimeout(settle);
        settle = setTimeout(function () {
          if (!document.contains(sel)) return;
          apply(Number(sel.value));
          focusNext = id;
          route();
        }, 600);
      });
      return el('span', { class: 'fh-field' }, el('label', { for: id }, label), sel);
    }
    var bar = el('div', { class: 'fh-treebar', role: 'group', 'aria-label': 'Chart controls' },
      el('span', { class: 'fh-toolgroup' },
        button('−', 'Zoom out', function () { zoom(-1); }),
        button('+', 'Zoom in', function () { zoom(1); }),
        button('Fit', 'Fit the whole chart in the frame', fitAll),
        button('Centre', 'Centre: scroll back to ' + focusName, toFocus)),
      el('span', { class: 'fh-toolgroup' },
        button('←', 'Move left', function () { pan(-1, 0); }),
        button('↑', 'Move up', function () { pan(0, -1); }),
        button('↓', 'Move down', function () { pan(0, 1); }),
        button('→', 'Move right', function () { pan(1, 0); })),
      el('span', { class: 'fh-toolgroup' },
        depthSelect('fh-up', 'Generations up', treeDepth.up, [1, 2, 3, 4, 5, 6, 7, 8], function (n) { treeDepth.up = n; }),
        depthSelect('fh-down', 'Generations down', treeDepth.down, [0, 1, 2, 3, 4], function (n) { treeDepth.down = n; })));
    s.appendChild(bar);
    if (depthRow) s.appendChild(depthRow);
    s.appendChild(frame);
    var legendBox = el('details', { class: 'fh-legendbox' }, el('summary', null, 'What the colours, patterns and lines mean'), legend());
    s.appendChild(legendBox);
    s.appendChild(textVersion(fullLayout, focusName, isViewer));
    s.fhKeepStatus = true;
    /* The first view waits until the frame has a real size (a tab opened in
     * the background lays out at zero width), then centres on the focus. A
     * phone never starts below 85 percent, so names stay readable. */
    function firstView() {
      if (!frame.clientWidth) return false;
      trimTexts(chartEl);
      var least = frame.clientWidth < PHONE_WIDTH ? 0.85 : 0.7;
      applyScale(Math.min(1, Math.max(least, frame.clientWidth / layout.width)), false);
      centreOn(layout.focus.cx, layout.focus.cy);
      return true;
    }
    s.fhAfter = function () {
      if (!firstView() && 'ResizeObserver' in window) {
        var watcher = new ResizeObserver(function () { if (firstView()) watcher.disconnect(); });
        watcher.observe(frame);
      }
      say('Family tree ready: ' + plural(layout.boxes.length, 'person', 'people') + ' in the chart, centred on ' + focusName + '.');
    };
    return s;
  }

  /* ── one person ───────────────────────────────────────────────────────── */

  function fieldList(pairs, className) {
    var dl = el('dl', { class: className || 'fh-fields' });
    pairs.forEach(function (p) {
      if (!p || p[1] == null || p[1] === '') return;
      dl.appendChild(el('div', null, el('dt', null, p[0]), el('dd', null, p[1])));
    });
    return dl.childNodes.length ? dl : null;
  }

  var DOC_WORD = { pdf: 'PDF', doc: 'Word document', docx: 'Word document', htm: 'saved web page', html: 'saved web page', txt: 'text file', rtf: 'document', tif: 'TIFF scan', tiff: 'TIFF scan', heic: 'iPhone photo' };

  function fileExt(m) {
    var f = String((m && m.file) || '');
    var dot = f.lastIndexOf('.');
    return dot === -1 ? '' : f.slice(dot + 1).toLowerCase();
  }

  /* Anything a browser cannot show as a picture (PDF, Word, saved web
   * pages, TIFF) opens in its own tab instead of the picture viewer. */
  function isDocument(m) {
    var ext = fileExt(m);
    return !!ext && !/^(jpe?g|png|gif|webp|avif|bmp)$/.test(ext);
  }

  function mediaKindWord(m) {
    if (isDocument(m)) return 'Document, ' + (DOC_WORD[fileExt(m)] || fileExt(m).toUpperCase());
    return { record: 'Record scan', grave: 'Grave photo', tree: 'Family photo', codex: 'Research document' }[m && m.kind] || 'Picture';
  }

  function openableMedia(m, alt, label) {
    if (isDocument(m)) {
      var doc = el('button', { type: 'button', class: 'fh-doclink' },
        el('span', { class: 'fh-docicon', 'aria-hidden': 'true' }, '📄'),
        el('span', { class: 'fh-thumbtext' }, label || 'Open the document'),
        el('span', { class: 'fh-small' }, mediaKindWord(m)),
        el('span', { class: 'sr-only' }, ' (opens a new tab)'));
      doc.addEventListener('click', function () {
        var w = window.open('', '_blank');
        mediaUrl(m.id).then(function (url) { if (w) { w.opener = null; w.location = url; } else location.href = url; }).catch(function (err) { if (w) w.close(); say(err.message, true); });
      });
      return doc;
    }
    /* The picture's alt text names the button; a visible caption it already
     * says is hidden from screen readers so it is not read twice. */
    var shown = label || 'View larger';
    var said = String(alt || '').toLowerCase().indexOf(shown.replace(/…$/, '').trim().toLowerCase()) !== -1;
    var btn = el('button', { type: 'button', class: 'fh-thumb' }, picture(m.id, alt), el('span', { class: 'fh-thumbtext', 'aria-hidden': said ? 'true' : null }, shown));
    btn.addEventListener('click', function () { openViewer(m, alt, btn); });
    return btn;
  }

  var dialog = null;
  var dialogReturn = null;
  function openViewer(m, alt, trigger) {
    if (!dialog) {
      var title = el('h2', { id: 'fh-dialog-title', tabindex: '-1' });
      var img = el('img', { class: 'fh-full', alt: '' });
      var caption = el('p', { class: 'fh-dialog-caption' });
      var full = el('a', { target: '_blank', rel: 'noopener noreferrer', class: 'fh-btn quiet' }, 'Open full size', el('span', { class: 'sr-only' }, ' (opens a new tab)'));
      var close = el('button', { type: 'button', class: 'fh-btn' }, 'Close');
      dialog = el('dialog', { class: 'fh-dialog', 'aria-labelledby': 'fh-dialog-title' },
        el('div', { class: 'fh-dialog-head' }, title, close), el('div', { class: 'fh-dialog-body' }, img), caption, el('p', { class: 'fh-actions' }, full));
      close.addEventListener('click', function () { dialog.close(); });
      dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener('close', function () {
        img.removeAttribute('src');
        if (dialogReturn && document.contains(dialogReturn)) dialogReturn.focus();
        dialogReturn = null;
      });
      dialog.fh = { title: title, img: img, caption: caption, full: full };
      document.body.appendChild(dialog);
    }
    if (typeof dialog.showModal !== 'function') {
      mediaUrl(m.id).then(function (url) { window.open(url, '_blank', 'noopener'); });
      return;
    }
    var parts = dialog.fh;
    parts.title.textContent = mediaKindWord(m);
    parts.caption.textContent = m.caption || alt;
    parts.img.alt = alt;
    parts.img.removeAttribute('src');
    parts.full.removeAttribute('href');
    dialogReturn = trigger;
    dialog.showModal();
    parts.title.focus();
    mediaUrl(m.id).then(function (url) {
      parts.img.src = url;
      parts.full.href = url;
    }).catch(function (err) { parts.caption.textContent = 'The picture could not be loaded: ' + err.message; });
  }

  function recordId(key) {
    return 'fh-rec-' + String(key).replace(/[^A-Za-z0-9_-]/g, '-');
  }

  function goToCard(id) {
    var card = document.getElementById(id);
    if (!card) return;
    var h = card.querySelector('h4');
    card.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (h) h.focus({ preventScroll: true });
  }

  function recordCard(r, mediaById, personName) {
    var card = el('article', { class: 'card fh-record' + (r.wrong ? ' is-wrong' : ''), id: recordId(r.key), 'aria-labelledby': recordId(r.key) + '-h' });
    card.appendChild(el('h4', { id: recordId(r.key) + '-h', tabindex: '-1' }, r.collection || 'Record'));
    if (r.name) card.appendChild(el('p', { class: 'fh-recname' }, 'Name on the record: ' + r.name));
    if (r.wrong) {
      card.appendChild(el('p', { class: 'fh-warn' }, el('strong', null, 'Wrongly attached. '),
        typeof r.wrong === 'string' ? r.wrong : 'This record is attached to ' + personName + ' in the tree, but it is about someone else.'));
    }
    var fields = fieldList((r.fields || []).map(function (f) { return Array.isArray(f) ? [f[0], f[1]] : null; }));
    if (fields) card.appendChild(fields);
    (r.tables || []).forEach(function (t, i) {
      if (!Array.isArray(t) || !t.length) return;
      var head = t[0] || [];
      var body = t.slice(1);
      var label = (r.tables.length > 1 ? 'Table ' + (i + 1) + ': ' : '') + (head[0] ? String(head[0]).replace(/\s*\(.*\)\s*$/, '') : 'Household');
      var table = el('table', null,
        el('caption', null, label),
        el('thead', null, el('tr', null, head.map(function (c) { return el('th', { scope: 'col' }, c); }))),
        el('tbody', null, body.map(function (row) {
          return el('tr', null, (row || []).map(function (c, j) { return j === 0 ? el('th', { scope: 'row' }, c) : el('td', null, c); }));
        })));
      card.appendChild(el('div', { class: 'fh-tablewrap', role: 'region', 'aria-label': label + ' (scrolls sideways)', tabindex: '0' }, table));
    });
    if (r.image) {
      var m = mediaById.get(r.image) || { id: r.image, kind: 'record', caption: (r.collection || 'Record') + (r.name ? ': ' + r.name : '') };
      card.appendChild(el('div', { class: 'fh-scan' }, openableMedia(m, 'Scan of the record: ' + (m.caption || r.collection || 'record'), 'View the scan')));
    }
    if (r.citation) card.appendChild(el('p', { class: 'fh-cite' }, el('small', null, 'Citation: ' + r.citation)));
    if (webHref(r.url)) card.appendChild(el('p', null, newTab(r.url, 'Open this record on Ancestry')));
    return card;
  }

  function memorialCard(m, personName) {
    var id = 'fh-mem-' + String(m.id || '').replace(/[^A-Za-z0-9_-]/g, '-');
    var card = el('article', { class: 'card fh-memorial' + (m.wrong ? ' is-wrong' : ''), id: id, 'aria-labelledby': id + '-h' });
    card.appendChild(el('h4', { id: id + '-h', tabindex: '-1' }, 'Find a Grave: ' + (m.name || personName)));
    if (m.wrong) card.appendChild(el('p', { class: 'fh-warn' }, el('strong', null, 'Wrongly attached. '), typeof m.wrong === 'string' ? m.wrong : 'This memorial is about someone else.'));
    var where = [m.cemetery, m.cemetery_place].filter(Boolean).join(', ');
    var fields = fieldList([
      ['Cemetery', where],
      ['Plot', m.plot],
      ['Born', [m.birth_date, m.birth_place].filter(Boolean).join(', ')],
      ['Died', [m.death_date, m.death_place].filter(Boolean).join(', ')],
    ]);
    if (fields) card.appendChild(fields);
    if (m.inscription) card.appendChild(el('figure', { class: 'fh-inscription' }, el('figcaption', null, 'Inscription'), el('blockquote', null, m.inscription)));
    if (m.bio) {
      card.appendChild(el('h5', null, 'Biography'));
      String(m.bio).split(/\n{2,}/).forEach(function (p) { if (p.trim()) card.appendChild(el('p', { class: 'fh-bio' }, p.trim())); });
    }
    var fam = m.family && typeof m.family === 'object' ? m.family : {};
    Object.keys(fam).forEach(function (heading) {
      var people = Array.isArray(fam[heading]) ? fam[heading] : [];
      if (!people.length) return;
      card.appendChild(el('h5', null, heading));
      card.appendChild(el('ul', { class: 'fh-list' }, people.map(function (p) { return el('li', null, (p.name || 'Unnamed') + (p.dates ? ' (' + p.dates + ')' : '')); })));
    });
    if (Array.isArray(m.family_notes) && m.family_notes.length) {
      card.appendChild(el('h5', null, 'Family notes'));
      card.appendChild(el('ul', { class: 'fh-list' }, m.family_notes.map(function (n) { return el('li', null, typeof n === 'string' ? n : JSON.stringify(n)); })));
    }
    var photos = (m.photos || []).map(function (p) {
      var mid = p && (p.id || (typeof p.media === 'string' ? p.media : p.media && p.media.id));
      return mid ? { id: mid, kind: 'grave', caption: p.caption || (p.media && p.media.caption) || '', file: p.file || (p.media && p.media.file) } : null;
    });
    var shown = photos.filter(Boolean);
    if (shown.length) {
      card.appendChild(el('h5', null, 'Photos'));
      card.appendChild(el('div', { class: 'fh-gallery' }, shown.map(function (p, i) {
        return openableMedia(p, 'Find a Grave photo ' + (i + 1) + ' for ' + (m.name || personName) + (p.caption ? ': ' + p.caption : ''), 'Photo ' + (i + 1));
      })));
    }
    var missing = photos.length - shown.length;
    if (missing > 0) card.appendChild(el('p', { class: 'muted' }, plural(missing, 'photo') + ' on Find a Grave ' + (missing === 1 ? 'is' : 'are') + ' not copied here yet.'));
    if (webHref(m.url)) card.appendChild(el('p', null, newTab(m.url, 'Open this memorial on Find a Grave')));
    return card;
  }

  function findingCard(f, headingLevel) {
    var people = (f.people || []).map(function (p) { return typeof p === 'string' ? { id: p } : p; }).filter(function (p) { return p && p.id; });
    var names = people.map(function (p) { return p.label || p.name ? nameOf(p) : null; }).filter(Boolean);
    var card = el('article', { class: 'card fh-finding' });
    card.appendChild(el(headingLevel || 'h3', null, names.length ? 'About ' + names.join(' and ') : 'A research finding'));
    card.appendChild(el('p', { class: 'fh-flag' }, 'Research finding, not proven'));
    card.appendChild(el('p', null, f.summary || ''));
    if (people.length) {
      card.appendChild(el('p', { class: 'fh-small' }, 'People it names:'));
      card.appendChild(el('ul', { class: 'fh-list' }, people.map(function (p) {
        var d = describe(p);
        return el('li', null, el('a', { href: personHref(p.id) }, p.label || p.name ? nameOf(p) + (p.lifespan ? ' (' + p.lifespan + ')' : '') : 'Open this person'), d ? ' — ' + d : '');
      })));
    }
    return card;
  }

  function pathSteps(relation) {
    var r = relOf(relation);
    if (!r || !r.pathText) return [];
    var segments = ownWords(r.pathText, sides.selfName).split(/\s*->\s*/).filter(Boolean);
    var path = Array.isArray(r.path) ? r.path.slice(1) : [];
    /* A descendant's line starts at the viewer themself ("Ada (born 1950) ->
     * daughter ..."); the chain already begins with "You". */
    if (path.length && segments.length === path.length + 1) segments = segments.slice(1);
    var counts = segments.map(function () { return 1; });
    var extra = path.length - segments.length;
    if (extra > 0) {
      segments.forEach(function (seg, i) {
        if (extra > 0 && (/shared ancestors?:/i.test(seg) || / and /.test(seg))) { counts[i] += 1; extra--; }
      });
    }
    var ok = path.length === counts.reduce(function (s, n) { return s + n; }, 0);
    var at = 0;
    return segments.map(function (seg, i) {
      var ids = ok ? path.slice(at, at + counts[i]) : [];
      at += counts[i];
      var text = anchor ? seg.replace(/^your\s/i, anchor + '’s ') : seg;
      return { text: text, id: ids.length === 1 ? ids[0] : null };
    });
  }

  function relationBlock(p, name, isSelf) {
    var box = el('section', { class: 'fh-relation', 'aria-labelledby': 'fh-rel-h' });
    box.appendChild(el('h3', { id: 'fh-rel-h' }, anchor ? 'How ' + firstName(name) + ' is related to ' + anchor : 'How you’re related'));
    var r = relOf(p.relation);
    if (isSelf || (r && (r.group === 'self' || /^you$/i.test(r.term)))) {
      box.appendChild(el('p', { class: 'fh-lead' }, anchor ? 'This is ' + anchor + '.' : 'This is you.'));
      return box;
    }
    if (!r) {
      box.appendChild(el('p', null, 'The tree has no known link between ' + name + ' and ' + (anchor || 'you') + ' yet.'));
      return box;
    }
    var category = categoryOf(r, p, sides);
    box.appendChild(el('p', { class: 'fh-lead' }, name + ' is ' + rel(r) + '.'));
    var tag = ['father', 'mother', 'both', 'marriage', 'research'].indexOf(category) !== -1 ? sideWords(category) : '';
    if (tag) box.appendChild(el('p', { class: 'fh-sidetag cat-' + category }, tag));
    var steps = pathSteps(r);
    if (steps.length) {
      box.appendChild(el('p', null, 'The line: ' + steps.map(function (s) { return s.text; }).join(', then ') + '.'));
      var chain = el('ol', { class: 'fh-chain', role: 'list', 'aria-label': 'The line, one step at a time' });
      chain.appendChild(el('li', { class: 'fh-chain-start' }, anchor || 'You'));
      steps.forEach(function (s) {
        chain.appendChild(el('li', null, s.id ? el('a', { href: personHref(s.id) }, s.text) : s.text));
      });
      box.appendChild(chain);
    }
    (Array.isArray(r.notes) ? r.notes : []).forEach(function (n) {
      box.appendChild(el('p', { class: /^research finding/i.test(n) ? 'fh-flagnote' : 'fh-warn' }, String(n)));
    });
    return box;
  }

  function familyBlock(family) {
    var groups = [
      ['parents', 'Parents'],
      ['spouses', 'Spouses and partners'],
      ['children', 'Children'],
      ['siblings', 'Brothers and sisters'],
    ];
    var box = el('section', { class: 'fh-family', 'aria-labelledby': 'fh-fam-h' }, el('h3', { id: 'fh-fam-h' }, 'Family'));
    var any = false;
    groups.forEach(function (g) {
      var list = Array.isArray(family && family[g[0]]) ? family[g[0]] : [];
      if (!list.length) return;
      any = true;
      box.appendChild(el('h4', null, g[1]));
      box.appendChild(el('ul', { class: 'fh-list' }, list.map(function (m) {
        learnSides(m.id, m.relation);
        var words = [];
        var linked = memberWord(g[0], m.kind);
        if (linked) words.push(linked);
        var d = describe(m);
        if (d) words.push(d);
        return el('li', null, el('a', { href: personHref(m.id) }, nameOf(m) + (m.lifespan ? ' (' + m.lifespan + ')' : '')), words.length ? ' — ' + words.join('; ') : '');
      })));
    });
    if (!any) box.appendChild(el('p', null, 'No family members are linked in the tree.'));
    return box;
  }

  function factSort(a, b) {
    var ya = a.year != null ? a.year : yearOf(a.date);
    var yb = b.year != null ? b.year : yearOf(b.date);
    if (ya == null && yb == null) return 0;
    if (ya == null) return 1;
    if (yb == null) return -1;
    if (ya !== yb) return ya - yb;
    var order = { BIRT: 0, BAPM: 1, CHR: 1, MARR: 5, DEAT: 8, BURI: 9, PROB: 10 };
    return (order[a.type] != null ? order[a.type] : 4) - (order[b.type] != null ? order[b.type] : 4);
  }

  function timelineBlock(facts, recordsByKey) {
    var box = el('section', { class: 'fh-timelinebox', 'aria-labelledby': 'fh-time-h' }, el('h3', { id: 'fh-time-h' }, 'Timeline'));
    var list = (facts || []).slice().sort(factSort);
    if (!list.length) {
      box.appendChild(el('p', null, 'No dated events are recorded.'));
      return box;
    }
    box.appendChild(el('ol', { class: 'fh-timeline', role: 'list' }, list.map(function (f) {
      var when = f.date || (f.year != null ? String(f.year) : 'Undated');
      var what = [f.label || f.type, f.value].filter(Boolean).join(': ');
      var place = String(f.place || '').replace(/[\s,;.]+$/, '');
      var li = el('li', null, el('span', { class: 'fh-when' }, when), ' ', el('strong', null, what || 'Event'), place ? ', ' + place : '', '.');
      if (f.note) li.appendChild(el('span', { class: 'fh-factnote' }, ' ' + f.note));
      var sources = (f.records || []).filter(function (k) { return recordsByKey.has(k); });
      if (sources.length) {
        var row = el('span', { class: 'fh-sources' }, ' ');
        sources.forEach(function (k, i) {
          var r = recordsByKey.get(k);
          row.appendChild(el('button', { type: 'button', class: 'chip', onclick: function () { goToCard(recordId(k)); } },
            'Source' + (sources.length > 1 ? ' ' + (i + 1) : ''), el('span', { class: 'sr-only' }, ': ' + (r.collection || 'record') + ', go to the record')));
          row.appendChild(document.createTextNode(' '));
        });
        li.appendChild(row);
      }
      return li;
    })));
    return box;
  }

  async function personView(live, id) {
    var data = cache.person.get(id) || await api('/person/' + enc(id));
    if (!live()) return null;
    cache.person.set(id, data);
    if (cache.person.size > 40) cache.person.delete(cache.person.keys().next().value);
    var p = data.person || {};
    learnSides(p.id, p.relation);
    var name = nameOf(p);
    var isSelf = me.viewer && p.id === me.viewer.personId && me.mode !== 'guest';
    var s = section(name, name);
    var sub = [];
    if (p.lifespan) sub.push(p.lifespan);
    else if (p.living) sub.push('Living');
    if (p.birthSurname && name.split(/\s+/).slice(-1)[0] !== p.birthSurname) sub.push('born a ' + p.birthSurname);
    if (sub.length) s.appendChild(el('p', { class: 'fh-lifespan' }, capital(sub.join(', '))));
    if (Array.isArray(p.otherNames) && p.otherNames.length) s.appendChild(el('p', null, 'Also known as ' + p.otherNames.join('; ') + '.'));
    if (p.duplicateOf) {
      s.appendChild(el('p', { class: 'fh-warn' }, el('strong', null, 'This is a copy. '), (p.duplicateWhy ? p.duplicateWhy + ' ' : 'This entry is a second copy of someone already in the tree. '),
        el('a', { href: personHref(p.duplicateOf) }, 'Open the main entry')));
    }
    if (p.virtual) s.appendChild(el('p', { class: 'fh-flagnote' }, 'This person comes from the research, not from the family tree itself.'));
    if (p.confidence) s.appendChild(el('p', { class: 'fh-flagnote' }, 'How sure the research is: ' + p.confidence + '.'));

    var actions = el('p', { class: 'fh-actions' }, el('a', { class: 'fh-btn', href: treeHref(p.id || id) }, 'Centre the tree here'));
    s.appendChild(actions);
    s.appendChild(relationBlock(p, name, isSelf));

    var mediaById = new Map();
    (data.media || []).forEach(function (m) { if (m && m.id) mediaById.set(m.id, m); });
    var gallery = [];
    var seenMedia = new Set();
    function addPic(m) {
      if (!m || !m.id || seenMedia.has(m.id)) return;
      seenMedia.add(m.id);
      gallery.push(m);
    }
    (data.media || []).forEach(addPic);
    (data.records || []).forEach(function (r) { if (r.image && !r.wrong) addPic(mediaById.get(r.image) || { id: r.image, kind: 'record', caption: (r.collection || 'Record') + (r.name ? ': ' + r.name : '') }); });
    if (gallery.length) {
      var order = { tree: 0, grave: 1, codex: 2, record: 3 };
      gallery.sort(function (a, b) { return (order[a.kind] == null ? 5 : order[a.kind]) - (order[b.kind] == null ? 5 : order[b.kind]); });
      s.appendChild(el('h3', null, 'Pictures and scans (' + gallery.length + ')'));
      s.appendChild(el('div', { class: 'fh-gallery' }, gallery.map(function (m) {
        return openableMedia(m, mediaKindWord(m) + ': ' + (m.caption || name), fit(m.caption || mediaKindWord(m), 60));
      })));
    }

    var basics = fieldList([
      ['Born', [p.birth && p.birth.date, p.birth && p.birth.place].filter(Boolean).join(', ')],
      ['Died', [p.death && p.death.date, p.death && p.death.place].filter(Boolean).join(', ')],
      ['Buried', [p.burial && p.burial.date, p.burial && p.burial.place].filter(Boolean).join(', ')],
    ]);
    if (basics) {
      s.appendChild(el('h3', null, 'At a glance'));
      s.appendChild(basics);
    }
    var relNotes = (relOf(p.relation) || {}).notes;
    var saidAlready = Array.isArray(relNotes) && relNotes.some(function (n) { return /more than one (father|mother|parent)/i.test(String(n)); });
    if (p.conflict && Array.isArray(p.conflict.parents) && !saidAlready) {
      var fam = (data.family && data.family.parents) || [];
      var label = function (pid) { var hit = fam.filter(function (f) { return f.id === pid; })[0]; return hit ? nameOf(hit) : 'another entry'; };
      var kept = (p.conflict.kept || []).map(label).join(' and ');
      var who = p.conflict.sex === 'M' ? 'father' : p.conflict.sex === 'F' ? 'mother' : 'parent';
      s.appendChild(el('p', { class: 'fh-warn' }, el('strong', null, 'Caution. '), 'The tree lists more than one ' + who + ' for ' + firstName(name) + ' (' + p.conflict.parents.map(label).join(', ') + ').' + (kept ? ' This site follows ' + kept + '.' : '')));
    }
    if (Array.isArray(p.notes) && p.notes.length) {
      s.appendChild(el('h3', null, 'Notes'));
      s.appendChild(el('ul', { class: 'fh-list' }, p.notes.map(function (n) { return el('li', null, String(n)); })));
    }

    var recordsByKey = new Map();
    (data.records || []).forEach(function (r) { if (r && r.key) recordsByKey.set(r.key, r); });
    s.appendChild(timelineBlock(p.facts, recordsByKey));
    s.appendChild(familyBlock(data.family || {}));

    var records = (data.records || []).slice().sort(function (a, b) { return (a.wrong ? 1 : 0) - (b.wrong ? 1 : 0); });
    if (records.length) {
      var wrongCount = records.filter(function (r) { return r.wrong; }).length;
      var recBox = el('section', { class: 'fh-records', 'aria-labelledby': 'fh-recs-h' }, el('h3', { id: 'fh-recs-h' }, 'Records (' + records.length + ')'));
      if (wrongCount) recBox.appendChild(el('p', { class: 'fh-small' }, plural(wrongCount, 'record') + ' at the end ' + (wrongCount === 1 ? 'is' : 'are') + ' marked as wrongly attached.'));
      records.forEach(function (r) { recBox.appendChild(recordCard(r, mediaById, name)); });
      s.appendChild(recBox);
    }
    var memorials = data.memorials || [];
    if (memorials.length) {
      var memBox = el('section', { class: 'fh-memorials', 'aria-labelledby': 'fh-mems-h' }, el('h3', { id: 'fh-mems-h' }, 'Find a Grave'));
      memorials.forEach(function (m) { memBox.appendChild(memorialCard(m, name)); });
      s.appendChild(memBox);
    }
    var findings = data.findings || [];
    if (findings.length) {
      var fBox = el('section', { 'aria-labelledby': 'fh-pf-h' }, el('h3', { id: 'fh-pf-h' }, 'Research findings about ' + firstName(name)));
      findings.forEach(function (f) { fBox.appendChild(findingCard(f, 'h4')); });
      s.appendChild(fBox);
    }
    if (Array.isArray(p.history) && p.history.length) {
      var hist = el('details', { class: 'fh-history' }, el('summary', null, 'Changes made to the tree (' + p.history.length + ')'));
      hist.appendChild(el('ul', { class: 'fh-list' }, p.history.map(function (n) { return el('li', null, String(n)); })));
      s.appendChild(hist);
    }
    return s;
  }

  /* ── people ───────────────────────────────────────────────────────────── */

  async function loadPeople() {
    if (!cache.people) cache.people = await api('/people?group=all');
    (cache.people || []).forEach(function (p) { learnSides(p.id, p.relation); });
    return cache.people || [];
  }

  function personItem(p) {
    var d = describe(p, categoryOf(Object.assign({ group: p.group }, relOf(p.relation) || {}), p, sides));
    return el('li', null, el('a', { href: personHref(p.id) }, nameOf(p) + (p.lifespan ? ' (' + p.lifespan + ')' : '')), d ? ' — ' + d : '');
  }

  function groupOf(p) {
    return p.group || (relOf(p.relation) || {}).group || 'none';
  }

  function peopleList(all, group) {
    var box = el('div', { class: 'fh-grouplist' });
    var list = all.filter(function (p) { return groupOf(p) === group; });
    if (!list.length) {
      box.appendChild(el('p', null, 'Nobody in this group yet.'));
      return { box: box, count: 0 };
    }
    if (group === 'ancestor' || group === 'descendant') {
      var byGen = new Map();
      list.forEach(function (p) {
        var g = Math.abs(Number(p.gen || (relOf(p.relation) || {}).gen) || 0);
        if (!byGen.has(g)) byGen.set(g, []);
        byGen.get(g).push(p);
      });
      Array.from(byGen.keys()).sort(function (a, b) { return a - b; }).forEach(function (g) {
        var title = g ? (group === 'ancestor' ? generationName(g) : descendantName(g)) : 'Generation not known';
        box.appendChild(el('h4', null, title + ' (' + byGen.get(g).length + ')'));
        box.appendChild(el('ul', { class: 'fh-list' }, byGen.get(g).map(personItem)));
      });
    } else {
      box.appendChild(el('ul', { class: 'fh-list' }, list.map(personItem)));
    }
    return { box: box, count: list.length };
  }

  async function peopleView(live) {
    var all = await loadPeople();
    if (!live()) return null;
    var s = section('People', 'People');
    var input = el('input', { type: 'search', id: 'fh-q', autocomplete: 'off', enterkeyhint: 'search', 'aria-describedby': 'fh-q-hint' });
    var results = el('div', { class: 'fh-results', id: 'fh-results' });
    var form = el('form', { role: 'search', class: 'fh-search', 'aria-label': 'Search the tree' },
      el('label', { for: 'fh-q' }, 'Search everyone in the tree'),
      el('p', { id: 'fh-q-hint', class: 'fh-small' }, 'A first name, last name or maiden name. Relatives come first.'),
      el('div', { class: 'fh-searchrow' }, input, el('button', { type: 'submit', class: 'fh-btn' }, 'Search')));
    var timer = null;
    var searchSeq = 0;
    async function search(announce) {
      var q = input.value.trim();
      var mine = ++searchSeq;
      if (q.length < 2) {
        results.replaceChildren();
        if (announce) say('Type at least two letters.');
        return;
      }
      try {
        var rows = await api('/search?q=' + enc(q));
        if (mine !== searchSeq) return;
        rows = Array.isArray(rows) ? rows : (rows && rows.results) || [];
        results.replaceChildren(el('h3', null, 'Search results'), rows.length ? el('ul', { class: 'fh-list' }, rows.map(personItem)) : el('p', null, 'Nobody in the tree matches “' + q + '”.'));
        say(rows.length ? plural(rows.length, 'person', 'people') + ' found' + (rows.length >= 50 ? ', showing the first 50' : '') + '.' : 'Nobody matches.');
      } catch (e) {
        if (mine === searchSeq) say(e.message, true);
      }
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); search(true); });
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { search(false); }, 350); });
    s.appendChild(form);
    s.appendChild(results);

    var groups = [
      ['ancestor', 'Ancestors'],
      ['descendant', 'Descendants'],
      ['blood', 'Blood relatives'],
      ['marriage', 'By marriage'],
      ['none', 'No known link'],
    ].filter(function (g) { return all.some(function (p) { return groupOf(p) === g[0]; }); });
    if (groups.every(function (g) { return g[0] !== peopleGroup; }) && groups.length) peopleGroup = groups[0][0];
    s.appendChild(el('h3', { id: 'fh-browse-h' }, 'Browse the tree'));
    var picker = el('div', { class: 'fh-picker', role: 'group', 'aria-labelledby': 'fh-browse-h' });
    var listBox = el('div');
    var intro = {
      ancestor: 'Ancestors by generation, nearest first.',
      descendant: 'Descendants by generation.',
      blood: 'Blood relatives who are not direct ancestors, nearest first.',
      marriage: 'People who married into the family, nearest first.',
      none: 'People in the tree with no known link yet.',
    };
    function draw(group, announce) {
      peopleGroup = group;
      Array.prototype.forEach.call(picker.children, function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-group') === group)); });
      var made = peopleList(all, group);
      listBox.replaceChildren(el('p', { class: 'fh-small' }, intro[group] || ''), made.box);
      if (announce) say('Showing ' + plural(made.count, 'person', 'people') + '.');
    }
    groups.forEach(function (g) {
      var count = all.filter(function (p) { return groupOf(p) === g[0]; }).length;
      picker.appendChild(el('button', { type: 'button', class: 'fh-pick', 'data-group': g[0], onclick: function () { draw(g[0], true); } }, g[1] + ' (' + num(count) + ')'));
    });
    s.appendChild(picker);
    s.appendChild(listBox);
    draw(peopleGroup, false);
    return s;
  }

  /* ── stories ──────────────────────────────────────────────────────────── */

  function renderInline(nodes, parent) {
    nodes.forEach(function (n) {
      if (n.t === 'text') parent.appendChild(document.createTextNode(n.v));
      else if (n.t === 'code') parent.appendChild(el('code', null, n.v));
      else if (n.t === 'strong') renderInline(n.c, parent.appendChild(el('strong')));
      else if (n.t === 'em') renderInline(n.c, parent.appendChild(el('em')));
      else if (n.t === 'span') renderInline(n.c, parent);
      else if (n.t === 'source') {
        parent.appendChild(el('span', { class: 'chip fh-source', title: n.v }, el('span', { 'aria-hidden': 'true' }, 'source'), el('span', { class: 'sr-only' }, ' (source: ' + n.v + ')')));
      } else if (n.t === 'link') {
        var inPage = n.href.indexOf('#/') === 0;
        var a = el('a', inPage ? { href: n.href } : { href: n.href, target: '_blank', rel: 'noopener noreferrer' });
        renderInline(n.c, a);
        if (!inPage) a.appendChild(el('span', { class: 'sr-only' }, ' (opens a new tab)'));
        parent.appendChild(a);
      }
    });
    return parent;
  }

  function renderMarkdown(blocks, parent, title) {
    var skipTitle = blocks.length && blocks[0].type === 'heading' && blocks[0].inline.map(function (n) { return n.v || ''; }).join('').trim() === String(title || '').trim();
    var levels = blocks.filter(function (b, i) { return b.type === 'heading' && !(i === 0 && skipTitle); }).map(function (b) { return b.level; });
    var shift = 3 - (levels.length ? Math.min.apply(null, levels) : 1);
    blocks.forEach(function (b, i) {
      if (i === 0 && skipTitle) return;
      if (b.type === 'heading') parent.appendChild(renderInline(b.inline, el('h' + Math.min(6, b.level + shift))));
      else if (b.type === 'paragraph') parent.appendChild(renderInline(b.inline, el('p')));
      else if (b.type === 'quote') parent.appendChild(renderInline(b.inline, el('blockquote')));
      else if (b.type === 'rule') parent.appendChild(el('hr'));
      else if (b.type === 'code') parent.appendChild(el('pre', null, el('code', null, b.text)));
      else if (b.type === 'list') parent.appendChild(el(b.ordered ? 'ol' : 'ul', null, b.items.map(function (it) { return renderInline(it, el('li')); })));
      else if (b.type === 'table') {
        parent.appendChild(el('div', { class: 'fh-tablewrap', role: 'region', 'aria-label': 'Table (scrolls sideways)', tabindex: '0' }, el('table', null,
          el('thead', null, el('tr', null, b.head.map(function (c) { return renderInline(c, el('th', { scope: 'col' })); }))),
          el('tbody', null, b.rows.map(function (row) { return el('tr', null, row.map(function (c) { return renderInline(c, el('td')); })); })))));
      }
    });
    return parent;
  }

  function minutes(words) {
    var m = Math.max(1, Math.round((Number(words) || 0) / 200));
    return 'about ' + plural(m, 'minute') + ' to read';
  }

  async function storiesView(live) {
    var list = cache.stories || await api('/stories');
    if (!live()) return null;
    cache.stories = list;
    list = Array.isArray(list) ? list : [];
    var s = section('Stories', 'Stories');
    if (!list.length) {
      s.appendChild(el('p', null, 'No stories have been written yet. They will appear here as the research turns into stories.'));
      return s;
    }
    s.appendChild(el('ul', { class: 'fh-stories' }, list.map(function (st) {
      return el('li', null, el('a', { href: '#/story/' + enc(st.slug) }, st.title || st.slug), st.words ? el('span', { class: 'fh-small' }, ' — ' + num(st.words) + ' words, ' + minutes(st.words)) : '');
    })));
    return s;
  }

  async function storyView(live, slug) {
    var st = await api('/story/' + enc(slug));
    if (!live()) return null;
    var title = st.title || slug;
    var s = section(title, title);
    s.appendChild(el('p', null, el('a', { href: '#/stories' }, 'All stories')));
    s.appendChild(renderMarkdown(parseMarkdown(st.markdown || ''), el('article', { class: 'fh-story', 'aria-labelledby': 'fh-view-heading' }), title));
    s.appendChild(el('p', null, el('a', { href: '#/stories' }, 'Back to all stories')));
    return s;
  }

  /* ── research findings ────────────────────────────────────────────────── */

  async function findingsView(live) {
    var list = cache.findings || await api('/findings');
    if (!live()) return null;
    cache.findings = list;
    list = Array.isArray(list) ? list : [];
    var s = section('Research findings', 'Research findings');
    s.appendChild(el('p', { class: 'fh-flagnote' }, 'These come from the research (DNA matches, obituaries, records) and are not proven. They are shown so the family can help confirm or correct them.'));
    if (!list.length) s.appendChild(el('p', null, 'There are no research findings yet.'));
    list.forEach(function (f) { s.appendChild(findingCard(f, 'h3')); });
    return s;
  }

  /* ── owner: who can see this ──────────────────────────────────────────── */

  async function accountsView(live) {
    var rows = await api('/accounts');
    if (!live()) return null;
    rows = Array.isArray(rows) ? rows : [];
    var s = section('Who can see this', 'Who can see this');
    s.appendChild(el('p', null, 'Match each family account to that person’s place in the tree. A matched account sees the tree from its own place. A guest sees it from yours. Everyone else is told it is private to the family.'));
    var busy = false;
    function accessWords(a) {
      if (a.testSeat) return 'Test account: always kept out of the family history.';
      if (a.access === 'family') return 'Matched to ' + (a.personLabel || a.personId) + '.';
      if (a.access === 'owner') return 'Administrator: always sees the tree as its owner.';
      if (a.access === 'guest') return 'Guest: sees the tree from your place.';
      if (a.personId) return 'Matched to a tree entry that is no longer in the tree (' + a.personId + '). No access until you match again.';
      return 'No access.';
    }
    /* The confirmation is spoken after focus lands on the account's heading,
     * so the focus move does not cut it off. */
    async function change(button, body, done) {
      if (busy) return;
      busy = true;
      button.setAttribute('aria-disabled', 'true');
      try {
        await api('/match', body);
        cache.person.clear();
        var fresh = await api('/accounts').catch(function () { return null; });
        rows = Array.isArray(fresh) ? fresh : rows;
        draw(body.userId);
        setTimeout(function () { say(done); }, 150);
      } catch (e) {
        say(e.message, true);
      } finally {
        busy = false;
        button.removeAttribute('aria-disabled');
      }
    }
    var list = el('div', { class: 'fh-accounts' });
    function draw(focusUser) {
      list.replaceChildren();
      rows.forEach(function (a) {
        var who = (a.name || a.username || 'Someone') + (a.username && a.name ? ' (' + a.username + ')' : '');
        var hid = 'fh-acct-' + String(a.userId).replace(/[^A-Za-z0-9_-]/g, '');
        var card = el('article', { class: 'card fh-account', 'aria-labelledby': hid }, el('h3', { id: hid, tabindex: '-1' }, who), el('p', null, accessWords(a)));
        if (a.changeable === false) {
          list.appendChild(card);
          return;
        }
        var actions = el('p', { class: 'fh-actions' });
        var finder = el('div', { class: 'fh-finder', hidden: true });
        var matchBtn = el('button', { type: 'button', class: 'fh-btn', 'aria-expanded': 'false' }, a.personId ? 'Match to someone else' : 'Match to a person');
        matchBtn.addEventListener('click', function () {
          var open = finder.hidden;
          finder.hidden = !open;
          matchBtn.setAttribute('aria-expanded', String(open));
          if (open) finder.querySelector('input').focus();
        });
        actions.appendChild(matchBtn);
        if (a.access !== 'guest' && a.access !== 'owner' && !a.personId) {
          var guestBtn = el('button', { type: 'button', class: 'fh-btn quiet' }, 'Let in as a guest');
          guestBtn.addEventListener('click', function () { change(guestBtn, { userId: a.userId, personId: null, guest: true }, who + ' can now visit as a guest.'); });
          actions.appendChild(guestBtn);
        }
        if (a.personId || a.access === 'guest') {
          var offBtn = el('button', { type: 'button', class: 'fh-btn quiet danger' }, 'Remove access');
          offBtn.addEventListener('click', function () { change(offBtn, { userId: a.userId, personId: null, guest: false }, who + ' no longer has access.'); });
          actions.appendChild(offBtn);
        }
        var qid = hid + '-q';
        var q = el('input', { type: 'search', id: qid, autocomplete: 'off' });
        var found = el('ul', { class: 'fh-list' });
        var findForm = el('form', { class: 'fh-search', role: 'search' }, el('label', { for: qid }, 'Find ' + (a.name || 'this person') + ' in the tree'), el('div', { class: 'fh-searchrow' }, q, el('button', { type: 'submit', class: 'fh-btn' }, 'Find')));
        findForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          if (q.value.trim().length < 2) { say('Type at least two letters.'); return; }
          try {
            var hits = await api('/search?q=' + enc(q.value.trim()));
            hits = Array.isArray(hits) ? hits : [];
            found.replaceChildren.apply(found, hits.slice(0, 15).map(function (h) {
              var pick = el('button', { type: 'button', class: 'fh-pickperson' }, 'Choose ' + nameOf(h) + (h.lifespan ? ' (' + h.lifespan + ')' : '') + (rel(h.relation) ? ', ' + rel(h.relation) : ''));
              pick.addEventListener('click', function () { change(pick, { userId: a.userId, personId: h.id }, who + ' is now matched to ' + nameOf(h) + '.'); });
              return el('li', null, pick);
            }));
            say(hits.length ? plural(Math.min(hits.length, 15), 'match', 'matches') + ' to choose from.' : 'Nobody matches.');
          } catch (err) { say(err.message, true); }
        });
        finder.appendChild(findForm);
        finder.appendChild(found);
        card.appendChild(actions);
        card.appendChild(finder);
        list.appendChild(card);
        if (focusUser && focusUser === a.userId) setTimeout(function () { var h = document.getElementById(hid); if (h) h.focus(); }, 0);
      });
      if (!rows.length) list.appendChild(el('p', null, 'No accounts to show.'));
    }
    draw(null);
    s.appendChild(list);
    return s;
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */

  async function resolveAnchor() {
    if (me.mode === 'guest') { anchor = firstName(nameOf(me.viewer)); return; }
    if (!me.viewNote) return;
    anchor = 'the tree owner';
    try {
      var all = await loadPeople();
      var self = all.filter(function (p) { return groupOf(p) === 'self' || (relOf(p.relation) || {}).term === 'you'; })[0];
      if (self) anchor = firstName(nameOf(self));
    } catch (e) {
      anchor = 'the tree owner';
    }
  }

  /* "Your father's side" needs the viewer's parents before the first view
   * draws (a shared link can open straight onto a person). The viewer's own
   * entry names them. With the owner's view standing in, resolveAnchor has
   * already learned the owner's parents from the people list. */
  async function learnViewerSides() {
    sides.selfName = me.viewer.name || nameOf(me.viewer);
    if (me.viewNote) return;
    try {
      var id = me.viewer.personId;
      var data = cache.person.get(id) || await api('/person/' + enc(id));
      cache.person.set(id, data);
      ((data.family && data.family.parents) || []).forEach(function (m) { learnSides(m.id, m.relation); });
    } catch (e) {
      /* the side words fall back to the words of each line */
    }
  }

  var booted = false;
  async function boot() {
    say('Checking that this account is family…');
    token = await freshToken();
    if (!token) { signIn(); return; }
    try {
      me = await api('/me');
    } catch (e) {
      if (e.quiet) return;
      mount(e.status === 403 ? privateSection(e.message) : errorSection(e, boot));
      say(e.message, e.status !== 403);
      return;
    }
    if (!me || !me.access || !me.viewer) {
      mount(privateSection(me && me.error));
      say('');
      return;
    }
    await resolveAnchor();
    await learnViewerSides();
    nav.hidden = false;
    if (isOwner() && !nav.querySelector('[data-route="accounts"]')) {
      nav.appendChild(el('a', { href: '#/accounts', 'data-route': 'accounts' }, 'Who can see this'));
    }
    if (location.hash && location.hash !== '#' && location.hash !== '#/') firstRender = false;
    if (booted) { route(); return; }
    booted = true;
    window.addEventListener('hashchange', function () {
      if (dialog && dialog.open) dialog.close();
      route();
    });
    route();
  }

  boot();
})();
