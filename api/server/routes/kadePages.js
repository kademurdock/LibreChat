/* Self-contained HTML for the usage dashboard + "Usage & Balance" page (renamed from "Feed the Server", July 16 2026).
 * No server-side auth: client JS fetches a token from /api/auth/refresh (the
 * same httpOnly refresh-cookie flow the SPA uses on boot), then calls the
 * gated /api/kade APIs. Fully static — no server-side interpolation. */

const SHARED_HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    /* KADE: safe-area padding keeps these pages clear of the iOS clock and
       home indicator when opened inside the standalone PWA (same bug family
       as the chat header clock overlap) */
    padding: calc(1.25rem + env(safe-area-inset-top, 0px)) 1.25rem calc(1.25rem + env(safe-area-inset-bottom, 0px));
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5; color: #16181d; background: #f6f7f9;
    max-width: 880px; margin-left: auto; margin-right: auto;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e7e9ee; background: #14161a; }
    .card { background: #1e2127 !important; border-color: #2c2f37 !important; }
    a.btn { background: #1f7a49 !important; }
    th { background: #24272f !important; }
    tr:nth-child(even) td { background: #1b1e24 !important; }
  }
  @media (prefers-contrast: more) {
    .muted { opacity: 1; }
    .card { border-width: 2px; }
    nav.kadetabs a { color: #3a4150; }
  }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; }
  .muted { opacity: .75; }
  .card {
    background: #fff; border: 1px solid #e3e6ea; border-radius: 14px;
    padding: 1.1rem 1.2rem; margin: 1rem 0;
  }
  .big { font-size: 2.6rem; font-weight: 700; line-height: 1.1; margin: .2rem 0; }
  a.btn {
    display: inline-block; background: #1f7a49; color: #fff; text-decoration: none;
    font-weight: 600; padding: .8rem 1.3rem; border-radius: 10px; margin-top: .6rem;
  }
  a.btn:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; font-size: .95rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #e3e6ea; }
  th { background: #eef1f4; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .status { padding: .75rem 1rem; border-radius: 10px; background: #fff6da; color: #6b5500; }
  .err { background: #ffe3e3; color: #8a1f1f; }
  dl.kv { display: grid; grid-template-columns: auto 1fr; gap: .35rem 1rem; margin: .5rem 0 0; }
  dl.kv dt { opacity: .8; }
  dl.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 2rem; font-size: .85rem; }
  a.back { display:inline-block; margin:0 0 .25rem; font-weight:600; text-decoration:none; color:#1d55d0; }
  a.back:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  body { padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px)) !important; }
  nav.kadetabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; background: #ffffff; border-top: 1px solid #d9dde3; padding-bottom: env(safe-area-inset-bottom, 0px); box-shadow: 0 -2px 10px rgba(0,0,0,.06); }
  nav.kadetabs a { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 8px 4px 10px; min-height: 56px; text-decoration: none; color: #5b6270; font-size: .78rem; font-weight: 600; }
  nav.kadetabs a .ic { font-size: 1.45rem; line-height: 1; }
  nav.kadetabs a[aria-current="page"] { color: #1d55d0; }
  nav.kadetabs a:focus-visible { outline: 3px solid #ffbf47; outline-offset: -3px; }
  nav.hublist { display: grid; gap: .6rem; margin-top: 1rem; }
  a.hubitem { display: flex; align-items: center; gap: .9rem; background: #fff; border: 1px solid #e3e6ea; border-radius: 14px; padding: 1rem 1.1rem; text-decoration: none; color: inherit; }
  a.hubitem:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  a.hubitem .hicon { font-size: 1.6rem; line-height: 1; flex: none; }
  a.hubitem strong { display: block; font-size: 1.08rem; }
  a.hubitem small { display: block; opacity: .7; font-size: .88rem; margin-top: .1rem; }
  @media (prefers-color-scheme: dark) {
    nav.kadetabs { background: #1a1d23; border-top-color: #2c2f37; }
    nav.kadetabs a { color: #9aa3b5; }
    nav.kadetabs a[aria-current="page"] { color: #6ea8ff; }
    a.hubitem { background:#1e2127; border-color:#2c2f37; }
  }
  /* KADE session 22 polish (July 21 2026): micro-interactions + gentle
     entrances for sighted eyes. Every rule that MOVES lives inside
     prefers-reduced-motion: no-preference, so reduced-motion users get the
     exact static page that shipped before this block existed. The AA
     palette from the July 21 contrast pass is untouched; hover cues that
     are pure color/shadow (not motion) apply everywhere. */
  nav.kadetabs a { border-top: 3px solid transparent; }
  nav.kadetabs a[aria-current="page"] { border-top-color: #1d55d0; }
  a.btn:hover { box-shadow: 0 3px 10px rgba(0,0,0,.22); }
  a.hubitem:hover { border-color: #1d55d0; box-shadow: 0 2px 8px rgba(0,0,0,.10); }
  @media (prefers-color-scheme: dark) {
    nav.kadetabs a[aria-current="page"] { border-top-color: #6ea8ff; }
    a.hubitem:hover { border-color: #6ea8ff; }
  }
  @media (prefers-contrast: more) {
    a.btn:hover, a.hubitem:hover { box-shadow: none; }
  }
  @media (prefers-reduced-motion: no-preference) {
    a.btn, a.hubitem, nav.kadetabs a, a.back {
      transition: transform .15s ease, box-shadow .2s ease, border-color .15s ease;
    }
    a.btn:hover, a.hubitem:hover { transform: translateY(-1px); }
    a.btn:active, a.hubitem:active, nav.kadetabs a:active { transform: scale(.985); }
    @keyframes kadeRise {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: none; }
    }
    .card, a.hubitem { animation: kadeRise .28s ease-out both; }
    .card:nth-of-type(2), nav.hublist a.hubitem:nth-child(2) { animation-delay: .05s; }
    .card:nth-of-type(3), nav.hublist a.hubitem:nth-child(3) { animation-delay: .1s; }
    .card:nth-of-type(n+4), nav.hublist a.hubitem:nth-child(n+4) { animation-delay: .14s; }
  }
</style>
<script>
  function money(n){ n = Number(n)||0; if(n>0 && n<0.01){ return '$'+n.toFixed(4); } return '$'+n.toFixed(2); }
  /* ~1,000 characters of text ~= one minute of spoken audio. */
  function listenTime(chars){ var m = Math.round((Number(chars)||0)/1000); if(m < 1){ return 'under a minute'; } if(m < 120){ return m + ' minutes'; } return (Math.round(m/6)/10) + ' hours'; }
  function num(n){ return (Number(n)||0).toLocaleString('en-US'); }
  async function getToken(){
    try{
      const r = await fetch('/api/auth/refresh', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:'{}'});
      if(!r.ok) return null;
      const j = await r.json();
      return j && j.token ? j.token : null;
    }catch(e){ return null; }
  }
  async function apiGet(path, token){
    const r = await fetch(path, {headers:{'Authorization':'Bearer '+token}});
    return r;
  }
  const _dlCache = {};
  function isIOS(){
    return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  async function fetchAssetBlob(id, kind, token){
    const r = await fetch('/api/kade/asset-download/' + id, {headers:{'Authorization':'Bearer '+token}});
    if(!r.ok){ throw new Error('HTTP '+r.status); }
    const disp = r.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="([^"]+)"/);
    const name = m ? m[1] : ('kade-ai-' + kind + (kind === 'video' ? '.mp4' : '.png'));
    const blob = await r.blob();
    return { blob: blob, name: name };
  }
  /* iPhone/iPad: downloads don't land in a Downloads folder like desktop —
   * the native SHARE SHEET is how media gets saved (Save Video → Photos).
   * navigator.share must run on a fresh tap, so iOS is a two-tap flow:
   * tap 1 fetches ("Getting your video…"), tap 2 opens the share sheet. */
  async function downloadAsset(id, kind, btn, statusEl, token){
    const prev = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', prev);
    if(isIOS()){
      const cached = _dlCache[id];
      if(cached){
        try{
          const file = new File([cached.blob], cached.name, { type: cached.blob.type || (kind === 'video' ? 'video/mp4' : 'image/png') });
          if(navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share){
            await navigator.share({ files: [file] });
            if(statusEl){ statusEl.textContent = 'Share sheet opened — choose Save ' + (kind === 'video' ? 'Video' : 'Image') + ' to keep it in your Photos.'; }
          } else {
            const url = URL.createObjectURL(cached.blob);
            window.open(url, '_blank');
            if(statusEl){ statusEl.textContent = 'Opened in a new tab — use the share button there to save it.'; }
          }
        }catch(e){
          if(statusEl && e && e.name !== 'AbortError'){ statusEl.textContent = 'Could not open the share sheet — try tapping Save again.'; }
        }
        return;
      }
      btn.disabled = true; btn.textContent = 'Getting your ' + kind + '…';
      if(statusEl){ statusEl.textContent = 'Getting your ' + kind + ' ready — one moment…'; }
      try{
        _dlCache[id] = await fetchAssetBlob(id, kind, token);
        btn.textContent = 'Save to device';
        btn.setAttribute('aria-label', 'Ready! Tap again to open the share sheet and save this ' + kind);
        if(statusEl){ statusEl.textContent = 'Ready! Tap "Save to device" to open the share sheet, then choose Save ' + (kind === 'video' ? 'Video' : 'Image') + '.'; }
      }catch(e){
        btn.textContent = prev;
        if(statusEl){ statusEl.textContent = 'Download failed — try again in a moment.'; }
      }
      btn.disabled = false;
      return;
    }
    btn.disabled = true; btn.textContent = 'Downloading…';
    if(statusEl){ statusEl.textContent = 'Downloading your ' + kind + ' — hang tight…'; }
    try{
      const got = await fetchAssetBlob(id, kind, token);
      const url = URL.createObjectURL(got.blob);
      const a = document.createElement('a');
      a.href = url; a.download = got.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
      if(statusEl){ statusEl.textContent = 'Downloaded! Check your files for ' + got.name + '.'; }
    }catch(e){
      if(statusEl){ statusEl.textContent = 'Download failed — try again in a moment.'; }
    }
    btn.disabled = false; btn.textContent = prev;
  }
  async function apiPost(path, token, body){
    const r = await fetch(path, {method:'POST', headers:{'Authorization':'Bearer '+token, 'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
    return r;
  }
  (function(){
    function kadeBuildTabs(){
      if (document.querySelector('nav.kadetabs')) return;
      if (!document.body) return;
      var path = location.pathname;
      if (path.length > 1 && path.charAt(path.length-1) === '/') path = path.slice(0, -1);
      if (!path) path = '/';
      var toolPages = ['/tools','/describe','/transcribe','/spotter','/debate-room','/conversation-hall','/game-room','/matchmaker','/wall-of-fame','/my-creations','/calls'];
      var youPages = ['/you','/feed-the-server','/usage-dashboard','/feedback-dashboard','/pronunciation-dictionary'];
      var active = 'chats';
      if (path === '/notifications') active = 'alerts';
      else if (youPages.indexOf(path) !== -1) active = 'you';
      else if (toolPages.indexOf(path) !== -1) active = 'tools';
      else if (path === '/') active = 'chats';
      else active = 'tools';
      /* Part 116.3: Home first -- it carries the whole map in the iPhone app's order; Tools lives inside it. */
      if (path === '/home' || path === '/conversations' || path === '/announcements') active = 'home';
      else if (active === 'tools') active = 'home';
      var items = [['home','/home','Home','🏠'],['chats','/','Chats','💬'],['alerts','/notifications','Alerts','🔔'],['you','/you','You','👤']];
      var nav = document.createElement('nav');
      nav.className = 'kadetabs';
      nav.setAttribute('aria-label','Main navigation');
      for (var i=0;i<items.length;i++){
        var it = items[i];
        var a = document.createElement('a');
        a.href = it[1];
        var ic = document.createElement('span'); ic.className='ic'; ic.setAttribute('aria-hidden','true'); ic.textContent = it[3];
        var tx = document.createElement('span'); tx.textContent = it[2];
        a.appendChild(ic); a.appendChild(tx);
        if (it[0] === active) { a.setAttribute('aria-current','page'); }
        nav.appendChild(a);
      }
      document.body.appendChild(nav);
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', kadeBuildTabs); } else { kadeBuildTabs(); }
  })();
</script>`;

const feedHtml = `<!doctype html><html lang="en"><head><title>Usage & Balance</title>${SHARED_HEAD}</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a></p>
  <h1>Usage &amp; Balance</h1>
  <p class="muted">The deal, plainly: your account starts with <strong>$10 of credit</strong> loaded by Kade, everything you do draws from it at exactly what it costs (no markup, no profit), and when it runs dry you top it up below and keep going. <strong>Voice is the exception: talking and listening are included free with Kade's own voice plan</strong> &mdash; they never touch your balance.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading your usage…</div>

  <main id="content" hidden>
    <div class="card" aria-labelledby="tabhead">
      <h2 id="tabhead" style="margin-top:0">Your balance</h2>
      <div class="big" id="suggested" aria-live="polite">$0.00</div>
      <p class="muted" id="tabnote">That's what you have left to spend. Chat barely touches it — pictures, phone calls, and video draw it down faster.</p>
      <a class="btn" id="donate" href="#" target="_blank" rel="noopener">Top up via PayPal</a>
      <p class="muted" style="font-size:.85rem;margin-top:.6rem">Any amount works. <strong>Put your name in the PayPal note</strong> so Kade knows whose balance to load — it's added to your account, usually the same day.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">This <span id="monthLabel">month</span>, broken down</h2>
      <dl class="kv">
        <dt>Chat (the AI thinking)</dt><dd id="m_llm">$0.00</dd>
        <dt>Voice / read-aloud</dt><dd id="m_tts">Included</dd>
        <dt>Image generation</dt><dd id="m_flux">$0.00</dd>
        <dt>Web searches</dt><dd id="m_tav">$0.00</dd>
        <dt>Phone calls</dt><dd id="m_phone">$0.00</dd>
        <dt>Video &amp; design lab</dt><dd id="m_other">$0.00</dd>
        <dt><strong>Total this month</strong></dt><dd id="m_total"><strong>$0.00</strong></dd>
      </dl>
    </div>

    <p><a class="back" href="/my-creations" aria-label="See your generated videos and images on the My Creations page">See everything you've made &rarr; My Creations</a></p>

    <div class="card">
      <h2 style="margin-top:0">For the curious</h2>
      <dl class="kv">
        <dt>All-time total you've used</dt><dd id="a_total">$0.00</dd>
      </dl>
      <p class="muted" id="qty" style="margin-top:.6rem;font-size:.9rem"></p>
    </div>
  </main>

  <footer class="muted">Numbers refresh every time you open this page. Thanks for being here. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      let token = null; try { token = await getToken(); } catch(e) {}
      if(!token){
        status.className = 'status err';
        status.textContent = 'Please sign in at the chat site first, then reload this page.';
        return;
      }
      let r; try { r = await apiGet('/api/kade/my-usage', token); } catch(e) { status.className='status err'; status.textContent='Could not reach the server. Check your connection and reload.'; return; }
      if(!r.ok){
        status.className = 'status err';
        status.textContent = 'Could not load your usage right now. Try reloading in a moment.';
        return;
      }
      const d = await r.json();
      document.getElementById('monthLabel').textContent = d.monthLabel || 'month';
      document.getElementById('suggested').textContent = money(d.balanceUSD);
      document.getElementById('suggested').setAttribute('aria-label', 'Balance remaining ' + money(d.balanceUSD));
      const dn = document.getElementById('donate');
      dn.href = d.paypal;
      dn.setAttribute('aria-label', 'Top up via PayPal, opens in a new tab');
      const m = d.monthToDate || {};
      document.getElementById('m_llm').textContent = money(m.llmUSD);
      /* Voice is included with Kade's plan (July 21 2026). Show real minutes
         instead of a confusing $0.00; if an older charge from earlier in the
         month exists, show it honestly alongside. */
      var ttsLabel = 'Included' + (m.tts_chars > 0 ? ' \u00b7 ~' + listenTime(m.tts_chars) : '');
      if (m.ttsUSD > 0) { ttsLabel += ' (' + money(m.ttsUSD) + ' charged earlier this month, before voice went free)'; }
      document.getElementById('m_tts').textContent = ttsLabel;
      document.getElementById('m_flux').textContent = money(m.fluxUSD);
      document.getElementById('m_tav').textContent = money(m.tavilyUSD);
      document.getElementById('m_phone').textContent = money(m.phoneUSD);
      document.getElementById('m_other').textContent = money(m.otherUSD);
      document.getElementById('m_total').innerHTML = '<strong>'+money(m.totalUSD)+'</strong>';
      document.getElementById('a_total').textContent = money((d.allTime||{}).totalUSD);
      const a = d.allTime || {};
      document.getElementById('qty').textContent =
        'All time, you have used about ' + num(a.tts_chars) + ' characters of voice (roughly ' + listenTime(a.tts_chars) + ' of listening \u2014 included free with Kade\u0027s voice plan), ' +
        num(a.flux_images) + ' generated images, ' + num(a.tavily_searches) + ' web searches, and ' +
        num(a.phone_minutes) + ' minutes of phone calls.';
      status.hidden = true;
      document.getElementById('content').hidden = false;
    })();
  </script>
</body></html>`;

const dashboardHtml = `<!doctype html><html lang="en"><head><title>Kade-AI Usage Dashboard</title>${SHARED_HEAD}</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a></p>
  <h1>Kade-AI Usage Dashboard</h1>
  <p class="muted">Admin view. Spend, usage, and balances across everyone on the instance.</p>
  <p><a class="back" href="/logs" style="font-weight:600">&#128220; Logs &mdash; look up any user's conversations &rarr;</a></p>

  <div id="status" class="status" role="status" aria-live="polite">Loading…</div>

  <main id="content" hidden>
    <div class="card">
      <h2 style="margin-top:0">Totals <span class="muted" id="winlabel"></span></h2>
      <dl class="kv">
        <dt>LLM (chat) spend — all time</dt><dd id="t_llm">$0.00</dd>
        <dt>Extra services (voice/image/search) — all time</dt><dd id="t_extra">$0.00</dd>
        <dt><strong>Grand total spent — all time</strong></dt><dd id="t_grand"><strong>$0.00</strong></dd>
        <dt>Total remaining balance (all users)</dt><dd id="t_bal">$0.00</dd>
      </dl>
    </div>

    <div class="card" id="twilio_card" hidden>
      <h2 style="margin-top:0">Twilio &mdash; SMS &amp; voice <span class="muted">(account-wide, not per-user)</span></h2>
      <dl class="kv">
        <dt>Spent all time</dt><dd id="tw_all">&mdash;</dd>
        <dt>Spent this month</dt><dd id="tw_month">&mdash;</dd>
        <dt>Balance remaining</dt><dd id="tw_bal">&mdash;</dd>
      </dl>
      <p class="muted" style="font-size:.85rem;margin-top:.5rem">Phone numbers, calls, and texts. Separate from the LibreChat spend above (that's per-user; this is one shared account bill).</p>
    </div>

    <div class="card" id="inworld_card" hidden>
      <h2 style="margin-top:0">Voice pool &mdash; Inworld <span class="muted">(your founder plan)</span></h2>
      <dl class="kv">
        <dt>Used this month, site + apps</dt><dd id="iw_used">&mdash;</dd>
        <dt>Included in your plan</dt><dd id="iw_incl">&mdash;</dd>
        <dt>Left before overage</dt><dd id="iw_left">&mdash;</dd>
      </dl>
      <p class="muted" style="font-size:.85rem;margin-top:.5rem">Family voice is free to them &mdash; it comes out of this monthly pool, which renews with your plan. Overage would bill $10 per million characters. Phone-call voice runs through the bridge and is not in this count; the Inworld console has the true account-wide number.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Add or link a caller</h2>
      <p class="muted" style="margin:.2rem 0 .8rem">The skeleton key. Give a phone number plus whatever you know — name, the email they use on the site — and their calls start landing on their own account and wallet. Works for brand-new folks and for fixing up existing ones (fields you leave blank stay as they were).</p>
      <div style="display:grid;gap:.7rem;max-width:26rem">
        <div>
          <label for="ac_name" style="display:block;font-weight:600;margin-bottom:.2rem">Name</label>
          <input id="ac_name" type="text" autocomplete="off" style="width:100%;padding:.6rem;border:1px solid #b9c0cb;border-radius:8px;font:inherit">
        </div>
        <div>
          <label for="ac_phone" style="display:block;font-weight:600;margin-bottom:.2rem">Phone number</label>
          <input id="ac_phone" type="tel" inputmode="tel" autocomplete="off" style="width:100%;padding:.6rem;border:1px solid #b9c0cb;border-radius:8px;font:inherit">
        </div>
        <div>
          <label for="ac_email" style="display:block;font-weight:600;margin-bottom:.2rem">Email on their site account</label>
          <input id="ac_email" type="email" autocomplete="off" style="width:100%;padding:.6rem;border:1px solid #b9c0cb;border-radius:8px;font:inherit">
        </div>
        <button type="button" id="ac_btn" class="addcred" style="font:inherit;font-weight:600;padding:.7rem 1rem;border-radius:10px;border:1px solid #1f7a49;background:#1f7a49;color:#fff;cursor:pointer">Wire them up</button>
        <p id="ac_status" role="status" aria-live="polite" class="muted" style="margin:.2rem 0 0"></p>
      </div>
    </div>

    <h2>By service</h2>
    <!-- KADE July 21 2026: was a 3-column table. Kade (screen-reader user):
         tables mean silently tracking which column you're in. Every value now
         sits DIRECTLY after its own label in a definition list. -->
    <div class="card">
      <dl class="kv" id="svc_list"></dl>
      <p class="muted" id="svc_empty" hidden>No voice / image / search usage logged yet.</p>
    </div>

    <h2>By person</h2>
    <!-- Same reason: was an 8-column table -- the worst offender. One card
         per person, every number labeled where it sits, +$5 button at the
         end of each card. -->
    <div id="user_cards"></div>
  </main>

  <footer class="muted">Refreshes on every load. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
    function svcQty(u, name){ const s=(u.services||{})[name]; return s? s.quantity.allTime : 0; }
    function svcExtra(u){ let t=0; for(const k in (u.services||{})){ t += u.services[k].costUSD.allTime; } return t; }
    (async function(){
      const status = document.getElementById('status');
      let token = null; try { token = await getToken(); } catch(e) {}
      if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }
      let r; try { r = await apiGet('/api/kade/usage?days=30', token); } catch(e) { status.className='status err'; status.textContent='Could not reach the server. Check your connection and reload.'; return; }
      if(r.status===401 || r.status===403){ status.className='status err'; status.textContent='This dashboard is for admins only.'; return; }
      if(!r.ok){ status.className='status err'; status.textContent='Could not load the dashboard right now. Try reloading.'; return; }
      const d = await r.json();
      const t = d.totals || {};
      document.getElementById('winlabel').textContent = '(window = last ' + d.windowDays + ' days)';
      document.getElementById('t_llm').textContent = money(t.llmSpendUSD.allTime);
      document.getElementById('t_extra').textContent = money(t.extraSpendUSD.allTime);
      document.getElementById('t_grand').innerHTML = '<strong>'+money(t.grandSpendUSD.allTime)+'</strong>';
      document.getElementById('t_bal').textContent = money(t.balanceUSD);

      const tw = d.twilio;
      if (tw) {
        document.getElementById('tw_all').textContent = (tw.allTimeUSD==null?'\u2014':money(tw.allTimeUSD));
        document.getElementById('tw_month').textContent = (tw.monthToDateUSD==null?'\u2014':money(tw.monthToDateUSD));
        document.getElementById('tw_bal').textContent = (tw.balanceUSD==null?'\u2014':money(tw.balanceUSD));
        document.getElementById('twilio_card').hidden = false;
      }

      const acBtn = document.getElementById('ac_btn');
      acBtn.addEventListener('click', async function(){
        const st = document.getElementById('ac_status');
        const phone = document.getElementById('ac_phone').value.trim();
        const name = document.getElementById('ac_name').value.trim();
        const email = document.getElementById('ac_email').value.trim();
        if(phone.replace(/\D/g,'').length < 10){ st.textContent = 'Need a full 10-digit phone number.'; return; }
        acBtn.disabled = true; st.textContent = 'Wiring\u2026';
        try {
          const resp = await apiPost('/api/kade/admin/phone-register', token, { phone: phone, name: name, email: email });
          const j = await resp.json();
          if(resp.ok && j.ok){
            let line = 'Wired ' + (name || 'caller') + ' at ' + (j.phone || phone) + '.';
            if(email && j.accountMatch){
              line += j.accountMatch.found
                ? ' Email matched the site account for ' + j.accountMatch.name + ' \u2014 calls will attribute and bill to them.'
                : ' Heads up: no site account uses that email yet \u2014 the row is saved, but nothing attributes until that account exists.';
            }
            st.textContent = line;
            document.getElementById('ac_name').value = '';
            document.getElementById('ac_phone').value = '';
            document.getElementById('ac_email').value = '';
          } else {
            st.textContent = (j && j.error) || 'That did not save \u2014 try again.';
          }
        } catch(e){ st.textContent = 'That did not save \u2014 try again.'; }
        acBtn.disabled = false;
      });

      const iw = d.inworld;
      if (iw && iw.includedChars) {
        var iwUsed = iw.monthChars || 0;
        var iwPct = Math.round(iwUsed * 100 / iw.includedChars);
        document.getElementById('iw_used').textContent = num(iwUsed) + ' characters \u2014 about ' + listenTime(iwUsed) + ' of speech, ' + iwPct + '% of the pool';
        document.getElementById('iw_incl').textContent = num(iw.includedChars) + ' characters a month';
        document.getElementById('iw_left').textContent = num(Math.max(0, iw.includedChars - iwUsed)) + ' characters';
        document.getElementById('inworld_card').hidden = false;
      }

      const svcList = document.getElementById('svc_list');
      const svcNames = Object.keys(d.perService||{});
      if(svcNames.length===0){
        document.getElementById('svc_empty').hidden = false;
      } else {
        svcList.innerHTML = svcNames.map(function(name){
          const s = d.perService[name];
          return '<dt>'+name+'</dt><dd>'+num(s.quantity.allTime)+' '+(s.unit||'')+' \u00b7 '+money(s.costUSD.allTime)+'</dd>';
        }).join('');
      }

      const ub = document.getElementById('user_cards');
      ub.innerHTML = (d.perUser||[]).map(function(u){
        const uid = String(u.userId||'').replace(/[^a-zA-Z0-9]/g,'');
        const safeName = (u.name||'this user').replace(/["&<>]/g,'');
        return '<section class="card">'+
          '<h3 style="margin:.1rem 0 .5rem;font-size:1.05rem">'+(u.name||'')+(u.role==='ADMIN'?' <span class="muted">(admin)</span>':'')+'</h3>'+
          '<dl class="kv">'+
          '<dt>Chat (LLM), all time</dt><dd>'+money(u.llmSpendUSD.allTime)+'</dd>'+
          '<dt>Voice, all time</dt><dd>'+num(svcQty(u,'tts'))+' chars \u00b7 ~'+listenTime(svcQty(u,'tts'))+'</dd>'+
          '<dt>Images</dt><dd>'+num(svcQty(u,'flux'))+'</dd>'+
          '<dt>Searches</dt><dd>'+num(svcQty(u,'tavily'))+'</dd>'+
          '<dt>Extra services, all time</dt><dd>'+money(svcExtra(u))+'</dd>'+
          '<dt>Balance</dt><dd id="bal_'+uid+'">'+money(u.balanceUSD)+'</dd>'+
          '</dl>'+
          '<button type="button" class="addcred" data-uid="'+(u.userId||'')+'" data-balid="bal_'+uid+'" aria-label="Add five dollars of credit to '+safeName+'">+$5 credit</button>'+
          '</section>';
      }).join('');

      ub.addEventListener('click', async function(ev){
        const btn = ev.target.closest('button.addcred'); if(!btn){ return; }
        const uid = btn.getAttribute('data-uid'); if(!uid){ return; }
        const orig = btn.textContent; btn.disabled = true; btn.textContent = '...';
        try {
          const resp = await apiPost('/api/kade/add-credits', token, { userId: uid, amountUSD: 5 });
          if(resp.ok){
            const j = await resp.json();
            const balCell = document.getElementById(btn.getAttribute('data-balid') || '');
            if(balCell){ balCell.textContent = money(j.balanceUSD); }
            btn.textContent = 'Added';
            status.hidden = false; status.className = 'status'; status.textContent = 'Added $5 -- new balance ' + money(j.balanceUSD) + '.';
          } else { btn.textContent = 'Failed'; }
        } catch(e){ btn.textContent = 'Failed'; }
        setTimeout(function(){ btn.textContent = orig; btn.disabled = false; }, 1600);
      });

      status.hidden = true;
      document.getElementById('content').hidden = false;
    })();
  </script>
</body></html>`;


const creationsHtml = `<!doctype html><html lang="en"><head><title>My Creations</title>${SHARED_HEAD}
<style>
  .asset video, .asset img { width: 100%; max-width: 640px; border-radius: 10px; display: block; }
  .asset audio { width: 100%; max-width: 640px; display: block; margin-bottom:.3rem; }
  .asset .meta { font-size: .9rem; margin-top: .5rem; }
  .asset .prompt, .asset .desc { margin-top: .35rem; font-size: .95rem; }
  .pill { display:inline-block; font-size:.8rem; font-weight:600; padding:.1rem .55rem; border-radius:999px; background:#e8f0fe; color:#1d4ed8; margin-right:.4rem; }
  button.share, button.dl { margin-top:.6rem; margin-right:.5rem; font: inherit; font-weight:600; padding:.5rem .9rem; border-radius:10px; border:1px solid #1d55d0; background:#fff; color:#1d55d0; cursor:pointer; }
  button.dl { border-color:#1f7a49; color:#1f7a49; }
  button.dl:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  button.share[aria-pressed="true"] { background:#1d55d0; color:#fff; }
  button.share:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  @media (prefers-color-scheme: dark) {
    .pill { background:#1e3a8a; color:#dbeafe; }
    button.share, button.dl { background:#1e2127; }
    button.share[aria-pressed="true"] { background:#1d55d0; color:#fff; }
  }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="/wall-of-fame">Wall of Fame &rarr;</a></p>
  <h1>My Creations</h1>
  <p class="muted">Every video, image, and audio clip you've generated here, newest first. Videos and audio play right on this page. Hit "Share to the Wall of Fame" on a favorite and everyone on the site can enjoy it too.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading your creations…</div>

  <main id="content" hidden aria-label="Your generated videos, images, and audio"></main>

  <footer class="muted">Fresh every time you open this page. Videos are backed up to Kade's own storage automatically, so they won't vanish — but download anything you want a personal copy of. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      let token = null; try { token = await getToken(); } catch(e) {}
      if(!token){
        status.className = 'status err';
        status.textContent = 'Please sign in at the chat site first, then reload this page.';
        return;
      }
      const r = await apiGet('/api/kade/my-assets', token);
      if(!r.ok){
        status.className = 'status err';
        status.textContent = 'Could not load your creations right now. Try reloading in a moment.';
        return;
      }
      const d = await r.json();
      const main = document.getElementById('content');
      if(!d.assets || d.assets.length === 0){
        status.textContent = 'Nothing here yet! Anything you generate with the video or image agents from now on will show up on this page automatically.';
        return;
      }
      const vids = d.assets.filter(function(a){ return a.kind === 'video'; }).length;
      const auds = d.assets.filter(function(a){ return a.kind === 'audio'; }).length;
      const docs = d.assets.filter(function(a){ return a.kind === 'document'; }).length;
      const imgs = d.assets.length - vids - auds - docs;
      status.textContent = 'You have ' + d.assets.length + ' creation' + (d.assets.length===1?'':'s') + ': ' + vids + ' video' + (vids===1?'':'s') + ', ' + imgs + ' image' + (imgs===1?'':'s') + ', ' + auds + ' audio clip' + (auds===1?'':'s') + (docs ? ', and ' + docs + ' document' + (docs===1?'':'s') : '') + '.';
      function esc(s){ const div=document.createElement('div'); div.textContent = s || ''; return div.innerHTML; }
      function when(iso){
        try { return new Date(iso).toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); }
        catch(e){ return ''; }
      }
      main.innerHTML = d.assets.map(function(a, i){
        const kindLabel = a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : a.kind === 'document' ? 'Document' : 'Image';
        const title = kindLabel + ' — ' + when(a.createdAt);
        const desc = a.description || a.prompt || ('Generated ' + a.kind);
        let media;
        if(a.kind === 'video'){
          media = '<video controls preload="metadata" playsinline aria-label="' + esc(desc) + '"><source src="' + esc(a.url) + '">' +
                  (a.backupUrl ? '<source src="' + esc(a.backupUrl) + '">' : '') + '</video>' +
                  '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open or download this video in a new tab">Open or download this video</a>' +
                  (a.backupUrl ? ' &middot; <a href="' + esc(a.backupUrl) + '" target="_blank" rel="noreferrer" aria-label="Open the backup copy of this video">backup copy</a>' : '');
        } else if(a.kind === 'audio'){
          media = '<audio controls preload="metadata" aria-label="' + esc(desc) + '"><source src="' + esc(a.url) + '">' +
                  (a.backupUrl ? '<source src="' + esc(a.backupUrl) + '">' : '') + '</audio>' +
                  '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open or download this audio clip in a new tab">Open or download this audio</a>' +
                  (a.backupUrl ? ' &middot; <a href="' + esc(a.backupUrl) + '" target="_blank" rel="noreferrer" aria-label="Open the backup copy of this audio">backup copy</a>' : '');
        } else if(a.kind === 'document'){
          /* Part 91.7 (Fable review): kade_make_file lands documents here, and
           * the else-branch below would render an .xlsx URL inside an <img>
           * tag — a broken picture standing where a spreadsheet should be. A
           * document's face is its SPOKEN SUMMARY, written at generation
           * time; the Download button below already streams it with the right
           * type and filename. */
          media = '<p class="desc">' + esc(a.spoken || ('A ' + ((a.model || 'text').toUpperCase()) + ' file.')) + '</p>' +
                  '<p class="meta">File type: ' + esc((a.model || 'document').toUpperCase()) + '. Use the Download button below to save and open it.</p>';
        } else {
          media = '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open full-size image in a new tab"><img loading="lazy" src="' + esc(a.url) + '" alt="' + esc(desc) + '"></a>';
        }
        /* July 13 2026 VO audit: aria-label repeating the inner h2 = iOS
         * VoiceOver double-read (same class as the July 11 message bug).
         * The heading labels the section instead. */
        return '<section class="card asset" aria-labelledby="asset-h-' + esc(a.id) + '">' +
          '<h2 id="asset-h-' + esc(a.id) + '" style="margin:0 0 .5rem;font-size:1.05rem">' + esc(title) + '</h2>' +
          media +
          '<p class="meta"><span class="pill">' + esc(a.kind) + '</span>' + esc(a.model || a.service) + (a.costUSD ? ' &middot; ' + money(a.costUSD) : '') + '</p>' +
          (a.description && a.kind !== 'document' ? '<p class="desc"><strong>' + (a.kind === 'audio' ? 'What you will hear:' : 'What it looks like:') + '</strong> ' + esc(a.description) + '</p>' : '') +
          (a.prompt ? '<p class="prompt"><strong>Prompt:</strong> ' + esc(a.prompt) + '</p>' : '') +
          '<button type="button" class="dl" data-id="' + esc(a.id) + '" data-kind="' + esc(a.kind) + '" aria-label="Download this ' + esc(a.kind) + ' to your device">Download</button>' +
          '<button type="button" class="share" data-id="' + esc(a.id) + '" aria-pressed="' + (a.shared ? 'true' : 'false') + '">' +
            (a.shared ? 'On the Wall of Fame — tap to remove' : 'Share to the Wall of Fame') + '</button>' +
        '</section>';
      }).join('');
      main.addEventListener('click', async function(ev){
        const dlBtn = ev.target.closest('button.dl');
        if(dlBtn){
          downloadAsset(dlBtn.getAttribute('data-id'), dlBtn.getAttribute('data-kind'), dlBtn, status, token);
          return;
        }
        const btn = ev.target.closest('button.share');
        if(!btn){ return; }
        const nowShared = btn.getAttribute('aria-pressed') !== 'true';
        btn.disabled = true;
        try{
          const resp = await apiPost('/api/kade/my-assets/' + btn.getAttribute('data-id') + '/share', token, { shared: nowShared });
          if(resp.ok){
            btn.setAttribute('aria-pressed', nowShared ? 'true' : 'false');
            btn.textContent = nowShared ? 'On the Wall of Fame — tap to remove' : 'Share to the Wall of Fame';
            status.textContent = nowShared ? 'Shared to the Wall of Fame!' : 'Removed from the Wall of Fame.';
          } else {
            status.textContent = 'Could not update sharing just now — try again in a moment.';
          }
        }catch(e){
          status.textContent = 'Could not update sharing just now — try again in a moment.';
        }
        btn.disabled = false;
      });
      status.hidden = false;
      main.hidden = false;
    })();
  </script>
</body></html>`;

const wallHtml = `<!doctype html><html lang="en"><head><title>Wall of Fame</title>${SHARED_HEAD}
<style>
  .asset video, .asset img { width: 100%; max-width: 640px; border-radius: 10px; display: block; }
  .asset audio { width: 100%; max-width: 640px; display: block; margin-bottom:.3rem; }
  .asset .meta { font-size: .9rem; margin-top: .5rem; }
  .asset .prompt, .asset .desc { margin-top: .35rem; font-size: .95rem; }
  .pill { display:inline-block; font-size:.8rem; font-weight:600; padding:.1rem .55rem; border-radius:999px; background:#fdf1d7; color:#8a6100; margin-right:.4rem; }
  button.dl { margin-top:.6rem; font: inherit; font-weight:600; padding:.5rem .9rem; border-radius:10px; border:1px solid #1f7a49; background:#fff; color:#1f7a49; cursor:pointer; }
  button.dl:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  @media (prefers-color-scheme: dark) { .pill { background:#5c4300; color:#ffe9b3; } button.dl { background:#1e2127; } }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="/my-creations">My Creations</a></p>
  <h1>Wall of Fame</h1>
  <p class="muted">The best AI creations from everyone on Kade-AI — shared by their makers. Add your own from your <a href="/my-creations">My Creations</a> page.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading the wall…</div>

  <main id="content" hidden aria-label="Creations shared by everyone on the site"></main>

  <footer class="muted">Only things people chose to share appear here. &mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      let token = null; try { token = await getToken(); } catch(e) {}
      if(!token){
        status.className = 'status err';
        status.textContent = 'Please sign in at the chat site first, then reload this page.';
        return;
      }
      const r = await apiGet('/api/kade/wall', token);
      if(!r.ok){
        status.className = 'status err';
        status.textContent = 'Could not load the wall right now. Try reloading in a moment.';
        return;
      }
      const d = await r.json();
      const main = document.getElementById('content');
      if(!d.assets || d.assets.length === 0){
        status.textContent = 'The wall is empty so far. Be the first: open My Creations and share a favorite!';
        return;
      }
      status.textContent = d.assets.length + ' shared creation' + (d.assets.length===1?'':'s') + ' on the wall.';
      function esc(s){ const div=document.createElement('div'); div.textContent = s || ''; return div.innerHTML; }
      function when(iso){
        try { return new Date(iso).toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric' }); }
        catch(e){ return ''; }
      }
      main.innerHTML = d.assets.map(function(a){
        const kindLabel = a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : a.kind === 'document' ? 'Document' : 'Image';
        const title = kindLabel + ' by ' + (a.by || 'Someone') + ' — ' + when(a.createdAt);
        const desc = a.description || a.prompt || ('Shared ' + a.kind);
        let media;
        if(a.kind === 'video'){
          media = '<video controls preload="metadata" playsinline aria-label="' + esc(desc) + '"><source src="' + esc(a.url) + '">' +
                  (a.backupUrl ? '<source src="' + esc(a.backupUrl) + '">' : '') + '</video>' +
                  '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open or download this video in a new tab">Open or download this video</a>';
        } else if(a.kind === 'audio'){
          media = '<audio controls preload="metadata" aria-label="' + esc(desc) + '"><source src="' + esc(a.url) + '">' +
                  (a.backupUrl ? '<source src="' + esc(a.backupUrl) + '">' : '') + '</audio>' +
                  '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open or download this audio clip in a new tab">Open or download this audio</a>';
        } else if(a.kind === 'document'){
          /* Part 91.7 — a shared document's face is its spoken summary, not a
           * broken <img>. Same reasoning as the My Creations branch. */
          media = '<p class="desc">' + esc(a.spoken || a.description || 'A shared document.') + '</p>' +
                  '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open or download this document in a new tab">Open or download this document</a>';
        } else {
          media = '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open full-size image in a new tab"><img loading="lazy" src="' + esc(a.url) + '" alt="' + esc(desc) + '"></a>';
        }
        /* July 13 2026 VO audit: aria-label repeating the inner h2 = iOS
         * VoiceOver double-read (same class as the July 11 message bug).
         * The heading labels the section instead. */
        return '<section class="card asset" aria-labelledby="asset-h-' + esc(a.id) + '">' +
          '<h2 id="asset-h-' + esc(a.id) + '" style="margin:0 0 .5rem;font-size:1.05rem">' + esc(title) + '</h2>' +
          media +
          '<p class="meta"><span class="pill">' + esc(a.by || 'Someone') + '</span>' + esc(a.kind) + (a.model ? ' &middot; ' + esc(a.model) : '') + '</p>' +
          (a.description && a.kind !== 'document' ? '<p class="desc"><strong>' + (a.kind === 'audio' ? 'What you will hear:' : 'What it looks like:') + '</strong> ' + esc(a.description) + '</p>' : '') +
          (a.prompt ? '<p class="prompt"><strong>Prompt:</strong> ' + esc(a.prompt) + '</p>' : '') +
          '<button type="button" class="dl" data-id="' + esc(a.id) + '" data-kind="' + esc(a.kind) + '" aria-label="Download this ' + esc(a.kind) + ' by ' + esc(a.by || 'Someone') + '">Download</button>' +
        '</section>';
      }).join('');
      main.addEventListener('click', function(ev){
        const dlBtn = ev.target.closest('button.dl');
        if(dlBtn){ downloadAsset(dlBtn.getAttribute('data-id'), dlBtn.getAttribute('data-kind'), dlBtn, status, token); }
      });
      status.hidden = false;
      main.hidden = false;
    })();
  </script>
</body></html>`;


/* KADE July 3 2026: /game-room — the Game Parlor leaderboard. Family
 * standings computed live from finished tables. Screen-reader-first:
 * real tables with scoped headers, status region, prose summaries. */
const feedbackHtml = `<!doctype html><html lang="en"><head><title>Feedback & Bug Reports</title>${SHARED_HEAD}</head>
<body>
  <a class="back" href="/">&larr; Back to chat</a>
  <h1>Feedback &amp; Bug Reports</h1>
  <p class="muted">Everything your users filed by telling any character. Newest first. Marking a report <strong>Solved</strong> notifies the reporter (push or their next chat, delivered by their companion) — and they can reopen it by just saying so.</p>
  <div id="filters" hidden style="margin:.5rem 0">
    <button id="f-open" class="btn" type="button" aria-pressed="true">Open only</button>
    <button id="f-all" class="btn" type="button" aria-pressed="false" style="background:#555">Show all</button>
  </div>
  <div id="status" class="status" role="status">Loading your feedback&hellip;</div>
  <div id="list" aria-live="polite"></div>
  <footer class="muted">Free feature. Reports are attributed to the user who sent them.</footer>
<script>
  var TOKEN=null; var MODE='open';
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function whenStr(d){ try{ return new Date(d).toLocaleString('en-US'); }catch(e){ return ''; } }
  function catLabel(c){ return c==='bug'?'Bug':c==='feature'?'Feature request':'Feedback'; }
  function stBtn(id,st,label){ return '<button class="btn" type="button" data-id="'+id+'" data-st="'+st+'" style="background:#555;font-size:.85rem;padding:.4rem .8rem;margin:.2rem .3rem 0 0">'+label+'</button>'; }
  function render(items){
    var list=document.getElementById('list'); list.innerHTML='';
    items.forEach(function(it){
      var who = it.user ? (it.user.name||it.user.email||'a user') : 'a user';
      var card=document.createElement('div'); card.className='card';
      card.innerHTML =
        '<h2>'+esc(it.subject||'(no subject)')+' <span class="muted">&mdash; '+catLabel(it.category)+'</span></h2>'+
        '<p>'+esc(it.detail)+'</p>'+
        '<dl class="kv" style="grid-template-columns:auto 1fr">'+
          '<dt>From</dt><dd style="text-align:left">'+esc(who)+'</dd>'+
          '<dt>Filed by</dt><dd style="text-align:left">'+esc(it.agent||'agent')+' ('+esc(it.surface||'chat')+')</dd>'+
          '<dt>When</dt><dd style="text-align:left">'+esc(whenStr(it.createdAt))+'</dd>'+
          '<dt>Status</dt><dd style="text-align:left" id="st-'+it._id+'"><strong>'+esc(it.status)+'</strong></dd>'+
        '</dl>'+
        '<div>'+stBtn(it._id,'acknowledged','Mark seen')+stBtn(it._id,'resolved','Resolved')+stBtn(it._id,'wontfix','Ignore')+'</div>';
      list.appendChild(card);
    });
    list.querySelectorAll('button[data-id]').forEach(function(b){
      b.addEventListener('click', function(){ setStatus(b.getAttribute('data-id'), b.getAttribute('data-st'), b); });
    });
  }
  async function load(){
    var statusEl=document.getElementById('status');
    if(!TOKEN){ TOKEN=await getToken(); }
    if(!TOKEN){ statusEl.className='status err'; statusEl.textContent='Please sign in on the main site first, then reload this page.'; return; }
    statusEl.className='status'; statusEl.textContent='Loading your feedback…';
    var r=await apiGet('/api/kade/feedback?status='+MODE, TOKEN);
    if(r.status===401||r.status===403){ statusEl.className='status err'; statusEl.textContent='This page is for admins only.'; return; }
    if(!r.ok){ statusEl.className='status err'; statusEl.textContent='Could not load feedback (error '+r.status+').'; return; }
    var items=await r.json();
    document.getElementById('filters').hidden=false;
    render(items);
    statusEl.className='status';
    statusEl.textContent = items.length ? (items.length+' report'+(items.length===1?'':'s')+' shown.') : ('No '+(MODE==='open'?'open ':'')+'reports yet.');
  }
  async function setStatus(id,st,b){
    b.disabled=true; var old=b.textContent; b.textContent='Saving…';
    var r=await apiPost('/api/kade/feedback/'+id+'/status', TOKEN, {status:st});
    if(r.ok){ var cell=document.getElementById('st-'+id); if(cell){ cell.innerHTML='<strong>'+st+'</strong>'; } b.textContent='Done'; if(MODE==='open'){ setTimeout(load,400); } }
    else { b.textContent=old; b.disabled=false; }
  }
  function setMode(m){
    MODE=m;
    var o=document.getElementById('f-open'), a=document.getElementById('f-all');
    o.setAttribute('aria-pressed', m==='open'?'true':'false'); o.style.background = m==='open'?'#1f7a49':'#555';
    a.setAttribute('aria-pressed', m==='all'?'true':'false'); a.style.background = m==='all'?'#1f7a49':'#555';
    load();
  }
  document.getElementById('f-open').addEventListener('click', function(){ setMode('open'); });
  document.getElementById('f-all').addEventListener('click', function(){ setMode('all'); });
  load();
</script>
</body></html>`;


const notificationsHtml = `<!doctype html><html lang="en"><head><title>Notifications & Reminders</title>${SHARED_HEAD}</head>
<body>
  <a class="back" href="/">&larr; Back to chat</a>
  <h1>Notifications &amp; Reminders</h1>
  <p class="muted">Everything here is opt-in and off by default (except in-chat reminders, which are free and silent). Say "remind me to take my meds at 9" to any character and it becomes a real reminder. You pick how each kind of nudge reaches you.</p>
  <div id="status" class="status" role="status">Loading your settings&hellip;</div>

  <div class="card">
    <h2>Push notifications on this device</h2>
    <p>Real notifications on your phone or computer, even with the site closed. On iPhone this only works from the installed app &mdash; Share button, then "Add to Home Screen" &mdash; and iOS 16.4 or newer.</p>
    <p id="push-state" class="muted">Checking&hellip;</p>
    <button id="btn-push" class="btn" type="button">Turn on push for this device</button>
    <button id="btn-push-off" class="btn" type="button" style="background:#555" hidden>Turn push off everywhere</button>
  </div>

  <div class="card">
    <h2>How should each nudge reach you?</h2>
    <form id="prefs-form">
      <fieldset style="border:1px solid #8884;border-radius:8px;margin:.6rem 0;padding:.6rem">
        <legend><strong>Reminders</strong> (things you asked a character to remind you about)</legend>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="reminders" value="chat"> In chat &mdash; your next conversation opens with it (free, silent)</label>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="reminders" value="push"> Push notification to my devices (free)</label>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="reminders" value="call"> Phone call &mdash; a character calls and tells me out loud</label>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="reminders" value="off"> Off &mdash; never remind me</label>
      </fieldset>
      <fieldset style="border:1px solid #8884;border-radius:8px;margin:.6rem 0;padding:.6rem">
        <legend><strong>Birthday</strong> (a happy-birthday nudge once a year, around 9am)</legend>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="birthday" value="off"> Off</label>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="birthday" value="chat"> In chat</label>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="birthday" value="push"> Push notification</label>
        <label style="display:block;margin:.25rem 0"><input type="radio" name="birthday" value="call"> Phone call</label>
        <div style="margin-top:.5rem">
          <label for="bday-month">My birthday: month</label>
          <select id="bday-month"><option value="">--</option></select>
          <label for="bday-day">day</label>
          <select id="bday-day"><option value="">--</option></select>
        </div>
      </fieldset>
      <div style="margin:.6rem 0">
        <label for="phone">Phone number for the call option (10 digits, US):</label>
        <input id="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="4175551234" style="padding:.5rem;border-radius:6px;border:1px solid #8886;max-width:14rem">
        <p class="muted">Calls cost the site a few pennies each; push and in-chat are free. Calls announce themselves as AI, like every Kade-AI call.</p>
      </div>
      <button class="btn" id="btn-save" type="submit" disabled>Save my choices (loading&hellip;)</button>
      <button class="btn" id="btn-test" type="button" style="background:#555">Send me a test nudge</button>
    </form>
  </div>

  <div class="card">
    <h2>Family check-in calls</h2>
    <p class="muted">Companion calls to a registered family member on a schedule you choose &mdash; the character calls them, chats warmly, and a written report of how they're doing comes back to you as a nudge. Each call costs about 5&ndash;10 cents (a daily schedule is a few dollars a month), billed to your Usage &amp; Balance tab. Calls run between 8am and 9pm Central. You can also just tell any character, "set up a daily check-in call for Dad at 10."</p>
    <div id="wellList" aria-live="polite"><p class="muted">Loading&hellip;</p></div>
    <form id="wellForm" style="margin-top:.8rem;">
      <h3 style="margin:.4rem 0;">New check-in schedule</h3>
      <label>Who (registered family)
        <select id="wWho" required></select>
      </label>
      <label style="margin-left:.8rem;">Time (Central)
        <input type="time" id="wTime" required value="10:00">
      </label>
      <fieldset style="border:0;padding:.4rem 0;margin:0;">
        <legend style="font-weight:600;">Days</legend>
        <label><input type="radio" name="wDays" value="daily" checked> Every day</label>
        <label style="margin-left:.7rem;"><input type="radio" name="wDays" value="custom"> Pick days:</label>
        <span id="wDayBoxes"></span>
      </fieldset>
      <label style="display:block;">Anything to weave in or listen for (optional)
        <input type="text" id="wTopics" maxlength="600" style="width:100%;" placeholder="ask about his garden, make sure he's eating okay">
      </label>
      <button class="btn" id="wCreate" type="submit">Create schedule (starts paused until you test it)</button>
    </form>
    <p class="muted" id="wellNote">New schedules start PAUSED. Use "Call me as a test" on the schedule to hear exactly what your person will hear, then Resume it.</p>
  </div>

  <div class="card">
    <h2>Agent check-ins (Kade-AI iPhone app)</h2>
    <p class="muted">Beyond reminders you set yourself, any character can reach out and check on YOU the way they choose to &mdash; right now, or on a repeating schedule. Just ask one directly: <em>"text me every evening at 6"</em> sets up a recurring check-in; <em>"send me a note that says goodnight"</em> fires one immediately. Ask what schedules you have going, and pause or cancel any of them in chat &mdash; no form to fill out here. This rides your <strong>Kade-AI iPhone app's</strong> notifications (the permission prompt it shows the first time you open it) rather than the browser push above, so it needs that app specifically. Free, and it shares the same quiet hours and daily caps as everything else on this page.</p>
  </div>

  <div class="card">
    <h2>What's New announcements</h2>
    <p class="muted">Platform news sent to the whole family. The push notification is just the headline &mdash; the full text lives here (and in Help, under What's New).</p>
    <div id="announcements" aria-live="polite"><p class="muted">Nothing yet.</p></div>
  </div>

  <div class="card">
    <h2>Recent nudges</h2>
    <div id="recent" aria-live="polite"><p class="muted">Nothing yet.</p></div>
  </div>
  <footer class="muted">Reminders live as memory cards too &mdash; you can see and delete them in any chat's side panel under Memories.</footer>
<script>
  var TOKEN=null, CFG=null;
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token||null; }catch(e){ return null; } }
  async function apiGet(p){ var r=await fetch(p,{headers:{Authorization:'Bearer '+TOKEN}}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  async function apiPost(p,body){ var r=await fetch(p,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  function say(msg, err){ var el=document.getElementById('status'); el.textContent=msg; el.className='status'+(err?' err':''); }
  function b64ToU8(base64){ var pad='='.repeat((4-base64.length%4)%4); var b=(base64+pad).replace(/-/g,'+').replace(/_/g,'/'); var raw=atob(b); var arr=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++){arr[i]=raw.charCodeAt(i);} return arr; }

  var mSel=document.getElementById('bday-month'), dSel=document.getElementById('bday-day');
  ['January','February','March','April','May','June','July','August','September','October','November','December'].forEach(function(n,i){ var o=document.createElement('option'); o.value=String(i+1).padStart(2,'0'); o.textContent=n; mSel.appendChild(o); });
  for(var i=1;i<=31;i++){ var o=document.createElement('option'); o.value=String(i).padStart(2,'0'); o.textContent=i; dSel.appendChild(o); }

  async function refreshPushState(){
    var stateEl=document.getElementById('push-state'), on=document.getElementById('btn-push'), off=document.getElementById('btn-push-off');
    if(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()){
      stateEl.textContent='You are in the Kade-AI app, so your phone notifications are handled by the app itself — you already turned them on the first time you opened it. The button below is only for using Kade-AI in a plain web browser, so it is switched off here.';
      on.disabled=true; on.hidden=true; if(off){ off.hidden=true; } return;
    }
    if(!('serviceWorker' in navigator) || !('PushManager' in window)){
      stateEl.textContent='This browser cannot do push. On iPhone: add Kade-AI to your Home Screen from Safari first, then open it from there.';
      on.disabled=true; return;
    }
    if(!CFG || !CFG.pushConfigured){ stateEl.textContent='Push is not switched on server-side yet.'; on.disabled=true; return; }
    try{
      var reg=await navigator.serviceWorker.ready;
      var sub=await reg.pushManager.getSubscription();
      if(sub){ stateEl.textContent='Push is ON for this device.'; off.hidden=false; }
      else { stateEl.textContent='Push is not set up on this device yet.'; }
    }catch(e){ stateEl.textContent='Could not check push state: '+e.message; }
  }

  document.getElementById('btn-push').addEventListener('click', async function(){
    try{
      say('Asking this device for permission…');
      var perm=await Notification.requestPermission();
      if(perm!=='granted'){ say('Permission was not granted. On iPhone, make sure you opened the Home Screen app, not Safari.', true); return; }
      var reg=await navigator.serviceWorker.ready;
      var sub=await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: b64ToU8(CFG.vapidPublicKey) });
      await apiPost('/api/kade/nudges/subscribe',{subscription: sub.toJSON()});
      say('Push is on for this device. Send yourself a test nudge to hear it land.');
      refreshPushState();
    }catch(e){ say('Could not turn on push: '+e.message, true); }
  });
  document.getElementById('btn-push-off').addEventListener('click', async function(){
    try{
      var reg=await navigator.serviceWorker.ready;
      var sub=await reg.pushManager.getSubscription();
      if(sub){ await sub.unsubscribe(); }
      await apiPost('/api/kade/nudges/unsubscribe',{});
      say('Push is off everywhere for your account.');
      refreshPushState();
    }catch(e){ say('Could not turn push off: '+e.message, true); }
  });

  document.getElementById('prefs-form').addEventListener('submit', async function(ev){
    ev.preventDefault();
    try{
      var rem=(document.querySelector('input[name=reminders]:checked')||{}).value||'chat';
      var bd=(document.querySelector('input[name=birthday]:checked')||{}).value||'off';
      var bdate=(mSel.value&&dSel.value)?(mSel.value+'-'+dSel.value):'';
      var phone=document.getElementById('phone').value||'';
      await apiPost('/api/kade/nudges/prefs',{reminders:rem,birthday:bd,birthdayDate:bdate,phone:phone});
      say('Saved. Nudges will use these choices from now on.');
    }catch(e){ say('Could not save: '+e.message, true); }
  });
  document.getElementById('btn-test').addEventListener('click', async function(){
    try{ say('Sending a test nudge…'); var r=await apiPost('/api/kade/nudges/test',{}); say('Test sent via the "'+r.channel+'" channel.'+(r.channel==='chat'?' Open any chat and the character will pass it along.':'')); loadRecent(); }
    catch(e){ say('Test failed: '+e.message, true); }
  });

  async function loadRecent(){
    try{
      var d=await apiGet('/api/kade/nudges/prefs');
      var wrap=document.getElementById('recent');
      if(!d.recent || !d.recent.length){ wrap.innerHTML='<p class="muted">Nothing yet.</p>'; return; }
      wrap.innerHTML='';
      d.recent.forEach(function(n){
        var p=document.createElement('p');
        var when=new Date(n.createdAt).toLocaleString('en-US');
        p.innerHTML='<strong>'+esc(n.type)+'</strong> via '+esc(n.channel)+(n.deliveredAt?'':' (waiting for your next chat)')+' &mdash; '+esc(n.text)+' <span class="muted">('+esc(when)+')</span>';
        wrap.appendChild(p);
      });
    }catch(e){ /* non-fatal */ }
  }

  /* ---- What's New announcements (Part 112) ---- */
  async function loadAnnouncements(){
    try{
      var d=await apiGet('/api/kade/announcements');
      var wrap=document.getElementById('announcements');
      var rows=(d&&d.broadcasts)||[];
      if(!rows.length){ wrap.innerHTML='<p class="muted">Nothing yet.</p>'; return; }
      wrap.innerHTML='';
      rows.forEach(function(a){
        var p=document.createElement('p');
        var when=a.ts?new Date(a.ts).toLocaleString('en-US'):'';
        p.innerHTML='<strong>'+esc(a.title||'Kade-AI')+'</strong> <span class="muted">('+esc(when)+')</span><br>'+esc(a.body||'');
        wrap.appendChild(p);
      });
    }catch(e){ /* non-fatal */ }
  }
  loadAnnouncements();

  /* ---- Family check-in calls (July 11 2026) ---- */
  var DAYNAMES=['mon','tue','wed','thu','fri','sat','sun'];
  function wellDayBoxes(){
    var span=document.getElementById('wDayBoxes');
    DAYNAMES.forEach(function(d){
      var l=document.createElement('label'); l.style.marginLeft='.45rem';
      var c=document.createElement('input'); c.type='checkbox'; c.value=d; c.className='wDayBox';
      c.addEventListener('change',function(){ document.querySelector('input[name=wDays][value=custom]').checked=true; });
      l.appendChild(c); l.appendChild(document.createTextNode(' '+d));
      span.appendChild(l);
    });
  }
  async function wellLoad(){
    var wrap=document.getElementById('wellList');
    try{
      var d=await apiGet('/api/kade/wellness');
      var rows=d.schedules||[];
      if(!rows.length){ wrap.innerHTML='<p class="muted">No check-in schedules yet.</p>'; return; }
      wrap.innerHTML='';
      rows.forEach(function(w){
        var div=document.createElement('div');
        div.style.cssText='padding:.6rem 0;border-bottom:1px solid rgba(128,128,128,.25);';
        var days=w.days==='daily'?'every day':(Array.isArray(w.days)?w.days.join(', '):String(w.days));
        var head=document.createElement('p'); head.style.margin='0 0 .3rem';
        head.innerHTML='<strong>'+esc(w.targetName)+'</strong> &mdash; '+esc(days)+' at '+esc(w.time)+' Central with '+esc(w.agentName)+
          (w.topics?(' <span class="muted">(topics: '+esc(w.topics)+')</span>'):'')+
          ' &mdash; <strong>'+(w.enabled?'ACTIVE':'PAUSED')+'</strong>'+
          (w.lastRun?(' <span class="muted">&middot; last ran '+esc(w.lastRun)+'</span>'):' <span class="muted">&middot; never run yet</span>')+
          (w.enrolledBy&&w.enrolledBy.userName?(' <span class="muted">&middot; set up by '+esc(w.enrolledBy.userName)+'</span>'):'');
        div.appendChild(head);
        function mkBtn(txt,fn){ var b=document.createElement('button'); b.type='button'; b.className='btn'; b.style.cssText='background:#555;margin-right:.5rem;padding:.45rem .8rem;font-size:.9rem;'; b.textContent=txt; b.addEventListener('click',async function(){ b.disabled=true; try{ await fn(); await wellLoad(); }catch(e){ say('Check-in change failed: '+e.message,true); b.disabled=false; } }); return b; }
        div.appendChild(mkBtn(w.enabled?'Pause':'Resume',function(){ return apiPost('/api/kade/wellness',{action:'toggle',id:w.id,enabled:!w.enabled}); }));
        div.appendChild(mkBtn('Call now as a test',async function(){ var r=await apiPost('/api/kade/wellness',{action:'fire',id:w.id}); say(r.note||'Test call dialing.'); }));
        div.appendChild(mkBtn('Delete',function(){ if(!confirm('Delete the check-in schedule for '+w.targetName+'?')) return Promise.resolve(); return apiPost('/api/kade/wellness',{action:'delete',id:w.id}); }));
        wrap.appendChild(div);
      });
    }catch(e){ wrap.innerHTML='<p class="muted">Could not load schedules: '+esc(e.message)+'</p>'; }
  }
  async function wellInit(){
    wellDayBoxes();
    try{
      var d=await apiGet('/api/kade/wellness/people');
      var sel=document.getElementById('wWho');
      (d.people||[]).forEach(function(pp){ var o=document.createElement('option'); o.value=pp.name; o.textContent=pp.name; sel.appendChild(o); });
      if(!(d.people||[]).length){ var o=document.createElement('option'); o.textContent='(nobody registered yet — ask Kade)'; o.value=''; sel.appendChild(o); }
    }catch(e){}
    document.getElementById('wellForm').addEventListener('submit',async function(ev){
      ev.preventDefault();
      var who=document.getElementById('wWho').value;
      var time=document.getElementById('wTime').value;
      if(!who||!time){ say('Pick a person and a time first.',true); return; }
      var days='daily';
      if(document.querySelector('input[name=wDays][value=custom]').checked){
        var picked=[].slice.call(document.querySelectorAll('.wDayBox:checked')).map(function(c){return c.value;});
        if(!picked.length){ say('Pick at least one day (or choose Every day).',true); return; }
        days=picked.join(',');
      }
      try{
        var r=await apiPost('/api/kade/wellness',{who:who,time:time,days:days,topics:document.getElementById('wTopics').value,enabled:false});
        say('Schedule created for '+((r.schedule&&r.schedule.targetName)||who)+' — it starts PAUSED. Use "Call now as a test" to hear one, then Resume.');
        wellLoad();
      }catch(e){ say('Could not create the schedule: '+e.message,true); }
    });
    wellLoad();
  }

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ say('Please sign in on the main site first, then reload this page.', true); return; }
    try{
      CFG=await apiGet('/api/kade/nudges/config');
      var d=await apiGet('/api/kade/nudges/prefs');
      var p=d.prefs||{};
      var remEl=document.querySelector('input[name=reminders][value='+(p.reminders||'chat')+']'); if(remEl){ remEl.checked=true; }
      var bdEl=document.querySelector('input[name=birthday][value='+(p.birthday||'off')+']'); if(bdEl){ bdEl.checked=true; }
      if(p.birthdayDate && /^\\d{2}-\\d{2}$/.test(p.birthdayDate)){ mSel.value=p.birthdayDate.slice(0,2); dSel.value=p.birthdayDate.slice(3,5); }
      if(p.phone){ document.getElementById('phone').value=p.phone; }
      /* July 13 2026 wipe guard: only arm Save once the saved values are IN the
       * form — saving an unhydrated form silently blanked phone + birthday. */
      var saveBtn=document.getElementById('btn-save'); saveBtn.disabled=false; saveBtn.textContent='Save my choices';
      say('Loaded. '+(d.pushSubscriptions?('Push is on for '+d.pushSubscriptions+' device(s).'):'Push is not set up yet — in-chat delivery works regardless.'));
      refreshPushState(); loadRecent(); wellInit();
    }catch(e){ say('Could not load your saved settings — reload the page before saving, or your saved phone and birthday could be lost: '+e.message, true); }
  })();
</script>
</body></html>`;


/* ---------------------------------------------------------------------------
 * /describe — SHARE-TO-DESCRIBE (July 11 2026). Blind-first: big Play button,
 * aria-live status, auto-read attempt, reminder offers for detected dates,
 * in-page picker, and the iPhone share-sheet Shortcut setup (iOS Safari has
 * no Web Share Target; Android installed PWAs share straight in).
 * ------------------------------------------------------------------------- */
const describeHtml = `<!doctype html><html lang="en"><head><title>Describe — Kade-AI</title>${SHARED_HEAD}
<style>
  .playbtn { font-size:1.35rem; font-weight:700; padding:1rem 2.2rem; border-radius:14px;
    border:0; background:#1d55d0; color:#fff; cursor:pointer; }
  .playbtn:focus-visible, button:focus-visible, .pickbtn:focus-visible { outline:4px solid #ffbf47; outline-offset:3px; }
  button.small { font-size:1rem; padding:.6rem 1.1rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; cursor:pointer; }
  @media (prefers-color-scheme: dark){ button.small{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  .pickbtn { display:inline-block; font-size:1.1rem; font-weight:700; padding:.9rem 1.6rem; border-radius:12px;
    background:#1f7a49; color:#fff; cursor:pointer; }
  #descText { font-size:1.12rem; }
  .datebtn { display:block; width:100%; text-align:left; margin:.4rem 0; font-size:1rem;
    padding:.7rem 1rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; cursor:pointer; }
  @media (prefers-color-scheme: dark){ .datebtn{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  code.tok { user-select:all; word-break:break-all; display:block; padding:.5rem; background:#eef1f4; border-radius:8px; }
  @media (prefers-color-scheme: dark){ code.tok{ background:#24272f; } }
</style>
</head><body>
<a class="back" href="/">&larr; Back to Kade-AI</a>
<h1>Describe</h1>
<p class="muted">Share or pick a photo, video, PDF, Word file, or text file — I will describe it or read it to you.</p>
<div id="status" class="status" role="status" aria-live="polite">Loading&hellip;</div>
<div id="controls" style="display:none; margin:1rem 0;">
  <button id="playBtn" class="playbtn" type="button">Play</button>
  <button id="stopBtn" class="small" type="button" style="margin-left:.6rem;">Stop</button>
  <label style="margin-left:.9rem;">Speed
    <select id="speed" aria-label="Reading speed">
      <option value="0.9">Slower</option>
      <option value="1" selected>Normal</option>
      <option value="1.2">Faster</option>
      <option value="1.4">Fastest</option>
    </select>
  </label>
</div>
<section id="resultSec" aria-label="Description" style="display:none;" class="card">
  <h2 id="resultTitle">Description</h2>
  <div id="descText"></div>
</section>
<section id="datesSec" aria-label="Dates found in this document" style="display:none;" class="card">
  <h2>Dates I spotted</h2>
  <p class="muted">Want me to remind you? Each button saves a reminder card — it will nudge you the way you chose on the Notifications page.</p>
  <div id="dateBtns"></div>
</section>
<section class="card" aria-label="Describe something">
  <h2>Describe another</h2>
  <label class="pickbtn" for="pick">Choose a photo or document</label>
  <input type="file" id="pick" accept="image/*,video/*,application/pdf,.pdf,.docx,.txt,.md,.csv,text/plain" style="position:absolute;width:1px;height:1px;opacity:0;">
</section>
<section class="card" aria-label="Set up sharing from your phone">
  <h2>Share straight from your phone</h2>
  <p><strong>Android:</strong> install Kade-AI (Add to Home Screen in Chrome) and "Kade-AI" appears right in the share menu for photos and files — nothing else to set up.</p>
  <details>
    <summary style="font-weight:700; cursor:pointer;">iPhone: add "Describe with Kade-AI" to your share sheet (one-time setup)</summary>
    <div id="iosSetup"><p class="muted">Sign in to see your personal setup link.</p></div>
  </details>
</section>
<footer class="muted">Descriptions cost about a tenth of a cent each — they land on your Usage &amp; Balance page like everything else.</footer>
<script>
(function(){
  var TOKEN=null, shareId=null, result=null;
  var qs=new URLSearchParams(location.search);
  shareId=qs.get('id');
  var statusEl=document.getElementById('status');
  function setStatus(t,isErr){ statusEl.textContent=t; statusEl.className='status'+(isErr?' err':''); }

  /* ---------- speech: platform TTS when signed in, device voice otherwise ---------- */
  var chunks=[], qi=0, playing=false, paused=false, curAudio=null, blobCache={};
  function chunkText(s){
    var out=[], cur='';
    var parts=String(s).replace(/\s+/g,' ').split(/(?<=[.!?])\s+/);
    for(var i=0;i<parts.length;i++){
      if((cur+' '+parts[i]).length>600){ if(cur)out.push(cur); cur=parts[i]; }
      else cur=cur?cur+' '+parts[i]:parts[i];
    }
    if(cur)out.push(cur);
    return out.filter(function(x){return x.trim();});
  }
  function speed(){ return Number(document.getElementById('speed').value)||1; }
  async function fetchClip(i){
    if(blobCache[i])return blobCache[i];
    var fd=new FormData();
    fd.append('input',chunks[i]);
    fd.append('speed',String(speed()));
    var r=await fetch('/api/files/speech/tts/manual',{method:'POST',headers:{Authorization:'Bearer '+TOKEN},body:fd});
    if(!r.ok)throw new Error('tts '+r.status);
    var b=await r.blob();
    blobCache[i]=URL.createObjectURL(b);
    return blobCache[i];
  }
  function stopAll(){
    playing=false; paused=false; qi=0;
    if(curAudio){ curAudio.pause(); curAudio=null; }
    try{ speechSynthesis.cancel(); }catch(e){}
    document.getElementById('playBtn').textContent='Play';
  }
  async function playFrom(i){
    if(!chunks.length)return;
    playing=true; paused=false;
    document.getElementById('playBtn').textContent='Pause';
    if(TOKEN){
      for(qi=i; qi<chunks.length && playing; ){
        var idx=qi;
        try{
          var url=await fetchClip(idx);
          if(!playing || qi!==idx)break;
          await new Promise(function(res,rej){
            curAudio=new Audio(url);
            curAudio.onended=function(){res();};
            curAudio.onerror=function(){rej(new Error('audio'));};
            curAudio.play().then(function(){ if(chunks[idx+1])fetchClip(idx+1).catch(function(){}); }).catch(rej);
          });
          if(!playing)break;
          qi++;
        }catch(e){ TOKEN=null; break; } /* fall through to device voice */
      }
      if(playing && qi>=chunks.length){ stopAll(); setStatus('Done reading.'); return; }
      if(!TOKEN && playing){ playFrom(qi); return; }
    } else {
      var remaining=chunks.slice(i).join(' ');
      var u=new SpeechSynthesisUtterance(remaining);
      u.rate=speed();
      u.onend=function(){ if(playing){ stopAll(); setStatus('Done reading.'); } };
      try{ speechSynthesis.cancel(); speechSynthesis.speak(u); }catch(e){ setStatus('This browser cannot speak — the text is written out below.',true); }
    }
  }
  document.getElementById('playBtn').addEventListener('click',function(){
    if(!playing){ playFrom(qi||0); return; }
    if(TOKEN){
      if(paused){ paused=false; if(curAudio)curAudio.play(); this.textContent='Pause'; }
      else { paused=true; if(curAudio)curAudio.pause(); this.textContent='Play'; }
    } else {
      if(paused){ paused=false; try{speechSynthesis.resume();}catch(e){} this.textContent='Pause'; }
      else { paused=true; try{speechSynthesis.pause();}catch(e){} this.textContent='Play'; }
    }
  });
  document.getElementById('stopBtn').addEventListener('click',function(){ stopAll(); setStatus('Stopped.'); });

  /* ---------- render ---------- */
  function speakable(){
    if(!result)return '';
    var t=result.description||'';
    if(result.readText){ t+=' ... Now the full text. ... '+result.readText; }
    return t;
  }
  function render(){
    var sec=document.getElementById('resultSec');
    var kindWord=result.kind==='image'?'photo':(result.kind==='video'?'video':'document');
    document.getElementById('resultTitle').textContent=
      'Your '+kindWord+(result.name?' — '+result.name:'');
    var d=document.getElementById('descText');
    d.textContent='';
    var p1=document.createElement('p'); p1.textContent=result.description; d.appendChild(p1);
    if(result.readText){
      var h=document.createElement('h3'); h.textContent='Full text'; d.appendChild(h);
      var p2=document.createElement('p'); p2.textContent=result.readText; d.appendChild(p2);
    }
    sec.style.display='';
    document.getElementById('controls').style.display='';
    chunks=chunkText(speakable()); qi=0; blobCache={};
    if(result.dates && result.dates.length){
      var wrap=document.getElementById('dateBtns'); wrap.textContent='';
      result.dates.forEach(function(dt){
        var b=document.createElement('button');
        b.type='button'; b.className='datebtn';
        b.textContent='Save reminder — '+dt.label+' on '+dt.when+' (Central)';
        b.addEventListener('click',async function(){
          b.disabled=true; b.textContent='Saving…';
          try{
            var r=await fetch('/api/kade/describe/reminder',{method:'POST',
              headers:Object.assign({'Content-Type':'application/json'},TOKEN?{Authorization:'Bearer '+TOKEN}:{}),
              body:JSON.stringify({id:shareId,when:dt.when,label:dt.label})});
            var j=await r.json();
            if(!r.ok)throw new Error(j.error||'failed');
            b.textContent='Saved — I will remind you: '+dt.label;
            setStatus('Reminder saved for '+dt.when+' Central.');
          }catch(e){ b.disabled=false; b.textContent='Save reminder — '+dt.label+' on '+dt.when+' (try again)'; setStatus('Could not save that reminder: '+e.message,true); }
        });
        wrap.appendChild(b);
      });
      document.getElementById('datesSec').style.display='';
    }
    var pb=document.getElementById('playBtn');
    pb.focus();
    playFrom(0); /* autoplay attempt; browsers may require one press of Play */
  }

  async function run(){
    setStatus('Describing — this usually takes a few seconds…');
    try{
      var r=await fetch('/api/kade/describe/run',{method:'POST',
        headers:Object.assign({'Content-Type':'application/json'},TOKEN?{Authorization:'Bearer '+TOKEN}:{}),
        body:JSON.stringify({id:shareId})});
      var j=await r.json();
      if(r.status===401){ setStatus('Please sign in to Kade-AI first, then share it again.',true); return; }
      if(!r.ok)throw new Error(j.error||('error '+r.status));
      result=j;
      setStatus(qs.get('more')?'Done. You shared more than one file — I described the first one; one at a time for now.':'Done.');
      render();
    }catch(e){ setStatus(e.message,true); }
  }

  async function uploadPicked(f){
    if(!TOKEN){ setStatus('Please sign in to Kade-AI first (open the app and log in), then come back.',true); return; }
    setStatus('Uploading '+f.name+'…');
    try{
      var fd=new FormData(); fd.append('media',f,f.name);
      var r=await fetch('/api/kade/describe/upload',{method:'POST',headers:{Authorization:'Bearer '+TOKEN},body:fd});
      var j=await r.json();
      if(!r.ok)throw new Error(j.error||('upload '+r.status));
      shareId=j.id; stopAll();
      document.getElementById('resultSec').style.display='none';
      document.getElementById('datesSec').style.display='none';
      run();
    }catch(e){ setStatus('Upload failed: '+e.message,true); }
  }
  document.getElementById('pick').addEventListener('change',function(){
    if(this.files && this.files[0]) uploadPicked(this.files[0]);
  });

  async function iosSetup(){
    if(!TOKEN)return;
    try{
      var r=await fetch('/api/kade/describe/token',{headers:{Authorization:'Bearer '+TOKEN}});
      var j=await r.json();
      if(!r.ok)return;
      var el=document.getElementById('iosSetup');
      el.innerHTML='';
      var steps=[
        'Open the Shortcuts app and tap the plus button to make a new Shortcut.',
        'Tap the info button at the bottom, turn ON "Show in Share Sheet", then set the accepted types to Images, Media, PDFs, and Files.',
        'Add the action "Get Contents of URL". Set the URL to your personal link below. Change Method to POST, and under Request Body choose Form; add one Form field named media, set its type to File, and choose the Shortcut Input (the shared file) as its value.',
        'Add the action "Get Dictionary Value" — key: url — from the Contents of URL result.',
        'Add the action "Open URLs" with that value.',
        'Name it "Describe with Kade-AI" and you are done — from any photo or PDF, tap Share, then Describe with Kade-AI, and this page opens and starts reading.'
      ];
      var intro=document.createElement('p');
      intro.textContent='Your personal upload link (treat it like a password — it lets things be described on your account):';
      el.appendChild(intro);
      var code=document.createElement('code'); code.className='tok'; code.textContent=j.ingestUrl; el.appendChild(code);
      var copy=document.createElement('button'); copy.type='button'; copy.className='small'; copy.textContent='Copy my link';
      copy.style.margin='.5rem 0 1rem';
      copy.addEventListener('click',function(){ navigator.clipboard.writeText(j.ingestUrl).then(function(){ copy.textContent='Copied'; setTimeout(function(){copy.textContent='Copy my link';},2000); }); });
      el.appendChild(copy);
      var ol=document.createElement('ol');
      steps.forEach(function(t){ var li=document.createElement('li'); li.textContent=t; li.style.margin='.4rem 0'; ol.appendChild(li); });
      el.appendChild(ol);
    }catch(e){}
  }

  (async function init(){
    TOKEN=await getToken();
    var err=qs.get('err');
    if(err==='empty'){ setStatus('That share came through empty — try again and pick the actual photo or file.',true); return; }
    if(err==='share'){ setStatus('Something went wrong receiving that share — try again.',true); return; }
    iosSetup();
    if(shareId){ run(); }
    else if(TOKEN){ setStatus('Pick a photo or document below, or share one straight from your phone.'); }
    else { setStatus('Sign in to Kade-AI (open the app and log in), then come back to this page.',true); }
  })();
})();
</script>
</body></html>`;


const toolsHtml = `<!doctype html><html lang="en"><head><title>Tools — Kade-AI</title>${SHARED_HEAD}</head>
<body>
<main>
<a class="back" href="/">&larr; Back to chat</a>
<h1>Tools</h1>
<p class="muted">Everything Kade-AI can do, in one place. Tap any one.</p>
<nav class="hublist" aria-label="Tools">
  <a class="hubitem" href="/transcribe"><span class="hicon" aria-hidden="true">🎙️</span><span><strong>Transcribe &amp; dictate</strong><small>Record or upload audio, get clean text, or organize it into notes</small></span></a>
  <a class="hubitem" href="/describe"><span class="hicon" aria-hidden="true">🖼️</span><span><strong>Describe</strong><small>Have any photo, video, PDF, or document described or read aloud</small></span></a>
  <a class="hubitem" href="/spotter"><span class="hicon" aria-hidden="true">👁️</span><span><strong>Your Spotter</strong><small>Set up your personal live video companion</small></span></a>
  <a class="hubitem" href="/lounge"><span class="hicon" aria-hidden="true">🎙️</span><span><strong>Kade's Clubhouse</strong><small>Live family voice rooms with a shared jukebox, private Hotel rooms, and companion guests</small></span></a>
  <a class="hubitem" href="/debate-room"><span class="hicon" aria-hidden="true">🗣️</span><span><strong>Debate Room</strong><small>Put characters in a room with a topic and jump in</small></span></a>
  <a class="hubitem" href="/conversation-hall"><span class="hicon" aria-hidden="true">🏛️</span><span><strong>Conversation Hall</strong><small>The greatest hits people have shared from the Debate Room</small></span></a>
  <a class="hubitem" href="/parlor"><span class="hicon" aria-hidden="true">🎲</span><span><strong>The Parlor</strong><small>Every game on a menu, party tables with friends, and the family standings</small></span></a>
  <a class="hubitem" href="/matchmaker"><span class="hicon" aria-hidden="true">💘</span><span><strong>Matchmaker</strong><small>Five quick questions to match you with characters</small></span></a>
  <a class="hubitem" href="/wall-of-fame"><span class="hicon" aria-hidden="true">🏆</span><span><strong>Wall of Fame</strong><small>Creations everyone has chosen to share</small></span></a>
  <a class="hubitem" href="/my-creations"><span class="hicon" aria-hidden="true">🎨</span><span><strong>My Creations</strong><small>Every video and image you have made, with downloads</small></span></a>
</nav>
</main>
<footer class="muted">&mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>
</body></html>`;

const youHtml = `<!doctype html><html lang="en"><head><title>You — Kade-AI</title>${SHARED_HEAD}</head>
<body>
<main>
<a class="back" href="/">&larr; Back to chat</a>
<h1>You</h1>
<p class="muted">Your account and settings.</p>
<nav class="hublist" aria-label="Your account">
  <a class="hubitem" href="/feed-the-server"><span class="hicon" aria-hidden="true">💳</span><span><strong>Donate &mdash; Feed the Server</strong><small>See your usage and balance, and chip in to keep this running</small></span></a>
  <a class="hubitem" href="/notifications"><span class="hicon" aria-hidden="true">🔔</span><span><strong>Notifications &amp; Reminders</strong><small>Birthday nudges and reminders — in chat, push, or by phone</small></span></a>
  <a class="hubitem" href="/pronunciation-dictionary"><span class="hicon" aria-hidden="true">🗣️</span><span><strong>Pronunciation Dictionary</strong><small>Teach Kade-AI how to say names or words you use</small></span></a>
  <a class="hubitem" href="/logbook"><span class="hicon" aria-hidden="true">📔</span><span><strong>Your Logbook</strong><small>The dated record your companions keep of your days &mdash; browse, add, or forget entries</small></span></a>
  <a class="hubitem" href="/brief"><span class="hicon" aria-hidden="true">🌅</span><span><strong>Morning Brief</strong><small>One push a day from your companion &mdash; your weather, a headline, your day ahead. Turn it on, pick your time</small></span></a>
  <a class="hubitem" href="#" id="exportLink"><span class="hicon" aria-hidden="true">📦</span><span><strong>Download Your Data</strong><small>Everything that's yours &mdash; memories, logbook, every conversation &mdash; as one zip you keep forever</small></span></a>
  <script>(function(){ var el=document.getElementById('exportLink'); el.addEventListener('click', async function(ev){ ev.preventDefault(); var small=el.querySelector('small'); var orig=small.textContent; small.textContent='Packing your zip — a few seconds…'; try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); var j=await r.json(); var t=j&&j.token; var resp=await fetch('/api/export/mine',{headers:{Authorization:'Bearer '+t}}); if(!resp.ok) throw new Error('export answered '+resp.status); var blob=await resp.blob(); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='kade-ai-export.zip'; document.body.appendChild(a); a.click(); a.remove(); small.textContent='Done — check your downloads. '+orig; }catch(e){ small.textContent='Could not pack it just now — try again in a minute.'; } }); })();</script>
  <a class="hubitem" id="accessReqLink" href="/access-requests" style="display:none;"><span class="hicon" aria-hidden="true">🚪</span><span><strong>Access Requests</strong><small>People asking to join &mdash; approve or deny, the blessing text writes itself</small></span></a>
  <script>(async function(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return; var j=await r.json(); var t=j&&j.token; if(!t) return; var a=await fetch('/api/admin/access-requests?status=pending',{headers:{Authorization:'Bearer '+t}}); if(a.ok){ document.getElementById('accessReqLink').style.display=''; var d=await a.json(); var n=(d.requests||[]).length; if(n>0){ var small=document.querySelector('#accessReqLink small'); small.textContent = n+(n===1?' person is':' people are')+' waiting at the door right now'; } } }catch(e){} })();</script>
  <a class="hubitem" href="/help"><span class="hicon" aria-hidden="true">❓</span><span><strong>Help &amp; FAQ</strong><small>How everything works</small></span></a>
</nav>
<p class="muted" style="margin-top:1.25rem"><a href="/settings">Settings</a> (speech, accessibility, appearance) and <a href="/files">your files</a> have their own addresses now. Signing out is on <a href="/home">Home</a>.</p>
</main>
<footer class="muted">&mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>
</body></html>`;


const pronunciationDictionaryHtml = `<!doctype html><html lang="en"><head><title>Pronunciation Dictionary — Kade-AI</title>${SHARED_HEAD}
<style>
  .dict-row { display:flex; align-items:center; justify-content:space-between; gap:.75rem; padding:.75rem 0; border-bottom:1px solid #e3e6ea; flex-wrap:wrap; }
  @media (prefers-color-scheme: dark){ .dict-row{ border-color:#2c2f37; } }
  .dict-row:last-child { border-bottom:0; }
  .dict-term { font-weight:700; }
  .dict-pron { opacity:.8; }
  button.small { font-size:1rem; padding:.6rem 1.1rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; cursor:pointer; }
  @media (prefers-color-scheme: dark){ button.small{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  button.small:focus-visible { outline:4px solid #ffbf47; outline-offset:2px; }
  button.danger { border-color:#c0392b; color:#c0392b; }
  @media (prefers-color-scheme: dark){ button.danger{ color:#ff8f80; border-color:#7a2c22; } }
  form.addform label { display:block; font-weight:600; margin:.6rem 0 .3rem; }
  form.addform input[type=text] { width:100%; font-size:1rem; padding:.6rem .7rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; }
  @media (prefers-color-scheme: dark){ form.addform input[type=text]{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  form.addform input:focus-visible { outline:4px solid #ffbf47; outline-offset:2px; }
  .pickbtn { display:inline-block; font-size:1.1rem; font-weight:700; padding:.9rem 1.6rem; border-radius:12px; border:0;
    background:#1f7a49; color:#fff; cursor:pointer; }
  .pickbtn:focus-visible { outline:4px solid #ffbf47; outline-offset:3px; }
</style>
</head><body>
<a class="back" href="/you">&larr; Back</a>
<h1>Pronunciation Dictionary</h1>
<p class="muted">A name or word Kade-AI mishears or says wrong? Add it once, spelled the way it sounds, and it is used everywhere: recognizing your voice on calls and in Transcribe, and reading it back correctly in voice messages and Spotter calls.</p>
<div id="status" class="status" role="status" aria-live="polite">Loading your dictionary&hellip;</div>
<section id="listSec" class="card" aria-label="Your words" style="display:none;">
  <h2>Your words</h2>
  <div id="list"></div>
</section>
<section class="card" aria-label="Add a word">
  <h2 id="formTitle">Add a word</h2>
  <form class="addform" id="addForm">
    <label for="term">Word, as it is normally spelled</label>
    <input type="text" id="term" name="term" autocomplete="off" required>
    <label for="pron">Respelling, for how it should sound</label>
    <input type="text" id="pron" name="pron" autocomplete="off" required placeholder="for example, Katie">
    <div style="margin-top:1rem;">
      <button class="pickbtn" type="submit" id="saveBtn">Save</button>
      <button class="small" type="button" id="cancelBtn" style="display:none; margin-left:.6rem;">Cancel</button>
    </div>
  </form>
</section>
<footer class="muted">&mdash; &copy; 2026 Kade Murdock &middot; Kade-AI</footer>
<script>
(function(){
  var TOKEN=null, entries=[], editingId=null;
  var statusEl=document.getElementById('status');
  function setStatus(t,isErr){ statusEl.textContent=t; statusEl.className='status'+(isErr?' err':''); }
  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token||null; }catch(e){ return null; } }
  async function apiGet(p){ var r=await fetch(p,{headers:{Authorization:'Bearer '+TOKEN}}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  async function apiPost(p,body){
    var r=await fetch(p,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    if(!r.ok){ var t=await r.text(); var msg=t; try{ msg=JSON.parse(t).error||t; }catch(e){} throw new Error(msg); }
    return r.json();
  }
  async function apiDelete(p){ var r=await fetch(p,{method:'DELETE',headers:{Authorization:'Bearer '+TOKEN}}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

  function renderList(){
    var listSec=document.getElementById('listSec'), list=document.getElementById('list');
    list.innerHTML='';
    if(!entries.length){ listSec.style.display='none'; return; }
    listSec.style.display='';
    entries.forEach(function(e){
      var row=document.createElement('div');
      row.className='dict-row';
      var text=document.createElement('div');
      var term=document.createElement('div'); term.className='dict-term'; term.textContent=e.term;
      var pron=document.createElement('div'); pron.className='dict-pron'; pron.textContent='sounds like: '+e.pronunciation;
      text.appendChild(term); text.appendChild(pron);
      var actions=document.createElement('div');
      var editBtn=document.createElement('button'); editBtn.type='button'; editBtn.className='small'; editBtn.textContent='Change';
      editBtn.setAttribute('aria-label','Change pronunciation for '+e.term);
      editBtn.addEventListener('click', function(){ startEdit(e); });
      var delBtn=document.createElement('button'); delBtn.type='button'; delBtn.className='small danger'; delBtn.textContent='Delete'; delBtn.style.marginLeft='.5rem';
      delBtn.setAttribute('aria-label','Delete '+e.term+' from your dictionary');
      delBtn.addEventListener('click', function(){ removeEntry(e); });
      actions.appendChild(editBtn); actions.appendChild(delBtn);
      row.appendChild(text); row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function startEdit(e){
    editingId=e.id;
    document.getElementById('formTitle').textContent='Change pronunciation for "'+e.term+'"';
    var termInput=document.getElementById('term');
    termInput.value=e.term;
    termInput.disabled=true;
    document.getElementById('pron').value=e.pronunciation;
    document.getElementById('cancelBtn').style.display='';
    document.getElementById('pron').focus();
  }

  function resetForm(){
    editingId=null;
    document.getElementById('formTitle').textContent='Add a word';
    var termInput=document.getElementById('term');
    termInput.disabled=false;
    document.getElementById('addForm').reset();
    document.getElementById('cancelBtn').style.display='none';
  }

  async function removeEntry(e){
    if(!confirm('Remove "'+e.term+'" from your dictionary?')) return;
    try{
      await apiDelete('/api/kade/pronunciation-dictionary/'+encodeURIComponent(e.id));
      entries=entries.filter(function(x){ return x.id!==e.id; });
      renderList();
      setStatus('Removed "'+e.term+'".');
    }catch(err){
      setStatus('Could not remove that entry — try again.', true);
    }
  }

  async function load(){
    try{
      var data=await apiGet('/api/kade/pronunciation-dictionary');
      entries=data.entries||[];
      renderList();
      setStatus(entries.length ? ('You have '+entries.length+' word'+(entries.length===1?'':'s')+' in your dictionary.') : 'No words yet — add your first one below.');
    }catch(err){
      setStatus('Could not load your pronunciation dictionary — try again in a moment.', true);
    }
  }

  document.getElementById('cancelBtn').addEventListener('click', resetForm);
  document.getElementById('addForm').addEventListener('submit', async function(ev){
    ev.preventDefault();
    var term=document.getElementById('term').value.trim();
    var pron=document.getElementById('pron').value.trim();
    if(!term || !pron) return;
    var saveBtn=document.getElementById('saveBtn');
    saveBtn.disabled=true; saveBtn.textContent='Saving…';
    try{
      // POST's own response is just {entry:{term,pronunciation}} -- no id
      // (confirmed live: the id only comes back from GET, a real Mongo
      // _id assigned server-side). Re-fetching the canonical list rather
      // than trying to patch local state from this response is what
      // PronunciationDictionaryService.swift's saveEntry() already does
      // natively for the exact same reason -- matching that here rather
      // than pushing a locally-built object that would be missing the id
      // its own Delete/Change buttons need.
      await apiPost('/api/kade/pronunciation-dictionary', {term:term, pronunciation:pron});
      setStatus('Saved "'+term+'".');
      resetForm();
      await load();
    }catch(err){
      setStatus(err && err.message ? err.message : 'Could not save that entry — try again.', true);
    }
    saveBtn.disabled=false; saveBtn.textContent='Save';
  });

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ setStatus('Sign in to Kade-AI (open the app and log in), then come back to this page.', true); return; }
    await load();
  })();
})();
</script>
</body></html>`;

const tabBarAsset = `(function(){
  if (window.__kadeTabsLoaded) return; window.__kadeTabsLoaded = true;
  var css = "body{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px)) !important;} nav.kadetabs{position:fixed;left:0;right:0;bottom:0;z-index:60;display:flex;background:#ffffff;border-top:1px solid #d9dde3;padding-bottom:env(safe-area-inset-bottom,0px);box-shadow:0 -2px 10px rgba(0,0,0,.06);} nav.kadetabs a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:8px 4px 10px;min-height:56px;text-decoration:none;color:#5b6270;font-size:.78rem;font-weight:600;} nav.kadetabs a .ic{font-size:1.45rem;line-height:1;} nav.kadetabs a[aria-current=page]{color:#1d55d0;} nav.kadetabs a:focus-visible{outline:3px solid #ffbf47;outline-offset:-3px;} @media (prefers-color-scheme:dark){nav.kadetabs{background:#1a1d23;border-top-color:#2c2f37;} nav.kadetabs a{color:#9aa3b5;} nav.kadetabs a[aria-current=page]{color:#6ea8ff;}}";
  function build(){
    if (!document.body || document.querySelector('nav.kadetabs')) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var path = location.pathname; if (path.length > 1 && path.charAt(path.length-1) === '/') path = path.slice(0,-1); if (!path) path = '/';
    var toolPages = ['/tools','/describe','/transcribe','/spotter','/debate-room','/conversation-hall','/game-room','/matchmaker','/wall-of-fame','/my-creations','/calls'];
    var youPages = ['/you','/feed-the-server','/usage-dashboard','/feedback-dashboard','/pronunciation-dictionary'];
    var active = 'chats';
    if (path === '/notifications') active = 'alerts';
    else if (youPages.indexOf(path) !== -1) active = 'you';
    else if (toolPages.indexOf(path) !== -1) active = 'tools';
    else if (path === '/') active = 'chats';
    else active = 'tools';
    if (path === '/home' || path === '/conversations' || path === '/announcements') active = 'home';
    else if (active === 'tools') active = 'home';
    var items = [['home','/home','Home','🏠'],['chats','/','Chats','💬'],['alerts','/notifications','Alerts','🔔'],['you','/you','You','👤']];
    var nav = document.createElement('nav'); nav.className = 'kadetabs'; nav.setAttribute('aria-label','Main navigation');
    for (var i=0;i<items.length;i++){ var it=items[i]; var a=document.createElement('a'); a.href=it[1]; var ic=document.createElement('span'); ic.className='ic'; ic.setAttribute('aria-hidden','true'); ic.textContent=it[3]; var tx=document.createElement('span'); tx.textContent=it[2]; a.appendChild(ic); a.appendChild(tx); if(it[0]===active) a.setAttribute('aria-current','page'); nav.appendChild(a); }
    document.body.appendChild(nav);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
`;


/* ADMIN LOGS VIEWER (session 21h). Drill-down: users -> their conversations ->
 * the messages, laid out like the user's own chat. Read-only support tool.
 * Reuses SHARED_HEAD's getToken()/apiGet()/styles; the API is admin-guarded. */
const logsHtml = `<!doctype html><html lang="en"><head><title>Kade-AI Logs</title>${SHARED_HEAD}
<style>
  .logrow { display:flex; justify-content:space-between; align-items:center; gap:.6rem;
    width:100%; text-align:left; padding:.8rem 1rem; border:1px solid #d9dde3; border-radius:12px;
    background:#fff; margin-bottom:.5rem; cursor:pointer; font:inherit; color:inherit; }
  .logrow:hover { border-color:#1d55d0; }
  .logrow:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .logrow .meta { color:#5b6270; font-size:.82rem; white-space:nowrap; }
  .bubble { max-width:46rem; padding:.6rem .9rem; border-radius:14px; margin:.4rem 0; white-space:pre-wrap; }
  .bubble.user { background:#1d55d0; color:#fff; margin-left:auto; }
  .bubble.bot  { background:#eef1f6; color:#12151b; margin-right:auto; }
  .bubble .who { display:block; font-size:.72rem; font-weight:700; opacity:.85; margin-bottom:.15rem; }
  .bubble.playing { outline: 3px solid #ffb000; }
  .bubble .act { font-size:.8rem; margin:.4rem .4rem 0 0; }
  .bubble .ts  { display:block; font-size:.68rem; opacity:.7; margin-top:.2rem; }
  .crumbs { color:#5b6270; font-size:.9rem; margin:.2rem 0 1rem; }
  .crumbs button { font:inherit; color:#1d55d0; background:none; border:none; cursor:pointer; padding:0; }
  #search { width:100%; padding:.7rem .9rem; border:1px solid #d9dde3; border-radius:12px; font:inherit; margin-bottom:1rem; }
  @media (prefers-color-scheme: dark) {
    .logrow { background:#1a1d23; border-color:#2c2f37; } .logrow .meta { color:#9aa3b5; }
    .bubble.bot { background:#242832; color:#e6e9ef; } #search { background:#1a1d23; border-color:#2c2f37; color:#e6e9ef; }
  }
</style></head>
<body>
  <p><a class="back" href="/usage-dashboard" aria-label="Back to the dashboard">&larr; Back to dashboard</a></p>
  <h1>Logs</h1>
  <p class="muted">Admin view. Look up any user's conversations to see exactly what happened — the same layout they see.</p>
  <div id="status" class="status" role="status" aria-live="polite">Loading&hellip;</div>
  <main id="content" hidden>
    <div id="crumbs" class="crumbs" aria-live="polite"></div>
    <div id="usersView">
      <input id="search" type="search" placeholder="Search users by name or email" aria-label="Search users" />
      <div id="usersList"></div>
    </div>
    <div id="convosView" hidden><div id="convosList"></div></div>
    <div id="messagesView" hidden><div id="messagesList"></div></div>
  </main>
  <script>
    (function(){
      var status = document.getElementById('status');
      var content = document.getElementById('content');
      var usersView = document.getElementById('usersView');
      var convosView = document.getElementById('convosView');
      var messagesView = document.getElementById('messagesView');
      var crumbs = document.getElementById('crumbs');
      var allUsers = [];
      var token = null;

      function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
      function when(d){ if(!d) return ''; try { return new Date(d).toLocaleString(); } catch(e){ return ''; } }
      function show(view){ usersView.hidden = view!=='users'; convosView.hidden = view!=='convos'; messagesView.hidden = view!=='messages'; }

      function setCrumbs(parts){
        crumbs.innerHTML = '';
        parts.forEach(function(p, i){
          if(i) crumbs.appendChild(document.createTextNode('  ›  '));
          if(p.onClick){ var b=document.createElement('button'); b.textContent=p.label; b.onclick=p.onClick; crumbs.appendChild(b); }
          else { crumbs.appendChild(document.createTextNode(p.label)); }
        });
      }

      function renderUsers(list){
        var box = document.getElementById('usersList');
        if(!list.length){ box.innerHTML = '<p class="muted">No users found.</p>'; return; }
        box.innerHTML = '';
        list.forEach(function(u){
          var b = document.createElement('button');
          b.className = 'logrow';
          b.innerHTML = '<span>'+esc(u.name)+(u.role==='ADMIN'?' <span class="meta">(admin)</span>':'')+'<br><span class="meta">'+esc(u.email)+'</span></span>'+
                        '<span class="meta">'+u.convoCount+' chat'+(u.convoCount===1?'':'s')+'</span>';
          b.setAttribute('aria-label', u.name+', '+u.email+', '+u.convoCount+' conversations');
          b.onclick = function(){ openUser(u); };
          box.appendChild(b);
        });
      }

      function filterUsers(){
        var q = (document.getElementById('search').value||'').toLowerCase().trim();
        if(!q){ renderUsers(allUsers); return; }
        renderUsers(allUsers.filter(function(u){ return (u.name+' '+u.email).toLowerCase().indexOf(q)>=0; }));
      }

      async function openUser(u){
        show('convos'); status.textContent=''; status.className='status';
        setCrumbs([{label:'Users', onClick:backToUsers}, {label:u.name}]);
        var box = document.getElementById('convosList');
        box.innerHTML = '<p class="muted">Loading conversations&hellip;</p>';
        var r = await apiGet('/api/kade/admin/logs-convos?userId='+encodeURIComponent(u.id), token);
        if(!r.ok){ box.innerHTML = '<p class="status err">Could not load conversations.</p>'; return; }
        var d = await r.json();
        var convos = d.convos||[];
        if(!convos.length){ box.innerHTML = '<p class="muted">This user has no conversations.</p>'; return; }
        box.innerHTML = '';
        convos.forEach(function(c){
          var b = document.createElement('button');
          b.className = 'logrow';
          b.innerHTML = '<span>'+esc(c.title)+'</span><span class="meta">'+esc(when(c.updatedAt))+'</span>';
          b.setAttribute('aria-label', c.title+', last active '+when(c.updatedAt));
          b.onclick = function(){ openConvo(u, c); };
          box.appendChild(b);
        });
      }

      async function openConvo(u, c){
        show('messages'); status.textContent=''; status.className='status';
        setCrumbs([{label:'Users', onClick:backToUsers}, {label:u.name, onClick:function(){ openUser(u); }}, {label:c.title}]);
        var box = document.getElementById('messagesList');
        box.innerHTML = '<p class="muted">Loading messages&hellip;</p>';
        var r = await apiGet('/api/kade/admin/logs-messages?conversationId='+encodeURIComponent(c.conversationId), token);
        if(!r.ok){ box.innerHTML = '<p class="status err">Could not load messages.</p>'; return; }
        var d = await r.json();
        var msgs = d.messages||[];
        if(!msgs.length){ box.innerHTML = '<p class="muted">No messages in this conversation.</p>'; return; }
        box.innerHTML = '';
        /* Part 126 (Sep 4 2026), her ask: hear these logs the way she hears her
         * own chats. The clip the person heard is not kept anywhere, so each
         * character line is re-made in THE VOICE THAT SEAT HAD CHOSEN for this
         * character (the route resolves it); the person's own lines are read by
         * the browser's plain voice so the two are never confused. "Play from
         * here" walks the rest of the conversation in order. */
        var voice = d.voice || null;
        var player = new Audio();
        var queue = null;
        function stopAll(){ queue = null; try{ player.pause(); }catch(e){} try{ window.speechSynthesis && window.speechSynthesis.cancel(); }catch(e){} }
        function speakUser(text){ return new Promise(function(done){ try { var u = new SpeechSynthesisUtterance(text); u.onend = done; u.onerror = done; window.speechSynthesis.speak(u); } catch(e){ done(); } }); }
        async function speakBot(text){
          if(!voice) return speakUser(text);
          var body = new URLSearchParams(); body.set('input', text); body.set('voice', voice);
          var rr = await fetch('/api/files/speech/tts/manual', { method:'POST', headers:{'Authorization':'Bearer '+token}, body: body });
          if(!rr.ok){ status.hidden=false; status.className='status err'; status.textContent='Could not make the voice for that line.'; return; }
          var blob = await rr.blob();
          return new Promise(function(done){ player.src = URL.createObjectURL(blob); player.onended = done; player.onerror = done; player.play().catch(done); });
        }
        async function playFrom(i){
          stopAll(); var my = {}; queue = my;
          for(var k=i; k<msgs.length; k++){
            if(queue !== my) return;
            var m = msgs[k];
            var el = box.children[k+1]; if(el){ el.classList.add('playing'); el.scrollIntoView({block:'nearest'}); }
            if(m.isUser) await speakUser((m.sender||'User') + ' said: ' + m.text); else await speakBot(m.text);
            if(el) el.classList.remove('playing');
          }
        }
        var bar = document.createElement('p'); bar.className='hint';
        bar.textContent = voice ? ('Character lines play in the voice this person chose for this character (' + voice + '). Their own lines are read by your browser\'s plain voice.') : 'No voice could be resolved for this conversation; lines will be read by your browser\'s plain voice.';
        var stopBtn = document.createElement('button'); stopBtn.className='logrow'; stopBtn.textContent='Stop playing'; stopBtn.onclick = stopAll; stopBtn.style.marginTop='.4rem';
        bar.appendChild(document.createElement('br')); bar.appendChild(stopBtn);
        box.appendChild(bar);
        msgs.forEach(function(m, i){
          var div = document.createElement('div');
          div.className = 'bubble ' + (m.isUser?'user':'bot');
          div.innerHTML = '<span class="who">'+esc(m.isUser?'User':m.sender)+'</span>'+esc(m.text)+'<span class="ts">'+esc(when(m.createdAt))+'</span>';
          var hear = document.createElement('button'); hear.type='button'; hear.className='act quiet'; hear.textContent = m.isUser ? 'Hear it' : 'Hear it in their voice';
          hear.setAttribute('aria-label', (m.isUser?'Hear this message':'Hear this reply in the voice they heard') + ', ' + when(m.createdAt));
          hear.onclick = function(){ stopAll(); var my={}; queue=my; (m.isUser ? speakUser(m.text) : speakBot(m.text)); };
          var from = document.createElement('button'); from.type='button'; from.className='act quiet'; from.textContent='Play from here'; from.onclick = function(){ playFrom(i); };
          var row = document.createElement('div'); row.appendChild(hear); row.appendChild(from);
          div.appendChild(row);
          box.appendChild(div);
        });
      }

      function backToUsers(){ show('users'); setCrumbs([{label:'Users'}]); }

      (async function(){
        token = await getToken();
        if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }
        var r = await apiGet('/api/kade/admin/logs-users', token);
        if(r.status===401 || r.status===403){ status.className='status err'; status.textContent='This page is for admins only.'; return; }
        if(!r.ok){ status.className='status err'; status.textContent='Could not load the logs right now. Try reloading.'; return; }
        var d = await r.json();
        allUsers = d.users||[];
        status.hidden = true; content.hidden = false;
        setCrumbs([{label:'Users'}]);
        renderUsers(allUsers);
        document.getElementById('search').addEventListener('input', filterUsers);
      })();
    })();
  </script>
</body></html>`;


/* ── THE PARLOR (July 23 2026 night — Kade's RS-Games-style menu room:
 * pick a game, seat characters if you want them, play YOUR OWN moves as
 * buttons, a narrator voice from her clone pool calls the table, table talk
 * on the side, transcript downloads for bragging rights. No LLM anywhere in
 * the mechanics — the engine's legal-move tokens ARE the buttons.) ───── */
const parlorHtml = `<!doctype html><html lang="en"><head><title>The Parlor</title>${SHARED_HEAD}
<style>
  .movegrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .55rem; margin-top: .6rem; }
  button.mv, button.game, button.opt {
    font: inherit; text-align: left; background: #fff; color: inherit;
    border: 1px solid #cdd3da; border-radius: 12px; padding: .75rem .9rem; cursor: pointer;
  }
  button.mv { border-width: 2px; border-color: #1f7a49; font-weight: 600; }
  button.mv:focus-visible, button.game:focus-visible, button.opt:focus-visible, .rowbtn:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    button.mv, button.game, button.opt { background: #1e2127; border-color: #3a4150; }
    button.mv { border-color: #2f8f5b; }
  }
  .gamelist { display: grid; gap: .55rem; margin-top: .6rem; }
  button.game .desc { display: block; font-weight: 400; opacity: .8; font-size: .92rem; margin-top: .15rem; }
  .rowbtn { font: inherit; background: #1f7a49; color: #fff; border: 0; border-radius: 10px; padding: .7rem 1.1rem; font-weight: 600; cursor: pointer; margin: .35rem .4rem .35rem 0; }
  .rowbtn.gray { background: #5b6270; }
  .rowbtn.red { background: #a33; }
  label.blk { display: block; margin: .7rem 0 .25rem; font-weight: 600; }
  select, input[type="text"], input[type="number"] { font: inherit; padding: .55rem .6rem; border-radius: 9px; border: 1px solid #cdd3da; background: #fff; color: inherit; max-width: 100%; }
  @media (prefers-color-scheme: dark) { select, input[type="text"], input[type="number"] { background: #1e2127; border-color: #3a4150; } }
  .seatbox { display: grid; gap: .3rem; margin-top: .35rem; max-height: 14rem; overflow: auto; border: 1px solid #cdd3da; border-radius: 10px; padding: .6rem; }
  #tlines { white-space: pre-wrap; }
  #talklog li { margin: .3rem 0; }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="#gameroom" id="gr-link">Game Room standings</a> &nbsp;&middot;&nbsp; <a class="back" href="/help/games">How the games work</a></p>
  <h1>The Parlor</h1>
  <div id="status" class="status" role="status" aria-live="polite">Warming up the tables&hellip;</div>

  <section id="menu" hidden>
    <p class="muted">Every game, on a menu. Pick one, set the table your way, and play your own cards &mdash; characters are optional company, never the referee.</p>
    <div id="resume-card" class="card" hidden>
      <h2 style="margin-top:0">Your open tables</h2>
      <div id="resume-list" class="gamelist"></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Join a friend's table</h2>
      <label class="blk" for="join-code">The 4-character code from your host</label>
      <input type="text" id="join-code" autocapitalize="characters" maxlength="8" style="text-transform:uppercase">
      <p><button type="button" class="rowbtn" id="join-btn">Take a seat</button></p>
    </div>
    <h2>Deal something new</h2>
    <div id="game-list" class="gamelist" role="list"></div>
    <div class="card">
      <h2 style="margin-top:0">The Game Room</h2>
      <p class="muted">Family bragging rights, straight from the referee &mdash; standings, highlights, latest results, and your chip bank. It lives here in the Parlor now.</p>
      <p><button type="button" class="rowbtn" id="gr-open">See the standings</button></p>
    </div>
  </section>

  <section id="gameroom" hidden>
    <style>
      .crown { font-size: .8rem; font-weight: 700; padding: .1rem .55rem; border-radius: 999px; background: #fdf1d7; color: #8a6100; margin-left: .4rem; }
      @media (prefers-color-scheme: dark) { .crown { background: #5c4300; color: #ffe9b3; } }
      li.result { margin: .3rem 0; }
    </style>
    <h2 id="gr-h" tabindex="-1" style="margin-top:0">The Game Room</h2>
    <p class="muted">Every finished game counts &mdash; walking away from a table never does.</p>
    <p><button type="button" class="rowbtn gray" id="gr-back">Back to the menu</button></p>
    <div id="gr-status" class="status" role="status" aria-live="polite">Loading the standings&hellip;</div>
    <section class="card" aria-labelledby="mine-h" id="mine-card" hidden>
      <h3 id="mine-h" style="margin-top:0">Your side of the table</h3>
      <p id="mine-chips"></p>
      <ul id="mine-tables" style="list-style:none; padding:0; margin:0"></ul>
    </section>
    <main id="gr-content" hidden>
      <section class="card" aria-labelledby="standings-h">
        <h3 id="standings-h" style="margin-top:0">Family standings</h3>
        <p id="standings-summary"></p>
        <table id="standings">
          <caption class="muted" style="text-align:left; caption-side:top">All games combined, most wins first. Chips are fake chips &mdash; never real money.</caption>
          <thead><tr><th scope="col">Player</th><th scope="col" class="num">Wins</th><th scope="col" class="num">Losses</th><th scope="col" class="num">Draws</th><th scope="col" class="num">Played</th><th scope="col" class="num">Blackjack chips</th></tr></thead>
          <tbody></tbody>
        </table>
      </section>
      <section class="card" aria-labelledby="dailyword-h" id="dailyword-card" hidden>
        <h3 id="dailyword-h" style="margin-top:0">Daily Word streaks</h3>
        <p class="muted" style="margin:.1rem 0 .4rem">One secret five-letter word a day, same word for everybody. Say &ldquo;play daily word&rdquo; to any companion.</p>
        <table id="dailyword">
          <thead><tr><th scope="col">Player</th><th scope="col" class="num">Streak</th><th scope="col" class="num">Best</th><th scope="col" class="num">Solved</th><th scope="col" class="num">Played</th><th scope="col">Today</th></tr></thead>
          <tbody></tbody>
        </table>
      </section>
      <section class="card" aria-labelledby="highlights-h" id="highlights-card" hidden>
        <h3 id="highlights-h" style="margin-top:0">Highlights</h3>
        <dl class="kv" id="highlights"></dl>
      </section>
      <div id="pergame"></div>
      <section class="card" aria-labelledby="recent-h" id="recent-card" hidden>
        <h3 id="recent-h" style="margin-top:0">Latest results</h3>
        <ul id="recent" style="list-style:none; padding:0; margin:0"></ul>
      </section>
    </main>
  </section>

  <section id="setup" hidden>
    <h2 id="setup-title">Set the table</h2>
    <form id="setup-form">
      <div id="opt-opponents-wrap" hidden><label class="blk" for="opt-opponents">House players (no personality, quick moves)</label><select id="opt-opponents"></select></div>
      <div id="opt-seats-wrap" hidden>
        <label class="blk" id="seats-label">Seat characters (their real personalities play &mdash; up to 3)</label>
        <input type="text" id="seat-filter" aria-label="Filter the character list" placeholder="Type to filter characters&hellip;">
        <div class="seatbox" id="seat-list" role="group" aria-labelledby="seats-label"></div>
      </div>
      <div id="opt-party-wrap" hidden>
        <label class="blk" for="opt-party">Open seats for friends (they join with a code)</label>
        <select id="opt-party"><option value="0" selected>None — just my table</option><option value="1">1 friend</option><option value="2">2 friends</option><option value="3">3 friends</option></select>
      </div>
      <div id="opt-rounds-wrap" hidden><label class="blk" for="opt-rounds">Length</label><select id="opt-rounds"></select></div>
      <div id="opt-difficulty-wrap" hidden><label class="blk" for="opt-difficulty">Difficulty</label><select id="opt-difficulty"></select></div>
      <div id="opt-category-wrap" hidden><label class="blk" for="opt-category">Topic</label><select id="opt-category"></select></div>
      <div id="opt-bet-wrap" hidden><label class="blk" for="opt-bet">Chip bet</label><input type="number" id="opt-bet" min="1" max="500" value="10"></div>
      <div id="opt-clean-wrap" hidden><label class="blk"><input type="checkbox" id="opt-clean"> Family-clean deck</label></div>

      <label class="blk" for="opt-narrator">Narrator &mdash; the house voice</label>
      <select id="opt-narrator">
        <optgroup label="Kade's voices">
          <option value="Voice 466" selected>Kade Candid</option>
          <option value="Voice 464">Kade conversational</option>
          <option value="Voice 327">Kade calm and casual</option>
          <option value="Voice 424">Kade's child impression</option>
        </optgroup>
        <optgroup label="Miss A's voices">
          <option value="Voice 385">Miss A Irish</option>
          <option value="Voice 391">Miss A animated</option>
          <option value="Voice 393">Miss A pro reading</option>
          <option value="Voice 463">Miss A casual</option>
        </optgroup>
        <option value="__custom">Another voice by number&hellip;</option>
      </select>
      <div id="opt-narrator-custom-wrap" hidden><label class="blk" for="opt-narrator-custom">Voice label (like &ldquo;Voice 52&rdquo;)</label><input type="text" id="opt-narrator-custom"></div>
      <label class="blk" for="opt-narrate-mode">Narrator speaks</label>
      <select id="opt-narrate-mode">
        <option value="events" selected>Game events (dealing, plays, wins)</option>
        <option value="everything">Everything (events + character chatter)</option>
        <option value="off">Nothing &mdash; my screen reader has it</option>
      </select>

      <p><button type="submit" class="rowbtn">Deal the table</button>
      <button type="button" class="rowbtn gray" id="setup-back">Back to the menu</button></p>
    </form>
  </section>

  <section id="table" hidden>
    <h2 id="ttitle"></h2>
    <div id="tstatus" class="status" role="status" aria-live="polite" tabindex="-1"></div>
    <div class="card"><h3 style="margin-top:0">The table</h3><div id="tlines"></div></div>
    <div id="moves-card" class="card"><h3 style="margin-top:0" id="moves-h">Your moves</h3><div id="tmoves" class="movegrid" role="group" aria-labelledby="moves-h"></div></div>
    <div class="card" id="talk-card" hidden>
      <h3 style="margin-top:0">Table talk</h3>
      <ul id="talklog" style="list-style:none; padding:0; margin:0 0 .5rem"></ul>
      <label class="blk" for="talk-input" id="talk-label">Say something to the table</label>
      <input type="text" id="talk-input" maxlength="280" style="width:100%">
      <p><button type="button" class="rowbtn" id="talk-send">Say it</button></p>
    </div>
    <p>
      <button type="button" class="rowbtn gray" id="btn-reread">Read the table again</button>
      <button type="button" class="rowbtn gray" id="btn-log">Download the transcript</button>
      <button type="button" class="rowbtn red" id="btn-quit">Quit this table</button>
      <button type="button" class="rowbtn gray" id="btn-menu">Back to the menu</button>
    </p>
  </section>

  <footer class="muted">Same tables as chat and the phone line &mdash; deal here, say &ldquo;deal me in&rdquo; to any companion later, and it picks right up. &mdash; Kade-AI</footer>

  <script>
    (async function(){
      const $ = (id) => document.getElementById(id);
      const status = $('status');
      let token = null; try { token = await getToken(); } catch(e) {}
      if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }

      let games = [];
      let roster = null;
      let current = null;   // chosen game meta (menu -> setup)
      let table = null;     // live table payload
      let narrator = { voice: 'Voice 466', mode: 'events' };

      /* ── speech: one queue, one audio element, her clone on the mic ── */
      const speaker = new Audio();
      let speechQueue = []; let speaking = false;
      function speak(text){
        if(narrator.mode === 'off' || !text) return;
        speechQueue.push(text);
        if(!speaking) nextSpeech();
      }
      async function nextSpeech(){
        const text = speechQueue.shift();
        if(text == null){ speaking = false; return; }
        speaking = true;
        try{
          const r = await fetch('/api/files/speech/tts/manual', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ input: text, voice: narrator.voice }) });
          if(!r.ok) throw new Error('tts '+r.status);
          const blob = await r.blob();
          speaker.src = URL.createObjectURL(blob);
          speaker.onended = () => { URL.revokeObjectURL(speaker.src); nextSpeech(); };
          speaker.onerror = () => { nextSpeech(); };
          await speaker.play();
        }catch(e){ nextSpeech(); }
      }
      function stopSpeech(){ speechQueue = []; try{ speaker.pause(); }catch(e){} speaking = false; }

      /* ── table sounds: the same clips the chat plays ── */
      function playCues(cues){
        (cues||[]).slice(0,6).forEach(function(c, i){
          setTimeout(function(){ try{ new Audio('/assets/sounds/'+c+'.mp3').play().catch(function(){}); }catch(e){} }, i*350);
        });
      }

      async function api(method, path, body){
        const r = await fetch(path, { method: method, headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(function(){ return {}; });
        if(!r.ok){ throw new Error(j.error || ('HTTP '+r.status)); }
        return j;
      }

      function show(section){
        ['menu','setup','table'].forEach(function(id){ $(id).hidden = (id !== section); });
      }
      function esc(s){ const d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML; }

      /* ── MENU ── */
      async function loadMenu(){
        show('menu'); stopSpeech();
        status.textContent = 'Pick a game from the menu below.';
        try{
          const mt = await api('GET', '/api/kade/my-tables');
          const open = (mt.active||[]);
          $('resume-card').hidden = open.length === 0;
          $('resume-list').innerHTML = open.map(function(t){
            return '<button type="button" class="game" data-resume="'+esc(t.gameId)+'">Resume '+esc(t.name)+' <span class="desc">table '+esc(t.gameId)+' &middot; '+t.turns+' turns in</span></button>';
          }).join('');
        }catch(e){}
        if(!games.length){
          const g = await api('GET', '/api/kade/parlor/games');
          games = g.games || [];
        }
        $('game-list').innerHTML = games.map(function(g){
          return '<button type="button" class="game" role="listitem" data-game="'+esc(g.key)+'">'+esc(g.name)+' <span class="desc">'+esc(g.blurb)+' ('+esc(g.players)+' player'+(g.players==='1'?'':'s')+(g.seatAware?' &middot; characters can sit in':'')+')</span></button>';
        }).join('');
      }

      $('game-list').addEventListener('click', function(ev){
        const b = ev.target.closest('button[data-game]'); if(!b) return;
        current = games.find(function(g){ return g.key === b.getAttribute('data-game'); });
        openSetup();
      });
      $('resume-list').addEventListener('click', async function(ev){
        const b = ev.target.closest('button[data-resume]'); if(!b) return;
        try{
          const p = await api('GET', '/api/kade/parlor/state/'+b.getAttribute('data-resume'));
          openTable(p, true);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });

      /* ── SETUP ── */
      function fillRange(sel, spec, labelFor){
        sel.innerHTML='';
        for(let v=spec[0]; v<=spec[1]; v++){
          const o=document.createElement('option'); o.value=String(v); o.textContent=labelFor?labelFor(v):String(v);
          if(v===spec[2]) o.selected=true; sel.appendChild(o);
        }
      }
      async function openSetup(){
        show('setup');
        $('setup-title').textContent = 'Set the table — '+current.name;
        status.textContent = current.name+': '+current.blurb;
        const o = current.options || {};
        $('opt-opponents-wrap').hidden = !o.opponents;
        if(o.opponents) fillRange($('opt-opponents'), o.opponents, function(v){ return v===0?'Just me':String(v); });
        $('opt-rounds-wrap').hidden = !o.rounds;
        if(o.rounds) fillRange($('opt-rounds'), o.rounds);
        $('opt-difficulty-wrap').hidden = !o.difficulty;
        if(o.difficulty){ $('opt-difficulty').innerHTML='<option value="">Mixed</option>'+o.difficulty.map(function(d){ return '<option>'+d+'</option>'; }).join(''); }
        $('opt-category-wrap').hidden = !o.category;
        if(o.category){ $('opt-category').innerHTML='<option value="">Any topic</option>'+o.category.map(function(c){ return '<option value="'+c+'">'+c.replace(/_/g,' ')+'</option>'; }).join(''); }
        $('opt-bet-wrap').hidden = !o.bet;
        $('opt-clean-wrap').hidden = !o.clean;
        $('opt-seats-wrap').hidden = !current.seatAware;
        $('opt-party-wrap').hidden = !current.seatAware;
        if(current.seatAware && !roster){
          try{
            const r = await api('GET', '/api/kade/room/agents');
            roster = r.agents || [];
          }catch(e){ roster = []; }
        }
        if(current.seatAware) renderSeats('');
      }
      function renderSeats(filter){
        const f = filter.toLowerCase();
        $('seat-list').innerHTML = (roster||[]).filter(function(a){ return !f || a.name.toLowerCase().includes(f); }).slice(0, 60).map(function(a){
          return '<label><input type="checkbox" name="seat" value="'+esc(a.name)+'"> '+esc(a.name)+'</label>';
        }).join('') || '<p class="muted">No characters matched.</p>';
      }
      $('seat-filter').addEventListener('input', function(){
        const checked = Array.from(document.querySelectorAll('input[name="seat"]:checked')).map(function(c){ return c.value; });
        renderSeats($('seat-filter').value);
        checked.forEach(function(v){ const c = document.querySelector('input[name="seat"][value="'+CSS.escape(v)+'"]'); if(c) c.checked = true; });
      });
      $('opt-narrator').addEventListener('change', function(){
        $('opt-narrator-custom-wrap').hidden = $('opt-narrator').value !== '__custom';
      });
      $('setup-back').addEventListener('click', loadMenu);

      $('setup-form').addEventListener('submit', async function(ev){
        ev.preventDefault();
        narrator.voice = $('opt-narrator').value === '__custom' ? ($('opt-narrator-custom').value.trim() || 'Voice 466') : $('opt-narrator').value;
        narrator.mode = $('opt-narrate-mode').value;
        const seats = Array.from(document.querySelectorAll('input[name="seat"]:checked')).slice(0,3).map(function(c){ return c.value; });
        const body = { game: current.key };
        if(!$('opt-party-wrap').hidden){
          const po = parseInt($('opt-party').value, 10) || 0;
          if(po > 0) body.party_open_seats = po;
        }
        if(seats.length && current.seatAware) body.agent_seats = seats;
        else if(!$('opt-opponents-wrap').hidden) body.opponents = parseInt($('opt-opponents').value, 10);
        if(!$('opt-rounds-wrap').hidden) body.rounds = parseInt($('opt-rounds').value, 10);
        if(!$('opt-difficulty-wrap').hidden && $('opt-difficulty').value) body.difficulty = $('opt-difficulty').value;
        if(!$('opt-category-wrap').hidden && $('opt-category').value) body.category = $('opt-category').value;
        if(!$('opt-bet-wrap').hidden) body.bet = parseInt($('opt-bet').value, 10) || 10;
        if(!$('opt-clean-wrap').hidden) body.clean = $('opt-clean').checked;
        status.textContent = 'Dealing…';
        try{
          const p = await api('POST', '/api/kade/parlor/new', body);
          speak('New table. '+current.name+'.');
          openTable(p, false);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });

      /* ── PARTY (phase 2): join, poll, your-turn gating ── */
      let partyTimer = null;
      let historyCursor = 0;
      $('join-btn').addEventListener('click', async function(){
        const code = $('join-code').value.trim().toUpperCase();
        if(!code) return;
        try{
          const p = await api('POST', '/api/kade/parlor/join', { code: code });
          $('join-code').value = '';
          openTable(p, false);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      function startPartyPolling(){
        stopPartyPolling();
        partyTimer = setInterval(async function(){
          if(!table || !table.party) return;
          try{
            const p = await api('GET', '/api/kade/parlor/party-state/'+table.gameId+'?since='+historyCursor);
            const fresh = (p.log || []).length > 0;
            historyCursor = p.historyCursor || historyCursor;
            if(fresh || p.yourTurn !== table.yourTurn || p.over !== table.over){
              renderTable(p, fresh ? null : ['']);
            } else {
              table = p;
            }
          }catch(e){}
        }, 2500);
      }
      function stopPartyPolling(){ if(partyTimer){ clearInterval(partyTimer); partyTimer = null; } }

      /* ── TABLE ── */
      function narrate(logLines){
        if(narrator.mode === 'off') return;
        (logLines||[]).forEach(function(l){
          const isChatter = / says: /.test(l);
          if(isChatter && narrator.mode !== 'everything') return;
          speak(l.replace(/ says: /, ' says, '));
        });
      }
      function openTable(p, resumed){
        table = p; show('table');
        historyCursor = p.historyCursor || p.historyCount || 0;
        $('ttitle').textContent = p.name + ' — table ' + p.gameId + (p.party && p.code ? ' — join code ' + p.code : '');
        $('talk-card').hidden = !((p.seatAgents && p.seatAgents.length) || (p.party && p.seatKinds && Object.values(p.seatKinds).indexOf('agent') !== -1));
        renderTable(p, resumed ? ['Back at the table.'] : null);
        if(p.party && p.code) speak('Your join code is ' + p.code.split('').join(' ') + '.');
        if(resumed) speak('Back at your '+p.name+' table.');
        if(p.party) startPartyPolling(); else stopPartyPolling();
      }
      function renderTable(p, extraStatus){
        table = p;
        $('tlines').textContent = (p.lines||[]).join('\n');
        const over = p.over;
        $('moves-h').textContent = over ? 'This table is finished' : (p.party ? (p.yourTurn ? 'Your moves' : 'Waiting on ' + (p.turnName || p.names[p.turnSeat] || 'the table')) : (p.turnSeat === 0 ? 'Your moves' : 'Waiting on ' + (p.names[p.turnSeat]||'the table')));
        $('tmoves').innerHTML = over
          ? '<button type="button" class="mv" id="btn-rematch">Deal a rematch</button>'
          : (p.legal||[]).map(function(m){ return '<button type="button" class="mv" data-move="'+esc(m.token)+'">'+esc(m.label)+'</button>'; }).join('') || '<p class="muted">No moves for you right now.</p>';
        const news = (extraStatus || p.log || []).join(' ');
        $('tstatus').textContent = news || (over ? 'Game over.' : 'Your table is ready.');
        playCues(p.sounds);
        narrate(p.log);
        $('tstatus').focus({ preventScroll: false });
      }
      $('tmoves').addEventListener('click', async function(ev){
        const r = ev.target.closest('#btn-rematch');
        if(r){ openSetup(); return; }
        const b = ev.target.closest('button[data-move]'); if(!b || !table) return;
        try{
          const path = table.party ? '/api/kade/parlor/party-move/' : '/api/kade/parlor/move/';
          const p = await api('POST', path+table.gameId, { move: b.getAttribute('data-move') });
          if(p.historyCursor) historyCursor = p.historyCursor;
          renderTable(p);
        }catch(e){
          $('tstatus').textContent = e.message; speak(e.message);
          try{ const p = await api('GET', '/api/kade/parlor/state/'+table.gameId); renderTable(p, [e.message]); }catch(e2){}
        }
      });
      $('btn-reread').addEventListener('click', function(){
        if(!table) return;
        $('tstatus').textContent = 'Reading the table.';
        speak((table.lines||[]).join(' '));
      });
      $('btn-log').addEventListener('click', async function(){
        if(!table) return;
        try{
          const r = await fetch('/api/kade/parlor/log/'+table.gameId, { headers:{ 'Authorization':'Bearer '+token } });
          const blob = await r.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'kade-parlor-'+table.gameKey+'-'+table.gameId+'.txt';
          document.body.appendChild(a); a.click(); a.remove();
          $('tstatus').textContent = 'Transcript downloaded.';
        }catch(e){ $('tstatus').textContent = 'Could not download the transcript.'; }
      });
      $('btn-quit').addEventListener('click', async function(){
        if(!table) return;
        if(!confirm('Close this table for good?')) return;
        try{ await api('POST', '/api/kade/parlor/quit/'+table.gameId); }catch(e){}
        loadMenu();
      });
      $('btn-menu').addEventListener('click', function(){ stopPartyPolling(); loadMenu(); });
      $('talk-send').addEventListener('click', sendTalk);
      $('talk-input').addEventListener('keydown', function(ev){ if(ev.key === 'Enter'){ ev.preventDefault(); sendTalk(); } });
      async function sendTalk(){
        const text = $('talk-input').value.trim(); if(!text || !table) return;
        $('talk-input').value = '';
        const li = document.createElement('li'); li.textContent = 'You: '+text; $('talklog').appendChild(li);
        try{
          const r = await api('POST', '/api/kade/parlor/talk/'+table.gameId, { text: text });
          const li2 = document.createElement('li'); li2.textContent = r.name+': '+r.line; $('talklog').appendChild(li2);
          if(narrator.mode === 'everything') speak(r.name+' says, '+r.line);
        }catch(e){
          const li3 = document.createElement('li'); li3.textContent = '(no reply — '+e.message+')'; $('talklog').appendChild(li3);
        }
      }

      /* ── The Game Room, folded into the Parlor (July 24 2026, her call:
         "the game room seems redundant with the parlor... combining them.") ── */
      var grLoaded = false;
      function grEl(id){ return document.getElementById(id); }
      function grShow(){
        grEl('menu').hidden = true; grEl('setup').hidden = true; grEl('table').hidden = true;
        grEl('gameroom').hidden = false;
        if(!grLoaded){ grLoaded = true; loadGameRoom(); }
        try{ grEl('gr-h').focus(); }catch(e){}
      }
      function grBack(){
        grEl('gameroom').hidden = true; grEl('menu').hidden = false;
        try{ grEl('gr-open').focus(); }catch(e){}
      }
      async function loadGameRoom(){
        var st = grEl('gr-status');
        try {
          const mt = await apiGet('/api/kade/my-tables', token);
          if (mt.ok) {
            const m = await mt.json();
            const esc0 = function(s){ const dv=document.createElement('div'); dv.textContent = s==null?'':s; return dv.innerHTML; };
            grEl('mine-chips').innerHTML =
              'Chip bank: <strong>' + num(m.chips) + '</strong> fake chips (never real money)' +
              (m.lifetimeWon || m.lifetimeLost ? ' — lifetime ' + num(m.lifetimeWon) + ' won, ' + num(m.lifetimeLost) + ' lost.' : '.');
            grEl('mine-tables').innerHTML = (m.active || []).map(function(t){
              return '<li class="result">Table ' + esc0(t.gameId) + ' — ' + esc0(t.name) + ', ' + num(t.turns) + ' turns in. It is on the menu under Your open tables.</li>';
            }).join('') || '<li class="result muted">No tables in play right now.</li>';
            grEl('mine-card').hidden = false;
          }
        } catch(e) {}
        var r; try { r = await apiGet('/api/kade/game-leaderboard', token); } catch(e) { r = null; }
        if(!r || !r.ok){
          st.className = 'status err';
          st.textContent = 'Could not load the standings right now. Try again in a moment.';
          return;
        }
        const d = await r.json();
        function esc(s){ const div=document.createElement('div'); div.textContent = s == null ? '' : s; return div.innerHTML; }
        function when(iso){
          try { return new Date(iso).toLocaleString('en-US', { month:'long', day:'numeric' }); }
          catch(e){ return ''; }
        }
        if(!d.finished){
          st.textContent = 'No finished games yet — the board is wide open. Deal something and claim the first win!';
          return;
        }
        st.textContent = d.finished + ' finished game' + (d.finished===1?'':'s') + ' on the books' +
          (d.activeTables ? ', ' + d.activeTables + ' table' + (d.activeTables===1?'':'s') + ' still in play.' : '.');
        const champ = d.players[0];
        grEl('standings-summary').innerHTML = champ && champ.wins > 0
          ? '<strong>' + esc(champ.by) + '</strong> leads the family with ' + champ.wins + ' win' + (champ.wins===1?'':'s') + ' across ' + champ.played + ' game' + (champ.played===1?'':'s') + '.'
          : 'Nobody has a win on the books yet — first one to finish a game takes the lead.';
        document.querySelector('#standings tbody').innerHTML = d.players.map(function(p, i){
          return '<tr><th scope="row">' + esc(p.by) + (i===0 && p.wins>0 ? ' <span class="crown">Champ</span>' : '') + '</th>' +
            '<td class="num">' + num(p.wins) + '</td><td class="num">' + num(p.losses) + '</td><td class="num">' + num(p.draws) + '</td>' +
            '<td class="num">' + num(p.played) + '</td><td class="num">' + (p.chips>0?'+':'') + num(p.chips) + '</td></tr>';
        }).join('');
        if(d.dailyWord && d.dailyWord.length){
          document.querySelector('#dailyword tbody').innerHTML = d.dailyWord.map(function(w){
            return '<tr><th scope="row">' + esc(w.by) + (w.streak>0 && w.streak>=(d.dailyWord[0].streak||0) && w.streak>0 ? ' <span class="crown">Hot</span>' : '') + '</th>' +
              '<td class="num">' + num(w.streak) + '</td><td class="num">' + num(w.best) + '</td>' +
              '<td class="num">' + num(w.wins) + '</td><td class="num">' + num(w.played) + '</td>' +
              '<td>' + (w.playedToday ? 'Played' : 'Not yet') + '</td></tr>';
          }).join('');
          grEl('dailyword-card').hidden = false;
        }
        const hl = [];
        if(d.highlights && d.highlights.biggestBlackjack){
          const b = d.highlights.biggestBlackjack;
          hl.push('<dt>Biggest Blackjack win</dt><dd>' + esc(b.by) + ' — ' + num(b.chips) + ' chips (' + when(b.when) + ')</dd>');
        }
        if(d.highlights && d.highlights.bestTrivia){
          const t = d.highlights.bestTrivia;
          hl.push('<dt>Best Trivia Night score</dt><dd>' + esc(t.by) + ' — ' + t.score + ' of ' + t.total + ' (' + when(t.when) + ')</dd>');
        }
        if(hl.length){
          grEl('highlights').innerHTML = hl.join('');
          grEl('highlights-card').hidden = false;
        }
        grEl('pergame').innerHTML = (d.games || []).map(function(g){
          const leader = g.rows[0];
          return '<section class="card" aria-labelledby="pg-h-' + esc(g.id || g.name).replace(/[^a-zA-Z0-9_-]/g,'') + '">' +
            '<h3 id="pg-h-' + esc(g.id || g.name).replace(/[^a-zA-Z0-9_-]/g,'') + '" style="margin:0 0 .25rem; font-size:1.05rem">' + esc(g.name) + '</h3>' +
            '<p class="muted" style="margin:.1rem 0 .4rem">' + num(g.played) + ' game' + (g.played===1?'':'s') + ' played' +
            (leader && leader.w>0 ? ' &middot; ' + esc(leader.by) + ' leads with ' + leader.w + ' win' + (leader.w===1?'':'s') : '') + '.</p>' +
            '<table><thead><tr><th scope="col">Player</th><th scope="col" class="num">Wins</th><th scope="col" class="num">Losses</th><th scope="col" class="num">Draws</th><th scope="col" class="num">Played</th></tr></thead><tbody>' +
            g.rows.map(function(rw){
              return '<tr><th scope="row">' + esc(rw.by) + '</th><td class="num">' + num(rw.w) + '</td><td class="num">' + num(rw.l) + '</td><td class="num">' + num(rw.d) + '</td><td class="num">' + num(rw.p) + '</td></tr>';
            }).join('') + '</tbody></table></section>';
        }).join('');
        if(d.recent && d.recent.length){
          grEl('recent').innerHTML = d.recent.map(function(x){
            const verb = x.outcome === 'won' ? 'won at' : x.outcome === 'lost' ? 'lost at' : 'drew at';
            return '<li class="result">' + esc(x.by) + ' ' + verb + ' ' + esc(x.game) +
              (x.detail ? ' — ' + esc(x.detail) : '') + ' <span class="muted">(' + when(x.when) + ')</span></li>';
          }).join('');
          grEl('recent-card').hidden = false;
        }
        grEl('gr-content').hidden = false;
      }
      grEl('gr-open').addEventListener('click', grShow);
      grEl('gr-back').addEventListener('click', grBack);
      grEl('gr-link').addEventListener('click', function(ev){ ev.preventDefault(); grShow(); });
      if((location.hash || '') === '#gameroom'){ setTimeout(grShow, 400); }

      await loadMenu();
      status.className = 'status';
    })();
  </script>
</body></html>`;

/* KADE Aug 7 2026 — THE DIARY PAGE (Living Diary Phase 4, her word same day).
 * The browsable surface over /api/diary: her day-to-day entries grouped by
 * date, newest first, each showing which companion holds it; forget any entry;
 * add a line by hand (manual adds are shared — written in HER diary, not told
 * to one character, so any companion may recall them; the page says so).
 * Screen-reader-first per the house standard: one polite live region carries
 * every state change, headings are the calendar, focus returns to the list
 * heading after a forget so VoiceOver never lands in a void. Static HTML,
 * client-side token via /api/auth/refresh — the exact pronunciation-dictionary
 * pattern. */
const diaryHtml = `<!doctype html><html lang="en"><head><title>Your Logbook — Kade-AI</title>${SHARED_HEAD}
<style>
  .entry-row { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; padding:.7rem 0; border-bottom:1px solid #e3e6ea; }
  .entry-row:last-child { border-bottom:0; }
  @media (prefers-color-scheme: dark){ .entry-row{ border-color:#2c2f37; } }
  .entry-text { font-size:1.02rem; }
  .entry-meta { font-size:.85rem; opacity:.75; margin-top:.15rem; }
  button.small { font-size:.9rem; padding:.45rem .8rem; border-radius:9px; border:1px solid #b9bfc9; background:transparent; color:inherit; cursor:pointer; white-space:nowrap; }
  button.small:focus-visible { outline:4px solid #ffbf47; outline-offset:2px; }
  button.danger { border-color:#c0392b; color:#c0392b; }
  @media (prefers-color-scheme: dark){ button.danger{ color:#ff8f80; border-color:#7a2c22; } }
  form.addform label { display:block; font-weight:600; margin:.6rem 0 .3rem; }
  form.addform textarea { width:100%; font-size:1rem; padding:.6rem .7rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; min-height:5.5rem; }
  @media (prefers-color-scheme: dark){ form.addform textarea{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  form.addform textarea:focus-visible { outline:4px solid #ffbf47; outline-offset:2px; }
  .pickbtn { display:inline-block; font-size:1.1rem; font-weight:700; padding:.9rem 1.6rem; border-radius:12px; border:0; background:#1f7a49; color:#fff; cursor:pointer; }
  .pickbtn:focus-visible { outline:4px solid #ffbf47; outline-offset:3px; }
  h2.datehead { font-size:1.05rem; margin:1.4rem 0 .2rem; }
</style>
</head><body>
<a class="back" href="/you">&larr; Back</a>
<h1>Your Logbook</h1>
<p class="muted">The dated record your companions quietly keep as you share your days — plus anything you write in yourself. Each entry stays with the companion you told it to; entries you add here can be recalled by any of them. Edit fixes an entry's wording in place; Forget removes it for good.</p>
<div id="status" class="status" role="status" aria-live="polite">Loading your logbook&hellip;</div>
<section id="listSec" aria-label="Logbook entries" style="display:none;">
  <h2 id="listTop" tabindex="-1" style="position:absolute;left:-9999px;">Logbook entries</h2>
  <div id="list"></div>
</section>
<section class="card" aria-label="Add an entry">
  <h2>Add an entry yourself</h2>
  <p class="muted" style="margin-top:0;">Dated today, in your own words. Any of your companions can recall entries you add here.</p>
  <form class="addform" id="addForm">
    <label for="entryText">What happened, or how the day went</label>
    <textarea id="entryText" name="entryText" required maxlength="2000"></textarea>
    <div style="margin-top:1rem;">
      <button class="pickbtn" type="submit" id="saveBtn">Save to logbook</button>
    </div>
  </form>
</section>
<section class="card" aria-labelledby="shareHead">
  <h2 id="shareHead">Memory sharing between your companions</h2>
  <p class="muted" style="margin-top:0;">Each companion keeps its own memories of you. Turn sharing on and the <strong>facts</strong> you told one &mdash; memory cards and logbook lines &mdash; can surface for another, marked as secondhand, so you never say a thing twice. Their <strong>opinions</strong> and their own read of you stay their own. Off is truly off; nothing is copied.</p>
  <fieldset id="shareSet" style="border:0;padding:0;margin:0;">
    <legend style="font-weight:600;margin-bottom:.4rem;">Who shares</legend>
    <label style="display:block;margin:.3rem 0;"><input type="radio" name="shareMode" value="off"> Off &mdash; each companion knows only what you told it</label>
    <label style="display:block;margin:.3rem 0;"><input type="radio" name="shareMode" value="all"> All my companions</label>
    <label style="display:block;margin:.3rem 0;"><input type="radio" name="shareMode" value="list"> Only the companions I pick</label>
  </fieldset>
  <div id="shareList" style="display:none;margin:.6rem 0 0 1.2rem;"></div>
  <div style="margin-top:1rem;">
    <button class="pickbtn" type="button" id="shareSave">Save sharing</button>
  </div>
  <div id="shareStatus" class="status" role="status" aria-live="polite" style="margin-top:.6rem;"></div>
</section>
<footer class="muted">&mdash; Kade-AI</footer>
<script>
(function(){
  var TOKEN=null, entries=[];
  var statusEl=document.getElementById('status');
  /* Part 129: the web's own sharing switch (Android and iPhone got theirs in Part 128). */
  var shareCompanions=[];
  function shareMode(){ var r=document.querySelector('input[name=shareMode]:checked'); return r?r.value:'off'; }
  function renderShareList(){
    var box=document.getElementById('shareList'); box.innerHTML='';
    box.style.display = shareMode()==='list' ? '' : 'none';
    if(shareMode()!=='list') return;
    if(shareCompanions.length<2){ var p=document.createElement('p'); p.className='muted'; p.textContent='Only one companion has memories of you so far, so there is nobody to share with yet.'; box.appendChild(p); return; }
    shareCompanions.forEach(function(c){
      var l=document.createElement('label'); l.style.display='block'; l.style.margin='.3rem 0';
      var cb=document.createElement('input'); cb.type='checkbox'; cb.value=c.agentId; cb.checked=!!c.on; cb.setAttribute('data-share','1');
      l.appendChild(cb); l.appendChild(document.createTextNode(' '+c.name));
      box.appendChild(l);
    });
  }
  async function loadShare(){
    var st=document.getElementById('shareStatus');
    try{
      var j=await apiGet('/api/kade/memory-share');
      var mode=j.mode||'off'; var picked=(j.agents||[]);
      shareCompanions=(j.companions||[]).map(function(c){ return { agentId:c.agentId, name:c.name, on: picked.indexOf(c.agentId)>=0 }; });
      var r=document.querySelector('input[name=shareMode][value="'+mode+'"]'); if(r) r.checked=true;
      renderShareList();
    }catch(e){ st.textContent='Could not read the sharing setting just now.'; st.className='status err'; }
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=shareMode]'), function(r){ r.addEventListener('change', renderShareList); });
  document.getElementById('shareSave').addEventListener('click', async function(){
    var st=document.getElementById('shareStatus'); var mode=shareMode();
    var agents=Array.prototype.map.call(document.querySelectorAll('#shareList input[data-share]:checked'), function(cb){ return cb.value; });
    if(mode==='list' && agents.length<2){ st.textContent='Pick at least two companions first.'; st.className='status err'; return; }
    st.textContent='Saving\u2026'; st.className='status';
    try{
      var r=await fetch('/api/kade/memory-share',{method:'PUT',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({mode:mode,agents:agents})});
      if(!r.ok){ throw new Error(await r.text()); }
      st.textContent='Saved. It takes effect on your next message.'; st.className='status';
    }catch(e){ st.textContent='Could not save that. '+(e&&e.message?e.message.slice(0,120):''); st.className='status err'; }
  });
  function setStatus(t,isErr){ statusEl.textContent=t; statusEl.className='status'+(isErr?' err':''); }
  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token||null; }catch(e){ return null; } }
  async function apiGet(p){ var r=await fetch(p,{headers:{Authorization:'Bearer '+TOKEN}}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  async function apiPost(p,body){ var r=await fetch(p,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body||{})}); if(!r.ok){ var t=await r.text(); var msg=t; try{ msg=JSON.parse(t).error||t; }catch(e){} throw new Error(msg); } return r.json(); }
  async function apiDelete(p){ var r=await fetch(p,{method:'DELETE',headers:{Authorization:'Bearer '+TOKEN}}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
  async function apiPatch(p,body){ var r=await fetch(p,{method:'PATCH',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body||{})}); if(!r.ok){ var t=await r.text(); var msg=t; try{ msg=JSON.parse(t).error||t; }catch(e){} throw new Error(msg); } return r.json(); }

  function prettyDate(ymd){
    try{
      var parts=ymd.split('-');
      var d=new Date(Number(parts[0]), Number(parts[1])-1, Number(parts[2]));
      return d.toLocaleDateString('en-US',{ weekday:'long', year:'numeric', month:'long', day:'numeric' });
    }catch(e){ return ymd; }
  }

  function metaLine(e){
    if(e.source==='manual'){ return 'Added by you'; }
    if(e.agentName){ return 'With '+e.agentName; }
    if(e.agentId){ return 'With one of your companions'; }
    return 'Shared — every companion may recall this';
  }

  function renderList(){
    var listSec=document.getElementById('listSec'), list=document.getElementById('list');
    list.innerHTML='';
    if(!entries.length){
      listSec.style.display='none';
      setStatus('Nothing here yet. Your logbook fills up as you share your days with your companions — or add a line yourself below.');
      return;
    }
    listSec.style.display='';
    var byDate={}; var order=[];
    entries.forEach(function(e){ if(!byDate[e.date]){ byDate[e.date]=[]; order.push(e.date); } byDate[e.date].push(e); });
    order.forEach(function(date){
      var h=document.createElement('h2'); h.className='datehead'; h.textContent=prettyDate(date);
      list.appendChild(h);
      var card=document.createElement('div'); card.className='card'; card.style.marginTop='.3rem';
      byDate[date].forEach(function(e){
        var row=document.createElement('div'); row.className='entry-row';
        var left=document.createElement('div');
        var txt=document.createElement('div'); txt.className='entry-text'; txt.textContent=e.text;
        var meta=document.createElement('div'); meta.className='entry-meta'; meta.textContent=metaLine(e);
        left.appendChild(txt); left.appendChild(meta);
        var btns=document.createElement('div'); btns.style.display='flex'; btns.style.flexDirection='column'; btns.style.gap='.4rem';
        var editBtn=document.createElement('button'); editBtn.type='button'; editBtn.className='small'; editBtn.textContent='Edit';
        editBtn.setAttribute('aria-label','Edit the entry from '+prettyDate(e.date)+': '+e.text.slice(0,60));
        editBtn.addEventListener('click', function(){ editEntry(e, row, left, btns); });
        var btn=document.createElement('button'); btn.type='button'; btn.className='small danger'; btn.textContent='Forget';
        btn.setAttribute('aria-label','Forget the entry from '+prettyDate(e.date)+': '+e.text.slice(0,60));
        btn.addEventListener('click', function(){ forgetEntry(e, btn); });
        btns.appendChild(editBtn); btns.appendChild(btn);
        row.appendChild(left); row.appendChild(btns);
        card.appendChild(row);
      });
      list.appendChild(card);
    });
  }

  function editEntry(e, row, left, btns){
    /* Inline editor: the row's text becomes a textarea with Save/Cancel.
     * Focus lands in the textarea; Escape cancels; the status line announces
     * the outcome for screen readers. Wording is the only thing that changes
     * — the entry keeps its date and who-knows-it scope. */
    btns.style.display='none';
    var oldHtml=left.innerHTML; left.innerHTML='';
    var lbl=document.createElement('label'); lbl.textContent='Edit the entry from '+prettyDate(e.date); lbl.style.fontWeight='600'; lbl.style.display='block'; lbl.style.marginBottom='.3rem';
    var taId='edit_'+e.id; lbl.setAttribute('for',taId);
    var ta=document.createElement('textarea'); ta.id=taId; ta.value=e.text; ta.maxLength=2000;
    ta.style.width='100%'; ta.style.minHeight='5rem'; ta.style.fontSize='1rem'; ta.style.padding='.5rem .6rem'; ta.style.borderRadius='10px';
    var actions=document.createElement('div'); actions.style.marginTop='.5rem'; actions.style.display='flex'; actions.style.gap='.6rem';
    var save=document.createElement('button'); save.type='button'; save.className='small'; save.textContent='Save';
    var cancel=document.createElement('button'); cancel.type='button'; cancel.className='small'; cancel.textContent='Cancel';
    function restore(){ left.innerHTML=oldHtml; btns.style.display=''; }
    cancel.addEventListener('click', function(){ restore(); setStatus('Edit cancelled.'); });
    ta.addEventListener('keydown', function(ev){ if(ev.key==='Escape'){ restore(); setStatus('Edit cancelled.'); } });
    save.addEventListener('click', async function(){
      var text=(ta.value||'').trim();
      if(!text){ setStatus('Write something first, or use Forget to remove the entry.', true); ta.focus(); return; }
      save.disabled=true; cancel.disabled=true;
      try{
        await apiPatch('/api/diary/'+encodeURIComponent(e.id),{ text:text });
        e.text=text;
        renderList();
        setStatus('Entry updated.');
      }catch(err){ save.disabled=false; cancel.disabled=false; setStatus('Could not save the edit: '+err.message, true); }
    });
    actions.appendChild(save); actions.appendChild(cancel);
    left.appendChild(lbl); left.appendChild(ta); left.appendChild(actions);
    ta.focus();
  }

  async function forgetEntry(e, btn){
    if(!window.confirm('Forget this entry for good?\\n\\n'+e.text)){ return; }
    btn.disabled=true;
    try{
      await apiDelete('/api/diary/'+encodeURIComponent(e.id));
      entries=entries.filter(function(x){ return x.id!==e.id; });
      renderList();
      setStatus('Entry forgotten.');
      var top=document.getElementById('listTop'); if(top){ top.focus(); }
    }catch(err){ btn.disabled=false; setStatus('Could not forget that entry: '+err.message, true); }
  }

  document.getElementById('addForm').addEventListener('submit', async function(ev){
    ev.preventDefault();
    var ta=document.getElementById('entryText'); var text=(ta.value||'').trim();
    if(!text){ setStatus('Write a line first.', true); ta.focus(); return; }
    var saveBtn=document.getElementById('saveBtn'); saveBtn.disabled=true;
    try{
      await apiPost('/api/diary',{ text:text });
      ta.value='';
      setStatus('Saved to your logbook.');
      await loadList();
    }catch(err){ setStatus('Could not save: '+err.message, true); }
    saveBtn.disabled=false;
  });

  async function loadList(){
    var data=await apiGet('/api/diary');
    entries=data.entries||[];
    renderList();
    if(entries.length){
      var n=entries.length;
      setStatus(String(n)+(n===1?' entry':' entries')+' in your logbook, newest first.'+(data.enabled===false?' The logbook is currently paused — nothing new is being written.':''));
    } else if(data.enabled===false){
      setStatus('The logbook is currently paused.');
    }
  }

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ setStatus('Please sign in on the main site first, then come back to this page.', true); return; }
    try{ await loadList(); }
    catch(e){ setStatus('Could not load your logbook just now. Pull to refresh or try again in a moment.', true); }
    loadShare();
  })();
})();
</script>
</body></html>`;

/* KADE Aug 9 2026 — THE FRONT DOOR (her registration overhaul): a public
 * ask-in page. No account needed — that's the point. Honeypot + server-side
 * rate limit carry the abuse load; the submit rings her phone. */
const requestAccessHtml = `<!doctype html><html lang="en"><head><title>Ask to Join — Kade-AI</title>${SHARED_HEAD}
<style>
  form label { display:block; font-weight:600; margin:.9rem 0 .3rem; }
  form input[type=text], form textarea { width:100%; font-size:1rem; padding:.6rem .7rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; }
  form textarea { min-height:5rem; }
  @media (prefers-color-scheme: dark){ form input[type=text], form textarea{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  .pickbtn { display:inline-block; font-size:1.1rem; font-weight:700; padding:.9rem 1.6rem; border-radius:12px; border:0; background:#1f7a49; color:#fff; cursor:pointer; margin-top:1rem; }
  .pickbtn:focus-visible { outline:4px solid #ffbf47; outline-offset:3px; }
  .hp { position:absolute; left:-9999px; height:1px; overflow:hidden; }
</style>
</head><body>
<a class="back" href="/login">&larr; Back to sign in</a>
<h1>Ask to Join</h1>
<p class="muted">Kade-AI is a private corner of the internet — family and friends of Kade's world. If that's you and nobody's handed you a code yet, knock here: tell her who you are, and the request goes straight to her phone. If she knows you, you'll hear back with your way in.</p>
<div id="status" class="status" role="status" aria-live="polite"></div>
<form id="askForm">
  <label for="name">What do people call you?</label>
  <input type="text" id="name" required maxlength="80" autocomplete="name">
  <label for="contact">How can Kade reach you? (phone or email)</label>
  <input type="text" id="contact" required maxlength="160" autocomplete="tel">
  <label for="who">Who are you — how do you know Kade or the family?</label>
  <textarea id="who" required maxlength="1200"></textarea>
  <label for="why">What brings you here? (optional)</label>
  <textarea id="why" maxlength="1200"></textarea>
  <div class="hp" aria-hidden="true"><label for="website">Website</label><input type="text" id="website" tabindex="-1" autocomplete="off"></div>
  <button class="pickbtn" type="submit" id="sendBtn">Send my request</button>
</form>
<footer class="muted">&mdash; Kade-AI</footer>
<script>
(function(){
  var statusEl=document.getElementById('status');
  function setStatus(t,isErr){ statusEl.textContent=t; statusEl.className='status'+(isErr?' err':''); }
  document.getElementById('askForm').addEventListener('submit', async function(ev){
    ev.preventDefault();
    var btn=document.getElementById('sendBtn'); btn.disabled=true;
    setStatus('Sending…');
    try{
      var r=await fetch('/api/access-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        name:document.getElementById('name').value,
        contact:document.getElementById('contact').value,
        whoYouAre:document.getElementById('who').value,
        whyHere:document.getElementById('why').value,
        website:document.getElementById('website').value
      })});
      var d=await r.json();
      if(r.ok && d.ok){ setStatus(d.message||'Request sent.'); document.getElementById('askForm').style.display='none'; }
      else setStatus(d.error||'Something hiccuped — try again.', true);
    }catch(e){ setStatus('Could not send just now — try again in a minute.', true); }
    btn.disabled=false;
  });
})();
</script>
</body></html>`;

/* Admin review page — the other side of the door. */
const accessRequestsHtml = `<!doctype html><html lang="en"><head><title>Access Requests — Kade-AI</title>${SHARED_HEAD}
<style>
  .req { border-bottom:1px solid #e3e6ea; padding:1rem 0; }
  @media (prefers-color-scheme: dark){ .req{ border-color:#2c2f37; } }
  .req h3 { margin:.1rem 0 .3rem; }
  .req .meta { font-size:.9rem; opacity:.75; }
  .req p { margin:.4rem 0; }
  .actions { display:flex; gap:.6rem; flex-wrap:wrap; margin-top:.6rem; }
  button.small { font-size:.95rem; padding:.5rem .9rem; border-radius:9px; border:1px solid #b9bfc9; background:transparent; color:inherit; cursor:pointer; }
  button.approve { border-color:#1f7a49; color:#1f7a49; font-weight:700; }
  button.deny { border-color:#c0392b; color:#c0392b; }
  @media (prefers-color-scheme: dark){ button.approve{ color:#7fd4a5; border-color:#2c5c42; } button.deny{ color:#ff8f80; border-color:#7a2c22; } }
  .blessing { background:rgba(31,122,73,.08); border-radius:10px; padding:.7rem .8rem; margin-top:.5rem; }
</style>
</head><body>
<a class="back" href="/you">&larr; Back</a>
<h1>Access Requests</h1>
<p class="muted">People knocking at the door. Approve as adult or kid and the blessing text writes itself &mdash; copy it and send it to them yourself; the code rides inside.</p>
<div id="status" class="status" role="status" aria-live="polite">Loading&hellip;</div>
<div id="list"></div>
<footer class="muted">&mdash; Kade-AI</footer>
<script>
(function(){
  var TOKEN=null;
  var statusEl=document.getElementById('status');
  function setStatus(t,isErr){ statusEl.textContent=t; statusEl.className='status'+(isErr?' err':''); }
  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token||null; }catch(e){ return null; } }
  async function api(method, path, body){ var r=await fetch(path,{method:method,headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}); if(!r.ok){ var t=await r.text(); var m=t; try{ m=JSON.parse(t).error||t; }catch(e){} throw new Error(m); } return r.json(); }
  function prettyWhen(iso){ try{ return new Date(iso).toLocaleString('en-US',{month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}); }catch(e){ return iso; } }

  function render(reqs){
    var list=document.getElementById('list'); list.innerHTML='';
    if(!reqs.length){ setStatus('Nobody at the door right now.'); return; }
    setStatus(reqs.length+(reqs.length===1?' person':' people')+' waiting.');
    reqs.forEach(function(rq){
      var d=document.createElement('div'); d.className='req';
      var h=document.createElement('h3'); h.textContent=rq.name; d.appendChild(h);
      var meta=document.createElement('div'); meta.className='meta'; meta.textContent='Asked '+prettyWhen(rq.createdAt)+' · reach them at: '+rq.contact; d.appendChild(meta);
      var who=document.createElement('p'); who.textContent='Who: '+rq.whoYouAre; d.appendChild(who);
      if(rq.whyHere){ var why=document.createElement('p'); why.textContent='Why: '+rq.whyHere; d.appendChild(why); }
      var acts=document.createElement('div'); acts.className='actions';
      var ok=document.createElement('button'); ok.type='button'; ok.className='small approve'; ok.textContent='Approve (adult)';
      var okC=document.createElement('button'); okC.type='button'; okC.className='small approve'; okC.textContent='Approve (kid)';
      var no=document.createElement('button'); no.type='button'; no.className='small deny'; no.textContent='Deny';
      ok.addEventListener('click', function(){ decide(rq,'approve','adult',d); });
      okC.addEventListener('click', function(){ decide(rq,'approve','child',d); });
      no.addEventListener('click', function(){ decide(rq,'deny',null,d); });
      acts.appendChild(ok); acts.appendChild(okC); acts.appendChild(no); d.appendChild(acts);
      list.appendChild(d);
    });
  }

  async function decide(rq, action, audience, card){
    try{
      var d=await api('POST','/api/admin/access-requests/'+rq.id+'/'+action, audience?{audience:audience}:{});
      if(action==='approve'){
        var b=document.createElement('div'); b.className='blessing';
        var p=document.createElement('p'); p.textContent=d.readyMessage; b.appendChild(p);
        var cp=document.createElement('button'); cp.type='button'; cp.className='small'; cp.textContent='Copy the blessing';
        cp.addEventListener('click', async function(){ try{ await navigator.clipboard.writeText(d.readyMessage); setStatus('Copied — send it to '+rq.contact); }catch(e){ setStatus('Select and copy the text above.', true); } });
        b.appendChild(cp);
        card.appendChild(b);
        card.querySelectorAll('.actions button').forEach(function(x){ x.disabled=true; });
        setStatus('Approved '+rq.name+' — the blessing text is ready below their card.');
      } else {
        card.style.opacity=.45;
        card.querySelectorAll('.actions button').forEach(function(x){ x.disabled=true; });
        setStatus('Denied. Nothing was sent to them.');
      }
    }catch(e){ setStatus('That did not go through: '+e.message, true); }
  }

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ setStatus('Sign in on the main site first, then come back.', true); return; }
    try{ var d=await api('GET','/api/admin/access-requests?status=pending'); render(d.requests||[]); }
    catch(e){ setStatus('Could not load (admin only): '+e.message, true); }
  })();
})();
</script>
</body></html>`;

/* KADE Aug 9 2026 — MORNING BRIEF SETTINGS (her spec, same evening she gave
 * it): per-account, plain and listenable. Runs on /api/brief (JWT), which
 * proxies the bridge server-side — the page never sees a secret. Listen
 * plays today's brief through the site's own TTS lane (same-origin), so
 * ears-first users get the brief the way they get everything else. */
const briefHtml = `<!doctype html><html lang="en"><head><title>Morning Brief — Kade-AI</title>${SHARED_HEAD}
<style>
  form.prefs label.row { display:flex; align-items:center; gap:.6rem; margin:.55rem 0; font-size:1.02rem; }
  form.prefs input[type=checkbox] { width:1.35rem; height:1.35rem; }
  form.prefs input[type=time], form.prefs input[type=text] { font-size:1rem; padding:.5rem .6rem; border-radius:10px; border:1px solid #b9bfc9; background:#fff; color:#16181d; }
  @media (prefers-color-scheme: dark){ form.prefs input[type=time], form.prefs input[type=text]{ background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  .pickbtn { display:inline-block; font-size:1.05rem; font-weight:700; padding:.8rem 1.4rem; border-radius:12px; border:0; background:#1f7a49; color:#fff; cursor:pointer; }
  .pickbtn:focus-visible, button.small:focus-visible { outline:4px solid #ffbf47; outline-offset:3px; }
  button.small { font-size:.95rem; padding:.5rem .9rem; border-radius:9px; border:1px solid #b9bfc9; background:transparent; color:inherit; cursor:pointer; }
  .brieftext { font-size:1.05rem; line-height:1.5; }
</style>
</head><body>
<a class="back" href="/you">&larr; Back</a>
<h1>Morning Brief</h1>
<p class="muted">One short push a day, written fresh by your companion: your town's weather, one worthwhile headline, and a nod to your day ahead. It goes only to your own phone, and only if you turn it on.</p>
<div id="status" class="status" role="status" aria-live="polite">Loading your settings&hellip;</div>

<section class="card" id="todaySec" style="display:none;" aria-label="Today's brief">
  <h2>Today's brief</h2>
  <p class="brieftext" id="todayText"></p>
  <div style="display:flex; gap:.8rem; margin-top:.6rem;">
    <button class="small" type="button" id="listenBtn">Listen</button>
  </div>
</section>

<section class="card" aria-label="Brief settings">
  <h2>Your settings</h2>
  <div id="linkNote" class="muted" style="display:none;">To actually receive the push, open the Kade-AI app on your phone once while signed in &mdash; that links your phone. Your settings save fine either way.</div>
  <form class="prefs" id="prefsForm">
    <label class="row"><input type="checkbox" id="enabled"> <span>Send me a morning brief</span></label>
    <label class="row" for="time"><span>At what time (Central)</span> <input type="time" id="time" value="09:00"></label>
    <fieldset style="border:0; padding:0; margin:.6rem 0;">
      <legend style="font-weight:600; margin-bottom:.2rem;">What goes in it</legend>
      <label class="row"><input type="checkbox" id="itemWeather" checked> <span>My weather</span></label>
      <label class="row"><input type="checkbox" id="itemNews" checked> <span>One good headline</span></label>
      <label class="row"><input type="checkbox" id="itemDayAhead" checked> <span>My day ahead (from what my companion knows)</span></label>
    </fieldset>
    <label class="row" for="location" style="align-items:flex-start; flex-direction:column; gap:.3rem;"><span>My town (for the weather)</span> <input type="text" id="location" placeholder="Highlandville, Missouri" maxlength="80" style="width:100%;"></label>
    <div style="display:flex; gap:.8rem; margin-top:1rem; flex-wrap:wrap;">
      <button class="pickbtn" type="submit" id="saveBtn">Save</button>
      <button class="small" type="button" id="testBtn">Send me one now</button>
    </div>
  </form>
</section>
<footer class="muted">&mdash; Kade-AI</footer>
<script>
(function(){
  var TOKEN=null, today=null, audio=null;
  var statusEl=document.getElementById('status');
  function setStatus(t,isErr){ statusEl.textContent=t; statusEl.className='status'+(isErr?' err':''); }
  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token||null; }catch(e){ return null; } }
  async function api(method, path, body){ var r=await fetch(path,{method:method,headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}); if(!r.ok){ var t=await r.text(); var msg=t; try{ msg=JSON.parse(t).error||t; }catch(e){} throw new Error(msg); } return r.json(); }

  function fillForm(d){
    var p=d.prefs||{};
    document.getElementById('enabled').checked = !!p.enabled;
    if(p.time) document.getElementById('time').value = p.time;
    var it=p.items||{};
    document.getElementById('itemWeather').checked = it.weather!==false;
    document.getElementById('itemNews').checked = it.news!==false;
    document.getElementById('itemDayAhead').checked = it.dayAhead!==false;
    document.getElementById('location').value = p.location||'';
    document.getElementById('linkNote').style.display = d.linked ? 'none' : '';
    today = d.lastBrief||null;
    if(today && today.text){
      document.getElementById('todayText').textContent = today.text;
      document.getElementById('todaySec').style.display='';
    }
  }

  function collect(){
    return {
      enabled: document.getElementById('enabled').checked,
      time: document.getElementById('time').value || '09:00',
      items: {
        weather: document.getElementById('itemWeather').checked,
        news: document.getElementById('itemNews').checked,
        dayAhead: document.getElementById('itemDayAhead').checked
      },
      location: (document.getElementById('location').value||'').trim()
    };
  }

  document.getElementById('prefsForm').addEventListener('submit', async function(ev){
    ev.preventDefault();
    var btn=document.getElementById('saveBtn'); btn.disabled=true;
    try{ var d=await api('POST','/api/brief',collect()); fillForm({prefs:d.prefs,linked:d.linked,lastBrief:today}); setStatus(d.prefs.enabled ? 'Saved. Your brief arrives daily at '+d.prefs.time+' Central.' : 'Saved. The brief is off.'); }
    catch(e){ setStatus('Could not save: '+e.message, true); }
    btn.disabled=false;
  });

  document.getElementById('testBtn').addEventListener('click', async function(){
    var btn=this; btn.disabled=true;
    setStatus('Writing your brief now — this takes a few seconds…');
    try{
      var d=await api('POST','/api/brief/fire');
      if(d.ok){
        today={text:d.generated};
        document.getElementById('todayText').textContent=d.generated;
        document.getElementById('todaySec').style.display='';
        var sent=d.delivery&&d.delivery.sent;
        setStatus(sent ? 'Sent to your phone — and it’s below to read or listen.' : 'Written (below) — but no linked phone to push it to yet. Open the app on your phone once to link.');
      } else { setStatus('Could not send: '+(d.error||'unknown'), true); }
    }catch(e){ setStatus('Could not send: '+e.message, true); }
    btn.disabled=false;
  });

  document.getElementById('listenBtn').addEventListener('click', async function(){
    if(!today || !today.text){ setStatus('Nothing to listen to yet today.', true); return; }
    var btn=this;
    if(audio){ audio.pause(); audio=null; btn.textContent='Listen'; setStatus('Stopped.'); return; }
    btn.disabled=true; setStatus('Fetching the voice…');
    try{
      var r=await fetch('/api/files/speech/tts',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({input:today.text,voice:'Voice 68'})});
      if(!r.ok) throw new Error('voice service answered '+r.status);
      var blob=await r.blob();
      audio=new Audio(URL.createObjectURL(blob));
      audio.addEventListener('ended', function(){ audio=null; btn.textContent='Listen'; setStatus('Done.'); });
      await audio.play();
      btn.textContent='Stop';
      setStatus('Playing.');
    }catch(e){ setStatus('Could not play it: '+e.message, true); }
    btn.disabled=false;
  });

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ setStatus('Please sign in on the main site first, then come back to this page.', true); return; }
    try{ fillForm(await api('GET','/api/brief')); setStatus('Ready.'); }
    catch(e){ setStatus('Could not load your settings just now: '+e.message, true); }
  })();
})();
</script>
</body></html>`;

/* KADE Aug 8 2026 — THE WORLD CLIENT (her correction made real): a direct,
 * no-LLM surface for the city. Type n/e/w/s at telnet speed; every engine
 * event carries a KIND, and kinds drive SOUND — the BASSLINE law, her own:
 * "the screen reader announces but doesn't play; earcons carry the gameplay."
 * Synth earcon defaults ship tonight so the world already talks in sound;
 * every one of them is overridable by HER designed audio via SOUND_URLS —
 * hand Kade a file per kind and it replaces the synth voice of the world.
 * Deliberately its OWN surface — not an agent chat, not the platform's face:
 * a doorway page. Ambience per district, off by default, remembered. */
const worldHtml = `<!doctype html><html lang="en"><head><title>The World — beyond the Threshold Gate</title>${SHARED_HEAD}
<style>
  #log { min-height: 40vh; max-height: 58vh; overflow-y: auto; padding: .8rem 1rem; border-radius: 14px;
         background: #101216; color: #d6e2d6; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
         font-size: .98rem; line-height: 1.55; border: 1px solid #22262e; }
  @media (prefers-color-scheme: light){ #log { background:#14161a; } }
  #log p { margin: .35rem 0; }
  #log p.you { color: #9ecbff; }
  #log p.world { color: #d6e2d6; }
  #log p.meanwhile { color: #c9b47a; font-style: italic; }
  #log p.err { color: #ff9d8f; }
  form.cmd { display: flex; gap: .5rem; margin-top: .7rem; }
  form.cmd input { flex: 1; font-size: 1.05rem; padding: .75rem .9rem; border-radius: 12px; border: 1px solid #b9bfc9;
                   background: #fff; color: #16181d; font-family: ui-monospace, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: dark){ form.cmd input { background:#242830; color:#e7e9ee; border-color:#3a3f49; } }
  form.cmd input:focus-visible { outline: 4px solid #ffbf47; outline-offset: 2px; }
  form.cmd button { font-size: 1.05rem; font-weight: 700; padding: .75rem 1.2rem; border-radius: 12px; border: 0;
                    background: #1f7a49; color: #fff; cursor: pointer; }
  form.cmd button:focus-visible { outline: 4px solid #ffbf47; outline-offset: 3px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .6rem; }
  .toolbar button { font-size: .92rem; padding: .5rem .8rem; border-radius: 10px; border: 1px solid #b9bfc9;
                    background: transparent; color: inherit; cursor: pointer; }
  .toolbar button:focus-visible { outline: 4px solid #ffbf47; outline-offset: 2px; }
  .toolbar button[aria-pressed="true"] { background: #1f7a49; color: #fff; border-color: #1f7a49; }
</style>
</head><body>
<a class="back" href="/you">&larr; Back</a>
<h1>The World</h1>
<p class="muted">The city beyond the Threshold Gate. Type commands — <strong>n s e w</strong>, <strong>look</strong>, <strong>take lantern</strong>, <strong>say hello</strong>, <strong>who</strong> — or dictate them. No narrator between you and the ground; this is the direct line. Sounds mark what happens (toggle below). Your character and everything you do here are the same ones the city's keepers see.</p>
<div id="log" role="log" aria-live="polite" aria-label="World output"></div>
<form class="cmd" id="cmdForm">
  <label for="cmdInput" style="position:absolute;left:-9999px;">Command</label>
  <input id="cmdInput" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="look" />
  <button type="submit">Do</button>
</form>
<div class="toolbar" role="group" aria-label="Quick commands and sound">
  <button type="button" data-cmd="look">Look</button>
  <button type="button" data-cmd="n">North</button>
  <button type="button" data-cmd="s">South</button>
  <button type="button" data-cmd="e">East</button>
  <button type="button" data-cmd="w">West</button>
  <button type="button" data-cmd="inventory">Inventory</button>
  <button type="button" data-cmd="who">Who</button>
  <button type="button" id="sfxToggle" aria-pressed="true">Sounds: on</button>
  <button type="button" id="ambToggle" aria-pressed="false">Ambience: off</button>
</div>
<footer class="muted">&mdash; a door, not a chat</footer>
<script>
(function(){
  var TOKEN=null, hist=[], histIx=-1;
  var logEl=document.getElementById('log');
  var input=document.getElementById('cmdInput');

  /* ── SOUND ─────────────────────────────────────────────────────────────
   * Every engine event kind gets a voice. SOUND_URLS is HER override lane:
   * set a URL per kind (her designed audio) and it replaces the synth. */
  var SOUND_URLS = { move:null, look:null, take:null, drop:null, say:null, emote:null, enter:null, leave:null, err:null };
  var ROOM_SOUNDS = {}, DISTRICT_SOUNDS = {}, ambAudio = null;
  fetch('/api/world/sounds').then(function(r){ return r.ok ? r.json() : null; }).then(function(m){
    if(!m) return;
    Object.keys(m.event||{}).forEach(function(k){ SOUND_URLS[k]=m.event[k]; });
    ROOM_SOUNDS=m.room||{}; DISTRICT_SOUNDS=m.district||{};
  }).catch(function(){});
  var AC=null; function ac(){ if(!AC){ try{ AC=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } return AC; }
  var sfxOn=true, ambOn=false, ambNodes=null;
  try{ sfxOn = localStorage.getItem('world_sfx')!=='0'; ambOn = localStorage.getItem('world_amb')==='1'; }catch(e){}

  function tone(freq,dur,delay,type,gain){
    var ctx=ac(); if(!ctx) return;
    var o=ctx.createOscillator(), g=ctx.createGain();
    o.type=type||'sine'; o.frequency.value=freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime+delay);
    g.gain.exponentialRampToValueAtTime(gain||0.12, ctx.currentTime+delay+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+delay+dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(ctx.currentTime+delay); o.stop(ctx.currentTime+delay+dur+0.05);
  }
  var SYNTH={
    move:  function(){ tone(150,.05,0,'square',.09); tone(130,.05,.09,'square',.08); },
    look:  function(){ tone(520,.07,0,'sine',.07); },
    take:  function(){ tone(330,.05,0,'triangle',.1); tone(540,.06,.05,'triangle',.1); },
    drop:  function(){ tone(220,.05,0,'triangle',.1); tone(110,.09,.05,'triangle',.1); },
    say:   function(){ tone(660,.06,0,'sine',.08); tone(880,.08,.07,'sine',.07); },
    emote: function(){ tone(440,.09,0,'sine',.08); },
    enter: function(){ tone(392,.06,0,'sine',.07); tone(494,.06,.06,'sine',.07); tone(587,.08,.12,'sine',.07); },
    leave: function(){ tone(587,.06,0,'sine',.07); tone(494,.06,.06,'sine',.07); tone(392,.08,.12,'sine',.06); },
    err:   function(){ tone(110,.16,0,'sawtooth',.06); }
  };
  function playKind(k){
    if(!sfxOn) return;
    if(SOUND_URLS[k]){ try{ new Audio(SOUND_URLS[k]).play(); return; }catch(e){} }
    (SYNTH[k]||function(){})();
  }
  function ambience(on, district){
    if(ambNodes){ try{ ambNodes.g.gain.linearRampToValueAtTime(0.0001, ac().currentTime+0.4); ambNodes.o1.stop(ac().currentTime+0.6); ambNodes.o2.stop(ac().currentTime+0.6); }catch(e){} ambNodes=null; }
    if(!on) return;
    var ctx=ac(); if(!ctx) return;
    var o1=ctx.createOscillator(), o2=ctx.createOscillator(), g=ctx.createGain(), f=ctx.createBiquadFilter();
    o1.frequency.value=55; o2.frequency.value=57.3; o1.type='sine'; o2.type='sine';
    f.type='lowpass'; f.frequency.value=160;
    g.gain.value=0.0001;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(ctx.destination);
    o1.start(); o2.start();
    g.gain.linearRampToValueAtTime(0.028, ctx.currentTime+1.2);
    ambNodes={o1:o1,o2:o2,g:g};
  }

  /* ── LOG ── */
  function addLine(text, cls){
    var p=document.createElement('p'); p.className=cls||'world'; p.textContent=text;
    logEl.appendChild(p); logEl.scrollTop=logEl.scrollHeight;
    while(logEl.children.length>250){ logEl.removeChild(logEl.firstChild); }
  }

  async function getToken(){ try{ var r=await fetch('/api/auth/refresh',{method:'POST',credentials:'include'}); if(!r.ok) return null; var j=await r.json(); return j&&j.token||null; }catch(e){ return null; } }

  async function send(cmd){
    cmd=(cmd||'').trim(); if(!cmd) return;
    addLine('> '+cmd, 'you');
    hist.push(cmd); histIx=hist.length;
    try{
      var r=await fetch('/api/world/command',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({command:cmd})});
      /* Aug 10 2026 (her session-close report: a command "trashed the whole
       * page — transmission error"): the token was fetched ONCE at page
       * load, so a tab left open past token expiry got a 401 on every
       * command forever — "try again" was a lie until a full reload. Now a
       * 401 quietly re-fetches the token and retries the command once;
       * only a genuinely dead session asks her to sign back in. */
      if(r.status===401){
        TOKEN=await getToken();
        if(TOKEN){ r=await fetch('/api/world/command',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify({command:cmd})}); }
        if(!TOKEN || r.status===401){ addLine('The gate lost track of you — sign in on the main site, then come back.', 'err'); playKind('err'); return; }
      }
      if(!r.ok){ addLine('The world flickered ('+r.status+') — that one did not land. Try it again in a moment.', 'err'); playKind('err'); return; }
      var d=await r.json();
      (d.lines||[]).forEach(function(line){
        addLine(line, /^MEANWHILE/.test(line)?'meanwhile':'world');
      });
      if(d.room){
        addLine(d.room.name+'. '+d.room.desc, 'world');
        addLine('Exits: '+(d.room.exits.join(', ')||'none')
          + (d.room.items && d.room.items.length ? '. Here: '+d.room.items.join(', ') : '')
          + (d.room.people && d.room.people.length ? '. Present: '+d.room.people.join(', ') : '. No one else here.'), 'world');
      }
      var kinds = d.kinds||[];
      if(!d.ok && (!kinds.length)) { playKind('err'); }
      kinds.forEach(function(k,i){ setTimeout(function(){ playKind(k); }, i*140); });
      /* KADE 2026-08-12: a command may hand back SPECIFIC sound ids — the Bite's
         nibble and take, the scale settling. They queue after the kinds so a
         move-then-cast still reads left to right. */
      (d.sounds||[]).forEach(function(s,i){ setTimeout(function(){ playKind(s); }, (kinds.length+i)*140); });
      if(ambOn){
        /* KADE 2026-08-12 FIX: room beds are keyed by roomId, not by display
           name — build 197 added roomId to the room view for exactly this and
           the lookup was never moved over, so no room bed has ever played. */
        var ambUrl = (d.room && (ROOM_SOUNDS[d.room.roomId] || ROOM_SOUNDS[d.room.name])) || (d.district && DISTRICT_SOUNDS[d.district]);
        if(ambUrl){
          if(!ambAudio || ambAudio.src!==ambUrl){
            if(ambAudio){ try{ ambAudio.pause(); }catch(e){} }
            ambAudio=new Audio(ambUrl); ambAudio.loop=true; ambAudio.volume=0.25;
            ambAudio.play().catch(function(){});
            ambience(false);
          }
        } else if(d.district){ if(ambAudio){ try{ ambAudio.pause(); }catch(e){} ambAudio=null; } ambience(true, d.district); }
      }
    }catch(e){ addLine('No road to the city just now — check your connection.', 'err'); playKind('err'); }
  }

  document.getElementById('cmdForm').addEventListener('submit', function(ev){
    ev.preventDefault(); var c=input.value; input.value=''; send(c); input.focus();
  });
  input.addEventListener('keydown', function(ev){
    if(ev.key==='ArrowUp'){ ev.preventDefault(); if(histIx>0){ histIx--; input.value=hist[histIx]||''; } }
    if(ev.key==='ArrowDown'){ ev.preventDefault(); if(histIx<hist.length){ histIx++; input.value=hist[histIx]||''; } }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.toolbar button[data-cmd]'), function(b){
    b.addEventListener('click', function(){ send(b.getAttribute('data-cmd')); input.focus(); });
  });
  var sfxBtn=document.getElementById('sfxToggle');
  function renderSfx(){ sfxBtn.textContent='Sounds: '+(sfxOn?'on':'off'); sfxBtn.setAttribute('aria-pressed', String(sfxOn)); }
  sfxBtn.addEventListener('click', function(){ sfxOn=!sfxOn; try{ localStorage.setItem('world_sfx', sfxOn?'1':'0'); }catch(e){} renderSfx(); if(sfxOn){ playKind('say'); } });
  var ambBtn=document.getElementById('ambToggle');
  function renderAmb(){ ambBtn.textContent='Ambience: '+(ambOn?'on':'off'); ambBtn.setAttribute('aria-pressed', String(ambOn)); }
  ambBtn.addEventListener('click', function(){ ambOn=!ambOn; try{ localStorage.setItem('world_amb', ambOn?'1':'0'); }catch(e){} renderAmb(); if(!ambOn && ambAudio){ try{ ambAudio.pause(); }catch(e){} ambAudio=null; } ambience(ambOn); });
  renderSfx(); renderAmb();

  (async function init(){
    TOKEN=await getToken();
    if(!TOKEN){ addLine('Sign in on the main site first, then come back to the gate.', 'err'); return; }
    addLine('The gate knows you. Type look, or just press Look.', 'world');
    send('look');
  })();
})();
</script>
</body></html>`;

module.exports = { feedHtml, dashboardHtml, creationsHtml, wallHtml, feedbackHtml, notificationsHtml, describeHtml, toolsHtml, youHtml, pronunciationDictionaryHtml, diaryHtml, briefHtml, requestAccessHtml, accessRequestsHtml, worldHtml, tabBarAsset, logsHtml, parlorHtml, SHARED_HEAD };

