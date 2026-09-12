'use strict';
/* ----------------------------------------------------------------------------
 * THE READING ROOM — turning a book file into something a voice can read
 * (Part 181, Sep 11 2026). Her ask: "a reading room ... bookshare books read
 * by the inworld voices, chunks at a time, rewind and forward, bookmarks ...
 * skip all that watermark material ... read like a Library of Congress NLS
 * book: book jacket, useful information, and the story."
 *
 * PURE FUNCTIONS, no I/O, no mongoose: `parseBook(buffer, filename)` returns
 *   { meta, sections, skipped, jacket, stats }
 * where every section is { title, chunks: [text...], chars, kind } in reading
 * order, and every chunk is one short piece (<= CHUNK_TARGET chars, whole
 * sentences) that the voice proxy's streamed lane can say in one call.
 *
 * FORMATS (read off five real Bookshare downloads on Sep 11 2026 — see
 * READING_ROOM_DESIGN_2026-09-11.md):
 *   - Bookshare DAISY 3 "text only" zip: one .opf (dc: metadata + Synopsis),
 *     one .ncx, one dtbook .xml (frontmatter/bodymatter, level1..6, h1..h6,
 *     p, pagenum, img), N .smil we ignore. The Bookshare notice is ALWAYS a
 *     <level1 id="bookshare_note"> whose last paragraph is "BEGIN CONTENT".
 *     Chapters are NOT reliably inside <bodymatter> (All the Light We Cannot
 *     See keeps its whole Part Zero in frontmatter), so we walk headings in
 *     document order and never trust front-vs-body.
 *   - DAISY 2.02 zip (ncc.html + content .html): same walker over the HTML.
 *   - EPUB 2/3: container.xml -> .opf -> spine -> XHTML in order.
 *   - .txt / .html / .xhtml / .docx (docx via mammoth, already a dependency).
 *
 * XML is walked by a small tolerant tokenizer instead of a parser dependency:
 * dtbook and XHTML are well-formed, and all we need is tag names, a handful
 * of attributes, and text. Entities are decoded.
 * -------------------------------------------------------------------------- */

const CHUNK_TARGET = 450; // <= 500 keeps the proxy's single-chunk streamed lane
const CHUNK_HARD_MAX = 600;
const CHARS_PER_MINUTE = 1000; // SHARED_HEAD's listenTime rule of thumb

const BLOCK_TAGS = new Set([
  'p', 'li', 'blockquote', 'div', 'tr', 'dd', 'dt', 'line', 'linegroup', 'poem', 'note', 'sidebar',
  'prodnote', 'caption', 'address', 'author', 'byline', 'dateline', 'epigraph', 'cite', 'pre',
  'table', 'td', 'th', 'section', 'article', 'aside', 'header', 'footer', 'figure', 'figcaption',
  'ul', 'ol', 'dl', 'list', 'br', 'hr', 'covertitle', 'bridgehead',
]);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hd']);
/** Bump when the parser learns something that changes sections/chunks; books
 * stamped with an older number are re-read from their stored original the
 * next time someone opens them (kadeReadingRoom.js reparseIfStale). */
const PARSER_VERSION = 2;
/* Sep 12 2026, her Narnia omnibus: Bookshare's DAISY carried the whole
 * seven-book collection as THREE <level2>s with an NCX of ten entries, and
 * every real chapter lived in a paragraph CLASS instead ("CN" Chapter One,
 * "CT" The Wrong Door, "chapter-heads", "A-HEAD"). The walker now reads a
 * heading-looking class on <p>/<div> as a heading, and a table-of-contents
 * class ("toc", "toc1", "tocpara", "contents...") as the Contents list, which
 * classify() skips. Kept narrow on purpose: title pages ("tp-title"),
 * copyright and cover classes are NOT headings. */
