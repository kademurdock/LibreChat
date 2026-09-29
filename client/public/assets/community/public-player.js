(() => {
  const access = document.getElementById('release-access');
  if (!access) return;
  const player = document.getElementById('release-player');
  const status = document.getElementById('player-error');
  const signIn = document.getElementById('release-signin');
  const actions = document.getElementById('release-actions');
  const open = document.getElementById('release-open');
  const download = document.getElementById('release-download');
  let token = '';
  let streamExpires = 0;
  let wantPlay = false;
  let renewing = false;
  const couldNotPlay = 'The recording could not play. Use Open player for a fresh link, or download it to play with another app.';

  async function refresh() {
    const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    // Sep 29 2026: with no refresh cookie the server answers 200 with plain text. That means
    // signed out, not an error, so it must not reach the status line every visitor hears.
    const data = response.ok ? await response.json().catch(() => null) : null;
    token = (data && data.token) || '';
    return !!token;
  }

  async function mediaLink(kind) {
    const endpoint = '/api/community/releases/' + encodeURIComponent(access.dataset.slug) + '/' + kind;
    let response = await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } });
    if (response.status === 401 && await refresh()) {
      response = await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } });
    }
    if (response.status === 401) {
      signIn.hidden = false;
      actions.hidden = true;
      player.pause();
      player.removeAttribute('src');
      player.load();
      player.hidden = true;
      throw new Error('Please sign in again to play or download this recording.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.url) throw new Error((data && data.error) || 'This recording is unavailable. Please try again.');
    const url = new URL(data.url);
    if (url.protocol !== 'https:' && !(location.hostname === 'localhost' && url.hostname === 'localhost')) {
      throw new Error('The media link could not be opened. Please try again.');
    }
    if (kind === 'stream') streamExpires = Date.now() + (Number(data.expiresIn) || 3600) * 1000;
    return url.href;
  }

  // Sep 29 2026: stream links last an hour, so a long film that seeks, resumes after a pause, or
  // keeps fetching (Safari) past that point fails. Swap in a fresh link at the same place instead of stopping.
  async function renew(resume) {
    renewing = true;
    const position = player.currentTime;
    try {
      const src = await mediaLink('stream');
      player.onloadedmetadata = () => {
        if (position > 0 && Number.isFinite(player.duration)) player.currentTime = Math.min(position, player.duration);
        if (resume) player.play().catch(() => { status.textContent = 'The player reconnected. Press Play to keep going.'; });
        else status.textContent = 'The player reconnected. Press Play to keep going.';
      };
      player.src = src;
      player.load();
    } catch (error) { status.textContent = error instanceof TypeError ? couldNotPlay : error.message; }
    finally { renewing = false; }
  }

  open.addEventListener('click', async () => {
    if (open.getAttribute('aria-disabled') === 'true') return;
    open.setAttribute('aria-disabled', 'true');
    status.textContent = 'Opening the player…';
    try {
      const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
      player.onloadedmetadata = () => {
        if (position > 0 && Number.isFinite(player.duration)) {
          player.currentTime = Math.min(position, player.duration);
        }
      };
      player.src = await mediaLink('stream');
      player.hidden = false;
      player.tabIndex = 0;
      player.load();
      player.focus();
      status.textContent = 'Player ready. Press Play when you’re ready.';
    } catch (error) { status.textContent = error.message; }
    finally { open.setAttribute('aria-disabled', 'false'); }
  });

  download.addEventListener('click', async () => {
    if (download.getAttribute('aria-disabled') === 'true') return;
    download.setAttribute('aria-disabled', 'true');
    status.textContent = 'Preparing your download…';
    try {
      const link = document.createElement('a');
      link.href = await mediaLink('download');
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
      status.textContent = 'Your download is starting.';
      document.getElementById('download-thanks').hidden = false;
    } catch (error) { status.textContent = error.message; }
    finally { download.setAttribute('aria-disabled', 'false'); }
  });

  player.addEventListener('play', () => { wantPlay = true; });
  player.addEventListener('pause', () => { wantPlay = false; });
  player.addEventListener('error', () => {
    // Only a link near or past its hour is renewed; a fresh link that fails is a real problem, so say so.
    if (!renewing && player.getAttribute('src') && Date.now() > streamExpires - 600000) { renew(wantPlay); return; }
    status.textContent = couldNotPlay;
  });

  refresh().then(signedIn => {
    signIn.hidden = signedIn;
    actions.hidden = !signedIn;
  }).catch(() => {
    status.textContent = 'Could not check your account. Try reloading, or use Sign in.';
  });
})();
