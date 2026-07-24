const express = require('express');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { SHARED_HEAD } = require('./kadePages');

/**
 * THE LOUNGE (July 24 2026 — Kade's TeamTalk-style ask, her words: "blind
 * people can stream hq stereo audio whether it's there own voices or music
 * or movies or both... talk shit while you're gaming, and play a song while
 * you're at it." Full workup: AUDIO_LOUNGE_TEAMTALK_STYLE_WORKUP_2026-07-24
 * in her folder; her call: LiveKit, sleeping when unused).
 *
 * Phase 1 = the WEB room: /lounge page + a LiveKit access-token mint. The
 * heavy lifting (SFU, opus, NAT traversal) is LiveKit's; this file only
 * signs JWTs and serves an accessible page over the LiveKit JS SDK.
 *
 * WIRING: three env vars on the LibreChat service —
 *   LIVEKIT_URL        wss://... (LiveKit Cloud project URL, or the
 *                      self-hosted Railway service later — same client)
 *   LIVEKIT_API_KEY    from the LiveKit project
 *   LIVEKIT_API_SECRET from the LiveKit project
 * Missing vars = warm fail-soft (the page says the room keys aren't in yet),
 * never an error. Swapping Cloud -> self-host later is JUST these vars.
 *
 * Token shape (LiveKit spec): HS256 JWT, iss = API key, sub = identity,
 * `video` grant {room, roomJoin, canPublish, canSubscribe}. 6-hour expiry —
 * long movie nights welcome.
 */

const router = express.Router();

const ROOMS = [
  { key: 'porch', name: 'The Porch', blurb: 'The everyday hangout — come sit.' },
  { key: 'game-night', name: 'Game Night', blurb: 'Talk trash while the cards fly. Pairs with Parlor party tables.' },
  { key: 'music-night', name: 'Music Night', blurb: 'Somebody takes the music seat, everybody listens in stereo.' },
];