const HEADING_CLASS_RE = /(^|[\s_-])(cn|ct|chapter[\s_-]?(?:head|heads|title|titles|number|num|no)|(?:[abc]|sub)[\s_-]?head(?:ing)?s?|hd[1-6]?|h[1-6]|heading[s]?|part[\s_-]?(?:title|number|head)|book[\s_-]?title)(?=$|[\s_-]|\d)/i;
const TOC_CLASS_RE = /(^|[\s_-])(toc\w*|contents\w*|tocis\d*)(?=$|[\s_-]|\d)/i;
const NOT_HEADING_CLASS_RE = /(toc|contents|copyright|title[\s_-]?page|tp[\s_-]|cover|dedication|epigraph|ext\b)/i;
const LEVEL_TAG = /^level[1-6]?$/;
const SKIP_TAGS = new Set(['pagenum', 'img', 'head', 'meta', 'script', 'style', 'title', 'doctitle', 'docauthor', 'link', 'svg', 'math', 'noteref', 'annoref']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] != null ? m[2] : m[3]) : '';
}
function squash(s) {
  return String(s).replace(/[ \t\r\n\f\v ]+/g, ' ').trim();
}

/* ── the walker ─────────────────────────────────────────────────────────── */
/** Walk one XML/HTML document, emitting sections in document order.
 * `into` is the running list of sections (shared across EPUB spine files). */
function walkMarkup(xml, into, opts = {}) {
  const titlesById = opts.titlesById || null;
  const src = String(xml)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t) => t.replace(/</g, '&lt;'))
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const re = /<\/?([a-zA-Z][a-zA-Z0-9:_-]*)([^>]*)>|([^<]+)/g;
  const stack = []; // open element names
  let skipDepth = 0; // inside a SKIP tag
  let noticeDepth = 0; // inside the Bookshare notice level
  let cur = null; // current section being filled
  let para = []; // words of the paragraph being built
  let headingBuf = null; // text of the heading being read

  const startSection = (title, kind) => {
    // An empty, untitled section is reused rather than left behind.
    if (cur && !cur.title && cur.paras.length === 0 && !cur.notice) {
      cur.title = title || '';
      cur.kind = kind || cur.kind;
      cur.notice = noticeDepth > 0;
      return;
    }
    if (cur) flushPara();
    cur = { title: title || '', paras: [], kind: kind || 'section', notice: noticeDepth > 0, ids: [] };
    into.push(cur);
  };
  const flushPara = () => {
    if (!cur) {
      cur = { title: '', paras: [], kind: 'section', notice: noticeDepth > 0, ids: [] };
      into.push(cur);
    }
    const t = squash(para.join(''));
    para = [];
    if (t) cur.paras.push(t);
  };

  let m;
  while ((m = re.exec(src))) {
    if (m[3] != null) {
      if (skipDepth > 0) continue;
      const text = decodeEntities(m[3]);
      if (headingBuf != null) headingBuf += text;
      else para.push(text);
      continue;
    }
    const raw = m[0];
    const name = m[1].toLowerCase().replace(/^.*:/, '');
    const rest = m[2] || '';
    const closing = raw[1] === '/';
    const selfClosing = /\/\s*$/.test(rest) || name === 'br' || name === 'hr' || name === 'img' || name === 'pagenum' && /\/\s*$/.test(rest);

    if (!closing) {
      if (SKIP_TAGS.has(name)) {
        if (!selfClosing) { stack.push(name); skipDepth++; }
        continue;
      }
      if (skipDepth > 0) { if (!selfClosing) stack.push(name); continue; }
      if (name === 'br') { para.push('\n'); flushPara(); continue; }
      if (LEVEL_TAG.test(name) || name === 'frontmatter' || name === 'bodymatter' || name === 'rearmatter' || name === 'body') {
        const id = attr(raw, 'id');
        const cls = attr(raw, 'class').toLowerCase();
        if (LEVEL_TAG.test(name)) {
          const isNotice = id === 'bookshare_note' || /bookshare/.test(id.toLowerCase()) || /bookshare/.test(cls);
          if (isNotice) noticeDepth++;
          stack.push(isNotice ? name + '#notice' : name);
          startSection(titlesById && id && titlesById[id] ? titlesById[id] : '', cls || 'section');
          if (id) cur.ids.push(id);
        } else if (!selfClosing) stack.push(name);
        continue;
      }
      if (HEADING_TAGS.has(name)) {
        flushPara();
        headingBuf = '';
        if (!selfClosing) stack.push(name);
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        flushPara();
        if (name === 'p' || name === 'div') {
          const cls = attr(raw, 'class');
          if (cls && TOC_CLASS_RE.test(cls)) {
            if (!cur || cur.kind !== 'toc') startSection('Contents', 'toc');
          } else if (cls && !NOT_HEADING_CLASS_RE.test(cls) && HEADING_CLASS_RE.test(cls)) {
            // a heading dressed as a paragraph: read it exactly like <h2>
            headingBuf = '';
            if (!selfClosing) stack.push(name + '#hd');
            continue;
          } else if (cur && cur.kind === 'toc') {
            // body text after the contents list, with no heading between
            startSection('', 'section');
          }
        }
        if (titlesById) {
          const id = attr(raw, 'id');
          if (id && titlesById[id]) {
            if (cur && !cur.title && cur.paras.length === 0) cur.title = titlesById[id];
            else if (!cur || cur.title !== titlesById[id]) startSection(titlesById[id], 'section');
            titlesById[id] = null; // used once
          }
        }
        if (!selfClosing) stack.push(name);
        continue;
      }
      if (!selfClosing) stack.push(name);
      // inline: nothing, text keeps flowing (a space guards word-joins like <em>x</em>y)
      para.push(' ');
      continue;
    }
    // closing tag
    let popped = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === name || stack[i] === name + '#notice' || stack[i] === name + '#hd') { popped = stack.splice(i).slice(0, 1)[0]; break; }
    }
    if (SKIP_TAGS.has(name)) { if (skipDepth > 0) skipDepth--; continue; }
    if (skipDepth > 0) continue;
    if (HEADING_TAGS.has(name) || (popped && popped.endsWith('#hd'))) {
      const title = squash(headingBuf || '');
      headingBuf = null;
      if (title) {
        if (cur && !cur.title && cur.paras.length === 0) cur.title = title;
        else startSection(title, 'section');
      }
      continue;
    }
    if (LEVEL_TAG.test(name)) {
      flushPara();
      if (popped && popped.endsWith('#notice') && noticeDepth > 0) noticeDepth--;
      continue;
    }
    if (BLOCK_TAGS.has(name)) { flushPara(); continue; }
    para.push(' ');
  }
  flushPara();
  return into;
}

