/* Family history: the family sky (Oct 2 2026). Contract: docs/FAMILY_HISTORY.md.
 *
 * A picture for sighted family, drawn at runtime on one canvas from the tree
 * chart history.js has already laid out (layoutTree): the person the tree is
 * centred on glows in the middle, each generation of ancestors is a ring of
 * lights rising and widening above them (Dad's side to the left and Mom's to
 * the right, as in the chart), children and grandchildren hang below, and
 * soft lines join each child to their parents. The colours are the chart's
 * side colours, and the line styles are the chart's (dashed for step, dotted
 * for a research finding).
 *
 * It is decoration and nothing else (the blind-access rule list in the
 * project's animation plan): history.js hides the whole box from screen
 * readers, the canvas takes no focus, nothing here speaks or makes a sound,
 * and everything it shows is already in the chart and its text version,
 * which stay the page's real content. Pointing at a light (or tapping it)
 * shows that person's name on a solid label and rings their box in the
 * chart; pointing at a box or a name in the chart lights their star. A click
 * (or a second tap) opens the same person page their name links to.
 *
 * Motion: when the box first comes into view the lights open out from the
 * centre (about a second) while the sky turns a little and slows to a stop
 * (4.5 seconds); after that it is still. Dragging sideways turns it, with a
 * short coast that stops within about a second. Under Reduce Motion it is a
 * still picture from the start and does not turn. It also stops when the tab
 * is hidden or the box scrolls away, and draws nothing while nothing changes.
 *
 * No libraries and no WebGL: a plain 2D canvas with a small perspective
 * projection. The pure placement (placeStars, pathTo) is checked on an
 * invented family by api/server/routes/kadeFamilyHistoryPage.nodetest.js. */
