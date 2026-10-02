/* Family history (Sep 29 2026). Contract: docs/FAMILY_HISTORY.md.
 *
 * One page, hash routes so Back works: #/ (start), #/tree/<id>, #/person/<id>,
 * #/people, #/gallery, #/stories, #/story/<slug>, #/findings, #/dna, #/note,
 * and for the tree's owner #/accounts and #/notes. Every word about the family
 * comes from /api/kade/family-history, read with ?v=2: the server writes each
 * relationship, sentence and picture label from the viewer's own place ("your
 * grandmother", or "Ada's grandmother" for a guest), so this file only draws.
 *
 * Nothing is built with innerHTML: every name, caption and story line is set
 * with textContent, so a record transcription or a story can never inject
 * markup. Links from the data are web links only.
 *
 * The pure helpers at the top (the tree layout, the markdown reader kept for
 * older answers, hash routes, where a spoken sentence sits in the story text)
 * are also loaded by api/server/routes/kadeFamilyHistoryPage.nodetest.js and
 * by the server's layout and story tests, which check their ports against them. */
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
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

  function capital(text) {
    var s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /* "5 March 2026", from the server's ISO times (asks and notes). */
  function dayWords(iso) {
    var d = new Date(String(iso || ''));
    if (!iso || isNaN(d.getTime())) return '';
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* A person card's relationship in words: "your grandfather, Dad's side".
   * The side is left out when the term already says it; with `research`, the
   * proof words follow ("research finding, strong DNA evidence"). */
  function personWords(card, research) {
    if (!card) return '';
    var words = [];
    var term = String(card.term || '').trim();
    var side = String(card.sideText || '').trim();
    if (term) words.push(term);
    if (side && term.toLowerCase().indexOf(side.toLowerCase()) === -1) words.push(side);
    if (research && card.research && card.research.text) {
      words.push('research finding, ' + String(card.research.text).charAt(0).toLowerCase() + String(card.research.text).slice(1));
    }
    return words.join(', ');
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
   * two boxes in a row can overlap, then turned into pixels. The server's
   * layout.ts is a port of this function, checked box for box. */
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

  /* ── hash routes ──────────────────────────────────────────────────────── */

  function decodePart(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return ''; }
  }

  /* "#/gallery?kind=records&from=48" -> { name: 'gallery', arg: '', query: {...} }.
   * The query has no prototype, so a key such as __proto__ is only a key. */
  function parseHash(hash) {
    var h = String(hash || '').replace(/^#\/?/, '');
    var query = Object.create(null);
    var q = h.indexOf('?');
    if (q !== -1) {
      h.slice(q + 1).split('&').forEach(function (pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        var key = decodePart(eq === -1 ? pair : pair.slice(0, eq));
        if (key && !(key in query)) query[key] = eq === -1 ? '' : decodePart(pair.slice(eq + 1));
      });
      h = h.slice(0, q);
    }
    var slash = h.indexOf('/');
    return {
      name: slash === -1 ? h : h.slice(0, slash),
      arg: slash === -1 ? '' : decodePart(h.slice(slash + 1)),
      query: query,
    };
  }

  function hashFor(name, arg, query) {
    var out = '#/' + name + (arg ? '/' + encodeURIComponent(arg) : '');
    var pairs = [];
    Object.keys(query || {}).forEach(function (k) {
      var v = query[k];
      if (v != null && v !== '') pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return pairs.length ? out + '?' + pairs.join('&') : out;
  }

  /* Where a tile, card or row from the server goes on this page ({to, id,
   * since, filter}); null for the parts only the iPhone app has so far. */
  function openHref(open) {
    if (!open || typeof open !== 'object') return null;
    var id = typeof open.id === 'string' ? open.id : '';
    switch (open.to) {
      case 'tree': return hashFor('tree', id);
      case 'person': return id ? hashFor('person', id) : null;
      case 'gallery': return hashFor('gallery', '', { kind: open.filter || '', since: open.since || '', person: id });
      case 'story': return id ? hashFor('story', id) : '#/stories';
      case 'stories': return '#/stories';
      case 'dna': return '#/dna';
      case 'discoveries': return '#/findings';
      case 'mysteries': return '#/findings/mysteries';
      case 'people': return '#/people';
      case 'note': return hashFor('note', '', { person: id });
      default: return null;
    }
  }

  /* ── where each spoken sentence sits in the story text ───────────────────
   * Listen reads the story in parts, one caption cue per sentence. To light up
   * the sentence being read, each cue is found in the text of the blocks drawn
   * on the page by its letters and digits alone (so spacing, punctuation and
   * the full stop a spoken heading gains never get in the way), in order. */
  function textKey(text) {
    var s = String(text || '');
    var key = '';
    var at = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i).toLowerCase().charAt(0);
      if (/[a-z0-9ß-ɏ]/.test(c)) {
        key += c;
        at.push(i);
      }
    }
    return { key: key, at: at };
  }

  /* cueRanges(["Block one text.", "Block two."], [["Block one text.", "Block two."]])
   * -> per part, per cue: { from: {block, at}, to: {block, at} } (to.at is past
   * the sentence's last mark), or null for a cue that could not be placed. */
  function cueRanges(blockTexts, cueLists) {
    var key = '';
    var blockOf = [];
    var posOf = [];
    var texts = (blockTexts || []).map(function (t) { return String(t || ''); });
    texts.forEach(function (text, b) {
      var k = textKey(text);
      key += k.key;
      for (var i = 0; i < k.at.length; i++) {
        blockOf.push(b);
        posOf.push(k.at[i]);
      }
    });
    var cursor = 0;
    return (cueLists || []).map(function (cues) {
      return (cues || []).map(function (cue) {
        var want = textKey(cue).key;
        if (!want) return null;
        var found = key.indexOf(want, cursor);
        if (found === -1 || found - cursor > 4000) return null;
        var last = found + want.length - 1;
        cursor = last + 1;
        var endBlock = blockOf[last];
        var end = posOf[last] + 1;
        var text = texts[endBlock];
        while (end < text.length && /[^\s0-9A-Za-zÀ-ɏ]/.test(text.charAt(end))) end++;
        return { from: { block: blockOf[found], at: posOf[found] }, to: { block: endBlock, at: end } };
      });
    });
  }

  /* ── safe markdown: text only, never raw HTML ─────────────────────────────
   * The v2 story answer carries blocks the server read; this reader stays for
   * an answer without them, and as the original the server's port is checked
   * against (packages/api/src/family/story.test.ts). */

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

  /* The routes this page draws, by the first part of the hash. */
  var ROUTES = ['', 'tree', 'person', 'people', 'gallery', 'stories', 'story', 'findings', 'dna', 'note', 'accounts', 'notes'];

  function archivePath(path, id) {
    return !id || id === 'default' ? path : path + (path.indexOf('?') === -1 ? '?' : '&') + 'archive=' + encodeURIComponent(id);
  }

  function archiveGuard(expected, readCurrent) {
    return function () {
      var current = readCurrent();
      if (current.id !== expected.id || current.seq !== expected.seq) throw Object.assign(new Error('Family archive changed.'), { quiet: true });
    };
  }

  var parts = {
    ordinal: ordinal,
    generationName: generationName,
    descendantName: descendantName,
    nameOf: nameOf,
    dayWords: dayWords,
    personWords: personWords,
    chooseParents: chooseParents,
    layoutTree: layoutTree,
    parentWords: parentWords,
    parseHash: parseHash,
    hashFor: hashFor,
    openHref: openHref,
    textKey: textKey,
    cueRanges: cueRanges,
    parseInline: parseInline,
    parseMarkdown: parseMarkdown,
    safeHref: safeHref,
    webHref: webHref,
    isSourcePath: isSourcePath,
    ROUTES: ROUTES,
    archivePath: archivePath,
    archiveGuard: archiveGuard,
  };
  if (typeof module === 'object' && module && module.exports) module.exports = parts;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  /* ── the page ─────────────────────────────────────────────────────────── */

  var API = '/api/kade/family-history';
  /* The family sky (sky.js) sits beside this file, at this file's version,
   * and loads only when a tree view can show it. */
  var SKY_SRC = (function () {
    var own = document.currentScript && document.currentScript.src;
    return own && /history\.js(\?[^#]*)?$/.test(own) ? own.replace(/history\.js(\?[^#]*)?$/, 'sky.js$1') : '/assets/family/sky.js';
  })();
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SILENCE = '/assets/silence.mp3';
  var ZOOMS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
  var PHONE_WIDTH = 600;
  var PHONE_UP = 2;
  var RECORDS_FIRST = 10;
  var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  var SIDE_WORDS = {
    self: 'You',
    father: 'Dad’s side',
    mother: 'Mom’s side',
    both: 'Both sides',
    marriage: 'By marriage',
    research: 'Research finding',
    descendant: 'Descendants',
    none: 'No known link',
  };
  var view = document.getElementById('fh-view');
  var statusEl = document.getElementById('fh-status');
  var nav = document.getElementById('fh-nav');
  var token = null;
  var me = null;
  var activeArchive = 'default';
  var archiveCatalog = [];
  var archiveSeq = 0;
  var archiveVersions = new Map();
  var navSeq = 0;
  var firstRender = true;
  var treeDepth = { up: 4, down: 2 };
  var cards = new Map();
  var signedUrls = new Map();
  var fileCache = new Map();
  var listening = null;
  var viewer = null;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function storeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storeSet(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* private window: remembered for this visit only */ }
  }

  /* One polite status line; inside the picture viewer (a modal dialog, which
   * hides the rest of the page from screen readers) the viewer's own line. */
  var sayTimer = null;
  function say(text, isError) {
    var target = viewer && viewer.dialog.open ? viewer.status : statusEl;
    clearTimeout(sayTimer);
    [statusEl, viewer && viewer.status].forEach(function (region) {
      if (!region) return;
      region.classList.toggle('err', !!isError && region === target);
      region.textContent = '';
    });
    if (!text) return;
    sayTimer = setTimeout(function () { target.textContent = text; }, 30);
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
    return hashFor('person', id);
  }

  function treeHref(id) {
    return hashFor('tree', id);
  }

  /* Signed picture addresses from the server: web addresses, or this site's own. */
  function srcOk(url) {
    return typeof url === 'string' && (/^https?:\/\/[^\s]+$/i.test(url) || /^\/[^\/\s][^\s]*$/.test(url));
  }

  /* A link to another site, or the plain words when the address is not a
   * web address (a javascript: or data: address never becomes a link). */
  function newTab(href, text, extraClass) {
    var safe = webHref(href);
    if (!safe) return document.createTextNode(text);
    return el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', class: extraClass || null },
      text, el('span', { class: 'sr-only', 'data-skip': '1' }, ' (opens a new tab)'));
  }

  /* The latest card for each person, so a note or a title can name them. */
  function remember(card) {
    if (!card || !card.id || !card.name) return card;
    cards.set(card.id, card);
    if (cards.size > 3000) cards.delete(cards.keys().next().value);
    return card;
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

  /* A signed-in request; one fresh sign-in is tried when the old one ran out. */
  function currentRequestGuard() {
    return archiveGuard({ id: activeArchive, seq: archiveSeq }, function () { return { id: activeArchive, seq: archiveSeq }; });
  }

  async function authFetch(path, init) {
    var guard = currentRequestGuard();
    var requestedPath = archivePath(path, activeArchive);
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!token) token = await freshToken();
      if (!token) { signIn(); throw Object.assign(new Error('Signed out.'), { status: 401, quiet: true }); }
      var opts = { cache: 'no-store', method: (init && init.method) || 'GET', headers: { Authorization: 'Bearer ' + token } };
      if (init && init.body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = init.body;
      }
      var r;
      try {
        r = await fetch(API + requestedPath, opts);
      } catch (e) {
        throw Object.assign(new Error('Could not reach the site. Check your connection and try again.'), { status: 0 });
      }
      guard();
      if (r.status === 401 && attempt === 0) { token = null; continue; }
      return r;
    }
    throw Object.assign(new Error('Your sign-in ran out. Please sign in again.'), { status: 401 });
  }

  async function api(path, body) {
    var guard = currentRequestGuard();
    var r = await authFetch(path, body ? { method: 'POST', body: JSON.stringify(body) } : null);
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    guard();
    if (r.status === 401) throw Object.assign(new Error('Your sign-in ran out. Please sign in again.'), { status: 401 });
    if (!r.ok) {
      var message = (j && j.error) || (r.status === 404 ? 'That was not found in the family tree.' : 'The site answered with an error (' + r.status + ').');
      throw Object.assign(new Error(message), { status: r.status, body: j });
    }
    if (j && j.version) {
      var previousVersion = archiveVersions.get(activeArchive);
      if (previousVersion && previousVersion !== j.version) { cards.clear(); signedUrls.clear(); fileCache.clear(); }
      archiveVersions.set(activeArchive, j.version);
    }
    return j;
  }

  /* A signed address for one size of a picture ('' = the stored file). */
  function signed(id, size) {
    var key = activeArchive + '|' + id + '|' + (size || '');
    var hit = signedUrls.get(key);
    if (hit && Date.now() - hit.at < 40 * 60 * 1000) return hit.promise;
    var promise = api('/media/' + enc(id) + (size ? '?size=' + enc(size) : '')).then(function (j) {
      if (!j || !srcOk(j.url)) throw new Error('No picture address came back.');
      return j.url;
    });
    promise.catch(function () { signedUrls.delete(key); });
    signedUrls.set(key, { at: Date.now(), promise: promise });
    return promise;
  }

  function sizesOf(image) {
    return Array.isArray(image && image.sizes) ? image.sizes : [];
  }

  /* A picture the browser can draw (the rest are documents that open in a tab). */
  function hasPicture(image) {
    if (!image) return false;
    var s = sizesOf(image);
    if (image.thumb || s.indexOf('t') !== -1 || s.indexOf('s') !== -1) return true;
    return !s.length && ['photo', 'portrait', 'grave', 'record'].indexOf(image.category) !== -1;
  }

  /* The best copy to look at closely: the 2,048 pixel copy, or for a big
   * scan the 4,096 one; an older bundle's stored file otherwise. */
  function viewSize(image) {
    var s = sizesOf(image);
    return s.indexOf('s') !== -1 ? 's' : s.indexOf('l') !== -1 ? 'l' : '';
  }

  function fullSize(image) {
    var s = sizesOf(image);
    var scan = image.category === 'record' || image.category === 'document';
    if (scan && s.indexOf('l') !== -1) return 'l';
    if (scan && s.indexOf('o') !== -1) return 'o';
    return viewSize(image);
  }

  function saveSize(image) {
    var s = sizesOf(image);
    var scan = image.category === 'record' || image.category === 'document';
    if (scan && s.indexOf('l') !== -1) return 'l';
    return s.indexOf('s') !== -1 ? 's' : s.indexOf('l') !== -1 ? 'l' : null;
  }

  /* An <img> for a picture reference. The server signs the small sizes into
   * the answer; an address that has run out (a page left open for an hour) is
   * signed again once, then the picture says it is not available. */
  function picture(image, opts) {
    opts = opts || {};
    var alt = opts.alt != null ? opts.alt : (image.alt || image.short || 'A picture');
    var img = el('img', { alt: alt, class: opts.className || null, decoding: 'async', loading: opts.eager ? null : 'lazy', 'aria-hidden': opts.hidden ? 'true' : null });
    var first = opts.face ? (image.face || image.thumb) : image.thumb;
    var tried = false;
    function resign() {
      if (tried) { pictureFailed(img, alt, opts.hidden); return; }
      tried = true;
      var s = sizesOf(image);
      var size = opts.face && s.indexOf('f') !== -1 ? 'f' : s.indexOf('t') !== -1 ? 't' : viewSize(image);
      signed(image.id, size).then(function (url) { img.src = url; }).catch(function () { pictureFailed(img, alt, opts.hidden); });
    }
    img.addEventListener('error', function () { if (img.getAttribute('src')) resign(); });
    if (srcOk(first)) img.src = first;
    else if (lazyObserver) { lazyQueue.set(img, resign); lazyObserver.observe(img); } else resign();
    return img;
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

  function pictureFailed(img, alt, decorative) {
    if (!img.parentNode) return;
    if (decorative) { img.remove(); return; }
    img.parentNode.replaceChild(el('span', { class: 'fh-nopic' }, 'Picture not available: ' + alt), img);
  }

  function sideClass(card) {
    if (!card) return 'none';
    if (card.research) return 'research';
    return Object.prototype.hasOwnProperty.call(SIDE_WORDS, card.side) ? card.side : 'none';
  }

  /* A face beside a name (decorative: the name and relationship are in the
   * words), or the person's initials in their side's colour. */
  function faceEl(card, big) {
    var cls = 'fh-face side-' + sideClass(card) + (big ? ' is-big' : '');
    var f = card && card.face;
    var src = f && (srcOk(f.face) ? f.face : srcOk(f.thumb) ? f.thumb : null);
    if (!src) return el('span', { class: cls + ' fh-initials', 'aria-hidden': 'true' }, (card && card.initials) || '?');
    var img = el('img', { alt: '', class: cls, decoding: 'async', loading: 'lazy', 'aria-hidden': 'true', src: src });
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.replaceChild(el('span', { class: cls + ' fh-initials', 'aria-hidden': 'true' }, card.initials || '?'), img);
    });
    return img;
  }

  function magnifier() {
    return svg('svg', { width: '14', height: '14', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false', class: 'fh-pillicon' },
      svg('circle', { cx: '6.5', cy: '6.5', r: '4.5' }), svg('path', { d: 'M10 10l4.5 4.5' }));
  }

  /* The Research pill: a magnifying glass and "Research" to see; the proof
   * words to hear ("research finding, strong DNA evidence, not proven by records"). */
  function researchPill(text, spoken) {
    return el('span', { class: 'fh-pill' }, magnifier(), el('span', { 'aria-hidden': 'true' }, 'Research'),
      el('span', { class: 'sr-only' }, spoken || 'Research finding' + (text ? ', ' + String(text).charAt(0).toLowerCase() + String(text).slice(1) : '') + ', not proven by records'));
  }

  /* The one proof scale: "Proven by records", or the Research pill with its words. */
  function proofLine(proof, proofText) {
    if (proof === 'records' || !proof) return el('p', { class: 'fh-proof is-proven' }, proofText || 'Proven by records');
    return el('p', { class: 'fh-proof' }, el('span', { class: 'fh-pill' }, magnifier(), 'Research'), ' ', (proofText || 'Research finding') + '. Not proven by records.');
  }

  /* One person in a list: face, name (a link), years, relationship, and the
   * Research pill when the link to them is a research finding. */
  function personRow(card, opts) {
    opts = opts || {};
    remember(card);
    var li = el('li', { class: 'fh-personrow' });
    li.appendChild(faceEl(card));
    var text = el('span', { class: 'fh-personrow-text' });
    text.appendChild(el('a', { href: personHref(card.id), id: opts.id || null }, card.name || nameOf(card)));
    if (card.yearsSpoken) text.appendChild(el('span', { class: 'fh-years' }, ' (' + card.yearsSpoken + ')'));
    var words = [personWords(card), opts.extra].filter(Boolean).join('; ');
    if (words) text.appendChild(document.createTextNode(', ' + words));
    if (card.research) text.appendChild(document.createTextNode(' '));
    if (card.research) text.appendChild(researchPill(card.research.text));
    li.appendChild(text);
    if (opts.centre) {
      li.appendChild(document.createTextNode(' '));
      li.appendChild(el('a', { href: treeHref(card.id), class: 'fh-small', 'aria-label': 'Centre the tree on ' + (card.name || 'this person') }, 'Centre here'));
    }
    return li;
  }

  function personList(list, opts) {
    return el('ul', { class: 'fh-people', role: 'list' }, (list || []).filter(function (c) { return c && c.id; }).map(function (c, i) {
      return personRow(c, Object.assign({}, opts || {}, { id: opts && opts.firstId && i === 0 ? opts.firstId : null }));
    }));
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
      say(e.message, e.status !== 403);
    } finally {
      if (live()) view.removeAttribute('aria-busy');
    }
  }

  function errorSection(e, retry) {
    if (e.status === 403 && e.body && e.body.reason) return lockedSection(e.body);
    var s = section(e.status === 404 ? 'Not found' : e.status === 403 ? 'Not open to you' : 'Something went wrong');
    s.appendChild(el('p', { class: 'status err' }, e.message));
    var row = el('p', { class: 'fh-actions' });
    if (retry && e.status !== 404 && e.status !== 403) row.appendChild(el('button', { type: 'button', class: 'fh-btn', onclick: retry }, 'Try again'));
    if (me && me.access) row.appendChild(el('a', { href: '#/', class: 'fh-btn quiet' }, 'Family history start'));
    else row.appendChild(el('a', { href: '/home', class: 'fh-btn quiet' }, 'Back to Home'));
    s.appendChild(row);
    return s;
  }

  /* The page for an account that is not let in, with the reason the server
   * gives, and "Ask to be added" for an account nobody has matched yet. */
  function lockedSection(refusal) {
    var r = refusal || {};
    var s = section('Private to the family');
    s.appendChild(el('p', { class: 'status' }, r.error || 'The family history is private to the family.'));
    var detail = el('p', { class: 'fh-lead', id: 'fh-locked-detail', tabindex: '-1' }, r.detail || '');
    var hint = el('p', null, r.hint || 'It opens for family members whose accounts have been matched to their place in the family tree.');
    s.appendChild(detail);
    s.appendChild(hint);
    var row = el('p', { class: 'fh-actions' });
    if (r.canAsk) {
      var ask = el('button', { type: 'button', class: 'fh-btn' }, 'Ask to be added');
      ask.addEventListener('click', async function () {
        if (ask.getAttribute('aria-disabled') === 'true') return;
        ask.setAttribute('aria-disabled', 'true');
        try {
          var done = await api('/ask', {});
          var after = done.refusal || {};
          detail.textContent = after.detail || ('Asked on ' + dayWords(done.askedAt));
          hint.textContent = done.text || 'Asked. The tree’s owner will see your request.';
          ask.remove();
          detail.focus();
          say(done.text || 'Asked.');
        } catch (e) {
          ask.removeAttribute('aria-disabled');
          say(e.message, true);
        }
      });
      row.appendChild(ask);
    }
    row.appendChild(el('a', { class: 'fh-btn quiet', href: '/home' }, 'Back to Home'));
    s.appendChild(row);
    return s;
  }

  function route() {
    stopListening();
    stopSky();
    var r = parseHash(location.hash);
    var current = { '': '', tree: 'tree', person: 'people', people: 'people', gallery: 'gallery', stories: 'stories', story: 'stories', findings: 'findings', dna: 'dna', accounts: 'accounts', notes: 'notes' }[r.name];
    Array.prototype.forEach.call(nav.querySelectorAll('a[data-route]'), function (a) {
      if (a.getAttribute('data-route') === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    var q = r.query;
    if (r.name === '') return show(homeView);
    if (r.name === 'tree') return show(function (live) { return treeView(live, r.arg); }, 'Loading the family tree…');
    if (r.name === 'person' && r.arg) return show(function (live) { return personView(live, r.arg); }, 'Loading this person…');
    if (r.name === 'people') return show(function (live) { return peopleView(live, q); }, 'Loading the people in the tree…');
    if (r.name === 'gallery') return show(function (live) { return galleryView(live, q); }, 'Loading the pictures…');
    if (r.name === 'stories') return show(storiesView, 'Loading the stories…');
    if (r.name === 'story' && r.arg) return show(function (live) { return storyView(live, r.arg); }, 'Loading the story…');
    if (r.name === 'findings') return show(function (live) { return findingsView(live, r.arg); }, 'Loading the discoveries…');
    if (r.name === 'dna') return show(dnaView, 'Loading what the DNA says…');
    if (r.name === 'note') return show(function (live) { return noteView(live, q); }, 'Loading…');
    if (r.name === 'accounts' && isOwner()) return show(accountsView, 'Loading the accounts…');
    if (r.name === 'notes' && isOwner()) return show(notesView, 'Loading the notes from the family…');
    return show(function () { return Promise.reject(Object.assign(new Error('There is no page at that address.'), { status: 404 })); });
  }

  function isOwner() {
    return !!(me && (me.isOwner || me.mode === 'owner'));
  }

  function ownerFirst() {
    return (me && me.owner && me.owner.first) || 'the tree’s owner';
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  async function homeView(live) {
    var seenKey = 'fh-seen-' + activeArchive + '-' + ((me.viewer && me.viewer.personId) || me.mode || 'you');
    var since = storeGet(seenKey);
    var home = await api('/home' + (since ? '?since=' + enc(since) : ''));
    if (!live()) return null;
    if (home.version) storeSet(seenKey, home.version);
    var s = section('Start here', 'Start');
    var hero = home.hero || {};
    var card = el('div', { class: 'card fh-hero' });
    if (hero.hello) card.appendChild(el('p', { class: 'fh-hello' }, hero.hello));
    if (hero.headline) card.appendChild(el('p', { class: 'fh-headline' }, hero.headline));
    [hero.youAre, hero.stats, hero.follows].forEach(function (t) { if (t) card.appendChild(el('p', null, t)); });
    var faces = home.faces || {};
    if (faces.layout === 'portrait' && faces.portrait && faces.portrait.image) {
      card.appendChild(el('figure', { class: 'fh-portrait' }, picture(faces.portrait.image, { className: 'fh-portrait-img', eager: true }), el('figcaption', null, faces.portrait.caption || '')));
    } else if ((faces.people || []).length) {
      card.appendChild(el('ul', { class: 'fh-faces', role: 'list', 'aria-label': 'Faces from the family' }, faces.people.map(function (p) {
        remember(p);
        return el('li', null, el('a', { href: personHref(p.id), 'aria-label': p.spoken || p.name }, faceEl(p, true), el('span', { class: 'fh-facename' }, p.first || p.name)));
      })));
    }
    s.appendChild(card);
    if (me.viewNote) s.appendChild(el('p', { class: 'fh-note' }, me.viewNote));
    if (home.news && home.news.text) {
      s.appendChild(el('p', { class: 'fh-news' }, el('a', { href: openHref(home.news.open) || '#/gallery' }, home.news.text)));
    }
    var featured = (home.featured || []).filter(Boolean);
    if (featured.length) {
      s.appendChild(el('h3', null, 'Featured'));
      s.appendChild(el('ul', { class: 'fh-cards', role: 'list' }, featured.map(function (f) {
        var href = openHref(f.open);
        var li = el('li', { class: 'card fh-featured' });
        li.appendChild(el('h4', null, href ? el('a', { href: href }, f.title) : f.title));
        if (f.image && hasPicture(f.image)) li.appendChild(picture(f.image, { className: 'fh-featured-img' }));
        li.appendChild(el('p', null, f.text));
        return li;
      })));
    }
    var go = el('nav', { class: 'fh-big', 'aria-label': 'Go to' });
    (home.tiles || []).concat(home.more || []).forEach(function (t, i) {
      var href = openHref(t.open);
      var id = 'fh-big-' + i;
      if (t.enabled === false) {
        go.appendChild(el('div', { class: 'fh-bigbtn is-off' }, el('strong', null, t.title), el('small', null, t.reason || t.detail || 'Not open to you')));
      } else if (href) {
        go.appendChild(el('a', { class: 'fh-bigbtn', href: href, 'aria-label': t.title, 'aria-describedby': id }, el('strong', null, t.title), el('small', { id: id }, t.detail || t.hint || '')));
      }
    });
    s.appendChild(go);
    if (home.owner) {
      var o = home.owner;
      s.appendChild(el('h3', null, 'For you, as the tree’s keeper'));
      s.appendChild(el('ul', { class: 'fh-list' },
        el('li', null, el('a', { href: '#/notes' }, 'Notes from the family'), o.notes ? ', ' + plural(o.notes, 'note') + ' to read' : ', nothing new'),
        el('li', null, el('a', { href: '#/accounts' }, 'Who can see this'), o.asks ? ', ' + plural(o.asks, 'account') + ' asking to be added' : '')));
    }
    if (home.comingSoon) s.appendChild(el('p', { class: 'fh-small' }, home.comingSoon));
    if (home.footnote) s.appendChild(el('p', { class: 'fh-small' }, home.footnote));
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

  function legend(lines) {
    var cats = ['self', 'father', 'mother', 'both', 'marriage', 'research', 'descendant'];
    var hints = {
      self: ' (thick border)',
      father: ' (solid bar)',
      mother: ' (striped bar)',
      both: ' (banded bar)',
      marriage: ' (dashed border)',
      research: ' (dotted border, checked bar)',
      descendant: ' (dotted bar)',
    };
    var list = el('ul', { class: 'fh-legend', role: 'list', 'aria-label': 'What the colours, patterns and lines mean' });
    cats.forEach(function (cat) {
      var swatch = svg('svg', { width: '34', height: '22', viewBox: '0 0 34 22', 'aria-hidden': 'true', focusable: 'false', class: 'fh-box cat-' + cat },
        svg('rect', { x: '1.5', y: '1.5', width: '31', height: '19', rx: '4', class: 'fh-boxbg' }),
        svg('rect', { x: '1.5', y: '1.5', width: '7', height: '19', rx: '2', class: 'fh-boxbar', fill: barFill(cat) }));
      list.appendChild(el('li', null, swatch, ' ', SIDE_WORDS[cat] + hints[cat]));
    });
    var swatchFor = { birth: 'kind-birth', step: 'kind-step', research: 'kind-probable' };
    (lines && lines.length ? lines : [
      { key: 'birth', text: 'Solid line: born to' },
      { key: 'step', text: 'Dashed line: step or adoptive parent' },
      { key: 'research', text: 'Dotted line: probable or doubtful parent, a research finding' },
    ]).forEach(function (line) {
      list.appendChild(el('li', null, swatchFor[line.key] ? lineSwatch(swatchFor[line.key]) : null, swatchFor[line.key] ? ' ' : null, line.text));
    });
    return list;
  }

  function lineSwatch(kind) {
    return svg('svg', { width: '34', height: '12', viewBox: '0 0 34 12', 'aria-hidden': 'true', focusable: 'false', class: 'fh-lineswatch' },
      svg('path', { d: 'M2 6H32', class: 'fh-edge ' + kind }));
  }

  function boxCategory(b, card) {
    if (!card) return 'none';
    if (card.side === 'self' || b.you) return 'self';
    return sideClass(card);
  }

  function nodeBox(b, layout) {
    var node = b.node || { id: b.id };
    var card = node.card || null;
    var category = boxCategory(b, card);
    var W = layout.box.w;
    var H = layout.box.h;
    var name = card ? card.name : nameOf(node);
    var years = card ? (card.yearsSpoken || (card.living ? 'Living' : '')) : (node.lifespan || '');
    var r = card ? capital(card.term || '') : '';
    var tag = card && card.research ? 'Research finding' : (card && card.side !== 'self' ? card.sideText || '' : '');
    if (b.role === 'focus') tag = 'Centre of the chart';
    var spoken = [card ? card.spoken : name, b.role === 'focus' ? 'Centre of the chart.' : '', b.repeat ? 'Appears more than once in this chart.' : ''].filter(Boolean).join(' ');
    var photo = card && card.face ? (srcOk(card.face.face) ? card.face.face : srcOk(card.face.thumb) ? card.face.thumb : null) : null;
    var textX = photo ? 70 : 16;
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
      line(61, 'fh-rel', r, 10),
      line(78, 'fh-tag', tag, 12),
      svg('rect', { x: '-4', y: '-4', width: W + 8, height: H + 8, rx: '13', class: 'fh-ring' }));
    if (photo) {
      var image = svg('image', { x: '14', y: '16', width: '48', height: '48', 'clip-path': 'url(#fh-clip)', preserveAspectRatio: 'xMidYMid slice', class: 'fh-photo', 'aria-hidden': 'true', href: photo });
      link.insertBefore(image, link.querySelector('text'));
      image.addEventListener('error', function () { image.remove(); });
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
    layout.boxes.forEach(function (b) { boxes.appendChild(nodeBox(b, layout)); });
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

  function textItem(b, extra, moreAbove) {
    var node = b.node || { id: b.id };
    var words = [extra, b.repeat ? 'appears more than once' : '', moreAbove ? plural(moreAbove, 'more generation') + ' above' : ''].filter(Boolean).join('; ');
    if (node.card) return personRow(node.card, { extra: words, centre: b.role !== 'focus' });
    var li = el('li', { class: 'fh-personrow' }, el('a', { href: personHref(b.id) }, nameOf(node)), words ? ', ' + words : '');
    return li;
  }

  function textVersion(layout, focusName, isViewer, above) {
    var box = el('section', { class: 'fh-textversion', id: 'fh-textversion', 'aria-labelledby': 'fh-tv-h' });
    box.appendChild(el('h3', { id: 'fh-tv-h', tabindex: '-1' }, isViewer ? 'Your family, generation by generation' : focusName + '’s family, generation by generation'));
    var focusCard = (layout.focus.node || {}).card;
    box.appendChild(el('p', null, 'The chart is centred on ', el('a', { href: personHref(layout.focus.id) }, focusName),
      focusCard && focusCard.yearsSpoken ? ' (' + focusCard.yearsSpoken + ')' : '', focusCard && !isViewer && personWords(focusCard) ? ', ' + personWords(focusCard) : '', '.'));
    var byGen = new Map();
    layout.boxes.forEach(function (b) {
      if (b.role !== 'ancestor') return;
      if (!byGen.has(b.gen)) byGen.set(b.gen, []);
      byGen.get(b.gen).push(b);
    });
    if (!byGen.size) box.appendChild(el('p', null, 'No parents are recorded for ' + focusName + ' in the tree.'));
    Array.from(byGen.keys()).sort(function (a, b) { return a - b; }).forEach(function (gen) {
      box.appendChild(el('h4', null, generationName(gen) + ' (' + byGen.get(gen).length + ')'));
      box.appendChild(el('ul', { class: 'fh-people', role: 'list' }, byGen.get(gen).map(function (b) {
        return textItem(b, gen === 1 && isViewer ? '' : relationOfChild(b, layout, gen > 1), above.get(b.key));
      })));
    });
    [['sibling', 'Brothers and sisters'], ['spouse', 'Spouses and partners']].forEach(function (g) {
      var list = layout.boxes.filter(function (b) { return b.role === g[0]; });
      if (!list.length) return;
      box.appendChild(el('h4', null, g[1] + ' (' + list.length + ')'));
      box.appendChild(el('ul', { class: 'fh-people', role: 'list' }, list.map(function (b) { return textItem(b, g[0] === 'sibling' ? parentWords(b, layout) : ''); })));
    });
    for (var level = 1; level <= layout.depth; level++) {
      var gen = layout.boxes.filter(function (b) { return b.role === 'descendant' && b.gen === -level; });
      if (!gen.length) continue;
      box.appendChild(el('h4', null, descendantName(level) + ' (' + gen.length + ')'));
      box.appendChild(el('ul', { class: 'fh-people', role: 'list' }, gen.map(function (b) { return textItem(b, parentWords(b, layout)); })));
    }
    var extra = layout.extraParents.filter(function (p) { return p && p.id; });
    var more = layout.unplaced.filter(function (n) { return !extra.some(function (p) { return p.id === n.id; }); });
    if (extra.length || more.length) {
      box.appendChild(el('h4', null, 'Also in this part of the tree'));
      var ul = el('ul', { class: 'fh-people', role: 'list' });
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

  /* ── the family sky: the tree as lights, for sighted family ─────────────
   * Decoration only (sky.js says what it draws and how it moves). The box is
   * aria-hidden and holds nothing focusable, so it adds no stop and no words;
   * the chart and its text version stay the content. It is left out before
   * the view is drawn (so nothing shifts later) under forced colours,
   * Increase Contrast, data saving and very large text, the same times the
   * site's paintings step aside; history.css also hides it in a narrow or
   * zoomed window (left to CSS, because a tab opened in the background is
   * laid out at no width at all). */
  var SKY_HIDDEN_WHEN = '(forced-colors: active), (prefers-contrast: more), (prefers-reduced-data: reduce)';
  var skyNow = null;
  var skyLoading = null;

  function skyAllowed(layout) {
    if (!layout || layout.boxes.length < 3) return false;
    try {
      if (window.matchMedia && window.matchMedia(SKY_HIDDEN_WHEN).matches) return false;
      var connection = navigator.connection;
      if (connection && connection.saveData) return false;
      if (parseFloat(getComputedStyle(document.documentElement).fontSize) > 20) return false;
      var probe = document.createElement('canvas');
      return !!(probe.getContext && probe.getContext('2d'));
    } catch (e) {
      return false;
    }
  }

  /* Still: the system's Reduce Motion, or Reverie's World motion switch
   * (reverie_motion = off), the site's one in-app motion switch so far. */
  function skyStill() {
    return reducedMotion() || storeGet('reverie_motion') === 'off';
  }

  function loadSky() {
    if (window.KadeFamilySky) return Promise.resolve(window.KadeFamilySky);
    if (!skyLoading) {
      skyLoading = new Promise(function (resolve, reject) {
        var tag = el('script', { src: SKY_SRC, async: true });
        tag.addEventListener('load', function () {
          if (window.KadeFamilySky) resolve(window.KadeFamilySky);
          else reject(new Error('The sky did not load.'));
        });
        tag.addEventListener('error', function () {
          skyLoading = null;
          tag.remove();
          reject(new Error('The sky did not load.'));
        });
        document.head.appendChild(tag);
      });
    }
    return skyLoading;
  }

  function stopSky() {
    if (skyNow) skyNow.stop();
    skyNow = null;
  }

  function skyView(layout, focusLabel) {
    if (!skyAllowed(layout)) return null;
    var still = skyStill();
    var mouse = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    var hint = mouse
      ? (still ? 'Point at a light to see who it is. Click it to open their page.' : 'Drag to turn the tree. Point at a light to see who it is.')
      : (still ? 'Tap a light to see who it is. Tap again to open.' : 'Tap a light to see who it is. Drag to turn.');
    var stage = el('div', { class: 'fh-skystage' });
    var box = el('div', { class: 'fh-sky', 'aria-hidden': 'true' }, stage, el('p', { class: 'fh-skyhint', 'aria-hidden': 'true' }, hint));
    var handle = null;
    var stopped = false;
    /* A lit star rings that person's box in the chart and their line in the
     * text version (a look only: no words, no focus, nothing moves). */
    function mark(id) {
      var host = box.parentNode;
      if (!host) return;
      Array.prototype.forEach.call(host.querySelectorAll('.is-lit'), function (n) { n.classList.remove('is-lit'); });
      if (id == null) return;
      var href = personHref(id);
      Array.prototype.forEach.call(host.querySelectorAll('a[href]'), function (a) {
        if (a.getAttribute('href') !== href) return;
        var spot = a.closest('.fh-box, .fh-personrow');
        if (spot) spot.classList.add('is-lit');
      });
    }
    return {
      box: box,
      start: function () {
        loadSky().then(function (Sky) {
          if (stopped || !box.isConnected) return;
          handle = Sky.mount(stage, layout, {
            still: skyStill,
            solid: !!(window.matchMedia && window.matchMedia('(prefers-reduced-transparency: reduce)').matches),
            focusLabel: focusLabel,
            ringName: generationName,
            descName: descendantName,
            onLight: mark,
            onOpen: function (id) { location.hash = personHref(id); },
          });
        }).catch(function () { /* the box keeps its plain dusk sky */ });
      },
      light: function (id) {
        if (handle) handle.light(id);
      },
      stop: function () {
        stopped = true;
        if (handle) handle.destroy();
        mark(null);
      },
    };
  }

  async function treeView(live, focusId) {
    var data = await api('/tree?v=2&up=' + treeDepth.up + '&down=' + treeDepth.down + (focusId ? '&focus=' + enc(focusId) : ''));
    if (!live()) return null;
    var byId = new Map();
    var above = new Map();
    var serverLayout = data.layout || {};
    (serverLayout.boxes || []).forEach(function (b) {
      if (b.person) byId.set(b.id, remember(b.person));
      if (b.moreAbove) above.set(b.key, b.moreAbove);
    });
    (serverLayout.extraParents || []).forEach(function (x) { if (x.person) byId.set(x.person.id, remember(x.person)); });
    (data.list || []).forEach(function (sec) { (sec.rows || []).forEach(function (row) { if (row.person) byId.set(row.id, remember(row.person)); }); });
    (data.nodes || []).forEach(function (n) { n.card = byId.get(n.id) || cards.get(n.id) || null; });
    var fullLayout = layoutTree(data, treeDepth);
    if (!fullLayout) throw Object.assign(new Error('That person is not in the family tree.'), { status: 404 });
    /* On a phone the chart starts at two generations up, so the parents and
     * grandparents sit near the focus; the text version always has them all. */
    var narrow = (view.clientWidth || window.innerWidth || 0) < PHONE_WIDTH;
    var shortLayout = narrow && treeDepth.up > PHONE_UP ? layoutTree(data, { up: PHONE_UP, down: treeDepth.down }) : null;
    var layout = shortLayout || fullLayout;
    var focusNode = layout.focus.node || {};
    var focusCard = focusNode.card;
    var focusName = focusCard ? focusCard.name : nameOf(focusNode);
    var isViewer = !!(me.viewer && layout.focus.id === me.viewer.personId && me.mode !== 'guest');
    var s = section(isViewer ? 'Family tree' : 'Family tree: ' + focusName, isViewer ? 'Family tree' : focusName + ' — family tree');
    if (data.summary && data.summary.text) s.appendChild(el('p', null, data.summary.text));
    if (!isViewer) {
      s.appendChild(el('p', null, 'Centred on ', el('a', { href: personHref(layout.focus.id) }, focusName), focusCard && personWords(focusCard) ? ', ' + personWords(focusCard) : '', '. ',
        el('a', { href: '#/tree' }, me.mode === 'guest' ? 'Centre on ' + ownerFirst() : 'Centre on you')));
    }
    var sky = skyView(fullLayout, isViewer ? 'You' : (focusCard && focusCard.first) || firstName(focusName));
    if (sky) {
      s.appendChild(sky.box);
      /* Pointing at a box or a name in the chart (or moving the keyboard
       * onto one) lights that person's star. */
      var pointAt = function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href^="#/person/"]') : null;
        sky.light(a ? parseHash(a.getAttribute('href')).arg || null : null);
      };
      s.addEventListener('mouseover', pointAt);
      s.addEventListener('focusin', pointAt);
      s.addEventListener('focusout', function () { sky.light(null); });
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
    s.appendChild(el('details', { class: 'fh-legendbox' }, el('summary', null, 'What the colours, patterns and lines mean'), legend(data.legend)));
    s.appendChild(textVersion(fullLayout, focusName, isViewer, above));
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
      if (sky) {
        skyNow = sky;
        sky.start();
      }
      if (!firstView() && 'ResizeObserver' in window) {
        var watcher = new ResizeObserver(function () { if (firstView()) watcher.disconnect(); });
        watcher.observe(frame);
      }
      say('Family tree ready: ' + plural(layout.boxes.length, 'person', 'people') + ' in the chart, centred on ' + focusName + '.');
    };
    return s;
  }

  /* ── pictures: the grid button and the viewer ─────────────────────────── */

  /* A picture that opens the viewer. The picture's words name the button (its
   * full description when there is one); the short caption shown under it
   * says the same, so it is hidden from screen readers and not read twice. */
  function pictureButton(list, index, opts) {
    opts = opts || {};
    var image = list[index];
    var restored = image.showing === 'restored';
    var caption = opts.caption != null ? opts.caption : (image.short || 'Picture') + (restored ? ' (restored with AI)' : '');
    var btn;
    if (hasPicture(image)) {
      btn = el('button', { type: 'button', class: 'fh-thumb' + (opts.className ? ' ' + opts.className : ''), id: opts.id || null },
        picture(image, { alt: opts.alt != null ? opts.alt : image.alt || image.short }),
        el('span', { class: 'fh-thumbtext', 'aria-hidden': 'true' }, caption));
    } else {
      btn = el('button', { type: 'button', class: 'fh-doclink', id: opts.id || null },
        el('span', { class: 'fh-docicon', 'aria-hidden': 'true' }, '📄'),
        el('span', { class: 'fh-thumbtext' }, image.short || image.alt || 'A document'));
    }
    btn.addEventListener('click', function () { openViewer(list, index, btn); });
    return btn;
  }

  function pictureGrid(list, opts) {
    return el('ul', { class: 'fh-grid', role: 'list', 'aria-label': (opts && opts.label) || null }, list.map(function (image, i) {
      return el('li', null, pictureButton(list, i, { id: opts && opts.idPrefix ? opts.idPrefix + i : null }));
    }));
  }

  function buildViewer() {
    var v = { seq: 0 };
    v.title = el('h2', { id: 'fh-dialog-title', tabindex: '-1' });
    var close = el('button', { type: 'button', class: 'fh-btn' }, 'Close');
    v.img = el('img', { class: 'fh-full', alt: '' });
    v.doc = el('div', { class: 'fh-viewer-doc', hidden: true });
    v.restoredLine = el('p', { class: 'fh-restoredline', hidden: true });
    v.switchBtn = el('button', { type: 'button', class: 'fh-btn quiet' });
    v.prev = el('button', { type: 'button', class: 'fh-btn quiet' }, 'Previous picture');
    v.next = el('button', { type: 'button', class: 'fh-btn quiet' }, 'Next picture');
    v.position = el('span', { class: 'fh-viewer-pos' });
    v.navRow = el('p', { class: 'fh-actions fh-viewer-nav' }, v.prev, v.position, v.next);
    v.info = el('div', { class: 'fh-viewer-info' });
    v.save = el('button', { type: 'button', class: 'fh-btn' }, 'Save a copy');
    v.share = el('button', { type: 'button', class: 'fh-btn quiet', hidden: !canShareFiles() }, 'Share');
    v.full = el('a', { target: '_blank', rel: 'noopener noreferrer', class: 'fh-btn quiet' }, 'Open full size', el('span', { class: 'sr-only' }, ' (opens a new tab)'));
    v.who = el('a', { class: 'fh-btn quiet' }, 'Do you know who this is?');
    v.restore = el('button', { type: 'button', class: 'fh-btn quiet', hidden: true }, 'Ask for this photo to be restored');
    v.actions = el('p', { class: 'fh-actions fh-viewer-actions' }, v.save, v.share, v.full, v.who, v.restore);
    v.status = el('p', { class: 'fh-status', role: 'status', 'aria-live': 'polite' });
    v.dialog = el('dialog', { class: 'fh-dialog', 'aria-labelledby': 'fh-dialog-title' },
      el('div', { class: 'fh-dialog-head' }, v.title, close),
      el('div', { class: 'fh-dialog-body' }, v.img, v.doc),
      v.restoredLine, v.navRow, v.status, v.info, v.actions);
    close.addEventListener('click', function () { v.dialog.close(); });
    v.dialog.addEventListener('click', function (e) { if (e.target === v.dialog) v.dialog.close(); });
    v.dialog.addEventListener('close', function () {
      v.seq++;
      v.img.removeAttribute('src');
      v.status.textContent = '';
      if (v.trigger && document.contains(v.trigger)) v.trigger.focus();
      v.trigger = null;
    });
    v.prev.addEventListener('click', function () { step(-1); });
    v.next.addEventListener('click', function () { step(1); });
    function step(by) {
      var to = v.index + by;
      if (to < 0 || to >= v.list.length) return;
      v.index = to;
      showInViewer(false);
      say((to + 1) + ' of ' + v.list.length + ': ' + (v.list[to].short || 'picture') + '.');
    }
    v.switchBtn.addEventListener('click', async function () {
      var cur = v.list[v.index];
      var other = cur.showing === 'restored' ? cur.original : cur.restored;
      if (!other) return;
      try {
        var info = await api('/media/' + enc(other) + '/info');
        v.list[v.index] = Object.assign({}, cur, info.image, { caption: info.caption || cur.caption, people: info.people || cur.people });
        showInViewer(false, info);
        say(v.list[v.index].showing === 'restored' ? 'Showing the copy restored with AI. Colours and repairs may be guessed.' : 'Showing the original.');
        v.switchBtn.focus();
      } catch (e) { say(e.message, true); }
    });
    v.save.addEventListener('click', function () { saveCopy(v.list[v.index], v.save); });
    v.share.addEventListener('click', function () { shareCopy(v.list[v.index], v.share); });
    v.restore.addEventListener('click', async function () {
      var cur = v.list[v.index];
      if (v.restore.getAttribute('aria-disabled') === 'true') return;
      v.restore.setAttribute('aria-disabled', 'true');
      try {
        var done = await api('/note', { kind: 'restore-request', about: { mediaId: cur.id } });
        v.restore.hidden = true;
        say(done.text || 'Asked.');
      } catch (e) { say(e.message, true); } finally { v.restore.removeAttribute('aria-disabled'); }
    });
    document.body.appendChild(v.dialog);
    return v;
  }

  function openViewer(list, index, trigger) {
    if (!viewer) viewer = buildViewer();
    var image = list[index];
    if (typeof viewer.dialog.showModal !== 'function') {
      var w = window.open('', '_blank');
      signed(image.id, viewSize(image)).then(function (url) { if (w) { w.opener = null; w.location = url; } else location.href = url; }).catch(function (e) { if (w) w.close(); say(e.message, true); });
      return;
    }
    viewer.list = list.slice();
    viewer.index = index;
    viewer.trigger = trigger;
    viewer.dialog.showModal();
    showInViewer(true);
  }

  /* Draws the picture at viewer.index, then fills in what /media/:id/info
   * adds (people, the description, the text, whether it can be restored). */
  function showInViewer(focusTitle, knownInfo) {
    var v = viewer;
    var image = v.list[v.index];
    var seq = ++v.seq;
    var restored = image.showing === 'restored';
    v.title.textContent = (image.short || 'Picture') + (restored ? ' (restored with AI)' : '');
    v.navRow.hidden = v.list.length < 2;
    v.position.textContent = (v.index + 1) + ' of ' + v.list.length;
    v.prev.setAttribute('aria-disabled', String(v.index === 0));
    v.next.setAttribute('aria-disabled', String(v.index === v.list.length - 1));
    var picturePart = hasPicture(image);
    v.img.hidden = !picturePart;
    v.doc.hidden = picturePart;
    v.img.alt = image.alt || image.short || 'A picture';
    v.img.removeAttribute('src');
    if (srcOk(image.thumb)) v.img.src = image.thumb;
    v.doc.replaceChildren();
    if (!picturePart) {
      var open = el('button', { type: 'button', class: 'fh-btn' }, 'Open the document', el('span', { class: 'sr-only' }, ' (opens a new tab)'));
      open.addEventListener('click', function () {
        var w = window.open('', '_blank');
        signed(image.id, '').then(function (url) { if (w) { w.opener = null; w.location = url; } else location.href = url; }).catch(function (err) { if (w) w.close(); say(err.message, true); });
      });
      v.doc.appendChild(el('p', null, 'This is a document, not a picture. Its words are below when the research copied them.'));
      v.doc.appendChild(el('p', null, open));
    }
    v.restoredLine.replaceChildren();
    v.restoredLine.hidden = !(image.restored || image.original);
    if (restored) {
      v.switchBtn.textContent = 'Show the original';
      v.restoredLine.appendChild(el('span', null, (image.restoredLabel || 'Restored with AI: colours and repairs may be guessed') + '. '));
      v.restoredLine.appendChild(v.switchBtn);
    } else if (image.restored) {
      v.switchBtn.textContent = 'Show the copy restored with AI';
      v.restoredLine.appendChild(el('span', null, 'A copy restored with AI is available. '));
      v.restoredLine.appendChild(v.switchBtn);
    }
    v.save.hidden = !saveSize(image);
    v.share.hidden = !saveSize(image) || !canShareFiles();
    v.share.textContent = 'Share';
    v.who.href = hashFor('note', '', { kind: 'who', media: image.id });
    v.who.hidden = !picturePart;
    v.restore.hidden = true;
    v.full.hidden = !picturePart;
    v.full.removeAttribute('href');
    v.info.replaceChildren(el('p', { class: 'fh-small' }, 'Loading what is known about this picture…'));
    if (focusTitle) v.title.focus();
    if (picturePart) {
      var size = viewSize(image);
      signed(image.id, size).then(function (url) { if (seq === v.seq) v.img.src = url; }).catch(function () { /* the small copy stays */ });
      var big = fullSize(image);
      signed(image.id, big).then(function (url) { if (seq === v.seq) v.full.href = url; }).catch(function () { if (seq === v.seq) v.full.hidden = true; });
    }
    (knownInfo ? Promise.resolve(knownInfo) : api('/media/' + enc(image.id) + '/info')).then(function (info) {
      if (seq !== v.seq) return;
      /* the full picture reference (a clipping opened from a list is only a
       * title until now); drawn again when that changes what can be shown */
      var merged = Object.assign({}, image, info.image || {}, { caption: info.caption || image.caption, people: info.people || image.people });
      v.list[v.index] = merged;
      if (hasPicture(merged) !== hasPicture(image) || saveSize(merged) !== saveSize(image) || merged.alt !== image.alt || merged.thumb !== image.thumb || merged.w !== image.w || merged.h !== image.h) {
        showInViewer(false, info);
        return;
      }
      fillViewerInfo(info, merged);
    }).catch(function (e) {
      if (seq !== v.seq) return;
      v.info.replaceChildren(el('p', { class: 'fh-small' }, e.message));
    });
  }

  function fillViewerInfo(info, image) {
    var v = viewer;
    var box = v.info;
    box.replaceChildren();
    if (info.caption) box.appendChild(el('p', { class: 'fh-lead' }, info.caption));
    if (info.evidenceWarning) box.appendChild(el('p', { class: 'fh-warn' }, info.evidenceWarning));
    var when = [image.date, image.place].filter(Boolean).join(', ');
    if (when) box.appendChild(el('p', null, when));
    var people = (info.people || image.people || []).filter(function (p) { return p && p.id; });
    if (people.length) {
      box.appendChild(el('h3', null, info.newspaperSource ? 'People linked to this record' : 'Who is in it'));
      box.appendChild(personList(people));
    }
    if (info.newspaperSource && info.newspaperSource.principalArticleSubject) box.appendChild(el('p', null, 'Main article subject: ' + info.newspaperSource.principalArticleSubject));
    if (info.description) {
      box.appendChild(el('details', { class: 'fh-more', open: true }, el('summary', null, 'Description'),
        el('p', null, info.description), info.describedNote ? el('p', { class: 'fh-small' }, info.describedNote) : null));
    }
    if (info.text) {
      box.appendChild(el('details', { class: 'fh-more', open: !hasPicture(image) }, el('summary', null, 'Read the text'),
        el('p', { class: 'fh-pretext' }, info.text), info.textNote ? el('p', { class: 'fh-small' }, info.textNote) : null));
    }
    if (info.restoredNotes && image.showing === 'restored') box.appendChild(el('p', { class: 'fh-small' }, 'What the restoring changed: ' + info.restoredNotes));
    if (info.source && (info.source.title || info.source.citation)) {
      var sourceInfo = el('details', { class: 'fh-more' }, el('summary', null, 'Source'));
      if (info.source.title) sourceInfo.appendChild(el('p', null, info.source.title));
      if (info.source.citation) sourceInfo.appendChild(el('p', { class: 'fh-pretext' }, info.source.citation));
      if (webHref(info.source.url)) sourceInfo.appendChild(el('p', null, newTab(info.source.url, 'Open source website')));
      box.appendChild(sourceInfo);
    }
    v.restore.hidden = !info.canAskRestore;
  }

  /* ── save and share ───────────────────────────────────────────────────────
   * The picture's bytes come from this site (/media/:id/file) under the name
   * the server gives it (a restored copy says "restored with AI" in it), so
   * nothing depends on the bucket answering other sites. On an iPhone the
   * share sheet is where "Save Image" to Photos lives. */

  var shareFilesOk = null;
  function canShareFiles() {
    if (shareFilesOk != null) return shareFilesOk;
    try {
      shareFilesOk = !!(navigator.share && navigator.canShare && typeof File === 'function' &&
        navigator.canShare({ files: [new File(['x'], 'x.jpg', { type: 'image/jpeg' })] }));
    } catch (e) {
      shareFilesOk = false;
    }
    return shareFilesOk;
  }

  async function pictureFile(image) {
    var guard = currentRequestGuard();
    var size = saveSize(image);
    if (!size) throw new Error('This picture cannot be saved from here.');
    var key = activeArchive + '|' + image.id + '.' + size;
    if (fileCache.has(key)) return fileCache.get(key);
    var r = await authFetch('/media/' + enc(image.id) + '/file?size=' + size);
    if (!r.ok) {
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      guard();
      throw Object.assign(new Error((j && j.error) || 'The picture could not be fetched (' + r.status + ').'), { status: r.status });
    }
    var blob = await r.blob();
    guard();
    var file = { blob: blob, name: image.shareName || 'Family picture.jpg' };
    fileCache.set(key, file);
    if (fileCache.size > 6) fileCache.delete(fileCache.keys().next().value);
    return file;
  }

  async function saveCopy(image, button) {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    say('Getting the picture…');
    try {
      var f = await pictureFile(image);
      var url = URL.createObjectURL(f.blob);
      var a = el('a', { href: url, download: f.name, hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      say('Saved as ' + f.name + '. Look in your downloads.');
    } catch (e) {
      if (!e.quiet) say(e.message, true);
    } finally {
      button.removeAttribute('aria-disabled');
    }
  }

  /* navigator.share has to follow a tap closely; when fetching the picture
   * took too long, the button says it is ready and a second tap shares. */
  async function shareCopy(image, button) {
    if (button.getAttribute('aria-disabled') === 'true') return;
    var size = saveSize(image);
    var ready = fileCache.get(activeArchive + '|' + image.id + '.' + size);
    if (!ready) {
      button.setAttribute('aria-disabled', 'true');
      say('Getting the picture…');
      try {
        ready = await pictureFile(image);
      } catch (e) {
        if (!e.quiet) say(e.message, true);
        return;
      } finally {
        button.removeAttribute('aria-disabled');
      }
    }
    var file = new File([ready.blob], ready.name, { type: ready.blob.type || 'image/jpeg' });
    try {
      await navigator.share({ files: [file] });
      button.textContent = 'Share';
      say('');
    } catch (e) {
      if (e && e.name === 'AbortError') { say(''); return; }
      if (e && e.name === 'NotAllowedError') {
        button.textContent = 'Share: ready';
        say('The picture is ready. Press Share again to open the share sheet.');
        return;
      }
      say('The share sheet did not open. Try Save a copy instead.', true);
    }
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

  function recordId(key) {
    return 'fh-rec-' + String(key).replace(/[^A-Za-z0-9_-]/g, '-');
  }

  function recordCard(r) {
    var card = el('article', { class: 'card fh-record' + (r.wrong ? ' is-wrong' : ''), id: recordId(r.key), 'aria-labelledby': recordId(r.key) + '-h' });
    card.appendChild(el('h4', { id: recordId(r.key) + '-h', tabindex: '-1' }, r.title || r.collection || 'Record'));
    if (r.name) card.appendChild(el('p', { class: 'fh-recname' }, 'Name on the record: ' + r.name));
    if (r.wrongText) card.appendChild(el('p', { class: 'fh-warn' }, r.wrongText));
    if (r.evidenceWarning) card.appendChild(el('p', { class: 'fh-warn' }, r.evidenceWarning));
    if (r.newspaperSource && r.newspaperSource.indexedPersonRole) card.appendChild(el('p', null, 'Role in the article: ' + r.newspaperSource.indexedPersonRole));
    if (r.newspaperSource && r.newspaperSource.principalArticleSubject) card.appendChild(el('p', null, 'Main article subject: ' + r.newspaperSource.principalArticleSubject));
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
    if (r.image) card.appendChild(el('div', { class: 'fh-scan' }, pictureButton([r.image], 0, { caption: 'View the scan' })));
    if (r.sourceExcerpt) {
      var savedWords = el('details', { class: 'fh-more' }, el('summary', null, 'Saved source text'), el('p', { class: 'fh-pretext' }, r.sourceExcerpt));
      if (r.sourceExcerptCoverage) savedWords.appendChild(el('p', { class: 'fh-small' }, 'Coverage: ' + r.sourceExcerptCoverage));
      if (r.newspaperSource && r.newspaperSource.limitations) r.newspaperSource.limitations.forEach(function (note) { savedWords.appendChild(el('p', { class: 'fh-small' }, note)); });
      card.appendChild(savedWords);
    }
    var savedCitation = r.sourceCitation || (r.newspaperSource && r.newspaperSource.citation);
    var savedUrl = r.sourceUrl || (r.newspaperSource && r.newspaperSource.sourceUrl);
    if (savedCitation) card.appendChild(el('p', { class: 'fh-cite' }, el('small', null, 'Saved source citation: ' + savedCitation)));
    if (webHref(savedUrl)) card.appendChild(el('p', null, newTab(savedUrl, 'Open the saved text’s source website')));
    if (r.citation && r.citation !== savedCitation) card.appendChild(el('p', { class: 'fh-cite' }, el('small', null, 'Original record citation: ' + r.citation)));
    if (webHref(r.url) && r.url !== savedUrl) card.appendChild(el('p', null, newTab(r.url, 'Open the original record on Ancestry (needs an Ancestry account)')));
    return card;
  }

  function memorialCard(m, personName) {
    var id = 'fh-mem-' + String(m.id || '').replace(/[^A-Za-z0-9_-]/g, '-');
    var card = el('article', { class: 'card fh-memorial' + (m.wrong ? ' is-wrong' : ''), id: id, 'aria-labelledby': id + '-h' });
    card.appendChild(el('h4', { id: id + '-h', tabindex: '-1' }, 'Find a Grave: ' + (m.name || personName)));
    if (m.wrong) card.appendChild(el('p', { class: 'fh-warn' }, el('strong', null, 'Attached to this person by mistake. '), typeof m.wrong === 'string' ? m.wrong : 'This memorial is about someone else.'));
    var fields = fieldList([
      ['Cemetery', [m.cemetery, m.cemetery_place].filter(Boolean).join(', ')],
      ['Born', [m.birth_date, m.birth_place].filter(Boolean).join(', ')],
      ['Died', [m.death_date, m.death_place].filter(Boolean).join(', ')],
    ]);
    if (fields) card.appendChild(fields);
    if (webHref(m.url)) card.appendChild(el('p', null, newTab(m.url, 'Open this memorial on Find a Grave')));
    return card;
  }

  /* A grave: cemetery, dates, inscription, the memorial's words and family,
   * and its photos. */
  function graveBlock(g, memorial, personName) {
    var box = el('div', { class: 'card fh-memorial' });
    var fields = fieldList([
      ['Cemetery', [g.cemetery, g.place].filter(Boolean).join(', ')],
      ['Plot', memorial && memorial.plot],
      ['Dates', g.dates],
      ['Born', memorial ? [memorial.birth_date, memorial.birth_place].filter(Boolean).join(', ') : ''],
      ['Died', memorial ? [memorial.death_date, memorial.death_place].filter(Boolean).join(', ') : ''],
    ]);
    if (fields) box.appendChild(fields);
    if (g.inscription) box.appendChild(el('figure', { class: 'fh-inscription' }, el('figcaption', null, 'Inscription'), el('blockquote', null, g.inscription)));
    if (g.bio) {
      box.appendChild(el('h5', null, 'Biography'));
      String(g.bio).split(/\n{2,}/).forEach(function (p) { if (p.trim()) box.appendChild(el('p', { class: 'fh-bio' }, p.trim())); });
    }
    var fam = memorial && memorial.family && typeof memorial.family === 'object' ? memorial.family : {};
    Object.keys(fam).forEach(function (heading) {
      var people = Array.isArray(fam[heading]) ? fam[heading] : [];
      if (!people.length) return;
      box.appendChild(el('h5', null, heading));
      box.appendChild(el('ul', { class: 'fh-list' }, people.map(function (p) { return el('li', null, (p.name || 'Unnamed') + (p.dates ? ' (' + p.dates + ')' : '')); })));
    });
    var photos = (g.photos || []).filter(Boolean);
    if (photos.length) {
      box.appendChild(el('h5', null, 'Photos of the grave'));
      box.appendChild(pictureGrid(photos, { label: 'Photos of ' + personName + '’s grave' }));
    }
    if (webHref(g.url)) box.appendChild(el('p', null, newTab(g.url, 'Open this memorial on Find a Grave')));
    return box;
  }

  function findingCard(f, level) {
    var card = el('article', { class: 'card fh-finding' });
    card.appendChild(el(level || 'h3', { tabindex: '-1' }, f.title || 'A research finding'));
    card.appendChild(proofLine(f.proof, f.proofText));
    if (f.text || f.summary) card.appendChild(el('p', null, f.text || f.summary));
    if (f.evidence) card.appendChild(el('p', { class: 'fh-small' }, f.evidence));
    var people = (f.people || []).filter(function (p) { return p && p.id && p.name; });
    if (people.length) {
      card.appendChild(el('p', { class: 'fh-small' }, 'People it names:'));
      card.appendChild(personList(people));
    }
    var links = el('p', { class: 'fh-actions' });
    if (f.storySlug) links.appendChild(el('a', { href: hashFor('story', f.storySlug) }, 'Read the story'));
    if (f.dna) links.appendChild(el('a', { href: '#/dna' }, 'What this means for your DNA'));
    if (links.childNodes.length) card.appendChild(links);
    return card;
  }

  /* Opens a collapsed section and moves to a record inside it. */
  function goToRecord(key) {
    var card = document.getElementById(recordId(key));
    var more = document.getElementById('fh-records-more');
    if (!card && more) { more.click(); card = document.getElementById(recordId(key)); }
    if (!card) return;
    var details = card.closest('details');
    if (details) details.open = true;
    var h = card.querySelector('h4');
    card.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (h) h.focus({ preventScroll: true });
  }

  async function personView(live, id) {
    var data = await api('/person/' + enc(id) + '?v=2');
    if (!live()) return null;
    var p = remember(data.person || {});
    var name = p.name || nameOf(p);
    var first = p.first || firstName(name);
    var s = section(name, name);

    var head = el('div', { class: 'fh-personhead' });
    if (data.header && hasPicture(data.header)) {
      head.appendChild(pictureButton([data.header], 0, { className: 'fh-headpic', caption: data.headerKind === 'portrait' ? 'View larger' : data.header.short }));
    } else {
      head.appendChild(faceEl(p, true));
    }
    var facts = el('div', { class: 'fh-personfacts' });
    var lines = [];
    if (p.yearsSpoken) lines.push(p.yearsSpoken);
    else if (p.living) lines.push('Living');
    if (p.bornA) lines.push(p.bornA);
    if (lines.length) facts.appendChild(el('p', { class: 'fh-lifespan' }, capital(lines.join(', '))));
    var words = personWords(p);
    if (words) facts.appendChild(el('p', { class: 'fh-lead' }, capital(words)));
    if (p.research) facts.appendChild(proofLine(p.research.level, p.research.text));
    if (Array.isArray(p.otherNames) && p.otherNames.length) facts.appendChild(el('p', null, 'Also known as ' + p.otherNames.join('; ') + '.'));
    head.appendChild(facts);
    s.appendChild(head);
    if (p.duplicate) {
      s.appendChild(el('p', { class: 'fh-warn' }, p.duplicate.text + '. ', p.duplicate.mainId ? el('a', { href: personHref(p.duplicate.mainId) }, 'Open the main entry') : ''));
    }
    if (p.virtual) s.appendChild(el('p', { class: 'fh-flagnote' }, 'This person comes from the research, not from the family tree itself.'));
    if (p.confidence) s.appendChild(el('p', { class: 'fh-flagnote' }, 'How sure the research is: ' + p.confidence + '.'));
    s.appendChild(el('p', { class: 'fh-actions' },
      el('a', { class: 'fh-btn', href: treeHref(p.id || id) }, 'Centre the tree here'),
      el('a', { class: 'fh-btn quiet', href: hashFor('note', '', { person: p.id || id }) }, 'Add a memory about ' + first)));

    if ((data.nutshell && data.nutshell.text) || data.livedThrough) {
      s.appendChild(el('h3', null, 'Life in a nutshell'));
      if (data.nutshell && data.nutshell.text) s.appendChild(el('p', null, data.nutshell.text));
      if (data.livedThrough) s.appendChild(el('p', null, data.livedThrough));
    }

    s.appendChild(relationBlock(data.relation, p, name));

    var pics = (data.pictures && data.pictures.items) || [];
    if (pics.length) {
      var total = data.pictures.total || pics.length;
      s.appendChild(el('h3', null, 'Pictures (' + num(total) + ')'));
      s.appendChild(pictureGrid(pics, { label: 'Pictures of ' + first }));
      s.appendChild(el('p', null, el('a', { href: hashFor('gallery', '', { kind: 'all', person: p.id || id }) }, total > pics.length ? 'All ' + num(total) + ' pictures of ' + first : 'Everything with ' + first + ' in it, records too')));
    }

    s.appendChild(lifeBlock(data.life || []));
    s.appendChild(familyBlock(data.family || {}));

    var records = (data.records || []).slice().sort(function (a, b) { return (a.wrong ? 1 : 0) - (b.wrong ? 1 : 0); });
    if (records.length) {
      var wrongCount = records.filter(function (r) { return r.wrong; }).length;
      var recBox = el('details', { class: 'fh-more', id: 'fh-records' }, el('summary', null, 'Records (' + num(records.length) + ')'));
      if (wrongCount) recBox.appendChild(el('p', { class: 'fh-small' }, plural(wrongCount, 'record') + ' at the end ' + (wrongCount === 1 ? 'is' : 'are') + ' attached by mistake.'));
      records.slice(0, RECORDS_FIRST).forEach(function (r) { recBox.appendChild(recordCard(r)); });
      if (records.length > RECORDS_FIRST) {
        var moreBtn = el('button', { type: 'button', class: 'fh-btn quiet', id: 'fh-records-more' }, 'Show the other ' + num(records.length - RECORDS_FIRST) + ' records');
        moreBtn.addEventListener('click', function () {
          var firstNew = null;
          records.slice(RECORDS_FIRST).forEach(function (r) {
            var c = recordCard(r);
            if (!firstNew) firstNew = c;
            recBox.insertBefore(c, moreBtn);
          });
          moreBtn.remove();
          if (firstNew) firstNew.querySelector('h4').focus();
          say('Showing all ' + num(records.length) + ' records.');
        });
        recBox.appendChild(moreBtn);
      }
      s.appendChild(recBox);
    }

    var memorials = data.memorials || [];
    var main = data.grave ? memorials.filter(function (m) { return m.id === data.grave.id; })[0] : null;
    var others = memorials.filter(function (m) { return m !== main; });
    if (data.grave || others.length) {
      var graveBox = el('details', { class: 'fh-more' }, el('summary', null, 'Grave' + (others.length ? ' (' + num(others.length + (data.grave ? 1 : 0)) + ' memorials)' : '')));
      if (data.grave) graveBox.appendChild(graveBlock(data.grave, main, name));
      others.forEach(function (m) { graveBox.appendChild(memorialCard(m, name)); });
      s.appendChild(graveBox);
    }

    var findings = data.findings || [];
    if (findings.length) {
      s.appendChild(el('h3', null, 'Research findings about ' + first));
      findings.forEach(function (f) { s.appendChild(findingCard(f, 'h4')); });
    }

    var sources = data.sources || [];
    if (sources.length || data.withheld) {
      var srcBox = el('details', { class: 'fh-more' }, el('summary', null, 'Sources (' + num(sources.length) + ')'));
      if (sources.length) {
        srcBox.appendChild(el('ul', { class: 'fh-list' }, sources.map(function (src) {
          return el('li', null, src.title || 'A source', src.citation ? el('span', { class: 'fh-small' }, '. ' + src.citation) : '', webHref(src.url) ? ' ' : '', webHref(src.url) ? newTab(src.url, 'Open it') : '');
        })));
      }
      if (data.withheld && data.withheld.text) srcBox.appendChild(el('p', { class: 'fh-small' }, data.withheld.text + '.'));
      s.appendChild(srcBox);
    }

    if (Array.isArray(p.notes) && p.notes.length) {
      s.appendChild(el('h3', null, 'Notes'));
      s.appendChild(el('ul', { class: 'fh-list' }, p.notes.map(function (n) { return el('li', null, String(n)); })));
    }
    if (Array.isArray(p.history) && p.history.length) {
      s.appendChild(el('details', { class: 'fh-more' }, el('summary', null, 'Changes made to the tree (' + p.history.length + ')'),
        el('ul', { class: 'fh-list' }, p.history.map(function (n) { return el('li', null, String(n)); }))));
    }
    return s;
  }

  function relationBlock(relation, p, name) {
    var box = el('section', { class: 'fh-relation', 'aria-labelledby': 'fh-rel-h' });
    var guest = me.mode === 'guest';
    box.appendChild(el('h3', { id: 'fh-rel-h' }, guest ? 'How ' + firstName(name) + ' is related to ' + ownerFirst() : 'How you’re related'));
    var r = relation || {};
    if (p.side === 'self' || r.term === 'you') {
      box.appendChild(el('p', { class: 'fh-lead' }, guest ? 'This is ' + ownerFirst() + '.' : 'This is you.'));
      return box;
    }
    if (!r.term) {
      box.appendChild(el('p', null, 'The tree has no known link between ' + name + ' and ' + (guest ? ownerFirst() : 'you') + ' yet.'));
      return box;
    }
    box.appendChild(el('p', { class: 'fh-lead' }, name + ' is ' + r.term + (r.chain ? ': ' + r.chain : '') + '.'));
    if (p.sideText) box.appendChild(el('p', { class: 'fh-sidetag side-' + sideClass(p) }, p.sideText));
    if (Array.isArray(r.ladder) && r.ladder.length > 1) {
      box.appendChild(el('ol', { class: 'fh-chain', role: 'list', 'aria-label': 'The generations, one step at a time' }, r.ladder.map(function (step, i) {
        return el('li', { class: i === 0 ? 'fh-chain-start' : null }, step);
      })));
    }
    if (r.pathText) box.appendChild(el('p', null, r.pathText));
    var steps = (r.pathPeople || []).filter(function (x) { return x && x.id; });
    if (steps.length) {
      box.appendChild(el('p', { class: 'fh-small' }, 'The people on the way:'));
      box.appendChild(personList(steps));
    }
    if (r.dnaLine) box.appendChild(el('p', null, r.dnaLine));
    if (r.details) box.appendChild(el('details', { class: 'fh-more' }, el('summary', null, 'Details for DNA fans'), el('p', null, r.details)));
    return box;
  }

  function lifeBlock(life) {
    var box = el('section', { class: 'fh-timelinebox', 'aria-labelledby': 'fh-time-h' }, el('h3', { id: 'fh-time-h' }, 'Life'));
    if (!life.length) {
      box.appendChild(el('p', null, 'No dated events are recorded.'));
      return box;
    }
    box.appendChild(el('ol', { class: 'fh-timeline', role: 'list' }, life.map(function (f) {
      var li = el('li', null, el('span', { class: 'fh-when' }, f.date || (f.year != null ? String(f.year) : 'Undated')), ' ', f.text || 'An event', '.');
      var keys = (f.records || []).filter(Boolean);
      if (keys.length) {
        /* up to three chips; the rest are under Records, and the line says how many */
        var row = el('span', { class: 'fh-sources' }, ' ');
        keys.slice(0, 3).forEach(function (k, i) {
          row.appendChild(el('button', { type: 'button', class: 'chip', onclick: function () { goToRecord(k); } },
            'Source' + (keys.length > 1 ? ' ' + (i + 1) : ''), el('span', { class: 'sr-only' }, ', go to the record')));
          row.appendChild(document.createTextNode(' '));
        });
        if (keys.length > 3) row.appendChild(el('span', { class: 'fh-small' }, 'and ' + num(keys.length - 3) + ' more under Records.'));
        li.appendChild(row);
      }
      return li;
    })));
    return box;
  }

  function familyBlock(family) {
    var groups = [
      ['parents', 'Parents'],
      ['spouses', 'Spouses and partners'],
      ['siblings', 'Brothers and sisters'],
      ['children', 'Children'],
    ];
    var box = el('section', { class: 'fh-family', 'aria-labelledby': 'fh-fam-h' }, el('h3', { id: 'fh-fam-h' }, 'Family'));
    var any = false;
    groups.forEach(function (g) {
      var list = (Array.isArray(family && family[g[0]]) ? family[g[0]] : []).filter(function (m) { return m && m.id; });
      if (!list.length) return;
      any = true;
      box.appendChild(el('h4', null, g[1]));
      box.appendChild(el('ul', { class: 'fh-people', role: 'list' }, list.map(function (m) {
        return personRow(m, { extra: m.kindText || '' });
      })));
    });
    if (!any) box.appendChild(el('p', null, 'No family members are linked in the tree.'));
    return box;
  }

  /* ── people ───────────────────────────────────────────────────────────── */

  var PEOPLE_GROUPS = [['ancestor', 'Ancestors'], ['blood', 'Blood relatives'], ['marriage', 'By marriage'], ['all', 'Everyone']];

  async function peopleView(live, q) {
    var group = PEOPLE_GROUPS.some(function (g) { return g[0] === q.group; }) ? q.group : 'ancestor';
    var data = await api('/people?v=2&group=' + enc(group) + (q.from ? '&from=' + enc(q.from) : ''));
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
      var text = input.value.trim();
      var mine = ++searchSeq;
      if (text.length < 2) {
        results.replaceChildren();
        if (announce) say('Type at least two letters.');
        return;
      }
      try {
        var found = await api('/search?v=2&q=' + enc(text));
        if (mine !== searchSeq) return;
        var people = (found && found.people) || [];
        results.replaceChildren(el('h3', null, 'Search results'), people.length ? personList(people, { centre: true }) : el('p', null, 'Nobody in the tree matches “' + text + '”.'));
        say((found && found.text) || plural(people.length, 'person', 'people') + ' found.');
      } catch (e) {
        if (mine === searchSeq) say(e.message, true);
      }
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); search(true); });
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { search(false); }, 350); });
    s.appendChild(form);
    s.appendChild(results);

    s.appendChild(el('h3', { id: 'fh-browse-h' }, 'Browse the tree'));
    s.appendChild(el('nav', { class: 'fh-picker', 'aria-labelledby': 'fh-browse-h' }, PEOPLE_GROUPS.map(function (g) {
      return el('a', { class: 'fh-pick', href: hashFor('people', '', { group: g[0] }), 'aria-current': g[0] === group ? 'true' : null }, g[1]);
    })));
    s.appendChild(el('p', { class: 'fh-small' }, (data.title || 'People') + ': ' + (data.pageSpoken || '')));
    var firstRow = true;
    (data.sections || []).forEach(function (sec) {
      if (sec.heading) s.appendChild(el('h4', null, sec.heading));
      var rows = (sec.rows || []).map(function (row) { return row.person; }).filter(Boolean);
      s.appendChild(personList(rows, { centre: true, firstId: firstRow ? 'fh-row-0' : null }));
      if (rows.length) firstRow = false;
    });
    if (!data.total) s.appendChild(el('p', null, 'Nobody in this group yet.'));
    s.appendChild(pager(data.prev, data.next, 60, function (from) { return hashFor('people', '', { group: group, from: from }); }, 'fh-row-0', 'people'));
    s.fhKeepStatus = true;
    s.fhAfter = function () { say(data.pageSpoken || ''); };
    return s;
  }

  /* Previous and Next page links; the new page's first row takes focus. */
  function pager(prev, next, size, hrefFor, firstId, what) {
    var row = el('p', { class: 'fh-actions fh-pager' });
    if (prev != null) row.appendChild(el('a', { class: 'fh-btn quiet', href: hrefFor(prev || ''), onclick: function () { focusNext = firstId; } }, 'Previous ' + size + ' ' + what));
    if (next != null) row.appendChild(el('a', { class: 'fh-btn quiet', href: hrefFor(next), onclick: function () { focusNext = firstId; } }, 'Next ' + size + ' ' + what));
    return row;
  }

  /* ── photos and records ───────────────────────────────────────────────── */

  async function galleryView(live, q) {
    var kind = q.kind || 'photos';
    var ask = { kind: kind, sort: q.sort === 'year' ? 'year' : '', person: q.person || '', since: q.since || '', from: q.from || '' };
    var params = Object.keys(ask).filter(function (k) { return ask[k]; }).map(function (k) { return k + '=' + enc(ask[k]); });
    var g = await api('/gallery?' + params.join('&'));
    if (!live()) return null;
    var s = section('Photos and records', g.title || 'Photos');
    var items = g.items || [];
    items.forEach(function (it) { (it.people || []).forEach(remember); });
    if (ask.person) {
      var who = cards.get(ask.person);
      s.appendChild(el('p', null, 'Pictures of ', who ? el('a', { href: personHref(ask.person) }, who.name) : 'one person', '. ',
        el('a', { href: hashFor('gallery', '', { kind: kind }) }, 'Show everyone’s pictures')));
    }
    if (ask.since) s.appendChild(el('p', null, 'New since your last visit. ', el('a', { href: hashFor('gallery', '', { kind: kind }) }, 'Show all of them')));
    s.appendChild(el('nav', { class: 'fh-picker', 'aria-label': 'Which pictures' }, (g.kinds || []).filter(function (k) { return k.count || k.key === g.kind; }).map(function (k) {
      return el('a', { class: 'fh-pick', href: hashFor('gallery', '', { kind: k.key, sort: ask.sort, person: ask.person, since: ask.since }), 'aria-current': k.key === g.kind ? 'true' : null }, k.title + ' (' + num(k.count) + ')');
    })));
    var sortSel = el('select', { id: 'fh-sort' },
      el('option', { value: '', selected: !ask.sort }, 'Nearest relatives first'),
      el('option', { value: 'year', selected: ask.sort === 'year' }, 'Oldest first'));
    var settle = null;
    sortSel.addEventListener('change', function () {
      clearTimeout(settle);
      settle = setTimeout(function () {
        if (!document.contains(sortSel)) return;
        focusNext = 'fh-sort';
        location.hash = hashFor('gallery', '', { kind: kind, sort: sortSel.value, person: ask.person, since: ask.since });
      }, 600);
    });
    s.appendChild(el('p', { class: 'fh-field fh-inline' }, el('label', { for: 'fh-sort' }, 'Order'), sortSel));
    s.appendChild(el('p', { class: 'fh-small' }, g.pageSpoken || ''));
    if (!items.length) s.appendChild(el('p', null, 'Nothing here yet.'));
    else s.appendChild(pictureGrid(items, { label: g.pageSpoken, idPrefix: 'fh-cell-' }));
    s.appendChild(pager(g.prev, g.next, 48, function (from) { return hashFor('gallery', '', { kind: kind, sort: ask.sort, person: ask.person, since: ask.since, from: from }); }, 'fh-cell-0', 'pictures'));
    s.fhKeepStatus = true;
    s.fhAfter = function () { say(g.pageSpoken || ''); };
    return s;
  }

  /* ── stories and Listen ───────────────────────────────────────────────── */

  async function storiesView(live) {
    var data = await api('/stories?v=2');
    if (!live()) return null;
    var s = section('Stories', 'Stories');
    var list = (data && data.stories) || [];
    if (!list.length) s.appendChild(el('p', null, 'No stories have been written yet. They will appear here as the research turns into stories.'));
    else {
      s.appendChild(el('ul', { class: 'fh-stories' }, list.map(function (st) {
        var li = el('li', null, el('a', { href: hashFor('story', st.slug) }, st.title || st.slug));
        if (st.detail) li.appendChild(el('span', { class: 'fh-small' }, ', ' + st.detail.charAt(0).toLowerCase() + st.detail.slice(1)));
        if (st.research) { li.appendChild(document.createTextNode(' ')); li.appendChild(researchPill('', 'Research: it rests on research findings, not proven by records')); }
        return li;
      })));
    }
    var clips = (data && data.clippings) || [];
    if (clips.length) {
      s.appendChild(el('h3', null, 'From the tree'));
      s.appendChild(el('p', { class: 'fh-small' }, 'Clippings and write-ups saved in the tree, with their words.'));
      var stubs = clips.map(function (c) { return { id: c.id, short: c.title || 'A clipping', alt: c.title || 'A clipping', category: 'story', sizes: [], people: c.people || [] }; });
      s.appendChild(el('ul', { class: 'fh-stories' }, stubs.map(function (stub, i) {
        var btn = el('button', { type: 'button', class: 'fh-linkbtn' }, stub.short);
        btn.addEventListener('click', function () { openViewer(stubs, i, btn); });
        var names = (clips[i].people || []).map(function (p) { return p.name; }).filter(Boolean);
        return el('li', null, btn, names.length ? el('span', { class: 'fh-small' }, ', about ' + names.join(', ')) : '');
      })));
    }
    return s;
  }

  /* The text nodes of one story block, in order, leaving out source chips and
   * words only screen readers hear, with where each starts in the block's text. */
  function textSegments(block) {
    var nodes = [];
    var text = '';
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.parentNode && n.parentNode.closest && n.parentNode.closest('[data-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
    return { text: text, nodes: nodes };
  }

  function segmentPoint(seg, at, isEnd) {
    for (var i = 0; i < seg.nodes.length; i++) {
      var n = seg.nodes[i];
      if (isEnd ? at > n.start && at <= n.end : at >= n.start && at < n.end) return { node: n.node, offset: at - n.start };
    }
    return null;
  }

  /* Lights up the sentence being read: its block gets a marker, and where the
   * browser can paint a highlight without touching the page, the sentence
   * itself (the words and their order never change for a screen reader). */
  function storyMarker(blockEls, chunks) {
    var segs = blockEls.map(textSegments);
    var ranges = cueRanges(segs.map(function (x) { return x.text; }), (chunks || []).map(function (c) {
      return (c.cues || []).map(function (q) { return q.text; });
    }));
    var paint = !!(window.CSS && CSS.highlights && typeof window.Highlight === 'function');
    var marked = [];
    function clear() {
      if (paint) { try { CSS.highlights.delete('fh-cue'); } catch (e) { /* nothing painted */ } }
      marked.forEach(function (b) { b.classList.remove('fh-reading'); });
      marked = [];
    }
    function show(part, cue) {
      clear();
      var r = ranges[part] && ranges[part][cue];
      if (!r) return null;
      for (var b = r.from.block; b <= r.to.block; b++) {
        blockEls[b].classList.add('fh-reading');
        marked.push(blockEls[b]);
      }
      if (paint) {
        var start = segmentPoint(segs[r.from.block], r.from.at, false);
        var end = segmentPoint(segs[r.to.block], r.to.at, true);
        if (start && end) {
          try {
            var range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            CSS.highlights.set('fh-cue', new window.Highlight(range));
          } catch (e) { /* the block marker is enough */ }
        }
      }
      return blockEls[r.from.block];
    }
    return { show: show, clear: clear, placed: ranges };
  }

  function stopListening() {
    if (listening) {
      listening.stop();
      listening = null;
    }
  }

  /* Listen: the story read aloud in the Library's voice, one part at a time
   * (the server voices each part once, the first time anyone asks, and keeps
   * it). The sentence being read is shown in a caption strip and lit up in the
   * text. Screen readers hear the voice itself; the caption is the same words
   * as the text below, so it stays out of their way. Nothing plays by itself. */
  function storyPlayer(st, ui, marker) {
    var slug = st.slug;
    var parts = st.chunks || [];
    var audio = new Audio();
    audio.preload = 'auto';
    var posKey = 'fh-listen-' + slug;
    var state = { i: 0, loaded: -1, playing: false, loading: false, cue: -1, seq: 0, unlocked: false, stopped: false, block: null, info: {} };
    var saved = Number(storeGet(posKey));
    if (saved > 0 && saved < parts.length) state.i = saved;
    var speed = Number(storeGet('fh-listen-speed'));
    if (SPEEDS.indexOf(speed) === -1) speed = 1;
    ui.speed.value = String(speed);

    function label() {
      ui.part.textContent = 'Part ' + (state.i + 1) + ' of ' + parts.length;
      ui.prev.setAttribute('aria-disabled', String(state.i === 0));
      ui.next.setAttribute('aria-disabled', String(state.i >= parts.length - 1));
      ui.restart.hidden = state.i === 0;
    }
    function setPlaying(on) {
      state.playing = on;
      ui.play.textContent = on ? 'Pause' : (state.loaded === state.i && audio.currentTime > 0 && !audio.ended ? 'Resume' : 'Play');
      ui.box.classList.toggle('is-playing', on);
    }
    function partInfo(n) {
      var hit = state.info[n];
      if (hit && Date.now() - hit.at < 40 * 60 * 1000) return hit.promise;
      var promise = api('/story/' + enc(slug) + '/audio/' + n);
      promise.catch(function () { delete state.info[n]; });
      state.info[n] = { at: Date.now(), promise: promise };
      return promise;
    }
    /* iPhones only let a page start sound from a tap: the first tap plays a
     * moment of silence on this same player, which then may play each part. */
    function unlock() {
      if (state.unlocked) return;
      state.unlocked = true;
      try {
        audio.src = SILENCE;
        var p = audio.play();
        if (p && p.catch) p.catch(function () { /* a real part follows */ });
      } catch (e) { /* a real part follows */ }
    }
    async function begin(n) {
      state.i = Math.max(0, Math.min(parts.length - 1, n));
      state.cue = -1;
      state.block = null;
      label();
      storeSet(posKey, state.i);
      marker.clear();
      ui.caption.textContent = '';
      var mine = ++state.seq;
      state.loading = true;
      setPlaying(true);
      ui.note.textContent = 'Getting the voice ready…';
      var j;
      try {
        j = await partInfo(state.i);
      } catch (e) {
        if (mine !== state.seq || state.stopped) return;
        state.loading = false;
        setPlaying(false);
        ui.note.textContent = '';
        say(e.message, true);
        return;
      }
      if (mine !== state.seq || state.stopped) return;
      if (!j || !srcOk(j.url)) {
        state.loading = false;
        setPlaying(false);
        ui.note.textContent = '';
        say('The voice for this part did not come back. Try again.', true);
        return;
      }
      audio.src = j.url;
      state.loaded = state.i;
      audio.playbackRate = speed;
      try {
        await audio.play();
        if (mine !== state.seq) return;
        state.loading = false;
        ui.note.textContent = '';
        setPlaying(true);
      } catch (e) {
        if (mine !== state.seq || state.stopped) return;
        state.loading = false;
        setPlaying(false);
        ui.note.textContent = '';
        say('The browser did not start the sound. Press Play again.', true);
      }
    }
    function toggle() {
      if (state.playing) {
        state.seq++;
        state.loading = false;
        audio.pause();
        ui.note.textContent = '';
        setPlaying(false);
        say('Paused.');
        return;
      }
      if (state.loaded === state.i && audio.currentTime > 0 && !audio.ended) {
        audio.playbackRate = speed;
        var p = audio.play();
        if (p && p.catch) p.catch(function () { say('The browser did not start the sound. Press Play again.', true); });
        setPlaying(true);
        return;
      }
      unlock();
      say('Playing part ' + (state.i + 1) + ' of ' + parts.length + '.');
      begin(state.i);
    }
    function jump(by) {
      var to = state.i + by;
      if (to < 0 || to >= parts.length) return;
      unlock();
      say('Part ' + (to + 1) + ' of ' + parts.length + '.');
      begin(to);
    }
    function showCue() {
      var cue = parts[state.i] && parts[state.i].cues ? parts[state.i].cues[state.cue] : null;
      ui.caption.textContent = cue ? cue.text : '';
      var block = marker.show(state.i, state.cue);
      if (block && block !== state.block) {
        state.block = block;
        if (ui.follow.checked) block.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }
    audio.addEventListener('timeupdate', function () {
      if (state.loaded !== state.i || !audio.duration || !isFinite(audio.duration) || audio.currentSrc.indexOf(SILENCE) !== -1) return;
      var f = audio.currentTime / audio.duration;
      var cues = (parts[state.i] && parts[state.i].cues) || [];
      var k = -1;
      for (var c = 0; c < cues.length; c++) {
        if (f >= cues[c].start && f < cues[c].end) { k = c; break; }
      }
      if (k === -1 && cues.length && f >= cues[cues.length - 1].start) k = cues.length - 1;
      if (k !== state.cue) {
        state.cue = k;
        showCue();
      }
      /* the next part's address, fetched while this one plays (the server has
       * already voiced it ahead), so the story runs on without a gap */
      if (f > 0.6 && state.i + 1 < parts.length) partInfo(state.i + 1).catch(function () { /* asked again when it is needed */ });
    });
    audio.addEventListener('ended', function () {
      if (state.stopped || state.loaded !== state.i || audio.currentSrc.indexOf(SILENCE) !== -1) return;
      if (state.i + 1 < parts.length) {
        begin(state.i + 1);
        return;
      }
      marker.clear();
      ui.caption.textContent = '';
      storeSet(posKey, 0);
      state.i = 0;
      state.loaded = -1;
      label();
      setPlaying(false);
      say('That is the end of the story.');
    });
    audio.addEventListener('pause', function () {
      if (state.loading || state.stopped || audio.ended || audio.currentSrc.indexOf(SILENCE) !== -1) return;
      if (state.playing) setPlaying(false);
    });
    audio.addEventListener('play', function () {
      if (audio.currentSrc.indexOf(SILENCE) === -1 && !state.stopped) setPlaying(true);
    });
    ui.play.addEventListener('click', toggle);
    ui.prev.addEventListener('click', function () { if (ui.prev.getAttribute('aria-disabled') !== 'true') jump(-1); });
    ui.next.addEventListener('click', function () { if (ui.next.getAttribute('aria-disabled') !== 'true') jump(1); });
    ui.restart.addEventListener('click', function () {
      unlock();
      say('From the beginning.');
      begin(0);
      ui.play.focus();
    });
    ui.speed.addEventListener('change', function () {
      speed = Number(ui.speed.value) || 1;
      audio.playbackRate = speed;
      storeSet('fh-listen-speed', speed);
    });

    function session(on) {
      if (!('mediaSession' in navigator)) return;
      try {
        if (on && typeof window.MediaMetadata === 'function') navigator.mediaSession.metadata = new window.MediaMetadata({ title: st.title || 'A family story', artist: 'Our family history' });
        if (!on) navigator.mediaSession.metadata = null;
        var handlers = {
          play: function () { if (!state.playing) toggle(); },
          pause: function () { if (state.playing) toggle(); },
          previoustrack: function () { jump(-1); },
          nexttrack: function () { jump(1); },
        };
        Object.keys(handlers).forEach(function (k) {
          try { navigator.mediaSession.setActionHandler(k, on ? handlers[k] : null); } catch (e) { /* not offered by this browser */ }
        });
      } catch (e) { /* no lock-screen controls here */ }
    }
    session(true);
    label();
    setPlaying(false);
    return {
      stop: function () {
        state.stopped = true;
        state.seq++;
        try { audio.pause(); } catch (e) { /* already quiet */ }
        audio.removeAttribute('src');
        try { audio.load(); } catch (e) { /* already empty */ }
        marker.clear();
        session(false);
      },
    };
  }

  function sourceChip(n) {
    var chip = el('button', { type: 'button', class: 'chip fh-source', 'data-skip': '1', 'aria-label': 'Source ' + n }, String(n));
    chip.addEventListener('click', function () {
      var item = document.getElementById('fh-src-' + n);
      if (!item) return;
      item.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      item.focus({ preventScroll: true });
    });
    return chip;
  }

  function renderRuns(runs, node) {
    runs.forEach(function (run) {
      if (typeof run.source === 'number') {
        node.appendChild(sourceChip(run.source));
        return;
      }
      var piece = document.createTextNode(run.text || '');
      if (run.em) piece = el('em', null, piece);
      if (run.strong) piece = el('strong', null, piece);
      if (run.link && webHref(run.link)) {
        piece = el('a', { href: webHref(run.link), target: '_blank', rel: 'noopener noreferrer' }, piece, el('span', { class: 'sr-only', 'data-skip': '1' }, ' (opens a new tab)'));
      }
      node.appendChild(piece);
    });
    return node;
  }

  /* The server's story blocks as page elements; a story heading sits one
   * level under the story's own title. Returns the blocks in reading order. */
  function renderBlocks(blocks, parent) {
    var list = null;
    var listOrdered = false;
    var out = [];
    blocks.forEach(function (b) {
      var node;
      if (b.type === 'li') {
        var ordered = typeof b.n === 'number';
        if (!list || listOrdered !== ordered) {
          list = el(ordered ? 'ol' : 'ul');
          listOrdered = ordered;
          parent.appendChild(list);
        }
        node = el('li');
        list.appendChild(node);
      } else {
        list = null;
        node = el(b.type === 'h2' ? 'h3' : b.type === 'h3' ? 'h4' : b.type === 'quote' ? 'blockquote' : 'p');
        parent.appendChild(node);
      }
      renderRuns(b.runs || [], node);
      out.push(node);
    });
    return out;
  }

  /* An older answer with only markdown: the page's own reader draws it. */
  function renderInline(nodes, parent) {
    nodes.forEach(function (n) {
      if (n.t === 'text') parent.appendChild(document.createTextNode(n.v));
      else if (n.t === 'code') parent.appendChild(el('code', null, n.v));
      else if (n.t === 'strong') renderInline(n.c, parent.appendChild(el('strong')));
      else if (n.t === 'em') renderInline(n.c, parent.appendChild(el('em')));
      else if (n.t === 'span') renderInline(n.c, parent);
      else if (n.t === 'source') parent.appendChild(el('span', { class: 'chip fh-source', title: 'A source' }, 'source'));
      else if (n.t === 'link' && webHref(n.href)) {
        var a = el('a', { href: webHref(n.href), target: '_blank', rel: 'noopener noreferrer' });
        renderInline(n.c, a);
        a.appendChild(el('span', { class: 'sr-only' }, ' (opens a new tab)'));
        parent.appendChild(a);
      } else if (n.t === 'link') renderInline(n.c, parent);
    });
    return parent;
  }

  function renderMarkdown(blocks, parent, title) {
    var skipTitle = blocks.length && blocks[0].type === 'heading' && blocks[0].inline.map(function (n) { return n.v || ''; }).join('').trim() === String(title || '').trim();
    blocks.forEach(function (b, i) {
      if (i === 0 && skipTitle) return;
      if (b.type === 'heading') parent.appendChild(renderInline(b.inline, el(b.level <= 2 ? 'h3' : 'h4')));
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

  function listenBox() {
    var ui = {};
    ui.play = el('button', { type: 'button', class: 'fh-btn fh-play' }, 'Play');
    ui.prev = el('button', { type: 'button', class: 'fh-btn quiet' }, 'Previous part');
    ui.next = el('button', { type: 'button', class: 'fh-btn quiet' }, 'Next part');
    ui.restart = el('button', { type: 'button', class: 'fh-btn quiet', hidden: true }, 'Start over');
    ui.speed = el('select', { id: 'fh-speed' }, SPEEDS.map(function (n) { return el('option', { value: String(n) }, n === 1 ? 'Normal' : String(n) + ' times'); }));
    ui.part = el('span', { class: 'fh-listen-part' });
    ui.note = el('span', { class: 'fh-small fh-listen-note' });
    ui.follow = el('input', { type: 'checkbox', id: 'fh-follow', checked: !reducedMotion() });
    ui.caption = el('p', { class: 'fh-caption', 'aria-hidden': 'true' });
    ui.box = el('section', { class: 'fh-listen card', 'aria-labelledby': 'fh-listen-h' },
      el('h3', { id: 'fh-listen-h' }, 'Listen'),
      el('p', { class: 'fh-small' }, 'Read aloud in the Library’s voice. All the words are on this page, and the sentence being read is lit up in the story.'),
      el('div', { class: 'fh-actions' }, ui.play, ui.prev, ui.next, ui.restart),
      el('div', { class: 'fh-actions' }, el('span', { class: 'fh-field fh-inline' }, el('label', { for: 'fh-speed' }, 'Speed'), ui.speed), ui.part, ui.note),
      el('p', { class: 'fh-check' }, ui.follow, el('label', { for: 'fh-follow' }, 'Scroll with the voice')),
      ui.caption);
    return ui;
  }

  async function storyView(live, slug) {
    var st = await api('/story/' + enc(slug) + '?v=2');
    if (!live()) return null;
    var title = st.title || slug;
    var s = section(title, title);
    if (st.detail) s.appendChild(el('p', { class: 'fh-lifespan' }, st.detail + '.'));
    s.appendChild(el('p', null, el('a', { href: '#/stories' }, 'All stories')));
    if (st.research && st.research.banner) s.appendChild(el('p', { class: 'fh-flagnote' }, st.research.banner));
    var blocks = Array.isArray(st.blocks) ? st.blocks : null;
    var chunks = Array.isArray(st.chunks) ? st.chunks : [];
    var ui = blocks && chunks.length && st.listen ? listenBox() : null;
    if (ui) s.appendChild(ui.box);
    else if (blocks && chunks.length) s.appendChild(el('p', { class: 'fh-small' }, 'Listening to the stories is coming soon.'));
    if (Array.isArray(st.short) && st.short.length) {
      s.appendChild(el('h3', null, 'The short version'));
      s.appendChild(el('ul', { class: 'fh-list' }, st.short.map(function (line) { return el('li', null, line); })));
    }
    if (Array.isArray(st.whoswho) && st.whoswho.length) {
      s.appendChild(el('h3', null, 'Who’s who for you'));
      s.appendChild(el('p', { class: 'fh-small' }, 'The story is told in ' + ownerFirst() + '’s words. Here is how each person in it is related to ' + (me.mode === 'guest' ? ownerFirst() : 'you') + '.'));
      s.appendChild(personList(st.whoswho));
    }
    var article = el('article', { class: 'fh-story', 'aria-label': title });
    var blockEls = blocks ? renderBlocks(blocks, article) : [];
    if (!blocks) renderMarkdown(parseMarkdown(st.markdown || ''), article, title);
    s.appendChild(article);
    var sources = Array.isArray(st.sources) ? st.sources : [];
    if (sources.length) {
      s.appendChild(el('h3', null, 'Sources'));
      s.appendChild(el('ol', { class: 'fh-list fh-sourcelist' }, sources.map(function (src) {
        return el('li', { id: 'fh-src-' + src.n, tabindex: '-1', value: src.n }, src.title || 'A source', webHref(src.url) ? ' ' : '', webHref(src.url) ? newTab(src.url, 'Open it') : '');
      })));
    }
    s.appendChild(el('p', null, el('a', { href: '#/stories' }, 'Back to all stories')));
    if (ui) {
      s.fhAfter = function () {
        stopListening();
        listening = storyPlayer(st, ui, storyMarker(blockEls, chunks));
      };
    }
    return s;
  }

  /* ── discoveries and family mysteries ─────────────────────────────────── */

  async function findingsView(live, arg) {
    var data = await api('/findings?v=2');
    if (!live()) return null;
    var s = section('Discoveries', 'Discoveries');
    s.appendChild(el('p', null, 'What the research found, and how sure it is. A research finding is marked, and is not proven by records.'));
    var list = (data && data.discoveries) || [];
    if (!list.length) s.appendChild(el('p', null, 'There are no discoveries yet.'));
    list.forEach(function (f) { s.appendChild(findingCard(f, 'h3')); });
    var m = data && data.mysteries;
    if (m) {
      var box = el('section', { class: 'fh-mysteries', 'aria-labelledby': 'fh-myst-h' },
        el('h3', { id: 'fh-myst-h', tabindex: '-1' }, (m.title || 'Family mysteries') + (m.count ? ' (' + num(m.count) + ')' : '')));
      box.appendChild(el('p', { class: 'fh-flagnote' }, m.headsUp || 'This part is about who some of your ancestors really were.'));
      var holder = el('div', { id: 'fh-myst-list', hidden: true });
      var btn = el('button', { type: 'button', class: 'fh-btn', 'aria-expanded': 'false', 'aria-controls': 'fh-myst-list' }, 'Show the family mysteries');
      var loaded = false;
      btn.addEventListener('click', async function () {
        if (!holder.hidden) {
          holder.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
          btn.textContent = 'Show the family mysteries';
          return;
        }
        if (!loaded) {
          try {
            var got = await api('/findings?group=mysteries');
            (got.findings || []).forEach(function (f) { holder.appendChild(findingCard(f, 'h4')); });
            if (!(got.findings || []).length) holder.appendChild(el('p', null, got.available === false ? 'The family mysteries are not open to you.' : 'There are none right now.'));
            loaded = true;
          } catch (e) {
            say(e.message, true);
            return;
          }
        }
        holder.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = 'Hide the family mysteries';
        var firstCard = holder.querySelector('h4');
        say('Showing ' + plural(holder.querySelectorAll('article').length, 'family mystery', 'family mysteries') + '.');
        if (firstCard) setTimeout(function () { firstCard.focus(); }, 150);
      });
      box.appendChild(btn);
      box.appendChild(holder);
      s.appendChild(box);
      if (arg === 'mysteries') focusNext = 'fh-myst-h';
    }
    return s;
  }

  /* ── DNA ──────────────────────────────────────────────────────────────── */

  function matchesTable(matches, caption) {
    var rows = (matches || []).filter(function (x) { return x && x.name; });
    if (!rows.length) return null;
    return el('div', { class: 'fh-tablewrap', role: 'region', 'aria-label': caption + ' (scrolls sideways)', tabindex: '0' }, el('table', null,
      el('caption', null, caption),
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'DNA cousin'), el('th', { scope: 'col' }, 'Shared cM'), el('th', { scope: 'col' }, 'Segments'))),
      el('tbody', null, rows.map(function (x) {
        return el('tr', null, el('th', { scope: 'row' }, x.name), el('td', null, x.cM != null ? num(x.cM) : ''), el('td', null, x.segments != null ? num(x.segments) : ''));
      }))));
  }

  function dnaCard(c, level) {
    var card = el('article', { class: 'card fh-finding' });
    card.appendChild(el(level, { tabindex: '-1' }, c.title || 'A DNA finding'));
    if (c.text) card.appendChild(el('p', null, c.text));
    card.appendChild(proofLine(c.proof, c.proofText));
    var about = [c.band ? 'Shared DNA ' + c.band : '', c.members ? plural(c.members, 'DNA cousin') + ' in this group' : ''].filter(Boolean).join('. ');
    if (about) card.appendChild(el('p', { class: 'fh-small' }, about + '.'));
    var people = (c.people || []).filter(function (p) { return p && p.id; });
    if (people.length) card.appendChild(personList(people));
    var table = matchesTable(c.matches, 'The DNA cousins in this group');
    if (table) card.appendChild(el('details', { class: 'fh-more' }, el('summary', null, 'The DNA cousins in this group (' + num(c.matches.length) + ')'), table));
    if (c.storySlug) card.appendChild(el('p', null, el('a', { href: hashFor('story', c.storySlug) }, 'Read the story')));
    return card;
  }

  function wedgeRow(w) {
    if (w.person && w.person.id) return personRow(w.person, { extra: w.share ? 'on average ' + w.share : '' });
    return el('li', { class: 'fh-personrow is-unknown' }, el('span', { class: 'fh-face fh-initials side-' + (w.side || 'none'), 'aria-hidden': 'true' }, '?'),
      el('span', { class: 'fh-personrow-text' }, 'Not found yet', w.side && SIDE_WORDS[w.side] ? ', ' + SIDE_WORDS[w.side] : '', w.share ? '; on average ' + w.share : ''));
  }

  async function dnaView(live) {
    var d = await api('/dna');
    if (!live()) return null;
    var s = section(d.title || 'What your DNA says', 'DNA');
    if (d.follows) s.appendChild(el('p', { class: 'fh-note' }, d.follows));
    var t = d.test;
    if (t) {
      s.appendChild(el('h3', null, 'What the DNA test found'));
      if (t.intro) s.appendChild(el('p', null, t.intro));
      (t.cards || []).forEach(function (c) { s.appendChild(dnaCard(c, 'h4')); });
      var myst = t.mysteries;
      if (myst && (myst.cards || []).length) {
        var box = el('section', { class: 'fh-mysteries', 'aria-labelledby': 'fh-dna-myst-h' }, el('h4', { id: 'fh-dna-myst-h' }, 'Family mysteries'));
        box.appendChild(el('p', { class: 'fh-flagnote' }, myst.headsUp));
        var holder = el('div', { id: 'fh-dna-myst', hidden: true }, myst.cards.map(function (c) { return dnaCard(c, 'h5'); }));
        var btn = el('button', { type: 'button', class: 'fh-btn', 'aria-expanded': 'false', 'aria-controls': 'fh-dna-myst' }, 'Show the family mysteries');
        btn.addEventListener('click', function () {
          var open = holder.hidden;
          holder.hidden = !open;
          btn.setAttribute('aria-expanded', String(open));
          btn.textContent = open ? 'Hide the family mysteries' : 'Show the family mysteries';
          if (open) {
            say('Showing ' + plural(myst.cards.length, 'family mystery', 'family mysteries') + '.');
            var h = holder.querySelector('h5');
            if (h) setTimeout(function () { h.focus(); }, 150);
          }
        });
        box.appendChild(btn);
        box.appendChild(holder);
        s.appendChild(box);
      }
      var det = t.details;
      if (det) {
        var fans = el('details', { class: 'fh-more' }, el('summary', null, det.title || 'Details for DNA fans'));
        if ((det.rows || []).length) fans.appendChild(el('ul', { class: 'fh-list' }, det.rows.map(function (r) { return el('li', null, r); })));
        if ((det.caveats || []).length) {
          fans.appendChild(el('h5', null, 'Keep in mind'));
          fans.appendChild(el('ul', { class: 'fh-list' }, det.caveats.map(function (r) { return el('li', null, r); })));
        }
        (det.clusters || []).forEach(function (c) {
          var table = matchesTable(c.matches, c.title || 'A group of DNA cousins');
          if (!table) return;
          fans.appendChild(el('h5', null, c.title));
          if (c.band || c.members) fans.appendChild(el('p', { class: 'fh-small' }, [c.band, c.members ? plural(c.members, 'DNA cousin') : ''].filter(Boolean).join(', ') + '.'));
          fans.appendChild(table);
        });
        s.appendChild(fans);
      }
      if (t.footnote) s.appendChild(el('p', { class: 'fh-small' }, t.footnote));
    }
    var paper = d.paper;
    if (paper && (paper.generations || []).length) {
      s.appendChild(el('h3', null, paper.title || 'Where your DNA comes from, on paper'));
      if (paper.note) s.appendChild(el('p', { class: 'fh-small' }, paper.note));
      paper.generations.forEach(function (g) {
        var box = el('details', { class: 'fh-more', open: g.gen === paper.startGen }, el('summary', null, g.spoken || g.text));
        if (g.text) box.appendChild(el('p', null, g.text));
        box.appendChild(el('ul', { class: 'fh-people', role: 'list' }, (g.wedges || []).map(wedgeRow)));
        s.appendChild(box);
      });
    }
    var bp = d.birthplaces;
    if (bp && (bp.byGen || bp.rows)) {
      s.appendChild(el('h3', null, 'Where they were born'));
      (bp.byGen && bp.byGen.length ? bp.byGen : [bp]).forEach(function (g) {
        var box = el('details', { class: 'fh-more', open: g.gen === bp.gen }, el('summary', null, g.title || 'Where they were born'));
        if (g.text) box.appendChild(el('p', null, g.text));
        if ((g.rows || []).length) box.appendChild(el('ul', { class: 'fh-list' }, g.rows.map(function (r) { return el('li', null, r.place + ': ' + num(r.count)); })));
        if (g.unknown) box.appendChild(el('p', { class: 'fh-small' }, 'Not known yet: ' + num(g.unknown) + '.'));
        s.appendChild(box);
      });
      if (bp.note) s.appendChild(el('p', { class: 'fh-small' }, bp.note));
    }
    var abroad = d.abroad;
    if (abroad && (abroad.text || (abroad.rows || []).length)) {
      s.appendChild(el('h3', null, 'Born across the ocean'));
      if (abroad.text) s.appendChild(el('p', null, abroad.text));
      var rows = (abroad.rows || []).filter(function (r) { return r && r.person && r.person.id; });
      if (rows.length) s.appendChild(el('ul', { class: 'fh-people', role: 'list' }, rows.map(function (r) { return personRow(r.person, { extra: r.text }); })));
    }
    var compare = d.compare;
    if (compare && (compare.averages || []).length) {
      s.appendChild(el('h3', null, compare.title || 'How much DNA you share with a relative'));
      s.appendChild(el('ul', { class: 'fh-list' }, compare.averages.map(function (a) { return el('li', null, a.text || (a.class + ': ' + a.percent)); })));
      if (compare.note) s.appendChild(el('p', { class: 'fh-small' }, compare.note));
    }
    return s;
  }

  /* ── notes to the owner ───────────────────────────────────────────────── */

  async function noteView(live, q) {
    var kind = q.kind === 'who' ? 'who' : 'memory';
    var about = null;
    var heading = 'Add a memory';
    var lead = null;
    var back = el('a', { href: '#/' }, 'Back to the start');
    if (q.media) {
      var info = await api('/media/' + enc(q.media) + '/info');
      if (!live()) return null;
      about = { mediaId: q.media };
      heading = kind === 'who' ? 'Do you know who this is?' : 'Add a memory about this picture';
      var image = info.image || { id: q.media };
      lead = el('div', { class: 'fh-note-about' }, hasPicture(image) ? picture(image, { className: 'fh-note-pic' }) : null, el('p', null, info.caption || image.short || ''));
      var shown = (info.people || []).filter(function (p) { return p && p.id; })[0];
      if (shown) back = el('a', { href: personHref(shown.id) }, 'Back to ' + shown.name);
    } else if (q.person) {
      var card = cards.get(q.person);
      if (!card) {
        var got = await api('/person/' + enc(q.person) + '?v=2');
        card = remember(got.person);
      }
      if (!live()) return null;
      about = { personId: q.person };
      heading = 'Do you know something about ' + ((card && card.first) || 'this person') + '?';
      if (card) lead = el('ul', { class: 'fh-people', role: 'list' }, personRow(card));
      back = el('a', { href: personHref(q.person) }, 'Back to ' + ((card && card.name) || 'the person'));
    }
    var s = section(heading, heading);
    if (lead) s.appendChild(lead);
    var who = ownerFirst();
    s.appendChild(el('p', null, kind === 'who'
      ? 'If you know who is in this picture, or where and when it was taken, tell ' + who + '. Only ' + who + ' reads these notes.'
      : 'Tell ' + who + ' something you remember: a story, a date, a place, a name. Only ' + who + ' reads these notes.'));
    var box = el('textarea', { id: 'fh-note-text', rows: '7', maxlength: '2000', 'aria-describedby': 'fh-note-hint' });
    var count = el('span', { class: 'fh-small', 'aria-hidden': 'true' }, '0 of 2,000 characters');
    box.addEventListener('input', function () { count.textContent = num(box.value.length) + ' of 2,000 characters'; });
    var send = el('button', { type: 'submit', class: 'fh-btn' }, 'Send to ' + who);
    var form = el('form', { class: 'fh-noteform' },
      el('label', { for: 'fh-note-text' }, 'Your note'),
      el('p', { id: 'fh-note-hint', class: 'fh-small' }, 'Up to 2,000 characters. ' + capital(who) + ' will see your name with it.'),
      box, count, el('p', { class: 'fh-actions' }, send));
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (send.getAttribute('aria-disabled') === 'true') return;
      var text = box.value.trim();
      if (!text) {
        say('Write the note first.', true);
        box.focus();
        return;
      }
      send.setAttribute('aria-disabled', 'true');
      try {
        var done = await api('/note', { kind: kind, about: about, text: text });
        var thanks = el('p', { class: 'fh-lead', id: 'fh-note-sent', tabindex: '-1' }, done.text || 'Sent. Thank you.');
        form.replaceWith(thanks);
        thanks.focus();
        say(done.text || 'Sent.');
      } catch (err) {
        send.removeAttribute('aria-disabled');
        say(err.message, true);
      }
    });
    s.appendChild(form);
    s.appendChild(el('p', null, back));
    return s;
  }

  /* ── owner: notes from the family ─────────────────────────────────────── */

  async function notesView(live) {
    var got = await Promise.all([api('/notes'), api('/accounts').catch(function () { return null; })]);
    if (!live()) return null;
    var rows = Array.isArray(got[0]) ? got[0] : [];
    var askers = (Array.isArray(got[1]) ? got[1] : []).filter(function (a) { return a.askedAt && a.access === 'none' && !a.testSeat; });
    var s = section('Notes from the family', 'Notes from the family');
    s.appendChild(el('p', null, 'Memories, “who is this” answers and requests to restore a photo. Only you see these.'));
    if (askers.length) {
      s.appendChild(el('p', { class: 'fh-flagnote' }, plural(askers.length, 'account is', 'accounts are') + ' asking to be added: ',
        askers.map(function (a) { return (a.name || a.username || 'Someone') + ' (' + dayWords(a.askedAt) + ')'; }).join(', ') + '. ',
        el('a', { href: '#/accounts' }, 'Match them in Who can see this')));
    }
    var open = el('div', { class: 'fh-notes' });
    var closed = el('div', { class: 'fh-notes' });
    var openHead = el('h3', { id: 'fh-notes-open', tabindex: '-1' });
    var doneBox = el('details', { class: 'fh-more' }, el('summary', { id: 'fh-notes-done' }), closed);
    function counts() {
      var n = rows.filter(function (r) { return !r.done; }).length;
      openHead.textContent = 'To read (' + num(n) + ')';
      doneBox.querySelector('summary').textContent = 'Done (' + num(rows.length - n) + ')';
    }
    function noteCard(r) {
      var hid = 'fh-note-' + String(r.id).replace(/[^A-Za-z0-9_-]/g, '');
      var card = el('article', { class: 'card fh-notecard', id: hid, 'aria-labelledby': hid + '-h' });
      card.appendChild(el('h4', { id: hid + '-h', tabindex: '-1' }, (r.kindText || 'A note') + ', from ' + ((r.from && r.from.name) || 'someone')));
      card.appendChild(el('p', { class: 'fh-small' }, dayWords(r.at) + (r.done && r.doneAt ? '. Marked done on ' + dayWords(r.doneAt) : '') + '.'));
      var about = r.about || null;
      if (about && about.person) card.appendChild(el('ul', { class: 'fh-people', role: 'list' }, personRow(about.person)));
      if (about && about.image) card.appendChild(el('div', { class: 'fh-note-about' }, pictureButton([about.image], 0)));
      if (r.text && r.text !== r.kindText) card.appendChild(el('p', { class: 'fh-pretext' }, r.text));
      var toggle = el('button', { type: 'button', class: 'fh-btn quiet' }, r.done ? 'Mark as not done' : 'Mark as done');
      toggle.addEventListener('click', async function () {
        if (toggle.getAttribute('aria-disabled') === 'true') return;
        toggle.setAttribute('aria-disabled', 'true');
        try {
          var res = await api('/notes/' + enc(r.id) + '/done', { done: !r.done });
          r.done = !!res.done;
          r.doneAt = r.done ? new Date().toISOString() : null;
          var list = r.done ? closed : open;
          var fresh = noteCard(r);
          card.remove();
          list.insertBefore(fresh, list.firstChild);
          counts();
          if (!open.childNodes.length) open.appendChild(el('p', { class: 'fh-empty' }, 'Nothing to read.'));
          var empty = open.querySelector('.fh-empty');
          if (empty && open.querySelector('article')) empty.remove();
          openHead.focus();
          say(r.done ? 'Marked as done. It is under Done.' : 'Moved back to To read.');
        } catch (e) {
          toggle.removeAttribute('aria-disabled');
          say(e.message, true);
        }
      });
      card.appendChild(el('p', { class: 'fh-actions' }, toggle));
      return card;
    }
    rows.forEach(function (r) { (r.done ? closed : open).appendChild(noteCard(r)); });
    if (!open.childNodes.length) open.appendChild(el('p', { class: 'fh-empty' }, 'Nothing to read.'));
    counts();
    s.appendChild(openHead);
    s.appendChild(open);
    s.appendChild(doneBox);
    return s;
  }

  /* ── owner: who can see this ──────────────────────────────────────────── */

  async function accountsView(live) {
    var rows = await api('/accounts');
    if (!live()) return null;
    rows = Array.isArray(rows) ? rows : [];
    var s = section('Who can see this', 'Who can see this');
    s.appendChild(el('p', null, 'Match each family account to that person’s place in the tree. A matched account sees the tree from its own place. A guest sees it from yours. Everyone else is told it is private to the family.'));
    var askers = rows.filter(function (a) { return a.askedAt && a.access === 'none'; });
    if (askers.length) s.appendChild(el('p', { class: 'fh-flagnote' }, plural(askers.length, 'account is', 'accounts are') + ' asking to be added. They are listed first.'));
    var busy = false;
    function accessWords(a) {
      if (a.testSeat) return 'Test account: always kept out of the family history.';
      if (a.access === 'family') return 'Matched to ' + (a.personLabel || a.personId) + '.';
      if (a.access === 'owner') return 'The tree’s owner: sees the tree from their own place.';
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
        var card = el('article', { class: 'card fh-account' + (a.askedAt && a.access === 'none' ? ' is-asking' : ''), 'aria-labelledby': hid }, el('h3', { id: hid, tabindex: '-1' }, who), el('p', null, accessWords(a)));
        if (a.askedAt && a.access === 'none') card.appendChild(el('p', { class: 'fh-flagnote' }, 'Asked to be added on ' + dayWords(a.askedAt) + '.'));
        if (a.changeable === false) {
          list.appendChild(card);
          return;
        }
        var actions = el('p', { class: 'fh-actions' });
        var finder = el('div', { class: 'fh-finder', hidden: true });
        var matchBtn = el('button', { type: 'button', class: 'fh-btn', 'aria-expanded': 'false' }, a.personId ? 'Match to someone else' : 'Match to a person');
        matchBtn.addEventListener('click', function () {
          var opening = finder.hidden;
          finder.hidden = !opening;
          matchBtn.setAttribute('aria-expanded', String(opening));
          if (opening) finder.querySelector('input').focus();
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
            var hits = await api('/search?v=2&q=' + enc(q.value.trim()));
            var people = (hits && hits.people) || [];
            found.replaceChildren.apply(found, people.slice(0, 15).map(function (h) {
              var pick = el('button', { type: 'button', class: 'fh-pickperson' }, 'Choose ' + h.name + (h.yearsSpoken ? ' (' + h.yearsSpoken + ')' : '') + (personWords(h) ? ', ' + personWords(h) : ''));
              pick.addEventListener('click', function () { change(pick, { userId: a.userId, personId: h.id }, who + ' is now matched to ' + h.name + '.'); });
              return el('li', null, pick);
            }));
            say(people.length ? plural(Math.min(people.length, 15), 'match', 'matches') + ' to choose from.' : 'Nobody matches.');
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

  var booted = false;
  function startRouting() {
    if (booted) return;
    booted = true;
    window.addEventListener('hashchange', function () {
      if (viewer && viewer.dialog.open) viewer.dialog.close();
      route();
    });
  }
  function drawArchiveSelector() {
    var box = document.getElementById('fh-archives');
    if (!box) return;
    box.replaceChildren();
    box.hidden = archiveCatalog.length < 2;
    if (box.hidden) return;
    var select = el('select', { id: 'fh-archive-choice' }, archiveCatalog.map(function (archive) {
      return el('option', { value: archive.id, selected: archive.id === activeArchive }, archive.title);
    }));
    select.addEventListener('change', function () { selectArchive(select.value); });
    box.appendChild(el('p', { class: 'fh-actions' }, el('label', { for: 'fh-archive-choice' }, 'Family archive'), select));
  }

  function ownerNav() {
    nav.querySelectorAll('[data-route="accounts"], [data-route="notes"]').forEach(function (link) { link.remove(); });
    if (!isOwner()) return;
    if (activeArchive === 'default') nav.appendChild(el('a', { href: '#/accounts', 'data-route': 'accounts' }, 'Who can see this'));
    nav.appendChild(el('a', { href: '#/notes', 'data-route': 'notes' }, 'Notes from the family'));
  }

  async function selectArchive(id) {
    if (!archiveCatalog.some(function (archive) { return archive.id === id; })) return;
    var seq = ++archiveSeq;
    navSeq++;
    activeArchive = id;
    stopListening();
    stopSky();
    if (viewer) { if (viewer.dialog.open) viewer.dialog.close(); viewer.seq++; }
    cards.clear(); signedUrls.clear(); fileCache.clear();
    lazyQueue.clear();
    if (lazyObserver) lazyObserver.disconnect();
    me = null;
    nav.hidden = true;
    view.replaceChildren();
    say('Opening the selected family archive…');
    drawArchiveSelector();
    try {
      var selectedMe = await api('/me');
      if (seq !== archiveSeq) return;
      me = selectedMe;
      if (!me || !me.access || !me.viewer) { mount(lockedSection(me)); say(''); return; }
      nav.hidden = false;
      ownerNav();
      startRouting();
      if (location.hash !== '#/') location.hash = '#/';
      else route();
    } catch (e) {
      if (seq !== archiveSeq || e.quiet) return;
      mount(errorSection(e, function () { selectArchive(id); }));
      say(e.message, true);
    }
  }

  async function boot() {
    say('Checking that this account is family…');
    token = await freshToken();
    if (!token) { signIn(); return; }
    try {
      var catalog = await api('/archives');
      archiveCatalog = catalog && Array.isArray(catalog.archives) ? catalog.archives.filter(function (archive) { return archive && typeof archive.id === 'string' && typeof archive.title === 'string'; }) : [];
      if (!archiveCatalog.some(function (archive) { return archive.id === activeArchive; }) && catalog && catalog.defaultArchive) activeArchive = catalog.defaultArchive;
    } catch (e) {
      if (e.status !== 404) { mount(errorSection(e, boot)); say(e.message, true); return; }
      archiveCatalog = [{ id: 'default', title: 'My family history' }];
      activeArchive = 'default';
    }
    drawArchiveSelector();
    try {
      me = await api('/me');
    } catch (e) {
      if (e.quiet) return;
      mount(e.status === 403 ? lockedSection(e.body) : errorSection(e, boot));
      say(e.message, e.status !== 403);
      return;
    }
    if (!me || !me.access || !me.viewer) {
      mount(lockedSection(me));
      say('');
      return;
    }
    nav.hidden = false;
    ownerNav();
    if (location.hash && location.hash !== '#' && location.hash !== '#/') firstRender = false;
    startRouting();
    route();
  }

  boot();
})();