/* ── chunking ───────────────────────────────────────────────────────────── */
const ABBREV = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Gen|Col|Lt|Sgt|Capt|Rev|Hon|vs|etc|e\.g|i\.e|Inc|Ltd|Co|No|Vol|Ch|pp|p|a\.m|p\.m|U\.S|U\.K|Ph\.D|B\.C|A\.D)\.$/i;
function splitSentences(text) {
  const out = [];
  const parts = squash(text).split(/(?<=[.!?…]["'”’)\]]?)\s+(?=["'“‘(\[]?[A-Z0-9])/);
  let buf = '';
  for (const p of parts) {
    buf = buf ? buf + ' ' + p : p;
    if (ABBREV.test(buf) || /\b[A-Z]\.$/.test(buf)) continue; // "Dr." / initials: keep joining
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}
function hardSplit(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(', ', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut + (rest[cut] === ',' ? 1 : 0)).trim());
    rest = rest.slice(cut).replace(/^[,\s]+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
/** Paragraphs -> chunks of whole sentences, <= target chars, never crossing a
 * paragraph boundary unless paragraphs are tiny (poetry, dialogue lines). */
function chunkParagraphs(paras, target = CHUNK_TARGET) {
  const chunks = [];
  let buf = '';
  const push = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    const sentences = splitSentences(p).flatMap((s) => (s.length > CHUNK_HARD_MAX ? hardSplit(s, target) : [s]));
    // a paragraph that fits whole and would overflow the buffer starts fresh
    if (buf && buf.length + 1 + p.length > target) push();
    for (const s of sentences) {
      if (buf && buf.length + 1 + s.length > target) push();
      buf = buf ? buf + ' ' + s : s;
    }
    // paragraph end: keep short lines flowing (dialogue), break on long ones
    if (buf.length > target * 0.6) push();
    else buf += '\n';
  }
  push();
  return chunks.map((c) => c.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* ── classification (the watermark skip) ────────────────────────────────── */
const NOTICE_RE = /begin content|this accessible media|print disabilit|bookshare (distributes|agreement|web site)|digitally fingerprinted|downloaded by [A-Z]/i;
const COPYRIGHT_RE = /all rights reserved|isbn[\s:-]*\d|library of congress|printed in the|first (edition|printing)|published (by|in the united)|copyright ©|© ?\d{4}/i;
const CONTENTS_RE = /^(table of )?contents$/i;
const PRAISE_RE = /^(praise for|also by|other (books|titles) by|books by|by the same author|about the publisher|newsletter sign|sign up for|a note about the type)/i;
const PUBLISHER_JUNK_RE = /thank you for (downloading|purchasing|buying|reading)|click here to sign up|join our mailing list|sign up (for|at) (our )?(e-?)?newsletter|visit us online to sign up|e-?book(s)? newsletter/i;

function classify(sections) {
  const kept = [];
  const skipped = [];
  let bodyStarted = false;
  sections.forEach((s, i) => {
    const text = s.paras.join('\n');
    const chars = text.length;
    let reason = null;
    if (s.notice || (NOTICE_RE.test(text) && /bookshare/i.test(text))) reason = 'bookshare-notice';
    else if (s.kind === 'toc') reason = 'contents';
    else if (chars < 12 && !s.title) reason = 'blank';
    else if (chars < 12 && s.title && /^(cover|title page|copyright page|half title|frontispiece)$/i.test(s.title)) reason = 'blank';
    else if (!bodyStarted && chars < 6000 && (CONTENTS_RE.test(s.title) || s.kind === 'toc')) reason = 'contents';
    else if (!bodyStarted && i < 12 && chars < 4000 && COPYRIGHT_RE.test(text) && !/chapter/i.test(s.title)) reason = 'copyright';
    else if (!bodyStarted && PRAISE_RE.test(s.title)) reason = 'front-matter';
    else if (chars < 900 && PUBLISHER_JUNK_RE.test(text)) reason = 'publisher';
    else if (bodyStarted && PRAISE_RE.test(s.title)) reason = 'back-matter';
    if (reason) {
      s.reason = reason;
      if (reason !== 'blank') skipped.push(s);
      return;
    }
    if (chars > 1500 || /^(chapter|part|prologue|book|\d+)\b/i.test(s.title)) bodyStarted = true;
    kept.push(s);
  });
  return { kept, skipped };
}

/* ── the jacket (NLS style) ─────────────────────────────────────────────── */
function listenEstimate(chars) {
  const min = Math.round(chars / CHARS_PER_MINUTE);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` and ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}
function buildJacket(meta, sections, totalChars) {
  const lines = [];
  lines.push(`${meta.title || 'Untitled'}.`);
  if (meta.author) lines.push(`By ${meta.author}.`);
  const pub = meta.sourcePublisher || (meta.publisher && !/bookshare/i.test(meta.publisher) ? meta.publisher : '');
  const year = meta.copyrightYear || '';
  if (pub && year) lines.push(`Published by ${pub}, ${year}.`);
  else if (pub) lines.push(`Published by ${pub}.`);
  else if (year) lines.push(`Copyright ${year}.`);
  if (meta.synopsis) lines.push(squash(meta.synopsis).replace(/([a-z])\.([A-Z])/g, '$1. $2'));
  const chapters = sections.length;
  lines.push(`${chapters} ${chapters === 1 ? 'section' : 'sections'}, about ${listenEstimate(totalChars)} of listening.`);
  if (meta.source === 'bookshare') lines.push('From Bookshare, for people with print disabilities. Please do not pass this book on.');
  return lines.join(' ');
}

/* ── format readers ─────────────────────────────────────────────────────── */
function readOpfMeta(opf) {
  const get = (tag) => {
    const m = opf.match(new RegExp(`<(?:dc:)?${tag}[^>]*>([\\s\\S]*?)</(?:dc:)?${tag}>`, 'i'));
    return m ? squash(decodeEntities(m[1])) : '';
  };
  const metaContent = (name) => {
    const m = opf.match(new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`, 'i')) || opf.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*name="${name}"`, 'i'));
    return m ? squash(decodeEntities(decodeEntities(m[1]))) : '';
  };
  const creators = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((x) => squash(decodeEntities(x[1]))).filter(Boolean);
  const rights = get('rights');
  const yearFrom = (s) => { const m = String(s || '').match(/\b(1[5-9]\d\d|20\d\d)\b/); return m ? m[1] : ''; };
  const bkshId = (opf.match(/Bookshare-(\d+)/i) || [])[1] || '';
  return {
    title: get('title'),
    author: creators.join(', '),
    publisher: get('publisher'),
    sourcePublisher: metaContent('dtb:sourcePublisher'),
    language: (get('language') || 'en').slice(0, 8),
    isbn: (opf.match(/scheme="ISBN"[^>]*>([\d-]+)</i) || opf.match(/urn:isbn:([\d-]+)/i) || [])[1] || '',
    synopsis: metaContent('Synopsis') || get('description'),
    copyrightYear: yearFrom(metaContent('DCTERMS.date.dateCopyrighted')) || yearFrom(rights) || yearFrom(get('date')),
    rights,
    bookshareId: bkshId,
    source: /bookshare/i.test(opf) ? 'bookshare' : 'upload',
  };
}

async function loadZip(buffer) {
  const JSZip = require('jszip');
  return JSZip.loadAsync(buffer);
}
async function zipText(zip, path) {
  const f = zip.file(path) || zip.file(path.replace(/^\.?\//, ''));
  if (!f) return '';
  return f.async('string');
}
function dirOf(p) { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i + 1); }
function joinPath(dir, rel) {
  const parts = (dir + rel).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

async function readDaisy3(zip, names) {
  const opfName = names.find((n) => /\.opf$/i.test(n));
  const opf = opfName ? await zipText(zip, opfName) : '';
  const meta = readOpfMeta(opf);
  meta.format = 'daisy3';
  const xmlName = names.find((n) => /\.xml$/i.test(n) && !/\.(opf|ncx|smil)$/i.test(n) && !/dtd/i.test(n));
  const xml = xmlName ? await zipText(zip, xmlName) : '';
  if (!xml || !/<dtbook/i.test(xml)) throw new Error('This DAISY zip has no dtbook text file inside.');
  if (!meta.title) meta.title = squash(decodeEntities((xml.match(/<doctitle[^>]*>([\s\S]*?)<\/doctitle>/i) || [])[1] || ''));
  if (!meta.author) meta.author = squash(decodeEntities((xml.match(/<docauthor[^>]*>([\s\S]*?)<\/docauthor>/i) || [])[1] || ''));
  const ncxName = names.find((n) => /\.ncx$/i.test(n));
  const titlesById = {};
  if (ncxName) {
    const ncx = await zipText(zip, ncxName);
    for (const np of ncx.matchAll(/<navPoint([^>]*)>\s*<navLabel>\s*<text>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src="[^"#]*#([^"]+)"/gi)) {
      const label = squash(decodeEntities(np[2]));
      const navId = attr(np[1], 'id');
      const targetId = np[3];
      if (!label) continue;
      // the navPoint id usually equals the level id; the content target is the
      // heading/paragraph id inside it. Register both; whichever opens first wins.
      if (navId && !titlesById[navId]) titlesById[navId] = label;
      if (targetId && !titlesById[targetId]) titlesById[targetId] = label;
    }
  }
  const sections = walkMarkup(xml, [], { titlesById });
  return { meta, sections };
}

async function readDaisy2(zip, names) {
  const ncc = names.find((n) => /(^|\/)ncc\.html?$/i.test(n));
  const nccHtml = await zipText(zip, ncc);
  const metaContent = (name) => (nccHtml.match(new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`, 'i')) || [])[1] || '';
  const meta = {
    title: squash(decodeEntities(metaContent('dc:title') || (nccHtml.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '')),
    author: squash(decodeEntities(metaContent('dc:creator'))),
    publisher: squash(decodeEntities(metaContent('dc:publisher'))),
    synopsis: '', copyrightYear: (metaContent('dc:date').match(/\d{4}/) || [])[0] || '', language: 'en',
    source: /bookshare/i.test(nccHtml) ? 'bookshare' : 'upload', format: 'daisy2',
  };
  const dir = dirOf(ncc);
  const hrefs = [...nccHtml.matchAll(/<a[^>]*href="([^"#]+)(#[^"]*)?"/gi)].map((x) => joinPath(dir, x[1]));
  const seen = new Set();
  const sections = [];
  for (const h of hrefs) {
    if (seen.has(h) || !/\.x?html?$/i.test(h)) continue;
    seen.add(h);
    const html = await zipText(zip, h);
    if (html) walkMarkup(html, sections);
  }
  if (!sections.length) throw new Error('This DAISY 2 zip has no readable text pages.');
  return { meta, sections };
}

async function readEpub(zip) {
  const container = await zipText(zip, 'META-INF/container.xml');
  const opfPath = (container.match(/full-path="([^"]+)"/i) || [])[1] || Object.keys(zip.files).find((n) => /\.opf$/i.test(n));
  if (!opfPath) throw new Error('This EPUB has no package file inside.');
  const opf = await zipText(zip, opfPath);
  const meta = readOpfMeta(opf);
  meta.format = 'epub';
  const dir = dirOf(opfPath);
  const items = {};
  for (const it of opf.matchAll(/<item\b([^>]*)>/gi)) {
    const id = attr(it[0], 'id');
    const href = attr(it[0], 'href');
    const type = attr(it[0], 'media-type');
    if (id && href) items[id] = { href: joinPath(dir, decodeURIComponent(href)), type };
  }
  const spine = [...opf.matchAll(/<itemref\b([^>]*)>/gi)].map((x) => attr(x[0], 'idref')).filter((id) => items[id]);
  // titles from the nav document / NCX, keyed by file
  const titlesByFile = {};
  const navItem = Object.values(items).find((i) => /nav/.test(attr(opf, 'properties')) && /xhtml/.test(i.type)) || null;
  const ncxItem = Object.values(items).find((i) => /ncx/i.test(i.type));
  if (ncxItem) {
    const ncx = await zipText(zip, ncxItem.href);
    for (const np of ncx.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src="([^"#]+)/gi)) {
      const f = joinPath(dirOf(ncxItem.href), decodeURIComponent(np[2]));
      if (!titlesByFile[f]) titlesByFile[f] = squash(decodeEntities(np[1]));
    }
  }
  if (navItem) {
    const nav = await zipText(zip, navItem.href);
    for (const a of nav.matchAll(/<a[^>]*href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const f = joinPath(dirOf(navItem.href), decodeURIComponent(a[1]));
      if (!titlesByFile[f]) titlesByFile[f] = squash(decodeEntities(a[2].replace(/<[^>]+>/g, '')));
    }
  }
  const sections = [];
  for (const id of spine) {
    const it = items[id];
    if (!/html|xml/i.test(it.type)) continue;
    const html = await zipText(zip, it.href);
    if (!html) continue;
    const before = sections.length;
    const bodyOnly = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1];
    walkMarkup(bodyOnly, sections);
    if (sections.length > before && !sections[before].title && titlesByFile[it.href]) sections[before].title = titlesByFile[it.href];
  }
  if (!sections.length) throw new Error('This EPUB has no readable text.');
  return { meta, sections };
}

function readPlainText(text, filename) {
  const title = String(filename || 'Untitled').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const meta = { title, author: '', publisher: '', synopsis: '', copyrightYear: '', language: 'en', source: 'upload', format: 'txt' };
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n/).map(squash).filter(Boolean);
  // headings: short lines that look like "Chapter N" / ALL CAPS start a section
  const sections = [];
  let cur = { title: '', paras: [], kind: 'section', notice: false, ids: [] };
  sections.push(cur);
  for (const p of paras) {
    if (p.length < 80 && (/^(chapter|part|book|prologue|epilogue)\b/i.test(p) || (p === p.toUpperCase() && /[A-Z]/.test(p) && p.split(' ').length <= 8))) {
      if (cur.paras.length === 0 && !cur.title) cur.title = p;
      else { cur = { title: p, paras: [], kind: 'section', notice: false, ids: [] }; sections.push(cur); }
    } else cur.paras.push(p);
  }
  // a Bookshare notice pasted into a txt export
  const first = sections[0];
  if (first && NOTICE_RE.test(first.paras.join('\n'))) first.notice = true;
  return { meta, sections };
}

/* ── entry point ────────────────────────────────────────────────────────── */
async function parseBook(buffer, filename = '') {
  const name = String(filename || '').toLowerCase();
  const head = buffer.slice(0, 4).toString('binary');
  let parsed;
  if (head.startsWith('PK')) {
    const zip = await loadZip(buffer);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    if (names.some((n) => /^META-INF\/container\.xml$/i.test(n)) || /\.epub$/.test(name)) parsed = await readEpub(zip);
    else if (names.some((n) => /(^|\/)ncc\.html?$/i.test(n))) parsed = await readDaisy2(zip, names);
    else if (names.some((n) => /\.opf$/i.test(n)) || names.some((n) => /\.xml$/i.test(n))) {
      if (/\.docx$/.test(name) || names.some((n) => /^word\/document\.xml$/i.test(n))) parsed = await readDocx(buffer, filename);
      else parsed = await readDaisy3(zip, names);
    } else if (names.some((n) => /^word\/document\.xml$/i.test(n))) parsed = await readDocx(buffer, filename);
    else throw new Error('That zip does not look like a DAISY book or an EPUB.');
  } else if (/\.docx$/.test(name)) {
    parsed = await readDocx(buffer, filename);
  } else if (/<(html|dtbook|body)\b/i.test(buffer.slice(0, 4000).toString('utf8'))) {
    const text = buffer.toString('utf8');
    const sections = walkMarkup((text.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, text])[1], []);
    const title = squash(decodeEntities((text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || String(filename).replace(/\.[^.]+$/, '')));
    parsed = { meta: { title, author: '', publisher: '', synopsis: '', copyrightYear: '', language: 'en', source: 'upload', format: 'html' }, sections };
  } else {
    parsed = readPlainText(buffer.toString('utf8').replace(/^﻿/, ''), filename);
  }
  return finish(parsed);
}

async function readDocx(buffer, filename) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ buffer });
  const sections = walkMarkup(r.value || '', []);
  const title = String(filename || 'Untitled').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return { meta: { title, author: '', publisher: '', synopsis: '', copyrightYear: '', language: 'en', source: 'upload', format: 'docx' }, sections };
}

