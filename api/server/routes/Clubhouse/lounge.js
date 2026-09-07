
    (async function(){
      const $ = (id) => document.getElementById(id);
      const status = $('status');
      // July 24 2026: the NATIVE app opens this page in an in-app WebKit
      // screen and hands its own sign-in over in the URL FRAGMENT (never
      // sent to the server, never logged): /lounge#lktok=<jwt>. Fragment
      // wins when present; the cookie-refresh path stays for browsers.
      let token = null;
      try {
        const m = /[#&]lktok=([^&]+)/.exec(location.hash || '');
        if (m) {
          token = decodeURIComponent(m[1]);
          history.replaceState(null, '', location.pathname); // scrub the hash
        }
      } catch(e) {}
      if (!token) { try { token = await getToken(); } catch(e) {} }
      if(!token){ status.className='status err'; status.textContent='Please sign in at the chat site first, then reload this page.'; return; }
      if(typeof LivekitClient === 'undefined'){
        status.className='status err';
        status.textContent='The audio engine could not load â€” check the connection and reload.';
        return;
      }
      const LK = LivekitClient;
      const AC = window.AudioContext || window.webkitAudioContext;

      let cfg;
      try{
        const r = await apiGet('/api/kade/lounge/config', token);
        cfg = await r.json();
      }catch(e){ status.className='status err'; status.textContent='Could not reach the Clubhouse â€” try a reload.'; return; }

      /* â”€â”€ the picker â”€â”€ */
      $('room-list').innerHTML = (cfg.rooms||[]).map(function(r){
        return '<button type="button" class="room" data-room="'+r.key+'">'+r.name+' <span class="desc">'+r.blurb+'</span></button>';
      }).join('');
      function renderHotel(list){
        // Only rooms YOU opened ever render â€” the Hotel keeps no public list.
        if(!list || !list.length){ $('hotel-mine').innerHTML = ''; return; }
        $('hotel-mine').innerHTML = '<h3>Rooms you opened</h3>' + list.map(function(h){
          return '<p>'+esc(h.name)+' <button type="button" class="rowbtn small red" data-close="'+h.key+'">Close this room</button></p>';
        }).join('');
      }
      function esc(s){ var d=document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/"/g,'&quot;'); }
      renderHotel(cfg.hotel);
      $('pick').hidden = false;
      if(!cfg.ready){
        status.className = 'status';
        status.textContent = "The Clubhouse is built and ready â€” it's just waiting on Kade to drop the room-server keys into Railway. Two-minute job, then this page comes alive.";
      } else {
        status.textContent = 'Pick a room.';
      }

      /* â”€â”€ shared room state â”€â”€ */
      let lkRoom = null;
      let micTrack = null;
      let micMuted = false;
      let myIdentity = null;
      let myName = null;
      let roomLabel = '';

      function say(text){ $('rstatus').textContent = text; }

      /* â”€â”€ THE HOUSE PA (July 24, her ask: announcements "like a PA system
       * and isn't screen reader reliant") â”€â”€
       * Room events get READ OUT LOUD on every member's device by two host
       * clone voices: Miss A pro reading works the front desk (joins,
       * leaves, taping notices) and Kade's calm narrator runs the booth
       * (jukebox news). Everyone hears the same words at the same moment â€”
       * each device speaks them locally, so the PA never depends on any one
       * phone. With the PA on, room events land in a NON-live line (no
       * VoiceOver double-talk); if a clip cannot fetch or play, the text
       * falls back to the live region so nothing is ever missed. */
      var PA_DOORS = 'Voice 393';  // Miss A pro reading â€” the front desk
      var PA_BOOTH = 'Voice 327';  // Kade, calm inspirational â€” the booth
      var paOn = true, paVol = 0.9;
      try{ paOn = localStorage.getItem('kadeClubPAOn') !== '0'; }catch(e){}
      try{ var pv = parseInt(localStorage.getItem('kadeClubPAVol'), 10); if(!isNaN(pv)) paVol = Math.max(0, Math.min(100, pv))/100; }catch(e){}
      var paCtx = null, paGain = null, paQueue = [], paBusy = false;
      var paCache = {}, paCacheKeys = [];
      function paCtxUp(){
        if(!paCtx){
          try{ paCtx = new AC(); keepWarm(paCtx); paGain = paCtx.createGain(); paGain.gain.value = paVol; paGain.connect(paCtx.destination); }catch(e){ return null; }
        }
        if(paCtx.state === 'suspended'){ try{ paCtx.resume(); }catch(e){} }
        return paCtx;
      }
      async function paClip(text, voice){
        var key = voice + '|' + text;
        if(paCache[key]) return paCache[key];
        var r = await fetch('/api/files/speech/tts/manual', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ input: text, voice: voice }) });
        if(!r.ok) throw new Error('tts');
        var buf = await paCtx.decodeAudioData(await r.arrayBuffer());
        paCache[key] = buf; paCacheKeys.push(key);
        while(paCacheKeys.length > 50){ delete paCache[paCacheKeys.shift()]; }
        return buf;
      }
      function paPump(){
        if(paBusy || !paQueue.length) return;
        paBusy = true;
        var item = paQueue.shift();
        (async function(){
          try{
            if(!paCtxUp()) throw new Error('ctx');
            var buf = await paClip(item.text, item.voice);
            await new Promise(function(done){
              var src = paCtx.createBufferSource();
              src.buffer = buf; src.connect(paGain);
              src.onended = done; src.start();
            });
          }catch(e){ say(item.text); /* the PA lost power â€” VoiceOver takes it */ }
          paBusy = false;
          paPump();
        })();
      }
      function paSay(text, lane){
        if(!text) return;
        if(!paOn || !lkRoom){ say(text); return; }
        $('pa-line').textContent = text;
        if(paQueue.length > 6){ paQueue.shift(); } // never let a backlog lecture the room
        paQueue.push({ text: text, voice: lane === 'booth' ? PA_BOOTH : PA_DOORS });
        paPump();
      }
      $('pa-on').checked = paOn;
      $('pa-vol').value = String(Math.round(paVol*100));
      $('pa-on').addEventListener('change', function(){
        paOn = $('pa-on').checked;
        try{ localStorage.setItem('kadeClubPAOn', paOn ? '1' : '0'); }catch(e){}
        say(paOn ? 'Host voices are on.' : 'Host voices are off â€” announcements go back to the screen reader.');
      });
      $('pa-vol').addEventListener('input', function(){
        paVol = Math.max(0, Math.min(100, parseInt($('pa-vol').value,10)||0))/100;
        try{ localStorage.setItem('kadeClubPAVol', String(Math.round(paVol*100))); }catch(e){}
        if(paGain){ try{ paGain.gain.value = paVol; }catch(e){} }
      });

      /* â”€â”€ THE TAPE DECK (July 24, her ask: "a record of audio the same way
       * they do of the game conversations") â”€â”€
       * Anybody can record the room: your mic, every voice, the jukebox,
       * the bot â€” mixed into one file on YOUR device, downloadable like a
       * Parlor transcript. The whole room is TOLD, by the PA, when a tape
       * starts and stops â€” no sneaky taping in this house. */
      var recCtx=null, recDest=null, recorder=null, recWired=null, recTimer=null, recT0=0, recCap=null;
      var RECORDERS = {};
      function recWire(stream){
        if(!recCtx || !recDest || !stream) return;
        try{
          var tr = stream.getAudioTracks()[0];
          if(!tr || recWired.has(tr.id)) return;
          recWired.add(tr.id);
          recCtx.createMediaStreamSource(new MediaStream([tr])).connect(recDest);
        }catch(e){}
      }
      function recLabel(){
        if(!recorder){ $('btn-rec').textContent = 'Record this conversation'; $('btn-rec').classList.remove('rec-live'); return; }
        var s = Math.floor((Date.now() - recT0)/1000);
        $('btn-rec').textContent = 'Stop the recording â€” ' + Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
        $('btn-rec').classList.add('rec-live');
      }
      function renderRecOthers(){
        var names = Object.keys(RECORDERS).filter(function(k){ return k !== myIdentity; }).map(function(k){ return RECORDERS[k]; });
        $('rec-others').hidden = !names.length;
        $('rec-others').textContent = names.length ? ('Taping now: ' + names.join(', ') + '.') : '';
      }
      function startRec(){
        if(recorder || !lkRoom) return;
        if(!window.MediaRecorder){ say('This browser cannot record â€” try Safari or Chrome.'); return; }
        try{
          recCtx = new AC(); recDest = recCtx.createMediaStreamDestination(); recWired = new Set();
          if(micTrack && micTrack.mediaStreamTrack){ recWire(new MediaStream([micTrack.mediaStreamTrack])); }
          lkRoom.remoteParticipants.forEach(function(p){
            (p.audioTrackPublications || new Map()).forEach(function(pub){
              if(pub.track && pub.track.mediaStreamTrack){ recWire(new MediaStream([pub.track.mediaStreamTrack])); }
            });
          });
          if(jbDest){ recWire(jbDest.stream); }
          if(botDest){ recWire(botDest.stream); }
          var mime = '';
          if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
          else if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
          recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
          var chunks = [];
          recorder.ondataavailable = function(ev){ if(ev.data && ev.data.size) chunks.push(ev.data); };
          recorder.onstop = function(){
            var type = (recorder && recorder.mimeType) || mime || 'audio/webm';
            var secs = Math.round((Date.now() - recT0)/1000);
            recorder = null;
            if(recTimer){ clearInterval(recTimer); recTimer = null; }
            if(recCap){ clearTimeout(recCap); recCap = null; }
            if(recCtx){ try{ recCtx.close(); }catch(e){} recCtx = null; recDest = null; recWired = null; }
            recLabel();
            delete RECORDERS[myIdentity]; renderRecOthers();
            var blob = new Blob(chunks, { type: type }); chunks = [];
            if(!blob.size){ say('The tape came out blank â€” that one is on the browser.'); return; }
            var ext = type.indexOf('mp4') >= 0 ? 'm4a' : 'webm';
            var stamp = new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).replace(/[,:]/g,'.').replace(/\s+/g,' ');
            var fname = 'Clubhouse - ' + (roomLabel || 'room') + ' - ' + stamp + '.' + ext;
            var url = URL.createObjectURL(blob);
            var mb = (blob.size/1048576).toFixed(1);
            var mins = Math.floor(secs/60) + ':' + String(secs%60).padStart(2,'0');
            var box = $('rec-done');
            box.hidden = false;
            box.innerHTML = '';
            var a = document.createElement('a');
            a.href = url; a.download = fname;
            a.textContent = 'Download the recording â€” ' + mins + ', ' + mb + ' MB';
            box.appendChild(a);
            a.click(); // lands straight in Downloads/Files; the link stays for a re-grab
            if(lkRoom){ sendData({ t:'rec', on:false, fromName: myName }); }
            paSay(myName + ' stopped recording. The tape is theirs to keep.', 'doors');
          };
          recT0 = Date.now();
          recorder.start(1000);
          recCap = setTimeout(function(){ if(recorder){ say('The tape ran out at two hours â€” saving what we have.'); stopRec(); } }, 7200000);
          recTimer = setInterval(recLabel, 1000);
          recLabel();
          RECORDERS[myIdentity] = myName; renderRecOthers();
          sendData({ t:'rec', on:true, fromName: myName });
          paSay(myName + ' is recording this conversation.', 'doors');
        }catch(e){
          recorder = null;
          if(recCtx){ try{ recCtx.close(); }catch(e2){} recCtx = null; recDest = null; recWired = null; }
          say('The tape deck jammed â€” try again.');
        }
      }
      function stopRec(){ if(recorder){ try{ recorder.stop(); }catch(e){ recorder = null; recLabel(); } } }
      $('btn-rec').addEventListener('click', function(){ if(recorder){ stopRec(); } else { startRec(); } });

      /* â”€â”€ the visual layer: audio-reactive bars + the spinning 45 â”€â”€
       * Decorative only (aria-hidden, no focus, no live regions); sits out
       * reduced-motion and hidden tabs. */
      var REDUCED = false;
      try{ REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){}
      var vizAnalysers = [], vizRAF = 0;
      function vizTap(ctx, node){
        if(REDUCED) return;
        try{
          var an = ctx.createAnalyser(); an.fftSize = 64;
          node.connect(an);
          vizAnalysers.push({ an: an, ctx: ctx });
        }catch(e){}
      }
      function vizDropCtx(ctx){
        vizAnalysers = vizAnalysers.filter(function(v){ return v.ctx !== ctx; });
      }
      function vizLoop(){
        vizRAF = 0;
        var cv = $('jb-viz');
        if(REDUCED || document.hidden || !lkRoom || cv.hidden){ return; }
        var g = cv.getContext('2d');
        var W = cv.width = cv.clientWidth || 300, H = cv.height = 44;
        g.clearRect(0,0,W,H);
        var bins = 24, sum = new Array(bins).fill(0);
        vizAnalysers.forEach(function(v){
          try{
            var d = new Uint8Array(v.an.frequencyBinCount);
            v.an.getByteFrequencyData(d);
            for(var i=0;i<bins;i++){ sum[i] = Math.max(sum[i], d[Math.min(d.length-1, i)] || 0); }
          }catch(e){}
        });
        var bw = W/bins;
        for(var i=0;i<bins;i++){
          var h = Math.max(2, (sum[i]/255) * (H-4));
          g.fillStyle = 'rgba(31,122,73,' + (0.35 + 0.65*(sum[i]/255)).toFixed(2) + ')';
          g.fillRect(i*bw + 1, H - h, bw - 2, h);
        }
        vizRAF = requestAnimationFrame(vizLoop);
      }
      function vizKick(){
        var cv = $('jb-viz');
        var on = !REDUCED && lkRoom && CLUB.jb.playing;
        cv.hidden = !on;
        if(on && !vizRAF){ vizRAF = requestAnimationFrame(vizLoop); }
      }
      document.addEventListener('visibilitychange', function(){ if(!document.hidden){ vizKick(); } });

      function isDj(identity){ return typeof identity === 'string' && identity.slice(-3) === '-dj'; }
      function rosterParts(){
        if(!lkRoom) return [];
        return [lkRoom.localParticipant].concat(Array.from(lkRoom.remoteParticipants.values()))
          .filter(function(p){ return !isDj(p.identity); });
      }
      function rosterNames(){
        return rosterParts().map(function(p){ return (p.name || p.identity || 'Someone'); });
      }
      function present(identity){
        if(!lkRoom) return false;
        if(identity === myIdentity) return true;
        return Array.from(lkRoom.remoteParticipants.values()).some(function(p){ return p.identity === identity; });
      }
      function stewardId(){
        var ids = rosterParts().map(function(p){ return p.identity; });
        ids.sort();
        return ids[0];
      }

      function renderRoster(){
        if(!lkRoom) return;
        const speaking = new Set((lkRoom.activeSpeakers||[]).map(function(p){ return p.identity; }));
        var html = rosterParts().map(function(p){
          const me = p === lkRoom.localParticipant;
          const talking = speaking.has(p.identity);
          return '<li'+(talking?' class="talking"':'')+'>'+(p.name||p.identity)+(me?' (you)':'')+(talking?' â€” talking':'')+'</li>';
        }).join('');
        if(BOT){
          html += '<li>'+esc(BOT.name)+' â€” companion guest, invited by '+esc(BOT.anchorName||'someone')+(botBusy? ' â€” thinking' : '')+
            ' <button type="button" class="rowbtn small" data-botact="cue">Your turn, '+esc(BOT.name)+'</button>'+
            ' <button type="button" class="rowbtn small gray" data-botact="kick">Ask them to leave</button></li>';
        }
        $('roster').innerHTML = html;
        $('bot-invite-row').hidden = !!BOT;
      }

      /* â”€â”€ THE SHARED JUKEBOX + BOT GUEST state (data-channel, host-hop) â”€â”€
       * One CLUB state for the whole room. The AUTHORITY (the current
       * song's adder if present, else the alphabetically-first identity)
       * applies every command, bumps the version, and broadcasts. Every
       * device then reconciles: "is it MY file that should be playing?
       * start/stop accordingly." Music files never leave the phone that
       * added them â€” the audio itself rides the room as a hi-fi track. */
      let CLUB = { v:0, actn:0, act:'', jb:{ queue:[], curId:null, playing:false, pos:-1 } };
      let lastActn = 0;
      let BOT = null;       // {agentId,name,anchor,anchorName}
      let botBusy = false;

      const myFiles = {};   // entry id -> File (only my own adds)
      const haltCount = {}; // entry id -> early-death count (session grabs)
      const myBuffers = {}; // entry id -> AudioBuffer (my own, decoded)
      const myPos = {};     // entry id -> seconds to resume from (radio fights)
      let jbCtx=null, jbDest=null, jbMonitor=null, jbSrc=null, jbTrack=null;
      let playingEntryId=null, jbStartOffset=0, jbStartTime=0, jbStopping=false, jbSession=0;
      let musicVol = 0.25;
      try{ var sv = parseInt(localStorage.getItem('kadeClubMusicVol'), 10); if(!isNaN(sv)) musicVol = Math.max(0, Math.min(100, sv))/100; }catch(e){}
      $('jb-vol').value = String(Math.round(musicVol*100));

      /* personal listening lane: remote music plays through a WebAudio gain
       * (iPhones ignore element volume; a muted keepalive element + gain
       * node works everywhere). Voices attach plain at full volume. */
      let listenCtx = null;
      let musicGains = [];
      /* KEEPALIVE (July 24, round 5 â€” her catch survived the watchdog):
       * a long-IDLE AudioContext is what iOS wedges in the first place.
       * A running constant-silence source keeps the audio unit warm, so
       * pause-for-twenty-minutes wakes up like pause-for-two-seconds.
       * Three lines per context, zero audible output, zero bandwidth. */
      function keepWarm(ctx){
        try{
          var k = ctx.createConstantSource();
          k.offset.value = 0;
          k.connect(ctx.destination);
          k.start();
        }catch(e){}
      }
      function ensureListenCtx(){
        if(!listenCtx){ try{ listenCtx = new AC(); keepWarm(listenCtx); }catch(e){ return null; } }
        if(listenCtx.state === 'suspended'){ try{ listenCtx.resume(); }catch(e){} }
        return listenCtx;
      }
      function wireMusicGain(track){
        var ctx = ensureListenCtx(); if(!ctx) return false;
        try{
          var src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
          var g = ctx.createGain(); g.gain.value = musicVol;
          src.connect(g); g.connect(ctx.destination);
          vizTap(ctx, g);
          musicGains.push({ track: track, src: src, gain: g });
          return true;
        }catch(e){ return false; }
      }
      function unwireMusicGain(track){
        musicGains = musicGains.filter(function(m){
          if(m.track !== track) return true;
          try{ m.src.disconnect(); m.gain.disconnect(); }catch(e){}
          return false;
        });
      }
      function applyMusicVol(){
        musicGains.forEach(function(m){ try{ m.gain.gain.value = musicVol; }catch(e){} });
        if(jbMonitor){ try{ jbMonitor.gain.value = musicVol; }catch(e){} }
      }
      $('jb-vol').addEventListener('input', function(){
        musicVol = Math.max(0, Math.min(100, parseInt($('jb-vol').value,10)||0))/100;
        try{ localStorage.setItem('kadeClubMusicVol', String(Math.round(musicVol*100))); }catch(e){}
        applyMusicVol();
      });

      /* â”€â”€ data channel â”€â”€ */
      function sendData(obj){
        if(!lkRoom) return;
        try{
          lkRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true, topic: 'club' });
        }catch(e){}
      }
      function curIndex(){
        var jb = CLUB.jb;
        for(var i=0;i<jb.queue.length;i++){ if(jb.queue[i].id === jb.curId) return i; }
        return -1;
      }
      function curEntry(){ var i = curIndex(); return i>=0 ? CLUB.jb.queue[i] : null; }
      function entryById(id){ for(var i=0;i<CLUB.jb.queue.length;i++){ if(CLUB.jb.queue[i].id===id) return CLUB.jb.queue[i]; } return null; }
      function authorityId(){
        var cur = curEntry();
        if(cur && present(cur.by)) return cur.by;
        return stewardId();
      }
      function iAmAuthority(){ return lkRoom && authorityId() === myIdentity; }
      function nextPlayable(fromIndex, dir){
        var q = CLUB.jb.queue;
        for(var i=fromIndex+dir; i>=0 && i<q.length; i+=dir){
          if(present(q[i].by)) return q[i];
        }
        return null;
      }
      function setCurrentId(id){ CLUB.jb.curId = id; CLUB.jb.pos = -1; }
      function setAct(text){ CLUB.act = text; CLUB.actn++; }
      function broadcastState(){
        sendData({ t:'state', v: CLUB.v, actn: CLUB.actn, act: CLUB.act, jb: CLUB.jb });
      }
      function bumpBroadcast(){
        CLUB.v++;
        broadcastState();
        if(CLUB.actn > lastActn){ lastActn = CLUB.actn; if(CLUB.act) paSay(CLUB.act, 'booth'); }
        reconcile();
        renderJukebox();
      }
      function adoptState(msg){
        if(!(msg.v > CLUB.v)) return;
        CLUB.v = msg.v; CLUB.jb = msg.jb || CLUB.jb; CLUB.act = msg.act || ''; CLUB.actn = msg.actn || 0;
        jbPosStamp = Date.now();
        if(CLUB.actn > lastActn){ lastActn = CLUB.actn; if(CLUB.act) paSay(CLUB.act, 'booth'); }
        reconcile();
        renderJukebox();
      }
      function normalizeCurrent(){
        var jb = CLUB.jb;
        if(!jb.curId) return;
        var c = entryById(jb.curId);
        if(!c){ jb.curId = null; jb.playing = false; return; }
        if(jb.playing && !present(c.by)){
          var n = nextPlayable(curIndex(), +1);
          if(n){ setCurrentId(n.id); setAct((c.byName||'Somebody') + " left and took their song along â€” next up: " + n.title + "."); }
          else { jb.playing = false; setAct((c.byName||'Somebody') + " left and took their song along. Music off."); }
        }
      }
      function applyCmd(m){
        var jb = CLUB.jb; var i = curIndex(); var who = m.fromName || 'Somebody';
        if(m.cmd === 'play'){
          if(!jb.curId){ var f = nextPlayable(-1, +1); if(f) setCurrentId(f.id); }
          if(jb.curId){ jb.playing = true; setAct(who + ' pressed play.'); }
        } else if(m.cmd === 'pause'){
          /* keep the position on pause (was -1) so the seek slider shows the
           * real spot instead of 0:00; resume still rides the owner's myPos. */
          if(jb.playing){ var pp = Math.max(0, Math.round(livePos())); jb.playing = false; jb.pos = pp; setAct(who + ' paused the music.'); }
        } else if(m.cmd === 'stop'){
          if(jb.curId){ jb.playing = false; jb.pos = 0; setAct(who + ' stopped the music.'); }
        } else if(m.cmd === 'skip'){
          var n = nextPlayable(i, +1);
          if(n){ setCurrentId(n.id); jb.playing = true; setAct(who + ' skipped ahead to ' + n.title + '.'); }
          else if(jb.curId){ jb.playing = false; jb.pos = 0; setAct(who + ' skipped â€” that was the end of the queue.'); }
        } else if(m.cmd === 'back'){
          var p = nextPlayable(i, -1);
          if(p){ setCurrentId(p.id); jb.playing = true; setAct(who + ' went back to ' + p.title + '.'); }
          else if(jb.curId){ jb.pos = 0; jb.playing = true; setAct(who + ' started the song over.'); }
        } else if(m.cmd === 'jump'){
          var e = entryById(m.id);
          if(e && present(e.by)){ setCurrentId(e.id); jb.playing = true; setAct(who + ' jumped to ' + e.title + '.'); }
        } else if(m.cmd === 'remove'){
          var r = entryById(m.id);
          if(r){
            var wasCur = jb.curId === r.id;
            var n2 = wasCur ? nextPlayable(curIndex(), +1) : null;
            jb.queue = jb.queue.filter(function(x){ return x.id !== r.id; });
            if(wasCur){
              if(n2){ setCurrentId(n2.id); } else { jb.curId = null; jb.playing = false; }
            }
            setAct(m.auto ? (r.title + ' would not play and came off the list.') : (who + ' took ' + r.title + ' off the list.'));
          }
        } else if(m.cmd === 'seek'){
          var se = entryById(m.id) || curEntry();
          if(se && se.id === jb.curId){
            var sp = Math.max(0, Number(m.pos) || 0);
            jb.pos = sp;
            jb.seek = { id: se.id, pos: sp, n: ((jb.seek && jb.seek.n) || 0) + 1 };
            setAct(who + ' moved the song.');
          }
        } else if(m.cmd === 'clearq'){
          if(jb.queue.length){
            jb.queue = []; jb.curId = null; jb.playing = false; jb.pos = -1; jb.seek = null;
            setAct(who + ' cleared the queue.');
          }
        } else if(m.cmd === 'ended'){
          var n3 = nextPlayable(i, +1);
          if(n3){ setCurrentId(n3.id); jb.playing = true; setAct('Next up: ' + n3.title + '.'); }
          else { jb.playing = false; jb.pos = 0; setAct('That was the end of the queue.'); }
        }
        normalizeCurrent();
        bumpBroadcast();
      }
      function applyAdd(entry, interrupt, fromName){
        var jb = CLUB.jb;
        if(interrupt && jb.curId){
          var i = curIndex();
          jb.queue.splice(i+1, 0, entry);
          setCurrentId(entry.id); jb.playing = true;
          setAct(fromName + ' cut in with ' + entry.title + '.');
        } else {
          jb.queue.push(entry);
          if(!jb.curId){ setCurrentId(entry.id); jb.playing = true; setAct(fromName + ' dropped a quarter in: ' + entry.title + '.'); }
          else { setAct(fromName + ' queued up ' + entry.title + '.'); }
        }
        normalizeCurrent();
        bumpBroadcast();
      }
      function clubCmd(cmd, extra){
        var msg = Object.assign({ t:'cmd', cmd: cmd, fromName: myName }, extra || {});
        if(iAmAuthority()){ applyCmd(msg); } else { sendData(msg); }
      }

      /* â”€â”€ my playback engine (only for entries I added) â”€â”€ */
      function myCurrentPos(){
        if(!jbCtx || !jbSrc) return 0;
        return jbStartOffset + (jbCtx.currentTime - jbStartTime);
      }
      async function getBuffer(id){
        if(myBuffers[id]) return myBuffers[id];
        var f = myFiles[id];
        if(!f) throw new Error('no file');
        var scratch = jbCtx || new AC();
        var buf = await scratch.decodeAudioData(await f.arrayBuffer());
        Object.keys(myBuffers).forEach(function(k){ if(k !== id) delete myBuffers[k]; });
        myBuffers[id] = buf;
        return buf;
      }
      async function startPlayback(entry){
        var session = ++jbSession;
        var prevId = playingEntryId;
        if(jbSrc && prevId && prevId !== entry.id){ myPos[prevId] = myCurrentPos(); }
        playingEntryId = entry.id;
        try{
          if(!jbCtx){
            jbCtx = new AC();
            keepWarm(jbCtx);
            jbDest = jbCtx.createMediaStreamDestination();
            jbMonitor = jbCtx.createGain();
            jbMonitor.gain.value = musicVol;
            jbMonitor.connect(jbCtx.destination);
            vizTap(jbCtx, jbMonitor);
          }
          if(jbCtx.state === 'suspended'){ try{ await jbCtx.resume(); }catch(e){} }
          var buf = await getBuffer(entry.id);
          if(session !== jbSession) return;
          if(!jbTrack){
            /* HER BUG (July 24, "it said it was playing that other song, but
             * it never really did"): unpublishTrack(track, true) STOPS the
             * destination's MediaStreamTrack, and a stopped track is dead
             * forever â€” republishing it ships silence while the state says
             * playing. A fresh destination node every republish = a live
             * track every time. */
            jbDest = jbCtx.createMediaStreamDestination();
            jbTrack = jbDest.stream.getAudioTracks()[0];
            recWire(jbDest.stream);
            await lkRoom.localParticipant.publishTrack(jbTrack, {
              dtx: false,
              red: false,
              /* round 5: browsers do not NEGOTIATE stereo opus on their own â€”
               * forceStereo writes it into the SDP so the encoder actually
               * sends two channels (her mono-on-the-receiver catch). */
              forceStereo: true,
              audioPreset: LK.AudioPresets.musicHighQualityStereo,
              source: LK.Track.Source.Unknown,
              name: 'music',
            });
            if(session !== jbSession) return;
          }
          if(jbSrc){ jbStopping = true; try{ jbSrc.onended=null; jbSrc.stop(); }catch(e){} jbStopping = false; jbSrc = null; }
          var offset = (CLUB.jb.pos === 0) ? 0 : (myPos[entry.id] || 0);
          if(offset >= buf.duration - 0.3) offset = 0;
          jbSrc = jbCtx.createBufferSource();
          jbSrc.buffer = buf;
          jbSrc.connect(jbDest);
          jbSrc.connect(jbMonitor);
          jbStartOffset = offset; jbStartTime = jbCtx.currentTime;
          if(!entry.dur){
            entry.dur = buf.duration;
            CLUB.v++; broadcastState(); renderJukebox();
          }
          /* WAKE WATCHDOG (July 24, her catch: "once music has been paused a
           * while it's impossible to start the session back up again even
           * though it says it is started"): after a long pause iOS can wedge
           * the AudioContext â€” resume() claims fine, currentTime freezes,
           * no audio, no onended, no error. Verify the clock actually RUNS
           * shortly after start; if it's wedged, tear the whole audio stack
           * down (a closed context can't be saved) and pause honestly â€” the
           * NEXT Play tap rebuilds from scratch inside the tap's user
           * gesture, which iOS always honors. */
          (function(sess, sId){
            setTimeout(function(){
              if(sess !== jbSession || playingEntryId !== sId || !jbCtx) return;
              if(jbCtx.state === 'running' && (jbCtx.currentTime - jbStartTime) > 0.15) return;
              stopPlayback(true);
              vizDropCtx(jbCtx);
              try{ jbCtx.close(); }catch(e){}
              jbCtx = null; jbDest = null; jbMonitor = null;
              say('iOS dozed off on the speakers â€” press Play once more.');
              clubCmd('pause');
            }, 1200);
          })(jbSession, entry.id);
          var thisId = entry.id;
          var thisDur = buf.duration;
          jbSrc.onended = function(){
            if(jbStopping || playingEntryId !== thisId) return;
            var played = myCurrentPos();
            playingEntryId = null; jbSrc = null;
            if(played < thisDur - 2){
              // died mid-song (audio session interruption) â€” resume once,
              // and if it keeps dying, pause honestly. Never eat the queue.
              myPos[thisId] = played;
              haltCount[thisId] = (haltCount[thisId] || 0) + 1;
              if(haltCount[thisId] <= 1){
                setTimeout(function(){
                  var c = curEntry();
                  if(c && c.id === thisId && CLUB.jb.playing && !playingEntryId){ startPlayback(c); }
                }, 1500);
              } else {
                say('The music keeps getting interrupted â€” press Play when you are ready.');
                clubCmd('pause');
              }
              return;
            }
            myPos[thisId] = 0;
            if(iAmAuthority()){ applyCmd({ cmd:'ended', fromName:'' }); }
          };
          jbSrc.start(0, offset);
        }catch(e){
          playingEntryId = null;
          say("That file would not play â€” try an MP3, M4A, or WAV.");
          clubCmd('remove', { id: entry.id, auto: true });
        }
      }
      function stopPlayback(savePos){
        jbSession++;
        if(jbSrc){
          jbStopping = true;
          if(savePos && playingEntryId){ myPos[playingEntryId] = myCurrentPos(); }
          try{ jbSrc.onended = null; jbSrc.stop(); }catch(e){}
          jbStopping = false;
          jbSrc = null;
        }
        if(jbTrack && lkRoom){
          try{ lkRoom.localParticipant.unpublishTrack(jbTrack, true); }catch(e){}
          jbTrack = null;
        }
        playingEntryId = null;
      }
      var mySeekN = 0;
      function reconcile(){
        var cur = curEntry();
        var sk = CLUB.jb.seek;
        if(cur && sk && sk.id === cur.id && sk.n !== mySeekN && cur.by === myIdentity){
          mySeekN = sk.n;
          myPos[cur.id] = Math.max(0, Number(sk.pos) || 0);
          if(playingEntryId === cur.id){ playingEntryId = null; } // force restart at the new spot
        }
        var mine = cur && CLUB.jb.playing && cur.by === myIdentity;
        if(mine){
          if(playingEntryId !== cur.id){ startPlayback(cur); }
          else if(CLUB.jb.pos === 0 && myCurrentPos() > 1.5){ CLUB.jb.pos = -1; myPos[cur.id] = 0; startPlayback(cur); }
        } else if(playingEntryId){
          stopPlayback(true);
        }
      }
      function renderJukebox(){
        var jb = CLUB.jb; var cur = curEntry();
        $('jb-now').textContent = cur
          ? ((jb.playing ? 'Now playing: ' : 'Paused: ') + cur.title + ' â€” brought by ' + cur.byName)
          : 'Nothing playing yet.';
        $('jb-disc').hidden = !cur;
        $('jb-disc').className = (cur && jb.playing) ? 'spin' : '';
        vizKick();
        $('jb-toggle').textContent = jb.playing ? 'Pause the music' : 'Play';
        $('jb-queue').innerHTML = jb.queue.map(function(e2){
          var here = present(e2.by);
          var mark = e2.id === jb.curId ? (jb.playing ? ' â€” playing' : ' â€” paused') : (here ? '' : ' â€” owner stepped out');
          return '<li>' + esc(e2.title) + ' <span class="muted">(' + esc(e2.byName) + ')</span>' + mark +
            ' <button type="button" class="rowbtn small" data-jump="' + e2.id + '">Play this now</button>' +
            ' <button type="button" class="rowbtn small gray" data-drop="' + e2.id + '">Take it off</button></li>';
        }).join('');
      }

      /* â”€â”€ the room â”€â”€ */
      async function joinRoom(roomKey, label, hotelCode){
        status.textContent = 'Getting your room keyâ€¦';
        let mint;
        try{
          const r = await fetch('/api/kade/lounge/token', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ room: roomKey, code: hotelCode || undefined }) });
          mint = await r.json();
          if(!r.ok) throw new Error(mint.error || 'No key.');
        }catch(e){ status.className='status err'; status.textContent = e.message; return; }
        status.className = 'status';
        myIdentity = mint.identity; myName = mint.name || (mint.identity||'Me').split('-')[0];
        roomLabel = label;

        lkRoom = new LK.Room({ adaptiveStream: false, dynacast: false });
        wireRoomEvents();
        // Waking-the-room retry: a slept Railway service can take 10-25s to
        // wake â€” eight patient tries (~30s), progress SAID each round; the
        // server-side wake ping has usually finished the job before try 3.
        let attempt = 0;
        while(true){
          attempt++;
          try{
            status.textContent = attempt === 1
              ? 'Connectingâ€¦'
              : 'Waking the room up â€” still warming, try ' + attempt + ' of 8â€¦';
            await lkRoom.connect(mint.url, mint.token);
            break;
          }catch(e){
            if(attempt >= 8){ status.className='status err'; status.textContent='The room server never answered â€” it may need a look. Try once more in a minute.'; return; }
            await new Promise(function(res){ setTimeout(res, 3500); });
          }
        }
        ensureListenCtx();
        try{
          micTrack = await LK.createLocalAudioTrack(micConstraints());
          await lkRoom.localParticipant.publishTrack(micTrack);
        }catch(e){
          say('Mic permission was refused â€” you can listen, but the room cannot hear you.');
        }
        $('pick').hidden = true;
        $('room').hidden = false;
        $('room-title').textContent = label;
        micMuted = false;
        $('btn-mic').textContent = 'Mute my mic';
        CLUB = { v:0, actn:0, act:'', jb:{ queue:[], curId:null, playing:false, pos:-1 } };
        lastActn = 0; BOT = null; botBusy = false;
        RECORDERS = {}; renderRecOthers();
        $('pa-line').textContent = '';
        renderRoster(); renderJukebox();
        loadBotRoster();
        say('You are in ' + label + ' with ' + Math.max(0, rosterNames().length - 1) + ' other' + (rosterNames().length === 2 ? '' : 's') + '. Your mic is live.');
        $('rstatus').focus();
        setTimeout(function(){ sendData({ t:'hello' }); }, 700);
      }

      // Aug 4 2026 (Kade: "make it play the connect and disconnect chimes when
      // people enter and leave clubhouse rooms. I still want it to announce, but
      // I like the chime also."). Brief notification chime alongside the PA line.
      var _chimeJoin, _chimeLeave;
      function roomChime(join){
        try{
          if(join){ _chimeJoin = _chimeJoin || new Audio('/assets/sounds/call-connected.mp3'); _chimeJoin.currentTime = 0; _chimeJoin.play().catch(function(){}); }
          else { _chimeLeave = _chimeLeave || new Audio('/assets/sounds/call-disconnected.mp3'); _chimeLeave.currentTime = 0; _chimeLeave.play().catch(function(){}); }
        }catch(e){}
      }
      function wireRoomEvents(){
        lkRoom
          .on(LK.RoomEvent.TrackSubscribed, function(track, pub){
            if(track.kind !== 'audio') return;
            var nm = (pub && (pub.trackName || pub.name)) || '';
            var el = track.attach();
            el.setAttribute('aria-hidden', 'true');
            el.dataset.club = nm || 'voice';
            if(nm === 'music'){
              el.muted = true; el.volume = 0; // keepalive only â€” audible lane is the gain node
              if(!wireMusicGain(track)){ el.muted = false; try{ el.volume = musicVol; }catch(e){} }
            }
            document.body.appendChild(el);
            if(track.mediaStreamTrack){ recWire(new MediaStream([track.mediaStreamTrack])); }
          })
          .on(LK.RoomEvent.TrackUnsubscribed, function(track){
            unwireMusicGain(track);
            try{ track.detach().forEach(function(el){ el.remove(); }); }catch(e){}
          })
          .on(LK.RoomEvent.DataReceived, function(payload, participant, kind, topic){
            if(topic && topic !== 'club') return;
            var msg;
            try{ msg = JSON.parse(new TextDecoder().decode(payload)); }catch(e){ return; }
            handleClubMsg(msg, participant);
          })
          .on(LK.RoomEvent.ParticipantConnected, function(p){
            if(isDj(p.identity)){ return; } // headless engines are furniture
            renderRoster(); roomChime(true); paSay((p.name||p.identity)+' just walked in.', 'doors');
          })
          .on(LK.RoomEvent.ParticipantDisconnected, function(p){
            if(isDj(p.identity)){ renderRoster(); reconcile(); renderJukebox(); return; }
            if(RECORDERS[p.identity]){ delete RECORDERS[p.identity]; renderRecOthers(); }
            if(BOT && BOT.anchor === p.identity){
              var bn = BOT.name; BOT = null;
              roomChime(false); paSay((p.name||p.identity)+' left and took '+bn+' with them.', 'doors');
            } else {
              roomChime(false); paSay((p.name||p.identity)+' headed out.', 'doors');
            }
            renderRoster();
            if(iAmAuthority()){
              normalizeCurrent();
              bumpBroadcast();
            } else {
              reconcile(); renderJukebox();
            }
          })
          .on(LK.RoomEvent.ActiveSpeakersChanged, function(){ renderRoster(); })
          .on(LK.RoomEvent.Disconnected, function(){
            say('You left the room.');
            cleanupRoom();
          });
      }

      function handleClubMsg(msg, participant){
        var fromId = participant && participant.identity;
        if(msg.t === 'state'){ adoptState(msg); return; }
        if(msg.t === 'hello'){
          if(iAmAuthority()){ broadcastState(); }
          if(BOT && BOT.anchor === myIdentity){ sendBotState(); }
          if(recorder){ sendData({ t:'rec', on:true, fromName: myName, again:true }); }
          return;
        }
        if(msg.t === 'rec'){
          var rn = msg.fromName || 'Somebody';
          if(msg.on){
            var knew = fromId && RECORDERS[fromId];
            if(fromId){ RECORDERS[fromId] = rn; }
            renderRecOthers();
            if(!knew && !msg.again){ paSay(rn + ' is recording this conversation.', 'doors'); }
            else if(!knew){ $('rec-others').hidden = false; } // late joiner: shown, not barked
          } else {
            if(fromId){ delete RECORDERS[fromId]; }
            renderRecOthers();
            paSay(rn + ' stopped recording. The tape is theirs to keep.', 'doors');
          }
          return;
        }
        if(msg.t === 'cmd'){ if(iAmAuthority()) applyCmd(msg); return; }
        if(msg.t === 'add'){ if(iAmAuthority()) applyAdd(msg.entry, msg.interrupt, msg.fromName || 'Somebody'); return; }
        if(msg.t === 'bot'){
          if(msg.bot && fromId && msg.bot.anchor === fromId){ BOT = msg.bot; renderRoster(); }
          else if(!msg.bot && BOT && fromId && BOT.anchor === fromId){ BOT = null; botBusy = false; renderRoster(); }
          return;
        }
        if(msg.t === 'bot-cue'){ if(BOT && BOT.anchor === myIdentity){ doBotTurn(msg.fromName || 'Somebody'); } return; }
        if(msg.t === 'bot-kick'){ if(BOT && BOT.anchor === myIdentity){ removeBot(msg.fromName || 'Somebody'); } return; }
        if(msg.t === 'bot-said'){ showBotLine(msg.name, msg.line); return; }
        if(msg.t === 'bot-busy'){ botBusy = !!msg.busy; renderRoster(); return; }
      }

      /* every 4s: the current song's owner reports position + reasserts
       * state (this is also what catches late joiners up); the bot's anchor
       * reasserts the guest. */
      setInterval(function(){
        if(!lkRoom) return;
        var cur = curEntry();
        if(cur && CLUB.jb.playing && cur.by === myIdentity && playingEntryId === cur.id){
          CLUB.jb.pos = Math.round(myCurrentPos());
          jbPosStamp = Date.now();
          haltCount[cur.id] = 0; // four stable seconds = the interruption passed
          CLUB.v++;
          broadcastState();
        }
        if(BOT && BOT.anchor === myIdentity){ sendBotState(); }
      }, 4000);

      /* â”€â”€ BOT GUEST (anchored on the inviter's device) â”€â”€ */
      let botCtx=null, botDest=null, botTrack=null;
      let TRANS = '';
      let capTimer=null, capRecs=[], capCtx=null, capGen=0;

      function sendBotState(){
        sendData({ t:'bot', bot: BOT && BOT.anchor === myIdentity ? BOT : (BOT || null) });
      }
      function showBotLine(name, line){
        $('bot-line').textContent = name + ': ' + line;
      }
      /* the full public roster runs 200+ names â€” scrolling one giant select
       * is misery (her catch). A filter box narrows it live; the count line
       * tells a screen reader user how the net came back. */
      var BOT_ROSTER = [];
      function renderBotOptions(){
        var q = ($('bot-filter').value || '').trim().toLowerCase();
        var keep = $('bot-pick').value;
        var hits = q ? BOT_ROSTER.filter(function(a){ return a.name.toLowerCase().indexOf(q) >= 0; }) : BOT_ROSTER;
        var opts = hits.map(function(a){
          return '<option value="'+esc(a.id)+'" data-name="'+esc(a.name)+'">'+esc(a.name)+'</option>';
        }).join('');
        $('bot-pick').innerHTML = '<option value="">Pick a companionâ€¦</option>' + opts;
        if(keep && hits.some(function(a){ return a.id === keep; })){ $('bot-pick').value = keep; }
        $('bot-count').textContent = q
          ? ('Showing ' + hits.length + ' of ' + BOT_ROSTER.length + ' companions.')
          : (BOT_ROSTER.length ? (BOT_ROSTER.length + ' companions â€” type above to shorten the list.') : '');
      }
      $('bot-filter').addEventListener('input', renderBotOptions);
      async function loadBotRoster(){
        try{
          const r = await apiGet('/api/kade/room/agents', token);
          const j = await r.json();
          BOT_ROSTER = (j.agents||[]).map(function(a){ return { id: a.id, name: a.name }; });
          renderBotOptions();
        }catch(e){
          $('bot-pick').innerHTML = '<option value="">Could not load companions</option>';
        }
      }
      $('bot-invite').addEventListener('click', async function(){
        if(BOT){ say('One guest at a time â€” ask ' + BOT.name + ' to leave first.'); return; }
        var sel = $('bot-pick');
        var id = sel.value;
        if(!id){ say('Pick a companion first.'); return; }
        var nm = sel.options[sel.selectedIndex].getAttribute('data-name') || 'Guest';
        try{
          botCtx = new AC();
          keepWarm(botCtx);
          if(botCtx.state === 'suspended'){ try{ await botCtx.resume(); }catch(e){} }
          botDest = botCtx.createMediaStreamDestination();
          botTrack = botDest.stream.getAudioTracks()[0];
          await lkRoom.localParticipant.publishTrack(botTrack, { name: 'bot', source: LK.Track.Source.Unknown });
        }catch(e){
          say('Could not set up the guest chair â€” try again.');
          botTeardownLocal();
          return;
        }
        BOT = { agentId: id, name: nm, anchor: myIdentity, anchorName: myName };
        TRANS = '';
        sendBotState();
        renderRoster();
        say(nm + ' pulled up a chair. Press their talk button when you want them to speak â€” they listen along in between.');
        startCapture();
      });
      $('roster').addEventListener('click', function(ev){
        var b = ev.target.closest('button[data-botact]'); if(!b || !BOT) return;
        var act = b.getAttribute('data-botact');
        if(act === 'cue'){
          if(BOT.anchor === myIdentity){ doBotTurn(myName); }
          else { sendData({ t:'bot-cue', fromName: myName }); say('Told ' + BOT.name + " it's their turn."); }
        } else if(act === 'kick'){
          if(BOT.anchor === myIdentity){ removeBot(myName); }
          else { sendData({ t:'bot-kick', fromName: myName }); }
        }
      });
      async function doBotTurn(fromName){
        if(!BOT || BOT.anchor !== myIdentity) return;
        if(botBusy){ say(BOT.name + ' is already mid-thought.'); return; }
        botBusy = true; renderRoster();
        sendData({ t:'bot-busy', busy: true });
        try{
          const r = await fetch('/api/kade/lounge/bot-turn', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ agentId: BOT.agentId, roomLabel: roomLabel, transcript: TRANS, cuedBy: fromName }) });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'No answer.');
          TRANS += '\n' + j.name + ' (the guest): ' + j.line;
          if(TRANS.length > 3800) TRANS = TRANS.slice(-3800);
          sendData({ t:'bot-said', name: j.name, line: j.line });
          showBotLine(j.name, j.line);
          if(j.voice){
            try{
              const tr = await fetch('/api/files/speech/tts/manual', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ input: j.line, voice: j.voice }) });
              if(tr.ok){
                var ab = await tr.arrayBuffer();
                var buf = await botCtx.decodeAudioData(ab);
                await new Promise(function(done){
                  var src = botCtx.createBufferSource();
                  src.buffer = buf;
                  src.connect(botDest);
                  src.connect(botCtx.destination); // the anchor hears them too
                  src.onended = done;
                  src.start();
                });
              }
            }catch(ttsErr){ /* text already landed on-screen for everyone */ }
          }
        }catch(e){
          say((BOT ? BOT.name : 'The guest') + ' lost their train of thought â€” cue them again.');
        }
        botBusy = false; renderRoster();
        sendData({ t:'bot-busy', busy: false });
      }
      function removeBot(byName){
        if(!BOT || BOT.anchor !== myIdentity) return;
        var nm = BOT.name;
        BOT = null; botBusy = false;
        stopCapture();
        botTeardownLocal();
        sendBotState();
        renderRoster();
        say(nm + ' said goodnight and headed out. (' + byName + ' showed them the door.)');
        sendData({ t:'bot-said', name: nm, line: '(left the room)' });
      }
      function botTeardownLocal(){
        if(botTrack && lkRoom){ try{ lkRoom.localParticipant.unpublishTrack(botTrack, true); }catch(e){} }
        botTrack = null; botDest = null;
        if(botCtx){ try{ botCtx.close(); }catch(e){} botCtx = null; }
      }

      /* room ears, PER SEAT (July 24 round 6, her ask: "Do the bots also
       * have speaker diorisation?"): the room already keeps every person on
       * their own track, so instead of blending everyone into one stream
       * and guessing, each 15-second cycle records EACH SEAT separately,
       * transcribes the ones that actually spoke (silent seats cost
       * nothing), and hands the guest lines with real names on them â€”
       * "Kade: ..., Amber: ..." â€” perfect attribution, zero guesswork.
       * Never the music, never the bot itself. Runs ONLY on the anchor's
       * device, ONLY while a guest is seated. */
      function startCapture(){
        stopCapture();
        capCycle();
      }
      function stopCapture(){
        capGen++;
        if(capTimer){ clearTimeout(capTimer); capTimer = null; }
        capRecs.forEach(function(r){ try{ if(r.state !== 'inactive'){ r.stop(); } }catch(e){} });
        capRecs = [];
        capCleanup();
      }
      function capCleanup(){
        if(capCtx){ try{ capCtx.close(); }catch(e){} capCtx = null; }
      }
      function capCycle(){
        if(!BOT || BOT.anchor !== myIdentity || !lkRoom) return;
        var gen = ++capGen;
        try{
          if(!window.MediaRecorder) return; // guest still works, just with no ears
          capCtx = new AC();
          var mime = '';
          if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
          else if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
          var seats = [];
          if(micTrack && micTrack.mediaStreamTrack && !micMuted){
            seats.push({ name: myName, mst: micTrack.mediaStreamTrack });
          }
          lkRoom.remoteParticipants.forEach(function(p){
            if(isDj(p.identity)) return;
            (p.audioTrackPublications || new Map()).forEach(function(pub){
              var nm = (pub && (pub.trackName || pub.name)) || '';
              if(nm === 'music' || nm === 'bot') return;
              if(pub.track && pub.track.mediaStreamTrack){
                seats.push({ name: (p.name || p.identity || 'Somebody'), mst: pub.track.mediaStreamTrack });
              }
            });
          });
          if(!seats.length){ capCleanup(); capTimer = setTimeout(capCycle, 15000); return; }
          capRecs = [];
          var takes = [];
          seats.forEach(function(seat){
            try{
              var dest = capCtx.createMediaStreamDestination();
              capCtx.createMediaStreamSource(new MediaStream([seat.mst])).connect(dest);
              var rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
              var chunks = [];
              rec.ondataavailable = function(ev){ if(ev.data && ev.data.size) chunks.push(ev.data); };
              takes.push(new Promise(function(done){
                rec.onstop = function(){ done({ name: seat.name, blob: new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }) }); };
                rec.onerror = function(){ done(null); };
              }));
              rec.start();
              capRecs.push(rec);
            }catch(e){}
          });
          if(!capRecs.length){ capCleanup(); capTimer = setTimeout(capCycle, 15000); return; }
          capTimer = setTimeout(function(){
            capRecs.forEach(function(r){ try{ if(r.state !== 'inactive') r.stop(); }catch(e){} });
          }, 15000);
          Promise.all(takes).then(function(got){
            if(gen !== capGen) return null;
            capCleanup();
            capRecs = [];
            var talkers = (got || []).filter(function(t){ return t && t.blob && t.blob.size >= 2500; });
            return Promise.all(talkers.map(function(t){
              return transcribeBlob(t.blob).then(function(text){
                return text ? (t.name + ': ' + text) : null;
              }).catch(function(){ return null; });
            }));
          }).then(function(lines){
            if(gen !== capGen) return;
            var spoke = (lines || []).filter(Boolean);
            if(spoke.length && BOT && BOT.anchor === myIdentity){
              TRANS += '\n' + spoke.join('\n');
              if(TRANS.length > 3800) TRANS = TRANS.slice(-3800);
            }
            if(BOT && BOT.anchor === myIdentity){ capTimer = setTimeout(capCycle, 250); }
          });
        }catch(e){
          capCleanup();
          capTimer = setTimeout(capCycle, 15000);
        }
      }
      async function transcribeBlob(blob){
        const r = await fetch('/api/kade/transcribe', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type': blob.type || 'audio/webm', 'x-kade-club':'1' }, body: blob });
        const j = await r.json();
        return (r.ok && j.transcript) ? j.transcript : '';
      }

      function cleanupRoom(){
        knockStop(true);
        stopRec();
        RECORDERS = {}; renderRecOthers();
        $('pa-line').textContent = '';
        paQueue = [];
        vizAnalysers = [];
        stopCapture();
        if(BOT && BOT.anchor === myIdentity){ botTeardownLocal(); }
        BOT = null; botBusy = false; TRANS = '';
        stopPlayback(false);
        if(jbCtx){ try{ jbCtx.close(); }catch(e){} jbCtx = null; jbDest = null; jbMonitor = null; }
        musicGains.forEach(function(m){ try{ m.src.disconnect(); m.gain.disconnect(); }catch(e){} });
        musicGains = [];
        if(listenCtx){ try{ listenCtx.close(); }catch(e){} listenCtx = null; }
        if(micTrack){ try{ micTrack.stop(); }catch(e){} micTrack = null; }
        document.querySelectorAll('audio[aria-hidden="true"]').forEach(function(el){ el.remove(); });
        lkRoom = null;
        CLUB = { v:0, actn:0, act:'', jb:{ queue:[], curId:null, playing:false, pos:-1 } };
        $('room').hidden = true;
        $('pick').hidden = false;
        status.textContent = 'Pick a room.';
      }

      /* iOS autoplay policy: any tap re-arms suspended audio engines. */
      document.addEventListener('click', function(){
        [listenCtx, jbCtx, botCtx, paCtx, recCtx].forEach(function(c){
          if(c && c.state === 'suspended'){ try{ c.resume(); }catch(e){} }
        });
      }, true);
      /* and a quiet heartbeat for contexts iOS dozed mid-session â€” resume
       * outside a gesture is a no-op on stubborn days, harmless always. */
      setInterval(function(){
        [listenCtx, jbCtx, botCtx, paCtx].forEach(function(c){
          if(c && c.state !== 'running'){ try{ c.resume(); }catch(e){} }
        });
      }, 15000);

      /* â”€â”€ picker wiring â”€â”€ */
      $('room-list').addEventListener('click', function(ev){
        const b = ev.target.closest('button[data-room]'); if(!b) return;
        const r = (cfg.rooms||[]).find(function(x){ return x.key === b.getAttribute('data-room'); });
        joinRoom(b.getAttribute('data-room'), r ? r.name : b.getAttribute('data-room'));
      });
      $('hotel-mine').addEventListener('click', async function(ev){
        const cb = ev.target.closest('button[data-close]');
        if(!cb) return;
        if(!confirm('Close this room for good?')) return;
        try{
          const r = await fetch('/api/kade/lounge/hotel/' + cb.getAttribute('data-close'), { method:'DELETE', headers:{ 'Authorization':'Bearer '+token } });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Could not close it.');
          status.textContent = 'Room closed.';
          const cr = await apiGet('/api/kade/lounge/config', token);
          cfg = await cr.json();
          renderHotel(cfg.hotel);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      $('hotel-checkin').addEventListener('click', async function(){
        var code = $('hotel-code').value.trim().toLowerCase();
        if(!code){ $('hotel-code').focus(); return; }
        try{
          const r = await fetch('/api/kade/lounge/hotel/checkin', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ code: code }) });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'No room answered.');
          status.className = 'status';
          $('hotel-code').value = '';
          joinRoom(j.key, j.name, code);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      $('hotel-create').addEventListener('click', async function(){
        var name = $('hotel-name').value.trim();
        var code = $('hotel-newcode').value.trim().toLowerCase();
        if(!name){ $('hotel-name').focus(); return; }
        if(!code){ $('hotel-newcode').focus(); return; }
        try{
          const r = await fetch('/api/kade/lounge/hotel', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ name: name, code: code }) });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Could not open the room.');
          status.textContent = 'The Hotel opened ' + j.name + '. Share the passcode with your people â€” walking you in now.';
          $('hotel-name').value = ''; $('hotel-newcode').value = '';
          joinRoom(j.key, j.name, code);
        }catch(e){ status.className='status err'; status.textContent = e.message; }
      });
      $('join-code').addEventListener('click', function(){
        const code = $('code').value.trim().toUpperCase();
        if(!code) return;
        joinRoom(code.toLowerCase(), 'Table ' + code);
      });
      $('btn-mic').addEventListener('click', async function(){
        if(!lkRoom) return;
        micMuted = !micMuted;
        try{ await lkRoom.localParticipant.setMicrophoneEnabled(!micMuted); }catch(e){}
        $('btn-mic').textContent = micMuted ? 'Unmute my mic' : 'Mute my mic';
        say(micMuted ? 'Mic muted.' : 'Mic live.');
      });
      $('btn-who').addEventListener('click', function(){
        const names = rosterNames();
        if(BOT){ names.push(BOT.name + ' (guest)'); }
        say(names.length ? ('Here now: ' + names.join(', ') + '.') : 'Nobody here yet.');
      });
      $('btn-leave').addEventListener('click', async function(){
        if(lkRoom){ try{ await lkRoom.disconnect(); }catch(e){} }
        cleanupRoom();
      });

      /* â”€â”€ jukebox wiring â”€â”€ */
      $('jb-file').addEventListener('change', function(){
        var has = !!$('jb-file').files.length;
        $('jb-cutin').hidden = !has;
        $('jb-queue-add').hidden = !has;
      });
      function addTrack(interrupt){
        var f = $('jb-file').files[0];
        if(!f || !lkRoom) return;
        if(f.size > 60000000){ say('That file is too big â€” keep songs under about sixty megabytes.'); return; }
        var id = 'e' + Math.random().toString(36).slice(2, 9);
        var title = (f.name || 'a song').replace(/.[a-z0-9]{2,5}$/i, '').slice(0, 60);
        var entry = { id: id, title: title, by: myIdentity, byName: myName };
        myFiles[id] = f;
        if(iAmAuthority()){ applyAdd(entry, interrupt, myName); }
        else { sendData({ t:'add', entry: entry, interrupt: interrupt, fromName: myName }); }
        $('jb-file').value = '';
        $('jb-cutin').hidden = true;
        $('jb-queue-add').hidden = true;
      }
      /* headphones clarity mode (July 24, her point: "we might not
         TECHnically need iphone noise reduction unless they were using the
         speaker... The idea is audio clarity anyway.") â€” raw mic on request,
         speaker-friendly processing stays the default because ONE
         speakerphone without echo cancel wrecks the room for everybody. */
      var micClear = false;
      try{ micClear = localStorage.getItem('kadeClubClearMic') === '1'; }catch(e){}
      $('mic-clear').checked = micClear;
      function micConstraints(){
        return micClear
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true };
      }
      $('mic-clear').addEventListener('change', async function(){
        micClear = $('mic-clear').checked;
        try{ localStorage.setItem('kadeClubClearMic', micClear ? '1' : '0'); }catch(e){}
        if(!lkRoom){ return; }
        try{
          var old = micTrack; micTrack = null;
          if(old){ try{ await lkRoom.localParticipant.unpublishTrack(old, true); }catch(e){} }
          micTrack = await LK.createLocalAudioTrack(micConstraints());
          await lkRoom.localParticipant.publishTrack(micTrack);
          if(micTrack.mediaStreamTrack){ recWire(new MediaStream([micTrack.mediaStreamTrack])); }
          if(micMuted){ try{ await lkRoom.localParticipant.setMicrophoneEnabled(false); }catch(e){} }
          say(micClear ? 'Mic is raw now â€” full clarity, headphones etiquette.' : 'Mic is speaker-friendly now.');
        }catch(e){ say('Could not switch the mic mode.'); }
      });

      $('jb-clear').addEventListener('click', function(){
        if(!lkRoom || !CLUB.jb.queue.length) return;
        if(confirm('Clear the whole queue, for everybody?')) clubCmd('clearq');
      });

      /* the seek lane: display ticks locally each second off the last
         broadcast position; releasing the slider sends ONE seek command. */
      var jbPosStamp = Date.now();
      var seekTouched = 0;
      function fmtTime(t){
        t = Math.max(0, Math.round(t));
        return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
      }
      function livePos(){
        var jb = CLUB.jb;
        var base = jb.pos >= 0 ? jb.pos : 0;
        return jb.playing ? base + (Date.now() - jbPosStamp) / 1000 : base;
      }
      setInterval(function(){
        if(!lkRoom) return;
        var cur = curEntry();
        var row = $('jb-seek-row');
        if(!cur){ row.hidden = true; return; }
        row.hidden = false;
        var dur = cur.dur ? Math.ceil(cur.dur) : 300;
        var sl = $('jb-seek');
        if(String(sl.max) !== String(dur)) sl.max = dur;
        var p = Math.min(dur, livePos());
        if(Date.now() - seekTouched > 2500){ sl.value = String(Math.round(p)); }
        $('jb-time').textContent = fmtTime(p) + ' of ' + (cur.dur ? fmtTime(dur) : 'about ' + fmtTime(dur));
      }, 1000);
      $('jb-seek').addEventListener('input', function(){ seekTouched = Date.now(); });
      $('jb-seek').addEventListener('change', function(){
        seekTouched = Date.now();
        if(!CLUB.jb.curId) return;
        clubCmd('seek', { id: CLUB.jb.curId, pos: Number($('jb-seek').value) || 0 });
      });

      $('jb-cutin').addEventListener('click', function(){ addTrack(true); });
      $('jb-queue-add').addEventListener('click', function(){ addTrack(false); });

      /* the link lane: a pasted link becomes ordinary jukebox bytes (the
       * server does the pulling) â€” after that it's a normal entry: queue
       * it, cut in, radio-fight over it. When YouTube's flickering gate is
       * closed (walled:true from the server), the KNOCKER takes the link:
       * quiet retries every 3 minutes for up to an hour, a holler when it
       * finally lands, a Stop-knocking button for changed minds. */
      var linkBusy = false;
      var KNOCK = null; // {url, interrupt, tries, timer}
      function knockStop(quiet){
        if(!KNOCK) return;
        if(KNOCK.timer){ clearTimeout(KNOCK.timer); }
        KNOCK = null;
        $('jb-knock-cancel').hidden = true;
        if(!quiet){ say('Stopped knocking for that link.'); }
      }
      function knockLater(){
        if(!KNOCK) return;
        $('jb-knock-cancel').hidden = false;
        KNOCK.timer = setTimeout(function(){
          if(!KNOCK || !lkRoom) return;
          KNOCK.tries++;
          fetchLink(KNOCK.url, KNOCK.interrupt, true);
        }, 180000);
      }
      async function fetchLink(url, interrupt, fromKnock){
        if(linkBusy){ return; }
        linkBusy = true;
        if(!fromKnock){ say('Fetching that link â€” give it a few secondsâ€¦'); }
        try{
          const r = await fetch('/api/kade/lounge/fetch-track', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ url: url }) });
          if(!r.ok){
            var j = null; try{ j = await r.json(); }catch(e){}
            if(j && j.walled && lkRoom){
              if(!KNOCK){ KNOCK = { url: url, interrupt: interrupt, tries: 0, timer: null }; }
              if(KNOCK.tries >= 20){
                knockStop(true);
                say("YouTube never opened up for that one â€” try it fresh later.");
              } else {
                if(!fromKnock){ say("YouTube's gate is closed â€” I'll keep knocking every few minutes and holler when it opens."); }
                else { say('Still closed â€” knock ' + KNOCK.tries + '. I keep trying.'); }
                knockLater();
              }
              linkBusy = false;
              return;
            }
            throw new Error((j && j.error) || 'That link would not fetch.');
          }
          var title = 'a song';
          try{ var th = r.headers.get('x-kade-title'); if(th){ title = decodeURIComponent(th); } }catch(e){}
          var bytes = await r.arrayBuffer();
          if(!bytes.byteLength){ throw new Error('That audio came back empty.'); }
          if(bytes.byteLength > 60000000){ throw new Error('That file is too big â€” 60MB tops.'); }
          var id = 'e' + Math.random().toString(36).slice(2, 9);
          myFiles[id] = new Blob([bytes], { type: 'audio/mp4' });
          var entry = { id: id, title: title.slice(0, 60), by: myIdentity, byName: myName };
          if(iAmAuthority()){ applyAdd(entry, interrupt, myName); }
          else { sendData({ t:'add', entry: entry, interrupt: interrupt, fromName: myName }); }
          if(fromKnock){ paSay('That link finally cleared the gate â€” ' + entry.title + ' just landed.', 'booth'); }
          knockStop(true);
        }catch(e){ say(e.message || 'That link would not fetch.'); }
        linkBusy = false;
      }
      function addLink(interrupt){
        if(!lkRoom) return;
        var url = ($('jb-link').value || '').trim();
        if(!url){ $('jb-link').focus(); return; }
        knockStop(true); // a fresh paste replaces any old knock
        $('jb-link').value = '';
        fetchLink(url, interrupt, false);
      }
      $('jb-link-cutin').addEventListener('click', function(){ addLink(true); });
      $('jb-link-queue').addEventListener('click', function(){ addLink(false); });
      $('jb-knock-cancel').addEventListener('click', function(){ knockStop(false); });
      $('jb-toggle').addEventListener('click', function(){
        if(!lkRoom) return;
        clubCmd(CLUB.jb.playing ? 'pause' : 'play');
      });
      $('jb-skip').addEventListener('click', function(){ if(lkRoom) clubCmd('skip'); });
      $('jb-back').addEventListener('click', function(){ if(lkRoom) clubCmd('back'); });
      $('jb-queue').addEventListener('click', function(ev){
        var jb = ev.target.closest('button[data-jump]');
        if(jb){ clubCmd('jump', { id: jb.getAttribute('data-jump') }); return; }
        var dr = ev.target.closest('button[data-drop]');
        if(dr){ clubCmd('remove', { id: dr.getAttribute('data-drop') }); }
      });
    })();
  