function loungeConfigured() {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

router.get('/config', requireJwtAuth, (_req, res) => {
  if (!loungeConfigured()) {
    return res.json({ ready: false, rooms: ROOMS });
  }
  return res.json({ ready: true, url: process.env.LIVEKIT_URL, rooms: ROOMS });
});

router.post('/token', requireJwtAuth, (req, res) => {
  try {
    if (!loungeConfigured()) {
      return res.status(503).json({
        error:
          "The Lounge is built but its room server isn't wired in yet — Kade just needs to drop the LiveKit keys into Railway.",
      });
    }
    let room = String(req.body?.room || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    if (!room) return res.status(400).json({ error: 'Which room?' });
    // Parlor fusion: joining by a 4-char table code lands everyone from that
    // party table in the same voice room, no extra coordination.
    if (/^[a-z0-9]{4}$/.test(room) && !ROOMS.some((r) => r.key === room)) {
      room = `table-${room}`;
    }
    const firstName = (req.user.name || 'Someone').trim().split(/\s+/)[0] || 'Someone';
    const identity = `${firstName}-${String(req.user.id).slice(-4)}`;
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        iss: process.env.LIVEKIT_API_KEY,
        sub: identity,
        name: firstName,
        nbf: now - 10,
        exp: now + 6 * 60 * 60,
        video: {
          room,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
      },
      process.env.LIVEKIT_API_SECRET,
      { algorithm: 'HS256' },
    );
    return res.json({ token, url: process.env.LIVEKIT_URL, room, identity, name: firstName });
  } catch (e) {
    logger.error('[kade/lounge token] error:', e);
    return res.status(500).json({ error: 'Could not mint a room key.' });
  }
});

/* ── The page ─────────────────────────────────────────────────────────── */
const loungeHtml = `<!doctype html><html lang="en"><head><title>The Lounge</title>${SHARED_HEAD}
<style>
  .rowbtn { font: inherit; background: #1f7a49; color: #fff; border: 0; border-radius: 10px; padding: .7rem 1.1rem; font-weight: 600; cursor: pointer; margin: .35rem .4rem .35rem 0; }
  .rowbtn.gray { background: #5b6270; }
  .rowbtn.red { background: #a33; }
  .rowbtn:focus-visible, button.room:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
  button.room { display:block; width:100%; text-align:left; font:inherit; background:#fff; color:inherit; border:1px solid #cdd3da; border-radius:12px; padding:.85rem 1rem; margin:.45rem 0; cursor:pointer; }
  button.room .desc { display:block; font-weight:400; opacity:.8; font-size:.92rem; margin-top:.15rem; }
  @media (prefers-color-scheme: dark) { button.room { background:#1e2127; border-color:#3a4150; } }
  #roster li { margin:.3rem 0; }
  .talking { font-weight:700; }
  label.blk { display:block; margin:.7rem 0 .25rem; font-weight:600; }
  input[type="text"] { font:inherit; padding:.55rem .6rem; border-radius:9px; border:1px solid #cdd3da; background:#fff; color:inherit; }
  @media (prefers-color-scheme: dark) { input[type="text"] { background:#1e2127; border-color:#3a4150; } }
</style>
</head>
<body>
  <p><a class="back" href="/" aria-label="Back to chat">&larr; Back to chat</a> &nbsp;&middot;&nbsp; <a class="back" href="/parlor">The Parlor</a> &nbsp;&middot;&nbsp; <a class="back" href="/help/whats-new">What's new</a></p>
  <h1>The Lounge</h1>
  <div id="status" class="status" role="status" aria-live="polite">Opening the Lounge&hellip;</div>

  <section id="pick" hidden>
    <p class="muted">Family voice rooms with real stereo sound. Sit and talk, or take the music seat and play something for everybody &mdash; TeamTalk energy, Kade's house rules.</p>
    <div id="room-list"></div>
    <div class="card">
      <h2 style="margin-top:0">Join a game table's room</h2>
      <label class="blk" for="code">The Parlor party code</label>
      <input type="text" id="code" maxlength="8" autocapitalize="characters" style="text-transform:uppercase">
      <p><button type="button" class="rowbtn" id="join-code">Join that table's voices</button></p>
    </div>
  </section>

  <section id="room" hidden>
    <h2 id="room-title"></h2>
    <div id="rstatus" class="status" role="status" aria-live="polite" tabindex="-1"></div>
    <div class="card">
      <h3 style="margin-top:0" id="roster-h">Who's here</h3>
      <ul id="roster" style="list-style:none;padding:0;margin:0" aria-labelledby="roster-h"></ul>
    </div>
    <p>
      <button type="button" class="rowbtn" id="btn-mic">Mute my mic</button>
      <button type="button" class="rowbtn gray" id="btn-who">Say who's here</button>
      <button type="button" class="rowbtn red" id="btn-leave">Leave the room</button>
    </p>
    <div class="card">
      <h3 style="margin-top:0">The music seat</h3>
      <p class="muted">Pick a song or any audio file &mdash; it streams to the whole room in high-quality stereo. Your mic stays separate, so keep talking over it.</p>
      <input type="file" id="music-file" accept="audio/*" aria-label="Choose an audio file to play for the room">
      <p>
        <button type="button" class="rowbtn" id="btn-music" hidden>Play it for the room</button>
        <button type="button" class="rowbtn gray" id="btn-music-stop" hidden>Stop the music</button>
      </p>
      <p id="now-playing" class="muted" aria-live="polite"></p>
    </div>
  </section>

  <footer class="muted">Your voices never touch the AI &mdash; the Lounge is straight person-to-person audio on Kade's own room server. &mdash; Kade-AI</footer>

  <script src="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js"></script>
  <script>
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
        status.textContent='The audio engine could not load — check the connection and reload.';
        return;
      }
      const LK = LivekitClient;

      let cfg;
      try{
        const r = await apiGet('/api/kade/lounge/config', token);
        cfg = await r.json();
      }catch(e){ status.className='status err'; status.textContent='Could not reach the Lounge — try a reload.'; return; }

      $('room-list').innerHTML = (cfg.rooms||[]).map(function(r){
        return '<button type="button" class="room" data-room="'+r.key+'">'+r.name+' <span class="desc">'+r.blurb+'</span></button>';
      }).join('');
      $('pick').hidden = false;
      if(!cfg.ready){
        status.className = 'status';
        status.textContent = "The Lounge is built and ready — it's just waiting on Kade to drop the room-server keys into Railway. Two-minute job, then this page comes alive.";
      } else {
        status.textContent = 'Pick a room.';
      }

      let lkRoom = null;
      let micTrack = null;
      let musicSource = null;
      let musicCtx = null;
      let musicTrackPub = null;
      let micMuted = false;

      function say(text){
        $('rstatus').textContent = text;
      }

      function rosterNames(){
        if(!lkRoom) return [];
        const names = [lkRoom.localParticipant].concat(Array.from(lkRoom.remoteParticipants.values()))
          .map(function(p){ return (p.name || p.identity || 'Someone'); });
        return names;
      }

      function renderRoster(){
        if(!lkRoom) return;
        const speaking = new Set((lkRoom.activeSpeakers||[]).map(function(p){ return p.identity; }));
        const parts = [lkRoom.localParticipant].concat(Array.from(lkRoom.remoteParticipants.values()));
        $('roster').innerHTML = parts.map(function(p){
          const me = p === lkRoom.localParticipant;
          const talking = speaking.has(p.identity);
          return '<li'+(talking?' class="talking"':'')+'>'+(p.name||p.identity)+(me?' (you)':'')+(talking?' — talking':'')+'</li>';
        }).join('');
      }

      async function joinRoom(roomKey, label){
        status.textContent = 'Getting your room key…';
        let mint;
        try{
          const r = await fetch('/api/kade/lounge/token', { method:'POST', headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ room: roomKey }) });
          mint = await r.json();
          if(!r.ok) throw new Error(mint.error || 'No key.');
        }catch(e){ status.className='status err'; status.textContent = e.message; return; }

        lkRoom = new LK.Room({ adaptiveStream: false, dynacast: false });
        wireRoomEvents();
        // Waking-the-room retry: a sleeping self-hosted server can bounce the
        // first knock while it spins up. Say the wait out loud, try again.
        let attempt = 0;
        while(true){
          attempt++;
          try{
            status.textContent = attempt === 1 ? 'Connecting…' : 'Waking the room up — give it a breath…';
            await lkRoom.connect(mint.url, mint.token);
            break;
          }catch(e){
            if(attempt >= 3){ status.className='status err'; status.textContent='Could not reach the room server. Try again in a minute.'; return; }
            await new Promise(function(res){ setTimeout(res, 2500); });
          }
        }
        try{
          micTrack = await LK.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true });
          await lkRoom.localParticipant.publishTrack(micTrack);
        }catch(e){
          say('Mic permission was refused — you can listen, but the room cannot hear you.');
        }
        $('pick').hidden = true;
        $('room').hidden = false;
        $('room-title').textContent = label;
        micMuted = false;
        $('btn-mic').textContent = 'Mute my mic';
        renderRoster();
        say('You are in ' + label + ' with ' + Math.max(0, rosterNames().length - 1) + ' other' + (rosterNames().length === 2 ? '' : 's') + '. Your mic is live.');
        $('rstatus').focus();
      }

      function wireRoomEvents(){
        lkRoom
          .on(LK.RoomEvent.TrackSubscribed, function(track){
            if(track.kind === 'audio'){
              const el = track.attach();
              el.setAttribute('aria-hidden', 'true');
              document.body.appendChild(el);
            }
          })
          .on(LK.RoomEvent.ParticipantConnected, function(p){
            renderRoster(); say((p.name||p.identity)+' joined.');
          })
          .on(LK.RoomEvent.ParticipantDisconnected, function(p){
            renderRoster(); say((p.name||p.identity)+' left.');
          })
          .on(LK.RoomEvent.ActiveSpeakersChanged, function(){ renderRoster(); })
          .on(LK.RoomEvent.Disconnected, function(){
            say('You left the room.');
            cleanupRoom();
          });
      }

      function cleanupRoom(){
        stopMusic();
        if(micTrack){ try{ micTrack.stop(); }catch(e){} micTrack = null; }
        document.querySelectorAll('audio[aria-hidden="true"]').forEach(function(el){ el.remove(); });
        lkRoom = null;
        $('room').hidden = true;
        $('pick').hidden = false;
        status.textContent = 'Pick a room.';
      }

      $('room-list').addEventListener('click', function(ev){
        const b = ev.target.closest('button[data-room]'); if(!b) return;
        const r = (cfg.rooms||[]).find(function(x){ return x.key === b.getAttribute('data-room'); });
        joinRoom(b.getAttribute('data-room'), r ? r.name : b.getAttribute('data-room'));
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
        say(names.length ? ('Here now: ' + names.join(', ') + '.') : 'Nobody here yet.');
      });
      $('btn-leave').addEventListener('click', async function(){
        if(lkRoom){ try{ await lkRoom.disconnect(); }catch(e){} }
        cleanupRoom();
      });

      /* ── The music seat: file → WebAudio → hi-fi stereo publish ── */
      $('music-file').addEventListener('change', function(){
        $('btn-music').hidden = !$('music-file').files.length;
      });
      $('btn-music').addEventListener('click', async function(){
        const file = $('music-file').files[0];
        if(!file || !lkRoom) return;
        stopMusic();
        try{
          musicCtx = new (window.AudioContext || window.webkitAudioContext)();
          const buf = await musicCtx.decodeAudioData(await file.arrayBuffer());
          const dest = musicCtx.createMediaStreamDestination();
          musicSource = musicCtx.createBufferSource();
          musicSource.buffer = buf;
          musicSource.connect(dest);
          musicSource.onended = function(){ stopMusic(); say('The song finished.'); };
          const track = dest.stream.getAudioTracks()[0];
          const lkTrack = new LK.LocalAudioTrack(track);
          musicTrackPub = await lkRoom.localParticipant.publishTrack(lkTrack, {
            dtx: false,
            red: false,
            audioPreset: LK.AudioPresets.musicHighQualityStereo,
            source: LK.Track.Source.Unknown,
            name: 'music',
          });
          musicSource.start();
          $('btn-music-stop').hidden = false;
          $('now-playing').textContent = 'Now playing for the room: ' + file.name;
          say('Music is on — ' + file.name + '.');
        }catch(e){
          say('That file would not play — try an MP3, M4A, or WAV.');
          stopMusic();
        }
      });
      $('btn-music-stop').addEventListener('click', function(){ stopMusic(); say('Music stopped.'); });
      function stopMusic(){
        if(musicSource){ try{ musicSource.stop(); }catch(e){} musicSource = null; }
        if(musicTrackPub && lkRoom){ try{ lkRoom.localParticipant.unpublishTrack(musicTrackPub.track, true); }catch(e){} musicTrackPub = null; }
        if(musicCtx){ try{ musicCtx.close(); }catch(e){} musicCtx = null; }
        $('btn-music-stop').hidden = true;
        $('now-playing').textContent = '';
      }
    })();
  </script>
</body></html>`;

router.page = (_req, res) => res.type('html').send(loungeHtml);

module.exports = router;
