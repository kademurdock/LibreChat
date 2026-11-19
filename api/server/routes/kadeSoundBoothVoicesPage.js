/* ----------------------------------------------------------------------------
 * THE VOICE LAB, ON THE WEB (Nov 18 2026)
 *
 * Her ask: clone voices on the platform, with the person's permission, from a screen she can use herself with NVDA or
 * VoiceOver. The server side is packages/api music/voiceLab.ts, mounted by kadeSoundBooth.js; this page is only its face.
 *
 * SCREEN-READER SHAPE (the booth's rules): every control is a real labelled form control; ONE polite live region
 * (#status) says what happened; nothing is drag and drop; nothing auto-plays; a press that costs money is a two-step
 * confirm that says the estimate first; after a list changes, focus lands on a heading or the control that was used, never
 * on nothing. The words (intro, permission sentence, tips, cost) come from the server's guide, so a wording fix is one
 * deploy. An account that may not use the lab gets one plain sentence and a way back.
 * -------------------------------------------------------------------------- */
const { SHARED_HEAD } = require('./kadePages');

const voiceLabHtml = `<!doctype html><html lang="en"><head><title>Voice lab — Sound Booth — Kade-AI</title>${SHARED_HEAD}
<style>
  .status { padding:.7rem .9rem; border-radius:10px; background:#eef3ff; margin:.8rem 0; }
  .status.err { background:#fdecea; }
  label.field { display:block; font-weight:600; margin:.8rem 0 .2rem; }
  .hint { font-size:.92rem; margin:.15rem 0 .4rem; opacity:.85; }
  input[type=text] { font:inherit; padding:.5rem .6rem; border-radius:10px; border:1px solid #b9bfc9; width:100%; max-width:32rem; box-sizing:border-box; }
  button.act { font:inherit; font-weight:700; padding:.6rem 1rem; border-radius:10px; border:1px solid #1d55d0; background:#fff; color:#1d55d0; cursor:pointer; margin:.5rem .5rem .2rem 0; }
  button.act.primary { background:#1f7a49; border-color:#1f7a49; color:#fff; }
  button.act.quiet { border-color:#8a919c; color:inherit; font-weight:600; }
  button.act.danger { border-color:#b3261e; color:#b3261e; }
  button.act[disabled] { opacity:.55; cursor:default; }
  button.act:focus-visible, input:focus-visible, h2:focus-visible, h3:focus-visible { outline:3px solid #ffbf47; outline-offset:2px; }
  .voice { border:1px solid #d9dde3; border-radius:14px; padding:.4rem 1rem .8rem; margin:1rem 0; }
  .voice h3 { margin:.5rem 0 .2rem; font-size:1.15rem; }
  fieldset { border:1px solid #d9dde3; border-radius:12px; margin:.8rem 0; padding:.5rem 1rem .8rem; }
  legend { font-weight:700; padding:0 .4rem; }
  ul.samples { margin:.3rem 0 .3rem 1.1rem; padding:0; }
  ul.samples li { margin:.25rem 0; }
  @media (prefers-color-scheme: dark) {
    .status { background:#1b2a4a; } .status.err { background:#4a1b1b; }
    input[type=text], button.act { background:#1e2127; border-color:#3a3f49; }
    button.act.primary { background:#1f7a49; }
    .voice, fieldset { border-color:#3a3f49; }
  }
</style>
</head>
<body>
  <p><a class="back" href="/sound-booth" aria-label="Back to the Sound Booth">&larr; Sound Booth</a> &nbsp;&middot;&nbsp; <a class="back" href="/home">Home</a></p>
  <h1>Voice lab</h1>
  <div id="status" class="status" role="status" aria-live="polite">Loading the voice lab&hellip;</div>

  <main id="app" hidden>
    <p id="intro"></p>
    <details><summary>Tips for good recordings, and what it costs</summary><ul id="tips"></ul><p id="cost"></p></details>

    <h2 id="voicesHeading" tabindex="-1">Your voices</h2>
    <div id="voices"></div>

    <h2 id="newHeading" tabindex="-1">Make a new voice</h2>
    <form id="newVoice" novalidate>
      <label class="field" for="newName">Name for this voice</label>
      <p class="hint" id="newNameHint">What you will pick it by, such as Dad singing, or My low voice. 2 to 40 characters.</p>
      <input type="text" id="newName" maxlength="40" autocomplete="off" aria-describedby="newNameHint">
      <fieldset>
        <legend>Whose voice is it?</legend>
        <label><input type="radio" name="whose" id="whoseMine" value="mine" checked> My own voice</label><br>
        <label><input type="radio" name="whose" id="whoseOther" value="other"> Someone else&rsquo;s voice</label>
      </fieldset>
      <div id="otherBox" hidden>
        <label class="field" for="newPerson">Whose voice</label>
        <p class="hint" id="newPersonHint">A first name, or how you know them. Kept with the voice as the record of whose it is.</p>
        <input type="text" id="newPerson" maxlength="80" autocomplete="off" aria-describedby="newPersonHint">
        <p><label><input type="checkbox" id="newConsent" aria-describedby="consentHint"> <span id="consentText"></span></label></p>
        <p class="hint" id="consentHint"></p>
      </div>
      <button type="submit" class="act primary" id="btnCreate">Make this voice</button>
    </form>
  </main>

  <script>
  (async function(){
    var status = document.getElementById('status'), app = document.getElementById('app');
    function say(msg, isErr){ status.className = 'status' + (isErr ? ' err' : ''); status.textContent = status.textContent===msg ? msg+'\\u00a0' : msg; }
    function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
    function clock(s){ s=Math.round(s||0); var m=Math.floor(s/60), r=s%60; return m ? m+' minute'+(m===1?'':'s')+(r?' '+r+' seconds':'') : r+' seconds'; }
    var token = null; try { token = await getToken(); } catch(e) {}
    if(!token){ say('Please sign in at the chat site first, then reload this page.', true); return; }
    async function call(method, path, body, form){
      var send = function(){ return fetch('/api/kade/sound-booth'+path, { method: method, headers: form ? {'Authorization':'Bearer '+token} : {'Authorization':'Bearer '+token,'Content-Type':'application/json'}, body: form ? form : body === undefined ? undefined : JSON.stringify(body) }); };
      var r = await send();
      if(r.status === 401){ try { token = await getToken(); } catch(e) {} if(token) r = await send(); }
      var data = {}; try { data = await r.json(); } catch(e) {}
      return { ok: r.ok, status: r.status, data: data };
    }
    var state = { voices: [], guide: null, busy: false, confirm: null, recorder: null, recordingFor: null, timer: null, last: {} };

    var first = await call('GET', '/voices');
    if(!first.ok){
      say(first.status === 404 ? 'The voice lab is not turned on for this account.' : 'The voice lab could not load just now. Reload the page to try again.', true);
      return;
    }
    state.guide = first.data.guide || {}; state.voices = first.data.voices || [];
    document.getElementById('intro').textContent = state.guide.intro || '';
    document.getElementById('tips').innerHTML = (state.guide.tips || []).map(function(t){ return '<li>'+esc(t)+'</li>'; }).join('');
    document.getElementById('cost').textContent = state.guide.cost || '';
    document.getElementById('consentText').textContent = state.guide.consent || 'I have this person\\u2019s permission to copy their voice.';
    document.getElementById('consentHint').textContent = state.guide.consentHint || '';
    app.hidden = false;

    function byId(id){ return state.voices.filter(function(v){ return v.id === id; })[0]; }
    function put(voice){ var at = -1; state.voices.forEach(function(v,i){ if(v.id === voice.id) at = i; }); if(at < 0) state.voices.unshift(voice); else state.voices[at] = voice; }
    function open(v){ return ['collecting','failed','cancelled','uncertain'].indexOf(v.state) >= 0; }
    function learning(v){ return v.state === 'training' || v.state === 'submitting'; }

    function card(v){
      var id = v.id, h = '';
      h += '<section class="voice" aria-labelledby="h_'+id+'"><h3 id="h_'+id+'" tabindex="-1">'+esc(v.name)+'</h3>';
      h += '<p class="hint">'+(v.whose === 'other' ? 'Someone else\\u2019s voice'+(v.person ? ': '+esc(v.person) : '')+', made with their permission.' : 'Your own voice.')+'</p>';
      h += '<p id="st_'+id+'">'+esc(v.status)+'</p>';
      if(open(v)){
        h += '<label class="field" for="file_'+id+'">Add a recording to '+esc(v.name)+'</label>';
        h += '<p class="hint" id="fileh_'+id+'">A WAV, MP3, M4A, OGG or FLAC file, up to 60 megabytes. You can pick several at once.</p>';
        h += '<input type="file" id="file_'+id+'" data-file="'+id+'" multiple accept=".wav,.mp3,.m4a,.ogg,.flac,.webm,audio/*" aria-describedby="fileh_'+id+'"'+(state.busy?' disabled':'')+'>';
        h += '<p><button type="button" class="act quiet" data-rec="'+id+'"'+(state.busy && state.recordingFor !== id ?' disabled':'')+'>'+(state.recordingFor === id ? 'Stop recording and add it' : 'Record with the microphone')+'</button></p>';
        if(v.samples.length){
          h += '<h4 id="sh_'+id+'">Recordings on this voice</h4><ul class="samples" aria-labelledby="sh_'+id+'">';
          v.samples.forEach(function(s, n){ h += '<li>'+esc(s.name)+', '+clock(s.seconds)+' <button type="button" class="act quiet" data-rm="'+id+'" data-n="'+n+'"'+(state.busy?' disabled':'')+'>Remove '+esc(s.name)+'</button></li>'; });
          h += '</ul>';
        }
        h += '<p><label><input type="checkbox" id="iso_'+id+'" aria-describedby="isoh_'+id+'"> These recordings have music in them</label></p><p class="hint" id="isoh_'+id+'">On: the singer is split from the music first. Leave off for a voice on its own.</p>';
        h += '<p><label><input type="checkbox" id="noise_'+id+'" aria-describedby="noiseh_'+id+'"> Clean up hiss and background noise first</label></p><p class="hint" id="noiseh_'+id+'">For phone recordings and old tapes. Leave off for clean recordings.</p>';
        h += '<p class="hint" id="est_'+id+'">'+esc(v.estimate)+'</p>';
        h += '<button type="button" class="act primary" data-train="'+id+'" aria-describedby="est_'+id+'"'+((!v.canTrain || state.busy)?' disabled':'')+'>'+(state.confirm === id ? 'Yes, learn '+esc(v.name)+' now' : 'Learn this voice')+'</button>';
      }
      if(learning(v)) h += '<button type="button" class="act" data-check="'+id+'">Check progress</button> <button type="button" class="act danger" data-stop="'+id+'">Stop learning</button>';
      if(v.state === 'ready') h += '<p><a href="/sound-booth">Go to the Sound Booth to sing with '+esc(v.name)+'</a></p>';
      h += ' <button type="button" class="act quiet" data-rename="'+id+'"'+(state.busy?' disabled':'')+'>Rename '+esc(v.name)+'</button>';
      if(!learning(v)) h += ' <button type="button" class="act danger" data-del="'+id+'"'+(state.busy?' disabled':'')+'>'+(state.confirm === 'del_'+id ? 'Yes, delete '+esc(v.name)+' for good' : 'Delete '+esc(v.name))+'</button>';
      return h + '</section>';
    }
    function render(focusId){
      var box = document.getElementById('voices');
      var keep = {}; state.voices.forEach(function(v){ var a=document.getElementById('iso_'+v.id), b=document.getElementById('noise_'+v.id); keep[v.id] = { iso: !!(a&&a.checked), noise: !!(b&&b.checked) }; });
      box.innerHTML = state.voices.length ? state.voices.map(card).join('') : '<p class="muted">No voices yet. Make one below.</p>';
      state.voices.forEach(function(v){ var a=document.getElementById('iso_'+v.id), b=document.getElementById('noise_'+v.id); if(a) a.checked = keep[v.id].iso; if(b) b.checked = keep[v.id].noise; });
      wire();
      if(focusId){ var el = document.getElementById(focusId) || document.querySelector(focusId); if(el) el.focus(); }
      watch();
    }
    function focusOf(el){ return el.id || (el.dataset.train ? '[data-train="'+el.dataset.train+'"]' : el.dataset.del ? '[data-del="'+el.dataset.del+'"]' : el.dataset.rec ? '[data-rec="'+el.dataset.rec+'"]' : null); }

    async function addFile(id, file){
      var fd = new FormData(); fd.append('clip', file, file.name || 'recording.webm');
      var r = await call('POST', '/voices/'+id+'/samples', undefined, fd);
      if(r.ok){ put(r.data.voice); return { ok: true, said: 'Added '+(r.data.added || file.name) }; }
      return { ok: false, said: (file.name ? file.name+': ' : '') + (r.data.error || 'That recording could not be added.') };
    }
    async function addFiles(id, files){
      if(state.busy || !files.length) return;
      state.busy = true; state.confirm = null; render('h_'+id);
      var good = 0, problems = [];
      for(var i=0;i<files.length;i++){
        say('Adding recording '+(i+1)+' of '+files.length+', '+files[i].name+'.');
        var out = await addFile(id, files[i]);
        if(out.ok) good++; else problems.push(out.said);
      }
      state.busy = false; render('file_'+id);
      var v = byId(id);
      say((good ? good+' recording'+(good===1?'':'s')+' added. ' : '') + (problems.length ? problems.join(' ')+' ' : '') + (v ? v.status+' '+v.estimate : ''), !!problems.length && !good);
    }
    async function toggleRecord(id){
      if(state.recorder && state.recordingFor === id){ state.recorder.stop(); return; }
      if(state.busy) return;
      if(!navigator.mediaDevices || !window.MediaRecorder){ say('This browser cannot record here. Record with another app and add the file instead.', true); return; }
      var stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
      catch(e){ say('The microphone is not available. Allow the microphone for this site, or add a file instead.', true); return; }
      var chunks = [], began = Date.now(), rec = new MediaRecorder(stream);
      rec.ondataavailable = function(e){ if(e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async function(){
        stream.getTracks().forEach(function(t){ t.stop(); });
        state.recorder = null; state.recordingFor = null; state.busy = false;
        var type = rec.mimeType || 'audio/webm', ext = type.indexOf('mp4') >= 0 ? 'm4a' : type.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
        var count = (byId(id) ? byId(id).samples.length : 0) + 1;
        var file = new File(chunks, 'Microphone recording '+count+'.'+ext, { type: type });
        if(Date.now() - began < 1500){ render('[data-rec="'+id+'"]'); say('That was too short to use. Record at least a few seconds.', true); return; }
        await addFiles(id, [file]);
      };
      state.recorder = rec; state.recordingFor = id; state.busy = true; state.confirm = null;
      rec.start();
      render('[data-rec="'+id+'"]');
      say('Recording. Sing or talk, then press Stop recording and add it.');
    }
    async function train(id, button){
      var v = byId(id); if(!v || state.busy) return;
      if(state.confirm !== id){ state.confirm = id; render('[data-train="'+id+'"]'); say('Ready to learn '+v.name+'. '+v.estimate+' Press the button again to start.'); return; }
      state.confirm = null; state.busy = true; render('h_'+id); say('Starting.');
      var iso = document.getElementById('iso_'+id), noise = document.getElementById('noise_'+id);
      var r = await call('POST', '/voices/'+id+'/train', { isolate: !!(iso && iso.checked), denoise: noise && noise.checked ? 0.4 : 0 });
      state.busy = false;
      if(r.ok){ put(r.data.voice); render('h_'+id); say(r.data.started || 'Learning has started.'); }
      else { await refresh(id); render('h_'+id); say(r.data.error || 'Learning could not start.', true); }
    }
    async function refresh(id){ var r = await call('GET', '/voices/'+id); if(r.ok) put(r.data.voice); return r.ok ? r.data.voice : null; }
    async function check(id, announce){
      var before = byId(id), was = before ? before.state : '';
      var v = await refresh(id); if(!v) return;
      if(v.state !== was){ render('h_'+id); say(v.name+': '+v.status, v.state === 'failed'); }
      else { var line = document.getElementById('st_'+id); if(line) line.textContent = v.status; if(announce) say(v.name+': '+v.status); }
    }
    function watch(){
      if(state.timer){ clearInterval(state.timer); state.timer = null; }
      if(!state.voices.some(learning)) return;
      state.timer = setInterval(function(){ state.voices.filter(learning).forEach(function(v){ check(v.id, false); }); }, 20000);
    }
    function wire(){
      Array.prototype.forEach.call(document.querySelectorAll('[data-file]'), function(el){ el.onchange = function(){ var files = Array.prototype.slice.call(el.files || []); if(files.length) addFiles(el.dataset.file, files); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-rec]'), function(el){ el.onclick = function(){ toggleRecord(el.dataset.rec); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-train]'), function(el){ el.onclick = function(){ train(el.dataset.train, el); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-check]'), function(el){ el.onclick = function(){ check(el.dataset.check, true); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-rm]'), function(el){ el.onclick = async function(){
        if(state.busy) return; var id = el.dataset.rm;
        var r = await call('DELETE', '/voices/'+id+'/samples/'+el.dataset.n);
        if(r.ok){ put(r.data.voice); state.confirm = null; render('file_'+id); say('Removed '+(r.data.removed || 'the recording')+'. '+byId(id).status); }
        else say(r.data.error || 'That recording could not be removed.', true);
      }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-stop]'), function(el){ el.onclick = async function(){
        var id = el.dataset.stop, r = await call('POST', '/voices/'+id+'/cancel');
        if(r.ok){ put(r.data.voice); render('h_'+id); say(r.data.stopped || 'Learning was stopped.'); } else say(r.data.error || 'It could not be stopped.', true);
      }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-rename]'), function(el){ el.onclick = async function(){
        var id = el.dataset.rename, v = byId(id); if(!v) return;
        var name = window.prompt('New name for '+v.name, v.name); if(name == null) return;
        var r = await call('PATCH', '/voices/'+id, { name: name });
        if(r.ok){ put(r.data.voice); render('h_'+id); say('Renamed to '+r.data.voice.name+'.'); } else say(r.data.error || 'It could not be renamed.', true);
      }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function(el){ el.onclick = async function(){
        var id = el.dataset.del, v = byId(id); if(!v || state.busy) return;
        if(state.confirm !== 'del_'+id){ state.confirm = 'del_'+id; render('[data-del="'+id+'"]'); say('Delete '+v.name+' for good, with its recordings and its voice model? This cannot be undone. Press the button again to delete it.'); return; }
        state.confirm = null;
        var r = await call('DELETE', '/voices/'+id);
        if(r.ok){ state.voices = state.voices.filter(function(x){ return x.id !== id; }); render('voicesHeading'); say(r.data.deleted || 'Deleted.'); }
        else { render('h_'+id); say(r.data.error || 'It could not be deleted.', true); }
      }; });
    }

    var other = document.getElementById('otherBox');
    function whose(){ return document.getElementById('whoseOther').checked ? 'other' : 'mine'; }
    document.getElementById('whoseMine').onchange = document.getElementById('whoseOther').onchange = function(){ other.hidden = whose() !== 'other'; };
    document.getElementById('newVoice').onsubmit = async function(e){
      e.preventDefault(); if(state.busy) return;
      var name = document.getElementById('newName').value.trim();
      if(name.length < 2){ say('Give the voice a name first.', true); document.getElementById('newName').focus(); return; }
      if(whose() === 'other' && !document.getElementById('newPerson').value.trim()){ say('Say whose voice this is.', true); document.getElementById('newPerson').focus(); return; }
      if(whose() === 'other' && !document.getElementById('newConsent').checked){ say('Tick the permission box first. A voice that is not your own needs that person\\u2019s permission.', true); document.getElementById('newConsent').focus(); return; }
      var r = await call('POST', '/voices', { name: name, whose: whose(), person: document.getElementById('newPerson').value.trim(), consent: document.getElementById('newConsent').checked });
      if(!r.ok){ say(r.data.error || 'The voice could not be made.', true); return; }
      put(r.data.voice);
      document.getElementById('newName').value = ''; document.getElementById('newPerson').value = ''; document.getElementById('newConsent').checked = false;
      document.getElementById('whoseMine').checked = true; other.hidden = true;
      render('h_'+r.data.voice.id);
      say(r.data.voice.name+' is made. Now add recordings of this voice: choose files, or record with the microphone.');
    };

    render();
    say(state.voices.length ? 'Voice lab ready. You have '+state.voices.length+' voice'+(state.voices.length===1?'':'s')+'.' : 'Voice lab ready. Make your first voice under Make a new voice.');
  })();
  </script>
</body></html>`;

module.exports = { voiceLabHtml };
