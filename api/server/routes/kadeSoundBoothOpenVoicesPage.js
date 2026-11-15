/* The Sound Booth page's Open voices panel (Nov 15 2026): VoxCPM2 and Ming, Design a voice and
 * Speak with a voice. Spliced into kadeSoundBoothPage.js by interpolation, so none of this passes
 * through that file's template-literal escaping. Routes: kadeSoundBoothOpenVoices.js.
 *
 * Screen-reader shape (her rule): real labelled controls, the page's ONE live region (#status),
 * nothing auto-plays. The panel stays hidden until the server lists at least one engine. Typing
 * here does not touch the main render's quote (events stop at the panel). */

const OPEN_VOICES_HTML = `
    <details id="openVoicesDrawer" hidden><summary>Open voices: design a voice, or speak with a saved one (VoxCPM2 and Ming)</summary>
    <fieldset id="openVoicesPanel"><legend>Open voices</legend>
      <label class="field" for="ovEngine">Voice engine</label>
      <select id="ovEngine" aria-describedby="ovEngineHint"></select>
      <p class="hint" id="ovEngineHint"></p>
      <div class="seg" role="group" aria-label="Design a voice or speak with one">
        <button type="button" id="ovModeDesign" aria-pressed="true">Design a voice</button>
        <button type="button" id="ovModeSpeak" aria-pressed="false">Speak with a voice</button>
      </div>
      <div id="ovDesignBox">
        <label class="field" for="ovDescription">Describe the voice</label>
        <p class="hint" id="ovDescriptionHint">For example: a warm older man with a slow Southern drawl and a little gravel. Each try makes a new voice.</p>
        <textarea id="ovDescription" aria-describedby="ovDescriptionHint" style="min-height:4.5rem"></textarea>
      </div>
      <div id="ovSpeakBox" hidden>
        <label class="field" for="ovVoice">Saved voice</label>
        <select id="ovVoice" aria-describedby="ovVoiceHint"></select>
        <p class="hint" id="ovVoiceHint">Your saved voices, newest first. Or choose An imported clip and import one below.</p>
        <button type="button" class="act quiet" id="ovForget" hidden>Remove this voice from my list</button>
        <div id="ovClipBox" hidden>
          <label class="field" for="ovClip">Import a clip: WAV, MP3 or M4A</label>
          <input type="file" id="ovClip" accept="audio/*,.wav,.mp3,.m4a" aria-describedby="ovClipHint">
          <p class="hint" id="ovClipHint">A clear recording of one person talking. Ten to thirty seconds works best.</p>
          <label class="field" for="ovClipWords">What the clip says, word for word (optional)</label>
          <input type="text" id="ovClipWords" maxlength="1000" aria-describedby="ovClipWordsHint">
          <p class="hint" id="ovClipWordsHint">Only for a clip of thirty seconds or less. Exact words make the copy closer. Leave it empty if unsure.</p>
          <label class="field" for="ovClipName">Name for this clip's voice</label>
          <input type="text" id="ovClipName" maxlength="80">
          <button type="button" class="act quiet" id="ovKeepClip">Keep this clip as a saved voice</button>
        </div>
        <label class="field" for="ovStyle">Style (optional)</label>
        <input type="text" id="ovStyle" maxlength="400" aria-describedby="ovStyleHint">
        <p class="hint" id="ovStyleHint">Plain words, for example: slightly faster, cheerful tone.</p>
      </div>
      <label class="field" for="ovText">Words to say</label>
      <textarea id="ovText" maxlength="5000" aria-describedby="ovTextHint" style="min-height:5rem"></textarea>
      <p class="hint" id="ovTextHint">Up to 5,000 characters. For a voice you plan to keep, a sentence or two is best.</p>
      <label class="field" for="ovSeed">Voice number (optional)</label>
      <input type="number" id="ovSeed" min="0" max="2147483647" step="1" aria-describedby="ovSeedHint">
      <p class="hint" id="ovSeedHint">Leave it empty for a new take every try. Type a take's number to hear that take again.</p>
      <button type="button" class="act primary" id="ovMake">Make a take</button>
      <button type="button" class="act" id="ovStop" hidden>Stop this take</button>
      <p class="hint">Each take is saved in My Creations. GPU time is billed.</p>
      <h3 id="ovTakesHeading" hidden>Takes</h3>
      <ul id="ovTakes" aria-labelledby="ovTakesHeading" style="list-style:none;padding:0"></ul>
    </fieldset>
    </details>`;