(function () {
  'use strict';

  /* The chart's side colours in their dark-mode shades: the sky is always a
   * dusk sky, in light mode too. */
  var GLOW = {
    self: '#7ee2a8',
    father: '#8cb8ff',
    mother: '#ff96c0',
    both: '#cfaaf7',
    marriage: '#bcc4d0',
    research: '#f6ca62',
    descendant: '#76dbe3',
    blood: '#beb3f3',
    none: '#aeb5c1',
  };
  var RISE = 0.95; /* height between generations */
  var RING = 1.0; /* how much wider each generation of ancestors is */
  var FAN = 0.9; /* the share of a full turn the ancestors fill; the gap is at the back */
  var PITCH = 0.36; /* looking a little down onto the rings */
  var REST_YAW = -0.2;
  var TURN = 0.8; /* how far the sky turns while it settles */
  var OPEN_MS = 1100; /* the lights open out: a big movement, 1.2 seconds at most */
  var SETTLE_MS = 4500; /* motion that starts by itself stops within 5 seconds */
  var TURN_PER_PX = 0.0085;
  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function easeOut(v) {
    var t = 1 - clamp01(v);
    return 1 - t * t * t;
  }

  /* The same rule as the chart's box colour (history.js boxCategory). */
  function categoryOf(box) {
    var card = box && box.node ? box.node.card : null;
    if (!card) return 'none';
    if (card.side === 'self') return 'self';
    if (card.research) return 'research';
    return Object.prototype.hasOwnProperty.call(GLOW, card.side) ? card.side : 'none';
  }

  function kindOf(kind) {
    if (kind === 'couple') return 'couple';
    if (kind === 'probable' || kind === 'doubtful') return 'research';
    if (kind === 'step' || kind === 'adopted') return 'step';
    return 'birth';
  }

  function spread(i, n) {
    return n <= 1 ? 0 : i / (n - 1);
  }

  /* Where each box of the chart sits in the sky. Ancestors of generation g
   * ring the centre at height g, their angle taken from their place across
   * the chart, so each couple sits above their child and the two sides open
   * left and right. Brothers and sisters stand to the left of the centre and
   * spouses to the right, as in the chart; descendants hang below. A box that
   * appears twice in the chart is two stars. */
  function placeStars(layout) {
    if (!layout || !layout.focus || !Array.isArray(layout.boxes)) return null;
    var focus = layout.focus;
    var ancSpan = 0.5;
    var descSpan = 0.5;
    var sibs = [];
    var spouses = [];
    layout.boxes.forEach(function (b) {
      var dx = Math.abs(b.x - focus.x) + 0.5;
      if (b.role === 'ancestor' && dx > ancSpan) ancSpan = dx;
      if (b.role === 'descendant' && dx > descSpan) descSpan = dx;
      if (b.role === 'sibling') sibs.push(b);
      if (b.role === 'spouse') spouses.push(b);
    });
    sibs.sort(function (a, b) { return b.x - a.x; });
    spouses.sort(function (a, b) { return a.x - b.x; });
    var stars = [];
    var byBox = new Map();
    var yMin = 0;
    var yMax = 0;
    var rMax = 0;
    var maxGen = 0;
    var depth = 0;
    layout.boxes.forEach(function (b) {
      var r = 0;
      var a = 0;
      var y = 0;
      var dx = b.x - focus.x;
      if (b.role === 'ancestor') {
        r = 0.3 + RING * b.gen;
        a = (dx / ancSpan) * Math.PI * FAN;
        y = b.gen * RISE;
        if (b.gen > maxGen) maxGen = b.gen;
      } else if (b.role === 'descendant') {
        r = 0.2 + 0.75 * -b.gen;
        a = (dx / descSpan) * Math.PI * 0.7;
        y = b.gen * RISE;
        if (-b.gen > depth) depth = -b.gen;
      } else if (b.role === 'sibling') {
        r = 1.05;
        a = -Math.PI * (0.32 + 0.48 * spread(sibs.indexOf(b), sibs.length));
      } else if (b.role === 'spouse') {
        r = 1.05;
        a = Math.PI * (0.32 + 0.48 * spread(spouses.indexOf(b), spouses.length));
      }
      var star = {
        key: b.key,
        id: b.id,
        role: b.role,
        gen: b.gen,
        focus: b === focus,
        cat: categoryOf(b),
        box: b,
        x: r * Math.sin(a),
        y: y,
        z: r * Math.cos(a),
        near: [],
      };
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
      if (r > rMax) rMax = r;
      stars.push(star);
      byBox.set(b, star);
    });
    var links = [];
    (layout.lines || []).forEach(function (l) {
      var a = byBox.get(l.from);
      var b = byBox.get(l.to);
      if (!a || !b || a === b) return;
      var link = { a: a, b: b, kind: kindOf(l.kind) };
      a.near.push({ star: b, link: links.length });
      b.near.push({ star: a, link: links.length });
      links.push(link);
    });
    var rings = [];
    for (var g = 1; g <= maxGen; g++) rings.push({ gen: g, y: g * RISE, r: 0.3 + RING * g });
    for (var d = 1; d <= depth; d++) rings.push({ gen: -d, y: -d * RISE, r: 0.2 + 0.75 * d });
    return { stars: stars, links: links, rings: rings, focus: byBox.get(focus) || null, yMin: yMin, yMax: yMax, rMax: rMax };
  }

  /* The stars and lines between a star and the centre of the sky, the way
   * the chart's lines join them (the shortest way, through parents). */
  function pathTo(scene, star) {
    var hit = { stars: new Set(), links: new Set() };
    if (!scene || !star) return hit;
    hit.stars.add(star);
    var goal = scene.focus;
    if (!goal || star === goal) return hit;
    var prev = new Map();
    prev.set(star, null);
    var queue = [star];
    for (var i = 0; i < queue.length && !prev.has(goal); i++) {
      queue[i].near.forEach(function (n) {
        if (prev.has(n.star)) return;
        prev.set(n.star, { from: queue[i], link: n.link });
        queue.push(n.star);
      });
    }
    if (!prev.has(goal)) return hit;
    for (var at = goal; prev.get(at); at = prev.get(at).from) {
      hit.stars.add(at);
      hit.links.add(prev.get(at).link);
    }
    return hit;
  }

  /* A camera that fits the whole sky in a w by h box at any turn, leaving
   * `side` pixels free at each side (for the generation labels). It measures
   * the stars and rings at twelve turns with a unit lens, then scales. */
  function fitCamera(scene, w, h, side) {
    var R = Math.max(1, scene.rMax);
    var cam = { yc: (scene.yMax + scene.yMin) / 2, D: R * 3 + (scene.yMax - scene.yMin) / 2 + 2, f: 1, cx: 0, cy: 0, unit: 0 };
    var pt = { x: 0, y: 0, k: 1, z: 0 };
    var box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    function take(P, x, y, z) {
      P(x, y, z, pt);
      if (pt.x < box.x0) box.x0 = pt.x;
      if (pt.x > box.x1) box.x1 = pt.x;
      if (pt.y < box.y0) box.y0 = pt.y;
      if (pt.y > box.y1) box.y1 = pt.y;
    }
    for (var i = 0; i < 12; i++) {
      var P = projector(cam, (i / 12) * Math.PI * 2);
      scene.stars.forEach(function (s) { take(P, s.x, s.y, s.z); });
      scene.rings.forEach(function (ring) {
        for (var j = 0; j < 16; j++) take(P, ring.r * Math.sin(j * Math.PI / 8), ring.y, ring.r * Math.cos(j * Math.PI / 8));
      });
    }
    var spanX = Math.max(0.001, box.x1 - box.x0);
    var spanY = Math.max(0.001, box.y1 - box.y0);
    var f = Math.max(20, Math.min((w - 2 * (side || 0) - 40) / spanX, (h - 52) / spanY));
    cam.f = f;
    cam.cx = w / 2 - f * (box.x0 + box.x1) / 2;
    cam.cy = (h - 10) / 2 - f * (box.y0 + box.y1) / 2;
    cam.unit = f / cam.D;
    cam.left = cam.cx + f * box.x0;
    return cam;
  }

  /* Turns (yaw, about the upright axis), tips (PITCH) and projects a point;
   * out.k is the perspective size (1 at the centre's depth), out.z how near
   * the viewer it is. */
  function projector(cam, yaw) {
    var cy = Math.cos(yaw);
    var sy = Math.sin(yaw);
    var cp = Math.cos(PITCH);
    var sp = Math.sin(PITCH);
    return function (x, y, z, out) {
      var xr = x * cy + z * sy;
      var zr = z * cy - x * sy;
      var yy = y - cam.yc;
      var yr = yy * cp - zr * sp;
      var zz = yy * sp + zr * cp;
      var dist = cam.D - zz;
      var k = cam.f / dist;
      out.x = cam.cx + xr * k;
      out.y = cam.cy - yr * k;
      out.k = cam.D / dist;
      out.z = zz;
      return out;
    };
  }

  var parts = { placeStars: placeStars, pathTo: pathTo, fitCamera: fitCamera, projector: projector, categoryOf: categoryOf, GLOW: GLOW };
  if (typeof module === 'object' && module && module.exports) module.exports = parts;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  /* ── drawing ──────────────────────────────────────────────────────────── */

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function seeded(seed) {
    var s = seed | 0;
    return function () {
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function glowSprite(hex) {
    var c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    var g = c.getContext('2d');
    if (!g) return null;
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(hex, 0.95));
    grad.addColorStop(0.2, rgba(hex, 0.5));
    grad.addColorStop(0.5, rgba(hex, 0.14));
    grad.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  function capital(text) {
    var s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* opts: still() -> true while nothing may move (Reduce Motion), solid
   * (Reduce Transparency: no glow), focusLabel, ringName(gen) and
   * descName(level) for the generation labels, onLight(id|null) when the
   * pointer lights a star, onOpen(id) for a click or a second tap. */
  function mount(host, layout, opts) {
    var scene = placeStars(layout);
    if (!scene || !scene.focus) return null;
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'fh-skycanvas';
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    host.appendChild(canvas);
    var sprites = {};
    Object.keys(GLOW).forEach(function (k) { sprites[k] = opts.solid ? null : glowSprite(GLOW[k]); });

    var w = 0;
    var h = 0;
    var dpr = 1;
    var cam = null;
    var dust = [];
    var phase = 'waiting'; /* waiting -> opening -> still */
    var t0 = 0;
    var yaw = REST_YAW;
    var shownYaw = REST_YAW;
    var spin = 0;
    var spinFrames = 0;
    var raf = 0;
    var hover = null;
    var outsideId = null;
    var pathFor = { id: undefined, hit: null };
    var drawn = [];
    var down = null;
    var dead = false;

    function makeDust() {
      var rand = seeded(20261002);
      var R = Math.max(1, scene.rMax);
      var count = Math.round(Math.max(50, Math.min(150, (w * h) / 2600)));
      dust = [];
      for (var i = 0; i < count; i++) {
        var a = rand() * Math.PI * 2;
        var r = R * (1.15 + rand() * 0.8);
        dust.push({
          x: r * Math.sin(a),
          y: scene.yMin - 0.9 + rand() * (scene.yMax - scene.yMin + 2.1),
          z: r * Math.cos(a),
          s: 0.7 + rand() * 1.1,
          a: 0.22 + rand() * 0.5,
        });
      }
    }

    function resize() {
      var nw = host.clientWidth;
      var nh = host.clientHeight;
      if (!nw || !nh) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cam && nw === w && nh === h && canvas.width === Math.round(nw * dpr)) return true;
      w = nw;
      h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cam = fitCamera(scene, w, h, labelled() ? 118 : 0);
      makeDust();
      return true;
    }

    /* The generation labels need a wide box: a phone shows the lights alone. */
    function labelled() {
      return w >= 560;
    }

    function canTurn() {
      return !opts.still();
    }

    function litId() {
      return hover ? hover.id : outsideId;
    }

    function litPath(id) {
      if (pathFor.id === id) return pathFor.hit;
      var hit = null;
      if (id != null) {
        hit = { stars: new Set(), links: new Set() };
        scene.stars.forEach(function (s) {
          if (s.id !== id) return;
          var one = pathTo(scene, s);
          one.stars.forEach(function (x) { hit.stars.add(x); });
          one.links.forEach(function (x) { hit.links.add(x); });
        });
        if (!hit.stars.size) hit = null;
      }
      pathFor = { id: id, hit: hit };
      return hit;
    }

    /* A lit person's name and relationship, beside their star. */
    function label(lines, x, y, edge) {
      var padX = 9;
      var lineH = [17, 15];
      ctx.font = '700 13px ' + FONT;
      var tw = ctx.measureText(lines[0]).width;
      if (lines[1]) {
        ctx.font = '400 12px ' + FONT;
        tw = Math.max(tw, ctx.measureText(lines[1]).width);
      }
      var bw = Math.min(w - 12, tw + padX * 2);
      var bh = 8 + lineH[0] + (lines[1] ? lineH[1] : 0);
      var bx = x + 14;
      var by = y - bh / 2;
      if (bx + bw > w - 6) bx = x - 14 - bw;
      bx = Math.max(6, Math.min(w - 6 - bw, bx));
      by = Math.max(6, Math.min(h - 6 - bh, by));
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      roundRect(ctx, bx, by, bw, bh, 7);
      ctx.fillStyle = '#0a0f24';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = edge;
      ctx.stroke();
      ctx.save();
      roundRect(ctx, bx + 1, by + 1, bw - 2, bh - 2, 6);
      ctx.clip();
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 13px ' + FONT;
      ctx.fillText(lines[0], bx + padX, by + 4 + 13);
      if (lines[1]) {
        ctx.fillStyle = '#d7ddf6';
        ctx.font = '400 12px ' + FONT;
        ctx.fillText(lines[1], bx + padX, by + 4 + lineH[0] + 12);
      }
      ctx.restore();
    }

    function wordsFor(star) {
      var node = star.box.node || {};
      var card = node.card || null;
      var name = card && card.name ? String(card.name) : String(node.label || '');
      var more = card ? [capital(card.term), card.years || ''].filter(Boolean).join(', ') : String(node.lifespan || '');
      return [name, more];
    }

    /* A label in the column at the left of the sky, with a dotted line to
     * the ring (or, for the centre, the star) it names. */
    function ringLabel(text, x, y, column, strong) {
      ctx.font = (strong ? '700 12.5px ' : '600 11.5px ') + FONT;
      var bw = ctx.measureText(text).width + (strong ? 18 : 14);
      var bx = Math.max(6, column - bw);
      var by = y - 10;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#b4c3ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([1.5, 4]);
      ctx.beginPath();
      ctx.moveTo(bx + bw + 4, y);
      ctx.lineTo(x - 6, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      roundRect(ctx, bx, by, bw, 20, 10);
      ctx.fillStyle = '#0a0f24';
      ctx.fill();
      if (strong) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      ctx.fillStyle = strong ? '#ffffff' : '#c4cdf0';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + (strong ? 9 : 7), by + 10.5);
      ctx.textBaseline = 'alphabetic';
    }

    function render(t) {
      if (!cam && !resize()) return;
      var opening = phase === 'opening';
      var open = opening ? t / OPEN_MS : 1;
      shownYaw = opening ? REST_YAW - TURN * (1 - easeOut(t / SETTLE_MS)) : yaw;
      var P = projector(cam, shownYaw);
      var pt = { x: 0, y: 0, k: 1, z: 0 };
      var unit = cam.unit;
      var id = litId();
      var path = litPath(id);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);

      /* dust: far specks that turn with the sky, for depth */
      var fade = clamp01(open * 1.4);
      ctx.fillStyle = '#e2e8ff';
      dust.forEach(function (d) {
        P(d.x, d.y, d.z, pt);
        ctx.globalAlpha = d.a * fade * (0.45 + 0.55 * clamp01((pt.k - 0.7) / 0.6));
        var s = d.s * pt.k;
        ctx.fillRect(pt.x - s / 2, pt.y - s / 2, s, s);
      });

      /* the generation rings: the far half fainter than the near half */
      var ringEnds = [];
      ctx.lineWidth = 1;
      scene.rings.forEach(function (ring) {
        var q = easeOut(open * 1.2 - Math.abs(ring.gen) * 0.06);
        if (q <= 0) return;
        var pts = [];
        var left = null;
        for (var i = 0; i <= 72; i++) {
          var a = (i / 72) * Math.PI * 2;
          P(ring.r * q * Math.sin(a), ring.y * q, ring.r * q * Math.cos(a), pt);
          pts.push({ x: pt.x, y: pt.y, front: pt.z > -0.15 });
          if (!left || pt.x < left.x) left = { x: pt.x, y: pt.y };
        }
        [false, true].forEach(function (front) {
          ctx.beginPath();
          for (var j = 1; j < pts.length; j++) {
            if (pts[j].front !== front || pts[j - 1].front !== front) continue;
            ctx.moveTo(pts[j - 1].x, pts[j - 1].y);
            ctx.lineTo(pts[j].x, pts[j].y);
          }
          ctx.globalAlpha = q * (front ? 0.3 : 0.12);
          ctx.strokeStyle = '#b4c3ff';
          ctx.stroke();
        });
        ringEnds.push({ gen: ring.gen, x: left.x, y: left.y, q: q });
      });

      /* where every star is this frame */
      var spots = scene.stars.map(function (s) {
        var q = s.focus ? 1 : easeOut(open - Math.min(0.4, Math.abs(s.gen) * 0.07) - (s.role === 'ancestor' ? 0 : 0.05));
        P(s.x * q, s.y * q, s.z * q, pt);
        return { star: s, x: pt.x, y: pt.y, k: pt.k, z: pt.z, q: q };
      });
      var spotOf = new Map();
      spots.forEach(function (sp) { spotOf.set(sp.star, sp); });

      /* the lines: from each child up (or down) to the parent's ring */
      ctx.lineCap = 'round';
      scene.links.forEach(function (l, i) {
        var a = spotOf.get(l.a);
        var b = spotOf.get(l.b);
        var q = Math.min(a.q, b.q);
        if (q <= 0.02) return;
        var lit = !!(path && path.links.has(i));
        var nearness = clamp01((Math.min(a.k, b.k) - 0.78) / 0.45);
        var alpha = q * (0.2 + 0.4 * nearness);
        if (path && !lit) alpha *= 0.4;
        if (lit) alpha = 0.95;
        var colour = l.kind === 'research' ? '246,202,98' : l.kind === 'couple' ? '255,214,170' : lit ? '255,243,214' : '205,218,255';
        ctx.strokeStyle = 'rgba(' + colour + ',' + alpha + ')';
        ctx.lineWidth = lit ? 2.6 : 1.3;
        ctx.setLineDash(l.kind === 'step' ? [6, 5] : l.kind === 'research' ? [1.5, 5] : []);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        if (l.kind === 'couple') {
          P((l.a.x + l.b.x) / 2 * q, (l.a.y + l.b.y) / 2 * q + 0.22, (l.a.z + l.b.z) / 2 * q, pt);
        } else {
          P(l.b.x * q, l.a.y * q, l.b.z * q, pt);
        }
        ctx.quadraticCurveTo(pt.x, pt.y, a.x, a.y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      /* the stars, far ones first */
      var base = Math.max(3, Math.min(7, unit * 0.13));
      drawn = [];
      spots.slice().sort(function (p, q2) { return p.z - q2.z; }).forEach(function (sp) {
        var s = sp.star;
        if (sp.q <= 0.02) return;
        var lit = id != null && s.id === id;
        var onPath = !!(path && path.stars.has(s));
        var r = base * sp.k * (s.focus ? 1.7 : 1) * (lit ? 1.35 : 1);
        var nearness = clamp01((sp.k - 0.78) / 0.45);
        var alpha = sp.q * (0.6 + 0.4 * nearness);
        if (path && !onPath) alpha *= 0.5;
        var colour = GLOW[s.cat] || GLOW.none;
        var sprite = sprites[s.cat];
        if (sprite) {
          var hr = r * (s.focus || lit ? 5 : 4.2);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = alpha * 0.85;
          ctx.drawImage(sprite, sp.x - hr, sp.y - hr, hr * 2, hr * 2);
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, alpha + 0.15);
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (sprite) {
          ctx.globalAlpha = alpha * 0.85;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
        if (s.focus || lit) {
          ctx.globalAlpha = s.focus && !lit ? 0.75 * sp.q : 1;
          ctx.lineWidth = lit ? 2.2 : 1.5;
          ctx.strokeStyle = lit ? '#ffbf47' : '#ffffff';
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, r * (lit ? 2.1 : 1.9), 0, Math.PI * 2);
          ctx.stroke();
        }
        drawn.push({ star: s, x: sp.x, y: sp.y, r: r });
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      /* words, always on a solid label: the centre's name ("You") and, on a
       * wide box, each generation's name, in one column at the left */
      var focusSpot = spotOf.get(scene.focus);
      var taken = [];
      if (open >= 0.6 && opts.focusLabel) {
        var fr = base * focusSpot.k * 1.7;
        ringLabel(opts.focusLabel, focusSpot.x - fr * 2, focusSpot.y, Math.min(cam.left - 14, focusSpot.x - fr * 2 - 24), true);
        taken.push(focusSpot.y);
      }
      if (labelled() && open >= 1) {
        ringEnds.sort(function (p, q2) { return p.y - q2.y; }).forEach(function (e) {
          var text = e.gen > 0 ? opts.ringName(e.gen) : opts.descName(-e.gen);
          if (!text || taken.some(function (y) { return Math.abs(y - e.y) < 22; })) return;
          taken.push(e.y);
          ringLabel(text, e.x, e.y, Math.min(cam.left - 14, e.x - 24), false);
        });
      }
      if (id != null) {
        var best = null;
        drawn.forEach(function (d) { if (d.star.id === id && (!best || d.star.z > best.star.z)) best = d; });
        if (best) label(wordsFor(best.star), best.x, best.y, GLOW[best.star.cat] || '#ffffff');
      }
    }

    function tick(now) {
      raf = 0;
      if (dead) return;
      if (!canvas.isConnected) { destroy(); return; }
      if (phase === 'waiting') return; /* nothing is drawn before the box is first seen */
      var t = phase === 'opening' ? now - t0 : 0;
      if (phase === 'opening' && (t >= SETTLE_MS || !canTurn())) {
        phase = 'still';
        yaw = REST_YAW;
      }
      if (spin) {
        yaw += spin;
        spin *= 0.9;
        spinFrames++;
        if (Math.abs(spin) < 0.0006 || spinFrames > 70 || !canTurn()) spin = 0;
      }
      render(t);
      if (phase === 'opening' || spin) request();
    }

    function request() {
      if (!raf && !dead) raf = window.requestAnimationFrame(tick);
    }

    /* Stops any motion where it is: the end of the settle, or no coast. */
    function settle(keepTurn) {
      if (phase === 'opening') {
        phase = 'still';
        yaw = keepTurn ? shownYaw : REST_YAW;
      }
      spin = 0;
      request();
    }

    function begin() {
      if (phase !== 'waiting') return;
      if (!resize()) return;
      if (!canTurn() || document.hidden) {
        phase = 'still';
      } else {
        phase = 'opening';
        t0 = window.performance && performance.now ? performance.now() : Date.now();
      }
      request();
    }

    function setHover(star) {
      var before = hover ? hover.id : null;
      var after = star ? star.id : null;
      hover = star;
      canvas.style.cursor = star ? 'pointer' : canTurn() ? 'grab' : 'default';
      if (before === after) return;
      if (opts.onLight) opts.onLight(after);
      request();
    }

    function hit(e) {
      var box = canvas.getBoundingClientRect();
      var x = e.clientX - box.left;
      var y = e.clientY - box.top;
      var reach = e.pointerType === 'mouse' ? 12 : 22;
      var best = null;
      var bestD = Infinity;
      drawn.forEach(function (d) {
        var dist = Math.sqrt((d.x - x) * (d.x - x) + (d.y - y) * (d.y - y));
        if (dist <= Math.max(reach, d.r * 2.2) && dist < bestD) {
          best = d.star;
          bestD = dist;
        }
      });
      return best;
    }

    function onDown(e) {
      if (e.button) return;
      down = { x: e.clientX, id: e.pointerId, type: e.pointerType, yaw: phase === 'opening' ? shownYaw : yaw, moved: false, turning: false, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
      spin = 0;
    }

    function onMove(e) {
      if (down && e.pointerId === down.id) {
        var dx = e.clientX - down.x;
        /* A drag is never a tap; it turns the sky only while motion is allowed. */
        if (!down.moved && Math.abs(dx) > 6) {
          down.moved = true;
          down.turning = canTurn();
          if (down.turning) {
            settle(true);
            down.yaw = yaw - dx * TURN_PER_PX;
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older browsers turn without capture */ }
            canvas.style.cursor = 'grabbing';
          }
        }
        if (down.turning) {
          yaw = down.yaw + dx * TURN_PER_PX;
          var dt = Math.max(8, e.timeStamp - down.lastT);
          down.v = ((e.clientX - down.lastX) * TURN_PER_PX / dt) * 16;
          down.lastX = e.clientX;
          down.lastT = e.timeStamp;
          request();
        }
        return;
      }
      if (e.pointerType === 'mouse') setHover(hit(e));
    }

    function onUp(e) {
      if (!down || e.pointerId !== down.id) return;
      var was = down;
      down = null;
      if (was.moved) {
        if (!was.turning) return;
        canvas.style.cursor = 'grab';
        if (canTurn() && Math.abs(was.v) > 0.002) {
          spin = Math.max(-0.08, Math.min(0.08, was.v));
          spinFrames = 0;
          request();
        }
        return;
      }
      var star = hit(e);
      if (was.type === 'mouse') {
        if (star && opts.onOpen) opts.onOpen(star.id);
        return;
      }
      if (star && hover && hover.id === star.id) {
        if (opts.onOpen) opts.onOpen(star.id);
        return;
      }
      setHover(star);
    }

    function onCancel() {
      down = null;
    }

    function onLeave(e) {
      if (e.pointerType === 'mouse' && !down) setHover(null);
    }

    function onVisibility() {
      if (document.hidden) settle(false);
    }

    function onMotionSetting() {
      if (!canTurn()) settle(false);
      canvas.style.cursor = canTurn() ? 'grab' : 'default';
    }

    canvas.style.cursor = canTurn() ? 'grab' : 'default';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionSetting);
    else if (motionQuery && motionQuery.addListener) motionQuery.addListener(onMotionSetting);

    var sizer = 'ResizeObserver' in window ? new ResizeObserver(function () {
      if (dead) return;
      if (!canvas.isConnected) { destroy(); return; }
      if (resize()) {
        if (phase === 'waiting' && !watcher) begin();
        else request();
      }
    }) : null;
    if (sizer) sizer.observe(host);

    /* The settle plays once the box is in view, and stops if it leaves. */
    var watcher = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (dead) return;
        if (!en.isIntersecting) { settle(false); return; }
        begin();
      });
    }, { threshold: 0.3 }) : null;
    if (watcher) watcher.observe(host);
    else begin();

    function destroy() {
      if (dead) return;
      dead = true;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      if (sizer) sizer.disconnect();
      if (watcher) watcher.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (motionQuery && motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotionSetting);
      else if (motionQuery && motionQuery.removeListener) motionQuery.removeListener(onMotionSetting);
      if (hover && opts.onLight) opts.onLight(null);
      hover = null;
    }

    return {
      light: function (id) {
        if (dead || outsideId === id) return;
        outsideId = id;
        request();
      },
      destroy: destroy,
    };
  }

  window.KadeFamilySky = { mount: mount };
})();