/** Tidy the raw sections before classification:
 *   - an untitled section whose first line looks like a heading (short, no
 *     sentence punctuation, or "Chapter 3" / "1 Kyle") takes it as its title;
 *   - a TINY untitled fragment (a stanza, a stray paragraph in its own level)
 *     joins the section before it; a big untitled one becomes "Part N" so a
 *     book with no real headings still has chapters to jump between;
 *   - a number-only heading with next to nothing under it ("1", "PART TWO")
 *     folds into the heading that follows ("1: The One and Only Kanye"). */
const HEADING_LINE_RE = /^(chapter|part|book|section|prologue|epilogue|interlude|act|scene)\b|^[\divxlc]+([.:\-–—]|\s+[A-Z])/i;
/** "3", "XII", "Chapter 1", "PART TWO" — a number heading with next to nothing
 * under it, folded into the title that follows. A heading with NOTHING under
 * it at all ("Chapter One" then "The Wrong Door" in the next paragraph class,
 * the Narnia shape) folds whatever its words are — see mergeFragments. */
const NUMBER_TITLE_RE = /^(chapter|part|book|section)?\s*[\divxlc]+\.?$/i;
const joinTitles = (a, b) => (String(a).trim().toLowerCase() === String(b).trim().toLowerCase() ? a : a + ': ' + b);
/** A heading that names a slot rather than a thing ("Chapter One", "Part
 * Two", "Introduction", "Prologue"): empty, it folds into the next title.
 * A dedication ("To Lucy Barfield") or a book title stays its own section. */
