/* Self-contained HTML for the usage dashboard + "Feed the Server" page.
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
    a.btn { background: #2f8f5b !important; }
    th { background: #24272f !important; }
    tr:nth-child(even) td { background: #1b1e24 !important; }
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
    display: inline-block; background: #2f8f5b; color: #fff; text-decoration: none;
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
  a.back { display:inline-block; margin:0 0 .25rem; font-weight:600; text-decoration:none; color:#2f6fed; }
  a.back:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
</style>
<script>
  function money(n){ n = Number(n)||0; if(n>0 && n<0.01){ return '$'+n.toFixed(4); } return '$'+n.toFixed(2); }
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
</script>`;

const feedHtml = `<!doctype html><html lang="en"><head><title>Feed the Server</title>${SHARED_HEAD}</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a></p>
  <h1>Feed the Server</h1>
  <p class="muted">Kade keeps this AI running out of pocket for friends and family. No one has to pay a cent. But if you'd like to chip in just enough to cover what <em>you've</em> used, here's your honest tab.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading your usage…</div>

  <main id="content" hidden>
    <div class="card" aria-labelledby="tabhead">
      <h2 id="tabhead" style="margin-top:0">Your tab so far this <span id="monthLabel">month</span></h2>
      <div class="big" id="suggested" aria-live="polite">$0.00</div>
      <p class="muted" id="tabnote">That's roughly what your chats, voices, and images have cost the server this month.</p>
      <a class="btn" id="donate" href="#" target="_blank" rel="noopener">Chip in via PayPal</a>
      <p class="muted" style="font-size:.85rem;margin-top:.6rem">Totally optional. Give what feels right — or nothing at all.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">This month, broken down</h2>
      <dl class="kv">
        <dt>Chat (the AI thinking)</dt><dd id="m_llm">$0.00</dd>
        <dt>Voice / read-aloud</dt><dd id="m_tts">$0.00</dd>
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
        <dt>Your remaining monthly balance</dt><dd id="balance">$0.00</dd>
      </dl>
      <p class="muted" id="qty" style="margin-top:.6rem;font-size:.9rem"></p>
    </div>
  </main>

  <footer class="muted">Numbers refresh every time you open this page. Thanks for being here. — Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      const token = await getToken();
      if(!token){
        status.className = 'status err';
        status.textContent = 'Please sign in at the chat site first, then reload this page.';
        return;
      }
      const r = await apiGet('/api/kade/my-usage', token);
      if(!r.ok){
        status.className = 'status err';
        status.textContent = 'Could not load your usage right now. Try reloading in a moment.';
        return;
      }
      const d = await r.json();
      document.getElementById('monthLabel').textContent = d.monthLabel || 'month';
      document.getElementById('suggested').textContent = money(d.suggestedDonationUSD);
      document.getElementById('suggested').setAttribute('aria-label', 'Suggested donation ' + money(d.suggestedDonationUSD));
      const dn = document.getElementById('donate');
      dn.href = d.paypal;
      dn.setAttribute('aria-label', 'Chip in via PayPal, opens in a new tab');
      const m = d.monthToDate || {};
      document.getElementById('m_llm').textContent = money(m.llmUSD);
      document.getElementById('m_tts').textContent = money(m.ttsUSD);
      document.getElementById('m_flux').textContent = money(m.fluxUSD);
      document.getElementById('m_tav').textContent = money(m.tavilyUSD);
      document.getElementById('m_phone').textContent = money(m.phoneUSD);
      document.getElementById('m_other').textContent = money(m.otherUSD);
      document.getElementById('m_total').innerHTML = '<strong>'+money(m.totalUSD)+'</strong>';
      document.getElementById('a_total').textContent = money((d.allTime||{}).totalUSD);
      document.getElementById('balance').textContent = money(d.balanceUSD);
      const a = d.allTime || {};
      document.getElementById('qty').textContent =
        'All time, you have used about ' + num(a.tts_chars) + ' characters of voice, ' +
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

    <h2>By service</h2>
    <div class="card" style="padding:.4rem .6rem">
      <table aria-label="Spend by service">
        <thead><tr><th scope="col">Service</th><th scope="col" class="num">Quantity (all time)</th><th scope="col" class="num">Cost (all time)</th></tr></thead>
        <tbody id="svc_rows"></tbody>
      </table>
    </div>

    <h2>By person</h2>
    <div class="card" style="padding:.4rem .6rem">
      <table aria-label="Spend by person">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col" class="num">LLM (all time)</th>
          <th scope="col" class="num">Voice chars</th>
          <th scope="col" class="num">Images</th>
          <th scope="col" class="num">Searches</th>
          <th scope="col" class="num">Extra $</th>
          <th scope="col" class="num">Balance</th>
        </tr></thead>
        <tbody id="user_rows"></tbody>
      </table>
    </div>
  </main>

  <footer class="muted">Refreshes on every load. — Kade-AI</footer>

  <script>
    function svcQty(u, name){ const s=(u.services||{})[name]; return s? s.quantity.allTime : 0; }
    function svcExtra(u){ let t=0; for(const k in (u.services||{})){ t += u.services[k].costUSD.allTime; } return t; }
    (async function(){
      const status = document.getElementById('status');
      const token = await getToken();
      if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }
      const r = await apiGet('/api/kade/usage?days=30', token);
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

      const svcBody = document.getElementById('svc_rows');
      const svcNames = Object.keys(d.perService||{});
      if(svcNames.length===0){
        svcBody.innerHTML = '<tr><td colspan="3" class="muted">No voice / image / search usage logged yet.</td></tr>';
      } else {
        svcBody.innerHTML = svcNames.map(function(name){
          const s = d.perService[name];
          return '<tr><td>'+name+'</td><td class="num">'+num(s.quantity.allTime)+' '+(s.unit||'')+'</td><td class="num">'+money(s.costUSD.allTime)+'</td></tr>';
        }).join('');
      }

      const ub = document.getElementById('user_rows');
      ub.innerHTML = (d.perUser||[]).map(function(u){
        return '<tr><td>'+ (u.name||'') + (u.role==='ADMIN'?' <span class="muted">(admin)</span>':'') +
          '</td><td class="num">'+money(u.llmSpendUSD.allTime)+
          '</td><td class="num">'+num(svcQty(u,'tts'))+
          '</td><td class="num">'+num(svcQty(u,'flux'))+
          '</td><td class="num">'+num(svcQty(u,'tavily'))+
          '</td><td class="num">'+money(svcExtra(u))+
          '</td><td class="num">'+money(u.balanceUSD)+'</td></tr>';
      }).join('');

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
  button.share, button.dl { margin-top:.6rem; margin-right:.5rem; font: inherit; font-weight:600; padding:.5rem .9rem; border-radius:10px; border:1px solid #2f6fed; background:#fff; color:#2f6fed; cursor:pointer; }
  button.dl { border-color:#2f8f5b; color:#2f8f5b; }
  button.dl:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  button.share[aria-pressed="true"] { background:#2f6fed; color:#fff; }
  button.share:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  @media (prefers-color-scheme: dark) {
    .pill { background:#1e3a8a; color:#dbeafe; }
    button.share, button.dl { background:#1e2127; }
    button.share[aria-pressed="true"] { background:#2f6fed; color:#fff; }
  }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="/wall-of-fame">Wall of Fame &rarr;</a></p>
  <h1>My Creations</h1>
  <p class="muted">Every video, image, and audio clip you've generated here, newest first. Videos and audio play right on this page. Hit "Share to the Wall of Fame" on a favorite and everyone on the site can enjoy it too.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading your creations…</div>

  <main id="content" hidden aria-label="Your generated videos, images, and audio"></main>

  <footer class="muted">Fresh every time you open this page. Videos are backed up to Kade's own storage automatically, so they won't vanish — but download anything you want a personal copy of. — Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      const token = await getToken();
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
      const imgs = d.assets.length - vids - auds;
      status.textContent = 'You have ' + d.assets.length + ' creation' + (d.assets.length===1?'':'s') + ': ' + vids + ' video' + (vids===1?'':'s') + ', ' + imgs + ' image' + (imgs===1?'':'s') + ', and ' + auds + ' audio clip' + (auds===1?'':'s') + '.';
      function esc(s){ const div=document.createElement('div'); div.textContent = s || ''; return div.innerHTML; }
      function when(iso){
        try { return new Date(iso).toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); }
        catch(e){ return ''; }
      }
      main.innerHTML = d.assets.map(function(a, i){
        const kindLabel = a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : 'Image';
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
        } else {
          media = '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open full-size image in a new tab"><img loading="lazy" src="' + esc(a.url) + '" alt="' + esc(desc) + '"></a>';
        }
        return '<section class="card asset" aria-label="' + esc(title) + '">' +
          '<h2 style="margin:0 0 .5rem;font-size:1.05rem">' + esc(title) + '</h2>' +
          media +
          '<p class="meta"><span class="pill">' + esc(a.kind) + '</span>' + esc(a.model || a.service) + (a.costUSD ? ' &middot; ' + money(a.costUSD) : '') + '</p>' +
          (a.description ? '<p class="desc"><strong>' + (a.kind === 'audio' ? 'What you will hear:' : 'What it looks like:') + '</strong> ' + esc(a.description) + '</p>' : '') +
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
  button.dl { margin-top:.6rem; font: inherit; font-weight:600; padding:.5rem .9rem; border-radius:10px; border:1px solid #2f8f5b; background:#fff; color:#2f8f5b; cursor:pointer; }
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

  <footer class="muted">Only things people chose to share appear here. — Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      const token = await getToken();
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
        const kindLabel = a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : 'Image';
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
        } else {
          media = '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer" aria-label="Open full-size image in a new tab"><img loading="lazy" src="' + esc(a.url) + '" alt="' + esc(desc) + '"></a>';
        }
        return '<section class="card asset" aria-label="' + esc(title) + '">' +
          '<h2 style="margin:0 0 .5rem;font-size:1.05rem">' + esc(title) + '</h2>' +
          media +
          '<p class="meta"><span class="pill">' + esc(a.by || 'Someone') + '</span>' + esc(a.kind) + (a.model ? ' &middot; ' + esc(a.model) : '') + '</p>' +
          (a.description ? '<p class="desc"><strong>' + (a.kind === 'audio' ? 'What you will hear:' : 'What it looks like:') + '</strong> ' + esc(a.description) + '</p>' : '') +
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
const gameRoomHtml = `<!doctype html><html lang="en"><head><title>The Game Room</title>${SHARED_HEAD}
<style>
  .crown { font-size: .8rem; font-weight: 700; padding: .1rem .55rem; border-radius: 999px; background: #fdf1d7; color: #8a6100; margin-left: .4rem; }
  @media (prefers-color-scheme: dark) { .crown { background: #5c4300; color: #ffe9b3; } }
  li.result { margin: .3rem 0; }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="/help/games">How the games work</a></p>
  <h1>The Game Room</h1>
  <p class="muted">Family bragging rights, straight from the Game Parlor's referee. Every finished game of Blackjack, Wild Eights, Go Fish, Pig, and Trivia Night counts. Walking away from a table doesn't count against you — only played-out games land here.</p>

  <div id="status" class="status" role="status" aria-live="polite">Loading the standings…</div>

  <main id="content" hidden>
    <section class="card" aria-labelledby="standings-h">
      <h2 id="standings-h" style="margin-top:0">Family standings</h2>
      <p id="standings-summary"></p>
      <table id="standings">
        <caption class="muted" style="text-align:left; caption-side:top">All games combined, most wins first. Chips are Blackjack's fake chips — never real money.</caption>
        <thead><tr><th scope="col">Player</th><th scope="col" class="num">Wins</th><th scope="col" class="num">Losses</th><th scope="col" class="num">Draws</th><th scope="col" class="num">Played</th><th scope="col" class="num">Blackjack chips</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card" aria-labelledby="highlights-h" id="highlights-card" hidden>
      <h2 id="highlights-h" style="margin-top:0">Best of the best</h2>
      <dl class="kv" id="highlights"></dl>
    </section>

    <section aria-labelledby="pergame-h">
      <h2 id="pergame-h">Game by game</h2>
      <div id="pergame"></div>
    </section>

    <section class="card" aria-labelledby="recent-h" id="recent-card" hidden>
      <h2 id="recent-h" style="margin-top:0">Latest results</h2>
      <ul id="recent" style="list-style:none; padding:0; margin:0"></ul>
    </section>
  </main>

  <footer class="muted">Start a game by telling Deuce or Kiana "deal me in" — in chat, in conversation mode, or on a call to +1&nbsp;833&nbsp;530&nbsp;0313. — Kade-AI</footer>

  <script>
    (async function(){
      const status = document.getElementById('status');
      const token = await getToken();
      if(!token){
        status.className = 'status err';
        status.textContent = 'Please sign in at the chat site first, then reload this page.';
        return;
      }
      const r = await apiGet('/api/kade/game-leaderboard', token);
      if(!r.ok){
        status.className = 'status err';
        status.textContent = 'Could not load the standings right now. Try reloading in a moment.';
        return;
      }
      const d = await r.json();
      function esc(s){ const div=document.createElement('div'); div.textContent = s == null ? '' : s; return div.innerHTML; }
      function when(iso){
        try { return new Date(iso).toLocaleString('en-US', { month:'long', day:'numeric' }); }
        catch(e){ return ''; }
      }
      if(!d.finished){
        status.textContent = 'No finished games yet — the board is wide open. Tell Deuce or Kiana "deal me in" and claim the first win!';
        return;
      }
      status.textContent = d.finished + ' finished game' + (d.finished===1?'':'s') + ' on the books' +
        (d.activeTables ? ', ' + d.activeTables + ' table' + (d.activeTables===1?'':'s') + ' still in play.' : '.');

      const champ = d.players[0];
      document.getElementById('standings-summary').innerHTML = champ && champ.wins > 0
        ? '<strong>' + esc(champ.by) + '</strong> leads the family with ' + champ.wins + ' win' + (champ.wins===1?'':'s') + ' across ' + champ.played + ' game' + (champ.played===1?'':'s') + '.'
        : 'Nobody has a win on the books yet — first one to finish a game takes the lead.';
      document.querySelector('#standings tbody').innerHTML = d.players.map(function(p, i){
        return '<tr><th scope="row">' + esc(p.by) + (i===0 && p.wins>0 ? ' <span class="crown">Champ</span>' : '') + '</th>' +
          '<td class="num">' + num(p.wins) + '</td><td class="num">' + num(p.losses) + '</td><td class="num">' + num(p.draws) + '</td>' +
          '<td class="num">' + num(p.played) + '</td><td class="num">' + (p.chips>0?'+':'') + num(p.chips) + '</td></tr>';
      }).join('');

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
        document.getElementById('highlights').innerHTML = hl.join('');
        document.getElementById('highlights-card').hidden = false;
      }

      document.getElementById('pergame').innerHTML = (d.games || []).map(function(g){
        const leader = g.rows[0];
        return '<section class="card" aria-label="' + esc(g.name) + ' standings">' +
          '<h3 style="margin:0 0 .25rem; font-size:1.05rem">' + esc(g.name) + '</h3>' +
          '<p class="muted" style="margin:.1rem 0 .4rem">' + num(g.played) + ' game' + (g.played===1?'':'s') + ' played' +
          (leader && leader.w>0 ? ' &middot; ' + esc(leader.by) + ' leads with ' + leader.w + ' win' + (leader.w===1?'':'s') : '') + '.</p>' +
          '<table><thead><tr><th scope="col">Player</th><th scope="col" class="num">Wins</th><th scope="col" class="num">Losses</th><th scope="col" class="num">Draws</th><th scope="col" class="num">Played</th></tr></thead><tbody>' +
          g.rows.map(function(rw){
            return '<tr><th scope="row">' + esc(rw.by) + '</th><td class="num">' + num(rw.w) + '</td><td class="num">' + num(rw.l) + '</td><td class="num">' + num(rw.d) + '</td><td class="num">' + num(rw.p) + '</td></tr>';
          }).join('') + '</tbody></table></section>';
      }).join('');

      if(d.recent && d.recent.length){
        document.getElementById('recent').innerHTML = d.recent.map(function(x){
          const verb = x.outcome === 'won' ? 'won at' : x.outcome === 'lost' ? 'lost at' : 'drew at';
          return '<li class="result">' + esc(x.by) + ' ' + verb + ' ' + esc(x.game) +
            (x.detail ? ' — ' + esc(x.detail) : '') + ' <span class="muted">(' + when(x.when) + ')</span></li>';
        }).join('');
        document.getElementById('recent-card').hidden = false;
      }
      document.getElementById('content').hidden = false;
    })();
  </script>
</body></html>`;

module.exports = { feedHtml, dashboardHtml, creationsHtml, wallHtml, gameRoomHtml };

