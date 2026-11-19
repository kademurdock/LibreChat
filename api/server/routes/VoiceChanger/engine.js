/* The iPhone's hidden Voice Changer engine page (/voice-changer/engine, served no-store).
 * Pure compute: no AudioContext, no microphone, no controls. It imports the engine's
 * bridge from the versioned folder the server wrote into the meta tag (the engine
 * manifest's version, read at startup by pages.js), and bridge.js puts window.vcBridge
 * on the page and posts {t:'ready', version} to webkit.messageHandlers.vc
 * (kadeVoiceChanger/CONTRACT.md section 10). If the bridge cannot load, native hears
 * {t:'error'} in a plain sentence instead of silence. */
(function () {
  'use strict';
  function tell(m) {
    try {
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.vc;
      if (h && typeof h.postMessage === 'function') { h.postMessage(m); return; }
    } catch (e) { /* fall through to the test array */ }
    (window.vcBridgeOut = window.vcBridgeOut || []).push(m);
  }
  var meta = document.querySelector('meta[name="vc-engine-base"]');
  var base = (meta && meta.getAttribute('content')) || '';
  if (!/^\/vc-engine\/[A-Za-z0-9._-]+\/$/.test(base)) {
    tell({ t: 'error', req: null, message: 'The Voice Changer engine version is missing from this page, so it cannot start.' });
    return;
  }
  import(base + 'host/bridge.js').catch(function (e) {
    tell({ t: 'error', req: null, message: 'The Voice Changer engine could not be loaded: ' + ((e && e.message) || String(e)) });
  });
})();
