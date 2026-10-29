/* Oct 28 2026: the live video face. A character's painting, driven live by
 * the audio of whatever it is saying, streamed back as video. Simli does
 * the face; this page is a thin, dependency-free copy of their LiveKit
 * transport (simli-client 3.2.0, read Oct 28 2026):
 *
 *   wss://api.simli.ai/compose/webrtc/livekit?session_token=...
 *   text frames in: START, ACK, STOP, CLOSING/RATE/ERROR, SPEAK, SILENT,
 *     a JSON {livekit_url, livekit_token} to join, VIDEO_METADATA, ENDFRAME
 *   binary frames out: raw PCM16 mono 16 kHz; "SKIP" drops the queue; "DONE" ends.
 *
 * The iPhone loads this page in a WKWebView with everything it needs in
 * the URL FRAGMENT (never sent to the server; scrubbed on boot), feeds
 * audio with window.face.audio(base64) and hears back through
 * webkit.messageHandlers.face. A browser can host it the same way with
 * postMessage, for the web app later.
 */
(() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = params.get('st') || '';
  // Only the face service's own hosts; a fragment cannot point the page elsewhere.
  const wsWanted = params.get('ws') || 'wss://api.simli.ai';
  const wsBase = /^wss:\/\/([a-z0-9-]+\.)*simli\.ai$/i.test(wsWanted) ? wsWanted : 'wss://api.simli.ai';
  const mute = params.get('mute') === '1';
  history.replaceState(null, '', location.pathname);

  const video = document.getElementById('v');
  const audio = document.getElementById('a');
  audio.muted = mute;

  function tell(msg) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.face) {
        window.webkit.messageHandlers.face.postMessage(msg);
        return;
      }
    } catch (_) {}
    try { if (window.parent !== window) window.parent.postMessage({ kadeLiveFace: msg }, '*'); } catch (_) {}
  }

  if (!token) { tell({ t: 'error', why: 'no session token' }); return; }

  let ws = null;
  let room = null;
  let open = false;
  let ended = false;
  let firstFrame = false;

  function end(why) {
    if (ended) return;
    ended = true;
    open = false;
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send('DONE'); } catch (_) {}
    try { if (ws) ws.close(); } catch (_) {}
    try { if (room) room.disconnect(); } catch (_) {}
    tell({ t: 'stop', why: why || '' });
  }

  async function join(info) {
    if (!(info && info.livekit_url && info.livekit_token)) { tell({ t: 'error', why: 'join details unknown' }); return; }
    try {
      const LK = window.LivekitClient;
      room = new LK.Room({ adaptiveStream: false, dynacast: true });
      room.on(LK.RoomEvent.Disconnected, () => end('room closed'));
      room.on(LK.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === LK.Track.Kind.Video) {
          track.attach(video);
          const shown = () => {
            if (firstFrame) return;
            firstFrame = true;
            video.classList.add('on');
            tell({ t: 'start' });
          };
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(shown);
          else video.addEventListener('playing', shown, { once: true });
        } else if (track.kind === LK.Track.Kind.Audio && !mute) {
          // A call keeps its own engine's sound and echo cancellation: the page
          // never plays audio there, so it never touches the audio route.
          track.attach(audio);
        }
      });
      await room.connect(info.livekit_url, info.livekit_token);
      tell({ t: 'joined' });
    } catch (e) {
      tell({ t: 'error', why: 'LiveKit join failed: ' + (e && e.message ? e.message : e) });
      end('join failed');
    }
  }

  function onText(text) {
    const first = String(text).toUpperCase().split(' ')[0];
    switch (first) {
      case 'START': return;
      case 'ACK': tell({ t: 'ack' }); return;
      case 'STOP': end('server stop'); return;
      case 'CLOSING': case 'RATE': case 'ERROR': case 'ERROR:':
        tell({ t: 'error', why: String(text).slice(0, 200) }); end('server error'); return;
      case 'SPEAK': tell({ t: 'speaking' }); return;
      case 'SILENT': tell({ t: 'silent' }); return;
      default:
        if (first.includes('SDP') || first.includes('LIVEKIT')) {
          try { join(JSON.parse(text)); } catch (_) { tell({ t: 'error', why: 'bad join message' }); }
        } else if (first.includes('VIDEO_METADATA')) {
          tell({ t: 'video_info', text: String(text).slice(0, 300) });
        } else if (first.includes('ENDFRAME')) {
          end('endframe');
        } else if (first.includes('DESTINATION')) {
          tell({ t: 'destination', text: String(text).slice(0, 300) });
        } else if (/^WARNING: /.test(text)) {
          tell({ t: 'warning', text: String(text).slice(0, 300) });
        }
    }
  }

  try {
    const url = new URL(wsBase + '/compose/webrtc/livekit');
    url.searchParams.set('session_token', token);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { open = true; tell({ t: 'ready' }); };
    ws.onmessage = (m) => { if (typeof m.data === 'string') onText(m.data); };
    ws.onerror = () => { tell({ t: 'error', why: 'websocket failed' }); end('websocket failed'); };
    ws.onclose = () => end('websocket closed');
  } catch (e) {
    tell({ t: 'error', why: 'websocket: ' + e });
    return;
  }

  function bytesOf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  window.face = {
    /* PCM16 mono 16 kHz, base64. Queued behind what was already sent. */
    audio(b64) {
      if (!open || ended || !firstFrame) return false;
      try { ws.send(bytesOf(b64)); return true; } catch (_) { return false; }
    },
    /* Drop everything queued (the person interrupted). */
    clear() { if (open && !ended) { try { ws.send('SKIP'); } catch (_) {} } },
    mute(on) { audio.muted = !!on; },
    end() { end('closed by host'); },
    state() { return { open, ended, firstFrame }; },
  };
})();
