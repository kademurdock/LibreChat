/* REVERIE LIFE — the verb registry and parser (Sep 6 2026).
 *
 * The old engine is one 2,300-line if-chain. Every new verb there costs a
 * scroll and a prayer. Here a verb is a record: names, a handler, a help
 * entry, and an optional `when` guard that says whether it makes sense right
 * now (which is also what puts it on the button bar). The parser tries, in
 * order: an exact verb or alias on the first word(s) — longest name wins, so
 * "move in" beats "move"; then regex verbs; then a unique prefix of three or
 * more letters ("inven" → inventory); then it hands the command to the old
 * engine, which still knows a hundred things. Only if THAT shrugs do we say
 * "did you mean". */

const verbs = [];
const byName = new Map();

/** register({ name, aliases, pattern, help:{topic, usage, blurb}, free, when, hidden, run }) */
function register(def) {
  if (!def || !def.name || typeof def.run !== 'function') throw new Error('bad verb def');
  const v = { aliases: [], free: false, hidden: false, ...def };
  verbs.push(v);
  for (const n of [v.name, ...v.aliases]) byName.set(n.toLowerCase(), v);
  return v;
}

/** Every verb name/alias sorted longest first, so multiword names match before their first word. */
let sortedNames = null;
function names() {
  if (!sortedNames || sortedNames.length !== byName.size) sortedNames = [...byName.keys()].sort((a, b) => b.length - a.length);
  return sortedNames;
}

/** Returns { verb, verbName, arg, argRaw } or null. `raw` keeps case for content. */
function resolve(raw) {
  const lower = raw.toLowerCase();
  for (const n of names()) {
    if (lower === n || lower.startsWith(n + ' ')) {
      return { verb: byName.get(n), verbName: n, arg: lower.slice(n.length).trim(), argRaw: raw.slice(n.length).trim() };
    }
  }
  for (const v of verbs) {
    if (v.pattern && v.pattern.test(raw)) {
      const m = v.pattern.exec(raw);
      return { verb: v, verbName: v.name, arg: lower, argRaw: raw, match: m };
    }
  }
  return null;
}

/** Unique-prefix completion for a typo'd first word: "inven" → "inventory". */
function complete(firstWord) {
  const w = firstWord.toLowerCase();
  if (w.length < 3) return null;
  const hits = [...new Set([...byName.keys()].filter((n) => !n.includes(' ') && n.startsWith(w)).map((n) => byName.get(n).name))];
  return hits.length === 1 ? hits[0] : null;
}

/** "Did you mean" — cheap edit distance over verb names. */
function suggest(firstWord, limit = 3) {
  const w = firstWord.toLowerCase();
  const scored = [];
  for (const n of byName.keys()) {
    if (n.includes(' ')) continue;
    const d = lev(w, n);
    if (d <= Math.max(1, Math.floor(n.length / 3))) scored.push([d, n]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return [...new Set(scored.map((s) => byName.get(s[1]).name))].slice(0, limit);
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function all() { return verbs.slice(); }
function get(name) { return byName.get(String(name).toLowerCase()) || null; }

module.exports = { register, resolve, complete, suggest, all, get };
