
(function(){
  function post(o){ try{ window.webkit.messageHandlers.engine.postMessage(o); }catch(e){} }
  var params = {};
  try{
    (location.hash || '').slice(1).split('&').forEach(function(kv){
      var i = kv.indexOf('='); if(i < 0) return;
      params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    history.replaceState(null, '', location.pathname);
  }catch(e){}
  var LKTOK = params.lk, WSURL = params.url, API = params.api;
  if(!LKTOK || !WSURL || typeof LivekitClient === 'undefined'){ post({t:'dead', why:'boot'}); return; }
  var LK = LivekitClient;
  var AC = window.AudioContext || window.webkitAudioContext;
  var room = new LK.Room({ adaptiveStream: false, dynacast: false });

  var mCtx=null, mDest=null, mTrack=null, mPub=false, mSrc=null, mId=null, mStartOff=0, mStartT=0, mStopping=false, mSession=0;
  var buffers = {};
  var staged = {}; // id -> [Uint8Array] fed from the app in base64 chunks
  var bCtx=null, bDest=null, bTrack=null, bPub=false;
  var earsOn=false, capTimer=null, capRecs=[], capCtx=null, capGen=0;
  function isDj(id){ return typeof id === 'string' && id.slice(-3) === '-dj'; }

  /* ── the tape deck (July 24 — "record this conversation") ──
   * The engine is the one seat that hears EVERYTHING: every remote track
   * (voices, other jukeboxes, bots — the app's own mic arrives as a remote
   * track too, since the engine is its own participant) plus its own local
   * music and bot output. Mix them into one MediaRecorder; hand the file
   * back to the app as chunked base64 when the tape stops. */
  var recCtx=null, recDest=null, recorder=null, recWired=null, recCap=null, recT0=0;
  function recWire(stream){
    if(!recCtx || !recDest || !stream) return;
    try{
      var tr = stream.getAudioTracks()[0];
      if(!tr || recWired.has(tr.id)) return;
      recWired.add(tr.id);
      recCtx.createMediaStreamSource(new MediaStream([tr])).connect(recDest);
    }catch(e){}
  }
  function recFinish(){
    if(recCap){ clearTimeout(recCap); recCap = null; }
    if(recorder){ try{ if(recorder.state !== 'inactive'){ recorder.stop(); } }catch(e){ post({t:'recfail'}); } }
  }

  room.on(LK.RoomEvent.TrackSubscribed, function(track){
    if(track.kind !== 'audio') return;
    var el = track.attach(); // muted keepalive so capture graphs stay warm
    el.muted = true; el.volume = 0; el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    if(track.mediaStreamTrack){ recWire(new MediaStream([track.mediaStreamTrack])); }
  });
  room.on(LK.RoomEvent.TrackUnsubscribed, function(track){
    try{ track.detach().forEach(function(el){ el.remove(); }); }catch(e){}
  });
  room.on(LK.RoomEvent.Disconnected, function(){ post({t:'gone'}); });

  function mPos(){ if(!mCtx || !mSrc) return 0; return mStartOff + (mCtx.currentTime - mStartT); }

  /* WAKE WATCHDOG (July 24, her catch: paused a while -> "impossible to
   * start the session back up again even though it says it is started").
   * A long-idle AudioContext can come back wedged: resume() claims fine,
   * currentTime freezes, no audio, no onended, no error. The engine has no
   * user-gesture rule (the app exempts it), so it can heal itself: tear the
   * whole audio stack down, mint a fresh context, and retry ONCE from the
   * same spot. Still wedged after that -> honest playfail (the 'publish'
   * kind: no queue-eating, the room just hears "try playing it again"). */
  function hardResetAudio(){
    if(mSrc){ mStopping = true; try{ mSrc.onended = null; mSrc.stop(); }catch(e){} mStopping = false; mSrc = null; }
    if(mPub && mTrack){ try{ room.localParticipant.unpublishTrack(mTrack, true); }catch(e){} }
    mPub = false; mTrack = null;
    if(mCtx){ try{ mCtx.close(); }catch(e){} }
    mCtx = null; mDest = null;
  }

  /* KEEPALIVE (round 5): a long-IDLE context is what iOS wedges in the
   * first place — a running constant-silence source keeps the audio unit
   * warm through any pause. Plus a 15s resume heartbeat; the engine page
   * is gesture-exempt, so resume() is always allowed here. */
  function keepWarm(ctx){
    try{
      var k = ctx.createConstantSource();
      k.offset.value = 0;
      k.connect(ctx.destination);
      k.start();
    }catch(e){}
  }
  setInterval(function(){
    [mCtx, bCtx].forEach(function(c){
      if(c && c.state !== 'running'){ try{ c.resume(); }catch(e){} }
    });
  }, 15000);

  async function ensureMusicPub(){
    if(!mCtx){ mCtx = new AC(); keepWarm(mCtx); mDest = mCtx.createMediaStreamDestination(); }
    if(mCtx.state !== 'running'){ try{ await mCtx.resume(); }catch(e){} }
    if(!mPub){
      /* silence() stops the track on unpublish, and a stopped destination
       * track is dead forever — republishing it is silent "playing". Fresh
       * destination node every republish (her pause-then-cut-in catch). */
      mDest = mCtx.createMediaStreamDestination();
      mTrack = mDest.stream.getAudioTracks()[0];
      recWire(mDest.stream);
      await room.localParticipant.publishTrack(mTrack, {
        dtx: false, red: false,
        /* round 5: stereo opus must be NEGOTIATED — forceStereo writes it
         * into the SDP so the encoder actually sends two channels. */
        forceStereo: true,
        audioPreset: LK.AudioPresets.musicHighQualityStereo,
        source: LK.Track.Source.Unknown,
        name: 'music',
      });
      mPub = true;
    }
  }

  window.KE = {
    loadPlay: async function(id, pos, attempt){
      var session = ++mSession;
      attempt = attempt || 0;
      try{
        if(!mCtx){ mCtx = new AC(); mDest = mCtx.createMediaStreamDestination(); }
        if(mCtx.state !== 'running'){ try{ await mCtx.resume(); }catch(e){} }
        var buf = buffers[id];
        if(!buf && !staged[id]){
          // the app has not fed this song's bytes yet — ask and wait
          post({t:'need', id: id});
          return;
        }
        if(!buf){
          var parts = staged[id];
          var total = 0;
          parts.forEach(function(a){ total += a.length; });
          var whole = new Uint8Array(total);
          var off = 0;
          parts.forEach(function(a){ whole.set(a, off); off += a.length; });
          delete staged[id];
          try{
            buf = await mCtx.decodeAudioData(whole.buffer);
          }catch(decErr){
            post({t:'playfail', id: id, why: 'decode'});
            return;
          }
          Object.keys(buffers).forEach(function(k){ if(k !== id) delete buffers[k]; });
          buffers[id] = buf;
        }
        if(session !== mSession) return;
        await ensureMusicPub();
        if(session !== mSession) return;
        if(mSrc){ mStopping = true; try{ mSrc.onended = null; mSrc.stop(); }catch(e){} mStopping = false; mSrc = null; }
        var off = Number(pos) || 0;
        if(off < 0) off = 0;
        if(off >= buf.duration - 0.3) off = 0;
        mSrc = mCtx.createBufferSource();
        mSrc.buffer = buf;
        mSrc.connect(mDest);
        mStartOff = off; mStartT = mCtx.currentTime; mId = id;
        mSrc.onended = function(){
          if(mStopping || mId !== id) return;
          var played = mPos();
          mSrc = null;
          if(played < buf.duration - 2){
            // died mid-song — iOS grabbed the audio session (VoiceOver, a
            // call, the works). NOT the end of the song. Her live catch:
            // "when I started talking... it said the queue was finished."
            post({t:'halted', id: id, pos: played});
          } else {
            post({t:'ended', id: id});
          }
        };
        mSrc.start(0, off);
        (function(sess, sId, sOff, sAttempt){
          setTimeout(function(){
            if(sess !== mSession || mId !== sId || !mCtx || !mSrc) return;
            if(mCtx.state === 'running' && (mCtx.currentTime - mStartT) > 0.15) return;
            // the clock never moved — the context came back from its nap dead
            hardResetAudio();
            if(sAttempt < 1){ window.KE.loadPlay(sId, sOff, sAttempt + 1); }
            else { post({t:'playfail', id: sId, why: 'publish'}); }
          }, 1200);
        })(session, id, off, attempt);
        post({t:'playing', id: id, pos: off, dur: buf.duration});
      }catch(e){ post({t:'playfail', id: id, why: 'publish'}); }
    },
    feedB64: function(id, b64, last){
      try{
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for(var i = 0; i < bin.length; i++){ arr[i] = bin.charCodeAt(i); }
        (staged[id] = staged[id] || []).push(arr);
        if(last){ post({t:'fed', id: id}); }
      }catch(e){
        delete staged[id];
        post({t:'feedfail', id: id});
      }
    },
    silence: function(){
      mSession++;
      var id = mId, p = mPos();
      if(mSrc){ mStopping = true; try{ mSrc.onended = null; mSrc.stop(); }catch(e){} mStopping = false; mSrc = null; }
      if(mPub && mTrack){ try{ room.localParticipant.unpublishTrack(mTrack, true); }catch(e){} mPub = false; mTrack = null; }
      mId = null;
      if(id){ post({t:'pos', id: id, pos: p, silenced: true}); }
    },
    botOn: async function(){
      try{
        if(!bCtx){ bCtx = new AC(); keepWarm(bCtx); }
        if(bCtx.state !== 'running'){ try{ await bCtx.resume(); }catch(e){} }
        if(!bPub){
          // fresh destination every republish — botOff() stops the old
          // track for good (same dead-track family as the jukebox fix).
          bDest = bCtx.createMediaStreamDestination();
          bTrack = bDest.stream.getAudioTracks()[0];
          recWire(bDest.stream);
          await room.localParticipant.publishTrack(bTrack, { name: 'bot', source: LK.Track.Source.Unknown });
          bPub = true;
        }
        post({t:'botReady'});
      }catch(e){ post({t:'botFail', why: 'on'}); }
    },
    botSay: async function(text, voice){
      try{
        if(!bPub) throw new Error('no chair');
        if(bCtx.state !== 'running'){ try{ await bCtx.resume(); }catch(e){} }
        var r = await fetch('/api/files/speech/tts/manual', { method: 'POST', headers: { 'Authorization': 'Bearer ' + API, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text, voice: voice }) });
        if(!r.ok) throw new Error('tts');
        var ab = await r.arrayBuffer();
        var buf = await bCtx.decodeAudioData(ab);
        var src = bCtx.createBufferSource();
        src.buffer = buf;
        src.connect(bDest);
        src.onended = function(){ post({t:'botDone'}); };
        src.start();
      }catch(e){ post({t:'botFail', why: 'say'}); }
    },
    botOff: function(){
      if(bPub && bTrack){ try{ room.localParticipant.unpublishTrack(bTrack, true); }catch(e){} bPub = false; bTrack = null; }
    },
    earsOn: function(){ if(earsOn) return; earsOn = true; capCycle(); },
    earsOff: function(){ earsStop(); },
    recOn: function(){
      if(recorder) return;
      try{
        if(!window.MediaRecorder){ post({t:'recfail'}); return; }
        recCtx = new AC();
        recDest = recCtx.createMediaStreamDestination();
        recWired = new Set();
        room.remoteParticipants.forEach(function(p){
          p.audioTrackPublications.forEach(function(pub){
            if(pub.track && pub.track.mediaStreamTrack){ recWire(new MediaStream([pub.track.mediaStreamTrack])); }
          });
        });
        if(mDest){ recWire(mDest.stream); }
        if(bDest){ recWire(bDest.stream); }
        var mime = '';
        if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
        else if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
        recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
        var chunks = [];
        recorder.ondataavailable = function(ev){ if(ev.data && ev.data.size) chunks.push(ev.data); };
        recorder.onstop = function(){
          var type = (recorder && recorder.mimeType) || mime || 'audio/webm';
          var secs = (Date.now() - recT0) / 1000;
          recorder = null;
          if(recCtx){ try{ recCtx.close(); }catch(e){} recCtx = null; recDest = null; recWired = null; }
          var blob = new Blob(chunks, { type: type });
          chunks = [];
          if(!blob.size){ post({t:'recfail'}); return; }
          var fr = new FileReader();
          fr.onerror = function(){ post({t:'recfail'}); };
          fr.onload = function(){
            try{
              var b64 = String(fr.result).split(',')[1] || '';
              var STEP = 1500000;
              for(var i = 0; i < b64.length; i += STEP){
                post({t:'recb', b64: b64.slice(i, i + STEP)});
              }
              post({t:'recdone', mime: type, secs: secs});
            }catch(e){ post({t:'recfail'}); }
          };
          fr.readAsDataURL(blob);
        };
        recT0 = Date.now();
        recorder.start(1000);
        // the tape runs out at two hours — memory honesty, announced app-side
        recCap = setTimeout(recFinish, 7200000);
        post({t:'recon'});
      }catch(e){
        recorder = null;
        if(recCtx){ try{ recCtx.close(); }catch(e2){} recCtx = null; recDest = null; recWired = null; }
        post({t:'recfail'});
      }
    },
    recOff: function(){ recFinish(); }
  };

  function earsStop(){
    earsOn = false;
    capGen++;
    if(capTimer){ clearTimeout(capTimer); capTimer = null; }
    capRecs.forEach(function(r){ try{ if(r.state !== 'inactive'){ r.stop(); } }catch(e){} });
    capRecs = [];
    if(capCtx){ try{ capCtx.close(); }catch(e){} capCtx = null; }
  }
  /* ears PER SEAT (round 6 — "Do the bots also have speaker diorisation?"):
   * every person is already their own track, so each seat records
   * separately and the transcript carries real names — no blending, no
   * guessing. Silent seats never get sent (pennies saved). The native
   * user's own mic arrives here as a remote track like everyone else's. */
  function capCycle(){
    if(!earsOn) return;
    var gen = ++capGen;
    try{
      if(!window.MediaRecorder){ return; }
      capCtx = new AC();
      var mime = '';
      if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
      else if(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
      var seats = [];
      room.remoteParticipants.forEach(function(p){
        if(isDj(p.identity)) return;
        p.audioTrackPublications.forEach(function(pub){
          var nm = pub.trackName || '';
          if(nm === 'music' || nm === 'bot') return;
          if(pub.track && pub.track.mediaStreamTrack){
            seats.push({ name: (p.name || p.identity || 'Somebody'), mst: pub.track.mediaStreamTrack });
          }
        });
      });
      if(!seats.length){ if(capCtx){ try{ capCtx.close(); }catch(e){} capCtx = null; } capTimer = setTimeout(capCycle, 15000); return; }
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
      if(!capRecs.length){ if(capCtx){ try{ capCtx.close(); }catch(e){} capCtx = null; } capTimer = setTimeout(capCycle, 15000); return; }
      capTimer = setTimeout(function(){
        capRecs.forEach(function(r){ try{ if(r.state !== 'inactive') r.stop(); }catch(e){} });
      }, 15000);
      Promise.all(takes).then(function(got){
        if(gen !== capGen) return null;
        if(capCtx){ try{ capCtx.close(); }catch(e){} capCtx = null; }
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
        if(spoke.length){ post({t:'ears', text: spoke.join('\n')}); }
        if(earsOn){ capTimer = setTimeout(capCycle, 250); }
      });
    }catch(e){
      if(capCtx){ try{ capCtx.close(); }catch(e2){} capCtx = null; }
      capTimer = setTimeout(capCycle, 15000);
    }
  }
  async function transcribeBlob(blob){
    var r = await fetch('/api/kade/transcribe', { method: 'POST', headers: { 'Authorization': 'Bearer ' + API, 'Content-Type': blob.type || 'audio/webm', 'x-kade-club': '1' }, body: blob });
    var j = await r.json();
    return (r.ok && j.transcript) ? j.transcript : '';
  }

  setInterval(function(){ if(mSrc && mId){ post({t:'pos', id: mId, pos: mPos()}); } }, 4000);

  (async function connect(){
    var attempt = 0;
    while(true){
      attempt++;
      try{ await room.connect(WSURL, LKTOK); break; }
      catch(e){
        if(attempt >= 8){ post({t:'dead', why: 'connect'}); return; }
        await new Promise(function(res){ setTimeout(res, 3500); });
      }
    }
    post({t:'ready'});
  })();
})();
