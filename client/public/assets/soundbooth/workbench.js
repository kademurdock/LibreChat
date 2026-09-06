(function () {
  'use strict';
  const form = document.getElementById('audioWorkbench');
  if (!form) return;
  const note = document.getElementById('mixStatus');
  const field = (name) => document.getElementById(name);
  let resultURL;
  let sourceURL;

  function number(name, min, max) {
    const n = Number(field(name).value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(field(name).getAttribute('aria-label') + ' must be between ' + min + ' and ' + max + '.');
    return n;
  }
  async function decode(file, context) {
    if (!file) throw new Error('Choose a main recording first.');
    if (file.size > 25 * 1024 * 1024) throw new Error('Use a file under 25 megabytes for this browser editor.');
    return context.decodeAudioData(await file.arrayBuffer());
  }
  function wav(buffer) {
    const channels = buffer.numberOfChannels;
    const bytes = buffer.length * channels * 2;
    const view = new DataView(new ArrayBuffer(44 + bytes));
    const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes, true);
    const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    let peak = 0;
    for (const channel of data) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    const scale = peak > 0.98 ? 0.98 / peak : 1;
    let pos = 44;
    for (let i = 0; i < buffer.length; i++) for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c][i] * scale));
      view.setInt16(pos, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); pos += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }
  function track(context, buffer, gainDB, offset, duration, fadeIn, fadeOut, loop) {
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = loop;
    const gain = context.createGain(); const level = Math.pow(10, gainDB / 20);
    gain.gain.setValueAtTime(fadeIn ? 0 : level, 0);
    if (fadeIn) gain.gain.linearRampToValueAtTime(level, fadeIn);
    if (fadeOut) { gain.gain.setValueAtTime(level, duration - fadeOut); gain.gain.linearRampToValueAtTime(0, duration); }
    source.connect(gain).connect(context.destination); source.start(0, offset, duration);
  }
  field('mixMain').addEventListener('change', async () => {
    const file = field('mixMain').files[0]; if (!file) return;
    if (sourceURL) URL.revokeObjectURL(sourceURL);
    sourceURL = URL.createObjectURL(file); field('mixOriginal').src = sourceURL;
    field('mixResult').hidden = true;
    field('mixOriginal').onloadedmetadata = () => {
      const duration = field('mixOriginal').duration;
      if (Number.isFinite(duration)) { field('mixEnd').value = Math.min(300, duration).toFixed(3); note.textContent = file.name + ': ' + duration.toFixed(1) + ' seconds. Set the start and end of the portion to keep.'; }
    };
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = field('mixBuild'); button.disabled = true;
    field('mixResult').hidden = true;
    let decoder;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio || !window.OfflineAudioContext) throw new Error('This browser does not support the audio editor. Try a recent Chrome, Edge, Safari, or Firefox.');
      const start = number('mixStart', 0, 3600), end = number('mixEnd', 0.01, 3600);
      const duration = end - start;
      if (duration <= 0 || duration > 300) throw new Error('The end must be after the start, with at most five minutes of audio selected.');
      const fadeIn = number('mixFadeIn', 0, 30), fadeOut = number('mixFadeOut', 0, 30);
      if (fadeIn + fadeOut > duration) throw new Error('The two fades together must fit inside the selected audio.');
      note.textContent = 'Making the mix on this device. Nothing is being uploaded.';
      decoder = new Audio();
      const main = await decode(field('mixMain').files[0], decoder);
      if (end > main.duration + 0.01) throw new Error('The end time goes past this recording. It is ' + main.duration.toFixed(2) + ' seconds long.');
      const bedFile = field('mixBed').files[0];
      const bed = bedFile ? await decode(bedFile, decoder) : null;
      const context = new OfflineAudioContext(2, Math.ceil(duration * 44100), 44100);
      track(context, main, number('mixGain', -36, 12), start, duration, fadeIn, fadeOut, false);
      if (bed) track(context, bed, number('mixBedGain', -48, 0), 0, duration, fadeIn, fadeOut, field('mixLoop').checked);
      const output = await context.startRendering();
      if (resultURL) URL.revokeObjectURL(resultURL);
      resultURL = URL.createObjectURL(wav(output));
      field('mixPlayer').src = resultURL; field('mixDownload').href = resultURL;
      field('mixResult').hidden = false;
      note.textContent = 'Ready: ' + duration.toFixed(1) + ' seconds. Play the mix, then download the WAV. The original files are unchanged. This local mix is not saved to My Creations.';
    } catch (error) { note.textContent = error.name === 'EncodingError' ? 'That file could not be read as audio. Try WAV, MP3, or M4A.' : error.message; }
    finally { if (decoder) await decoder.close().catch(() => {}); button.disabled = false; }
  });
})();
