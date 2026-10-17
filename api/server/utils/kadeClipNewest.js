/**
 * KADE Oct 16 2026 — clip a formatted memory list from the OLD end.
 *
 * getFormattedMemories numbers cards oldest first, and three places cut that
 * text with `.slice(0, max)`: the character's canon (4,000 characters) and the
 * phone call's memory (6,000). A slice from the front keeps the oldest cards and
 * drops the newest, so a character with a long canon stopped hearing whatever
 * it said about itself most recently, and a call forgot the newest things a
 * person had shared. This keeps every section header and removes the oldest
 * entries of the longest section until the text fits.
 *
 * The text shape it reads: optional "# Header" lines, entries separated by a
 * blank line, each entry opening "N. [date]. ...". Anything it cannot parse is
 * cut from the front instead, which is still newest-kept.
 */

const ENTRY = /^\d+\.\s/;

function parseSections(text) {
  const sections = [];
  let current = null;
  for (const block of String(text).split('\n\n')) {
    let body = block;
    if (body.startsWith('# ')) {
      const nl = body.indexOf('\n');
      const header = nl === -1 ? body : body.slice(0, nl);
      body = nl === -1 ? '' : body.slice(nl + 1);
      current = { header, entries: [] };
      sections.push(current);
    }
    if (!current) {
      current = { header: '', entries: [] };
      sections.push(current);
    }
    if (!body) {
      continue;
    }
    if (ENTRY.test(body) || current.entries.length === 0) {
      current.entries.push(body);
    } else {
      /* A blank line inside one card: keep it with the card it belongs to. */
      current.entries[current.entries.length - 1] += `\n\n${body}`;
    }
  }
  return sections;
}

function render(sections, note) {
  const out = sections
    .filter((s) => s.header || s.entries.length)
    .map((s) => {
      const body = (s.dropped ? [note, ...s.entries] : s.entries).join('\n\n');
      return s.header ? (body ? `${s.header}\n${body}` : s.header) : body;
    })
    .join('\n\n');
  return out;
}

/**
 * @param {string} text formatted memory text
 * @param {number} max character budget
 * @param {string} [note] line placed where entries were removed
 * @returns {string}
 */
function clipKeepNewest(text, max, note = '(older entries left out to fit)') {
  const s = String(text || '');
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) {
    return s;
  }
  const sections = parseSections(s);
  let rendered = render(sections, note);
  let guard = 0;
  while (rendered.length > max && guard < 10000) {
    guard += 1;
    let longest = null;
    for (const section of sections) {
      if (section.entries.length > 1 && (!longest || section.entries.join('').length > longest.entries.join('').length)) {
        longest = section;
      }
    }
    if (!longest) {
      break;
    }
    longest.entries.shift();
    longest.dropped = true;
    rendered = render(sections, note);
  }
  if (rendered.length > max) {
    /* One giant entry or unparsed text: keep the end, which is the newest. */
    rendered = `${note}\n${rendered.slice(rendered.length - max + note.length + 1)}`;
  }
  return rendered;
}

module.exports = { clipKeepNewest };
