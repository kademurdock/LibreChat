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
    margin: 0; padding: 1.25rem;
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
        <dt><strong>Total this month</strong></dt><dd id="m_total"><strong>$0.00</strong></dd>
      </dl>
    </div>

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
      document.getElementById('m_total').innerHTML = '<strong>'+money(m.totalUSD)+'</strong>';
      document.getElementById('a_total').textContent = money((d.allTime||{}).totalUSD);
      document.getElementById('balance').textContent = money(d.balanceUSD);
      const a = d.allTime || {};
      document.getElementById('qty').textContent =
        'All time, you have used about ' + num(a.tts_chars) + ' characters of voice, ' +
        num(a.flux_images) + ' generated images, and ' + num(a.tavily_searches) + ' web searches.';
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

module.exports = { feedHtml, dashboardHtml };