const LABEL_TITLE_RE = /^(chapter|part|book|section|introduction|prologue|epilogue|interlude|act|scene|volume)\b/i;
function looksLikeHeadingLine(t) {
  if (!t || t.length > 70) return false;
  if (HEADING_LINE_RE.test(t)) return true;
  return !/[.!?,;:]["'”’)]?$/.test(t) && t.split(' ').length <= 9;
}
function mergeFragments(sections) {
  const out = [];
  let pendingNumber = null;
  let untitledCount = 0;
  for (const s of sections) {
    // the notice and a contents list pass straight through; a pending
    // heading waits for the next real section on the other side of them
    if (s.notice || s.kind === 'toc') { out.push(s); continue; }
    if (!s.title) {
      const chars = s.paras.join(' ').length;
      const first = s.paras[0] || '';
      if (s.paras.length > 1 && looksLikeHeadingLine(first) && chars > first.length + 200) {
        s.title = first;
        s.paras = s.paras.slice(1);
      } else if (chars < 600 && out.length && !out[out.length - 1].notice) {
        out[out.length - 1].paras.push(...s.paras);
        continue;
      } else if (chars >= 600) {
        untitledCount++;
        s.title = `Part ${untitledCount}`;
        s.untitled = true;
      } else if (chars === 0) {
        continue; // an empty level (cover, title page image) — nothing to keep
      }
      // else: a small untitled piece right after the notice — kept as its own section
    }
    const numberOnly = s.title && s.paras.join(' ').length < 200 && NUMBER_TITLE_RE.test(s.title);
    const labelOnly = s.title && s.paras.length === 0 && LABEL_TITLE_RE.test(s.title);
    if (numberOnly || labelOnly) {
      pendingNumber = pendingNumber ? { title: joinTitles(pendingNumber.title, s.title), paras: pendingNumber.paras.concat(s.paras) } : { title: s.title, paras: s.paras.slice() };
      continue;
    }
    if (pendingNumber && s.title && s.paras.length === 0) {
      // a bare dedication or book title between the label and its chapter:
      // the label stands on its own rather than swallowing it
      out.push({ title: pendingNumber.title, paras: pendingNumber.paras, kind: 'section', notice: false, ids: [] });
      pendingNumber = null;
    }
    if (pendingNumber) {
      s.title = s.title ? joinTitles(pendingNumber.title, s.title) : pendingNumber.title;
      s.paras = pendingNumber.paras.concat(s.paras);
      pendingNumber = null;
    }
    out.push(s);
  }
  if (pendingNumber) out.push({ title: pendingNumber.title, paras: pendingNumber.paras, kind: 'section', notice: false, ids: [] });
  return out;
}

function finish({ meta, sections }) {
  const { kept, skipped } = classify(mergeFragments(sections));
  const outSections = kept.map((s) => {
    const chunks = chunkParagraphs(s.paras);
    const title = s.title || '';
    // the heading is spoken first, as its own chunk, unless the text opens with it
    if (title && !(chunks[0] || '').toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) chunks.unshift(title.replace(/\s*\.?$/, '.'));
    return { title: title || (chunks[0] ? chunks[0].slice(0, 60) : 'Untitled section'), chunks, chars: chunks.reduce((n, c) => n + c.length, 0), kind: s.kind };
  }).filter((s) => s.chunks.length);
  const totalChars = outSections.reduce((n, s) => n + s.chars, 0);
  const jacket = buildJacket(meta, outSections, totalChars);
  const jacketChunks = chunkParagraphs(jacket.split(/(?<=[.!?])\s+(?=[A-Z0-9])/));
  const skippedOut = skipped.map((s) => ({ title: s.title || (s.reason === 'bookshare-notice' ? 'Bookshare notice' : 'Untitled'), reason: s.reason, chunks: chunkParagraphs(s.paras), chars: s.paras.join(' ').length }));
  return {
    meta,
    jacket,
    sections: [{ title: 'About this book', chunks: jacketChunks, chars: jacket.length, kind: 'jacket' }, ...outSections],
    skipped: skippedOut,
    stats: { sections: outSections.length, chunks: outSections.reduce((n, s) => n + s.chunks.length, 0), chars: totalChars, listen: listenEstimate(totalChars), skipped: skippedOut.map((s) => s.reason) },
  };
}

module.exports = {
  parseBook,
  walkMarkup,
  chunkParagraphs,
  splitSentences,
  classify,
  buildJacket,
  readOpfMeta,
  listenEstimate,
  CHUNK_TARGET,
  PARSER_VERSION,
  _internals: { decodeEntities, squash, hardSplit, NOTICE_RE, COPYRIGHT_RE },
};
