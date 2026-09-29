(() => {
  const player = document.querySelector('video, audio');
  if (!player) return;
  player.addEventListener('error', () => {
    document.getElementById('player-error').textContent = 'The recording could not play. Reload the page to get a fresh playback link, or try another browser.';
  });
})();
