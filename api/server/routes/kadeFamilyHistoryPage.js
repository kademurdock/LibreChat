/* ----------------------------------------------------------------------------
 * FAMILY HISTORY, THE PAGE (Sep 29 2026). Contract: docs/FAMILY_HISTORY.md.
 *
 * A server-rendered shell in the kade-pages look (SHARED_HEAD). It carries no
 * family data at all: the script (client/public/assets/family/history.js)
 * signs in with getToken(), asks /api/kade/family-history/me whether this
 * account is family, and draws every section from the API. Everything that
 * moves or draws lives in the asset file, so no page script sits inside this
 * template literal (no doubled backslashes to get wrong).
 *
 * SCREEN-READER SHAPE: one h1; each view has its own h2, which takes focus
 * when you move between views; one role="status" region for loading and
 * errors; the tree chart has a full text version under it.
 * -------------------------------------------------------------------------- */
const { SHARED_HEAD } = require('./kadePages');

const ASSET_VERSION = '20260929a';

const familyHistoryHtml = `<!doctype html><html lang="en"><head><title>Family history — Kade-AI</title>${SHARED_HEAD}
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/assets/family/history.css?v=${ASSET_VERSION}">
</head>
<body class="fh-page">
<main id="fh-main">
<a class="back" href="/home">&larr; Home</a>
<h1 id="fh-title">Our family history</h1>
<nav class="fh-nav" id="fh-nav" aria-label="Family history sections" hidden>
  <a href="#/" data-route="">Start</a>
  <a href="#/tree" data-route="tree">Family tree</a>
  <a href="#/people" data-route="people">People</a>
  <a href="#/stories" data-route="stories">Stories</a>
  <a href="#/findings" data-route="findings">Research findings</a>
</nav>
<p id="fh-status" class="fh-status" role="status" aria-live="polite">Checking that this account is family…</p>
<div id="fh-view" class="fh-view"></div>
<noscript><p class="status err">The family history needs JavaScript turned on.</p></noscript>
</main>
<footer class="muted">&mdash; &copy; 2026 Kade Murdock &middot; Kade-AI &middot; Private to the family</footer>
<script src="/assets/family/history.js?v=${ASSET_VERSION}" defer></script>
</body></html>`;

module.exports = {
  familyHistoryHtml,
  ASSET_VERSION,
  page: (_req, res) => res.type('html').send(familyHistoryHtml),
};