const OPEN_VOICES_SCRIPT = `
  <script>
  (async function(){
    var drawer = document.getElementById('openVoicesDrawer');
    var panel = document.getElementById('openVoicesPanel');
    if(!drawer || !panel) return;
    var status = document.getElementById('status');
    function say(msg, isErr){ status.className = 'status' + (isErr ? ' err' : ''); status.textContent = msg; }
    function $(id){ return document.getElementById(id); }
    ['input','change'].forEach(function(t){ panel.addEventListener(t, function(e){ e.stopPropagation(); }); });
    var token = null; try { token = await getToken(); } catch(e) {}
    if(!token) return;
    async function call(path, body){
      try {
        var r = await fetch('/api/kade/sound-booth' + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        var j = null; try { j = await r.json(); } catch(e) {}
        return { ok: r.ok, status: r.status, data: j || {} };
      } catch(e) { return { ok: false, status: 0, data: { error: 'Connection lost. Try again.' } }; }
    }
    var ov = { mode: 'design', engines: [], voices: [], clip: null, jobId: null, timer: null, coldSaid: false, takes: 0, lastSpoken: 0, busy: false };
    var first = await call('/open-voices');
    if(!first.ok || !first.data.engines || !first.data.engines.length) return;
    ov.engines = first.data.engines; ov.coldNote = first.data.coldNote || '';
    ov.engines.forEach(function(e){ var o = document.createElement('option'); o.value = e.id; o.textContent = e.label; $('ovEngine').appendChild(o); });
    function showEngine(){ var e = ov.engines.find(function(x){ return x.id === $('ovEngine').value; }) || ov.engines[0]; $('ovEngineHint').textContent = e ? e.about : ''; }
    $('ovEngine').onchange = showEngine; showEngine();
    function fillVoices(keep){
      var sel = $('ovVoice'); sel.textContent = '';
      ov.voices.forEach(function(v){ var o = document.createElement('option'); o.value = v.id; o.textContent = v.name + (v.seconds ? ', ' + Math.round(v.seconds) + ' seconds' : ''); sel.appendChild(o); });
      var c = document.createElement('option'); c.value = 'clip'; c.textContent = 'An imported clip'; sel.appendChild(c);
      if(keep && Array.prototype.some.call(sel.options, function(o){ return o.value === keep; })) sel.value = keep;
      showVoice();
    }
    function showVoice(){ var clip = $('ovVoice').value === 'clip'; $('ovClipBox').hidden = !clip; $('ovForget').hidden = clip; }
    $('ovVoice').onchange = showVoice;
    async function reloadVoices(keep){ var r = await call('/open-voices'); if(r.ok){ ov.voices = r.data.voices || []; fillVoices(keep); } }
    ov.voices = first.data.voices || []; fillVoices();
    function setMode(m){
      ov.mode = m;
      $('ovModeDesign').setAttribute('aria-pressed', m === 'design'); $('ovModeSpeak').setAttribute('aria-pressed', m === 'speak');
      $('ovDesignBox').hidden = m !== 'design'; $('ovSpeakBox').hidden = m !== 'speak';
    }
    $('ovModeDesign').onclick = function(){ setMode('design'); say('Design a voice. Describe it, then type the words to say.'); };
    $('ovModeSpeak').onclick = function(){ setMode('speak'); say(ov.voices.length ? 'Speak with a voice. Pick a saved voice or import a clip.' : 'Speak with a voice. You have no saved voices yet, so import a clip, or keep a designed take first.'); };
    drawer.hidden = false;

    $('ovClip').onchange = async function(){
      var f = this.files && this.files[0]; if(!f) return;
      if(f.size > 20*1024*1024){ say('That clip is over twenty megabytes.', true); return; }
      say('Importing ' + f.name + '…');
      try {
        var fd = new FormData(); fd.append('clip', f, f.name); fd.append('engine', 'scenema');
        var r = await fetch('/api/kade/sound-booth/reference', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(240000) });
        var j = null; try { j = await r.json(); } catch(e) {}
        if(!r.ok || !j || !j.url) throw new Error((j && j.error) || 'That clip could not be imported.');
        ov.clip = { url: j.url, seconds: j.seconds || null, name: j.name || f.name };
        if(!$('ovClipName').value) $('ovClipName').value = String(ov.clip.name).replace(/\\.[a-z0-9]+$/i, '').slice(0, 80);
        say('Clip imported' + (j.seconds ? ', ' + j.seconds + ' seconds' : '') + '. It will be the voice for the next take.');
      } catch(e) { ov.clip = null; say(e.message || 'That clip could not be imported.', true); }
    };
    $('ovKeepClip').onclick = async function(){
      if(!ov.clip){ say('Import a clip first.', true); $('ovClip').focus(); return; }
      var name = $('ovClipName').value.trim(); if(!name){ say('Give the voice a name first.', true); $('ovClipName').focus(); return; }
      var r = await call('/open-voices/keep-clip', { clipUrl: ov.clip.url, name: name, clipWords: $('ovClipWords').value, seconds: ov.clip.seconds });
      if(!r.ok){ say(r.data.error || 'The voice did not save.', true); return; }
      await reloadVoices(r.data.voice && r.data.voice.id); say(r.data.spoken || 'Saved.');
    };
    $('ovForget').onclick = async function(){
      var id = $('ovVoice').value; if(!id || id === 'clip') return;
      var r = await call('/open-voices/forget', { voiceId: id });
      if(!r.ok){ say(r.data.error || 'Could not remove it.', true); return; }
      await reloadVoices(); say(r.data.spoken || 'Removed.'); $('ovVoice').focus();
    };

    function setBusy(b){ ov.busy = b; $('ovMake').disabled = b; $('ovStop').hidden = !b; }
    $('ovMake').onclick = async function(){
      if(ov.busy) return;
      var body = { engine: $('ovEngine').value, mode: ov.mode, text: $('ovText').value, seed: $('ovSeed').value };
      if(ov.mode === 'design') body.description = $('ovDescription').value;
      else {
        body.style = $('ovStyle').value;
        if($('ovVoice').value === 'clip'){ if(!ov.clip){ say('Import a clip first, or pick a saved voice.', true); $('ovClip').focus(); return; } body.clipUrl = ov.clip.url; body.clipWords = $('ovClipWords').value; }
        else body.voiceId = $('ovVoice').value;
      }
      setBusy(true); say('Starting a take…');
      var r = await call('/open-voices/take', body);
      if(!r.ok){ setBusy(false); say(r.data.error || 'The take could not start.', true); return; }
      ov.jobId = r.data.jobId; ov.lastSpoken = Date.now();
      var msg = 'Making a take, voice number ' + r.data.seed + '.';
      if(r.data.coldLikely && !ov.coldSaid){ ov.coldSaid = true; msg += ' ' + (r.data.coldNote || ov.coldNote); }
      say(msg + ' The page will say when it is ready.');
      ov.timer = setTimeout(poll, 3000);
    };
    $('ovStop').onclick = async function(){
      if(!ov.jobId) return;
      var r = await call('/open-voices/stop', { jobId: ov.jobId });
      if(!r.ok){ say(r.data.error || 'Stop was not confirmed.', true); return; }
      clearTimeout(ov.timer); ov.jobId = null; setBusy(false); say('Stopped. Nothing was kept from this take.');
    };
    async function poll(){
      if(!ov.jobId) return;
      var id = ov.jobId;
      var r = await call('/open-voices/take/' + encodeURIComponent(id));
      var d = r.data || {};
      if(id !== ov.jobId) return;
      if(r.ok && d.state === 'done' && d.url){ ov.jobId = null; setBusy(false); addTake(d, id); return; }
      if(!r.ok || d.state === 'failed' || d.state === 'cancelled'){ ov.jobId = null; setBusy(false); say(d.error || 'The take did not finish.', true); return; }
      if(d.spoken && Date.now() - ov.lastSpoken > 20000){ ov.lastSpoken = Date.now(); say(d.spoken); }
      ov.timer = setTimeout(poll, 3000);
    }
    function addTake(d, jobId){
      ov.takes++;
      var n = ov.takes, engine = (ov.engines.find(function(e){ return e.id === d.engine; }) || {}).label || d.engine;
      var li = document.createElement('li'); li.className = 'proj';
      var title = 'Take ' + n + ', ' + engine + ', voice number ' + d.seed + (d.seconds ? ', ' + Math.round(d.seconds) + ' seconds' : '');
      var h = document.createElement('h3'); h.textContent = title; li.appendChild(h);
      var a = document.createElement('audio'); a.controls = true; a.preload = 'none'; a.src = d.url; a.setAttribute('aria-label', 'Play take ' + n); li.appendChild(a);
      var lab = document.createElement('label'); lab.className = 'field'; lab.htmlFor = 'ovName' + n; lab.textContent = 'Name for this voice';
      var name = document.createElement('input'); name.type = 'text'; name.id = 'ovName' + n; name.maxLength = 80;
      var keep = document.createElement('button'); keep.type = 'button'; keep.className = 'act quiet'; keep.textContent = 'Keep as a saved voice';
      keep.setAttribute('aria-label', 'Keep take ' + n + ' as a saved voice');
      keep.onclick = async function(){
        var nm = name.value.trim(); if(!nm){ say('Give the voice a name first.', true); name.focus(); return; }
        var r = await call('/open-voices/keep', { jobId: jobId, name: nm });
        if(!r.ok){ say(r.data.error || 'The voice did not save.', true); return; }
        keep.disabled = true; keep.textContent = 'Kept as ' + nm; await reloadVoices(); say(r.data.spoken || 'Saved.');
      };
      li.appendChild(lab); li.appendChild(name); li.appendChild(keep);
      $('ovTakes').insertBefore(li, $('ovTakes').firstChild); $('ovTakesHeading').hidden = false;
      say(title + ' is ready. Play it, or keep it as a saved voice.');
    }
  })();
  </script>`;

/* Both empty while KADE_OPEN_VOICES=0, so the page is then the text it was before. */
function pageParts(env = process.env) {
  return env.KADE_OPEN_VOICES === '0' ? { OPEN_VOICES_HTML: '', OPEN_VOICES_SCRIPT: '' } : { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT };
}

module.exports = { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT, pageParts };
