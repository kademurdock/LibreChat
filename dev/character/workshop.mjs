import { createCallCharacter } from './adapter.mjs';
import { createPortraitRig } from './portrait-rig.mjs';
import { observePlayback } from './playback-browser.mjs';

const $ = id => document.getElementById(id);
const media = matchMedia('(prefers-reduced-motion: reduce)');
const atlas = createPortraitRig($('atlas'), { id: 'kiana', portrait: 'portrait.png', atlas: 'kiana-atlas-draft.png',
  onFailure: () => { $('status').textContent = 'Artwork could not load. The static portrait remains available.'; } });
const character = createCallCharacter({
  resolveProfile: id => id === 'kiana' ? { id, rigReady: true } : null,
  render: frame => { atlas.render(frame); $('frames').textContent = JSON.stringify(frame, null, 2); $('frames').dataset.frame = JSON.stringify(frame); },
  requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
});
let ctx, generation = 0;
const sources = new Set();
function preferences() { character.preferences({ enabled: $('enabled').checked, visible: !document.hidden, reducedMotion: media.matches }); }
function stop() {
  generation++;
  character.clear();
  for (const source of sources) { try { source.stop(); } catch {} }
  sources.clear();
}
async function play(speech) {
  stop(); const own = generation;
  ctx ||= new AudioContext();
  await ctx.resume();
  const data = await fetch('character-sample.wav').then(r => r.arrayBuffer());
  const buffer = await ctx.decodeAudioData(data);
  if (own !== generation) return;
  const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(ctx.destination);
  const start = ctx.currentTime + 0.1;
  source.start(start); sources.add(source);
  source.onended = () => { sources.delete(source); if (own === generation) $('status').textContent = 'Sample finished.'; };
  observePlayback(character, source, { buffer, start, clock: () => ctx.currentTime, speech, agentId: $('character').value });
  // The server may say listening before the local audio finishes draining.
  character.status('listening');
  $('status').textContent = speech ? 'Playing the speech sample.' : 'Playing as a sound effect. Mouth stays closed.';
}
$('enabled').onchange = preferences;
$('character').onchange = () => { stop(); character.select($('character').value); };
$('listen').onclick = () => { stop(); character.status('listening'); $('status').textContent = 'Showing listening motion.'; };
$('play').onclick = () => play(true).catch(() => { stop(); $('status').textContent = 'Could not play the sample.'; });
$('effect').onclick = () => play(false).catch(() => { stop(); $('status').textContent = 'Could not play the sample.'; });
$('stop').onclick = () => { stop(); $('status').textContent = 'Interrupted.'; };
media.addEventListener('change', preferences);
document.addEventListener('visibilitychange', preferences);
addEventListener('pagehide', () => { stop(); character.dispose(); atlas.dispose(); void ctx?.close(); }, { once: true });
character.select('kiana'); preferences();
