/* Shared library media streams directly to each listener. Only timing travels through the room. */
(() => {
  class ClubLibraryPlayer {
    constructor(options) {
      this.options = options; this.generation = 0; this.proof = ''; this.state = { active: false, revision: 0 };
      this.player = document.getElementById('library-player'); this.$ = id => document.getElementById('library-' + id);
      this.page = 0; this.mediaId = ''; this.urlAt = 0; this.lastGood = 0; this.polling = false; this.commanding = false;
      this.player.volume = .5;
      this.$('search-form').onsubmit = event => { event.preventDefault(); this.search(false); };
      this.$('more').onclick = () => this.search(true);
      this.$('toggle').onclick = () => this.command(this.state.playing ? 'pause' : 'play');
      this.$('stop').onclick = () => this.command('stop');
      this.$('back').onclick = () => this.command('seek', { position: Math.max(this.state.begin || 0, this.player.currentTime - 30) });
      this.$('ahead').onclick = () => this.command('seek', { position: Math.min(this.state.end ?? 604800, this.player.currentTime + 30) });
      this.$('take').onclick = () => this.command('take-control');
      this.$('join').onclick = () => { this.player.play().catch(() => this.say('Playback could not start. Try Rejoin playback.')); this.poll(true); };
      this.$('volume').oninput = () => { this.player.volume = Number(this.$('volume').value) / 100; };
      this.$('picture').onchange = () => { this.player.hidden = !this.$('picture').checked || !this.state.mime?.startsWith('video/'); };
      this.player.addEventListener('waiting', () => { if (this.state.active && this.state.playing) this.say('Buffering. You will catch up to the room when ready.'); });
      this.player.addEventListener('playing', () => { if (this.state.active) this.say('Playing: ' + this.state.title); });
      this.player.addEventListener('timeupdate', () => { if (this.state.active && this.state.end != null && this.player.currentTime >= this.state.end) this.player.pause(); });
      // Sep 29 2026: a recording with no stored length (or a too-long one) keeps "playing" for the room past its real end; the controller pauses the room there.
      this.player.addEventListener('ended', () => { if (!this.state.active) return; if (this.state.controlling && this.state.playing && (this.state.end ?? Infinity) > this.player.currentTime + 1) this.command('pause'); else this.say('Finished: ' + this.state.title); });
      this.player.addEventListener('error', () => { if (this.proof && this.mediaId) { this.urlAt = 0; this.player.pause(); this.say('This recording could not play. Try Rejoin playback.'); } });
      this.onVisibility = () => { if (!document.hidden && this.proof) this.poll(true); };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    say(text) { if (this.$('status').textContent !== text) this.$('status').textContent = text; }
    async request(path, body, retry = true) {
      const generation = this.generation;
      const response = await fetch('/api/community/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + (this.authToken || this.options.token()), 'X-Clubhouse-Token': this.proof, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      if (response.status === 401 && retry) {
        const refreshed = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (generation !== this.generation) throw new Error('The room changed.');
        // Sep 29 2026: signed out, the refresh answers 200 with plain text rather than JSON.
        this.authToken = (refreshed.ok && (await refreshed.json().catch(() => null))?.token) || '';
        if (this.authToken) return this.request(path, body, false);
      }
      if (response.status === 401) throw new Error('Please sign in again to use the room player.');
      const data = await response.json().catch(() => null); if (!response.ok || !data) throw new Error(data?.error || 'The library could not answer.'); return data;
    }
    start(proof) {
      this.stop(); this.proof = proof || ''; this.lastGood = Date.now();
      this.$('panel').hidden = !proof;
      if (!proof) return;
      this.poll(true); this.timer = setInterval(() => this.poll(), 2000);
    }
    stop() {
      this.generation++; this.proof = ''; clearInterval(this.timer); this.player.pause();
      this.player.removeAttribute('src'); this.player.load(); this.mediaId = ''; this.urlAt = 0;
      this.state = { active: false, revision: 0 }; this.$('panel').hidden = true;
    }
    async search(more) {
      if (!this.proof) return;
      const generation = this.generation; const page = more ? this.page + 1 : 0;
      this.$('search-button').disabled = true; this.$('more').disabled = true;
      try {
        const data = await this.request('library?q=' + encodeURIComponent(this.$('query').value) + '&page=' + page);
        if (generation !== this.generation) return;
        this.page = page; if (!more) this.$('results').replaceChildren();
        data.items.forEach(item => { const row = document.createElement('li'); const button = document.createElement('button');
          button.type = 'button'; button.className = 'rowbtn gray'; button.textContent = item.title;
          button.onclick = async () => { button.disabled = true; try {
            const data = await this.request('tracks/' + item.id); if (generation !== this.generation) return;
            this.$('tracks').replaceChildren(); this.$('chosen').textContent = data.title;
            data.tracks.forEach(track => { const b = document.createElement('button'); b.className = 'rowbtn'; b.textContent = 'Choose ' + track.title;
              b.onclick = () => this.command('load', { book: data.id, track: track.index }); this.$('tracks').append(b); });
            this.$('chosen').focus();
          } catch (e) { this.say(e.message); } finally { button.disabled = false; } }; row.append(button); this.$('results').append(row); });
        this.$('more').hidden = !data.more; this.say(data.items.length ? 'Choose a library recording below.' : 'No shared recordings matched your search.');
      } catch (e) { this.say(e.message); } finally { this.$('search-button').disabled = false; this.$('more').disabled = false; }
    }
    async command(action, extra = {}) {
      if (this.commanding || !this.proof) return;
      this.commanding = true; const generation = this.generation;
      try {
        await this.request('playback', { action, revision: this.state.revision, ...extra });
        if (generation !== this.generation) return;
        if (action === 'load' || action === 'play') this.options.pauseJukebox();
        this.options.changed(); await this.poll(true);
        if (action === 'load') { this.$('toggle').focus(); this.say('Ready. Press Play for everyone when the room is ready.'); }
      } catch (e) { this.say(e.message); await this.poll(); } finally { this.commanding = false; }
    }
    async poll(force = false) {
      if (!this.proof || this.polling) return;
      this.polling = true; const generation = this.generation; const began = performance.now();
      try {
        const needUrl = force || !this.mediaId || Date.now() - this.urlAt > 1800000;
        const state = await this.request('playback' + (needUrl ? '?url=1' : ''));
        if (generation !== this.generation) return;
        this.lastGood = Date.now(); const previous = this.state; this.state = state;
        if (!state.active) {
          this.player.pause(); this.player.removeAttribute('src'); this.player.load(); this.mediaId = ''; this.urlAt = 0;
          this.$('now').textContent = 'Nothing selected.'; this.player.hidden = true;
          this.say(state.unavailable ? 'This room’s recording is unavailable to your account. ' + (state.canTakeControl ? 'Use Take over playback to clear it and choose another.' : 'You can still join the conversation.') : 'Choose a recording from the shared library.');
        } else {
          const id = state.book + ':' + state.track;
          if (id !== this.mediaId && !state.url) { this.urlAt = 0; this.mediaId = ''; return; }
          const target = Math.min(state.end ?? Infinity, state.position + (state.playing ? (performance.now() - began) / 2000 : 0));
          if (id !== this.mediaId || (needUrl && state.url && Date.now() - this.urlAt > 1800000)) {
            this.player.pause(); this.player.src = state.url; this.mediaId = id; this.urlAt = Date.now(); this.player.load();
            this.player.onloadedmetadata = () => { if (generation === this.generation && this.mediaId === id) this.sync(); };
          }
          this.target = target; this.targetAt = performance.now();
          this.$('now').textContent = state.title + (state.trackTitle ? ' — ' + state.trackTitle : '');
          this.player.hidden = !state.mime.startsWith('video/') || !this.$('picture').checked;
          this.$('picture-row').hidden = !state.mime.startsWith('video/');
          this.$('host').textContent = state.controlling ? 'You control playback for the room.' : state.hostName + ' controls playback for the room.';
          this.sync();
          if (previous.revision !== state.revision || !previous.active) this.say((state.playing ? 'Playing: ' : 'Paused: ') + state.title);
        }
        const focused = ['toggle', 'back', 'ahead', 'stop', 'take', 'join'].map(id => this.$(id)).find(control => control === document.activeElement);
        this.$('toggle').textContent = state.playing ? 'Pause for everyone' : 'Play for everyone';
        ['toggle', 'back', 'ahead', 'stop'].forEach(id => { this.$(id).disabled = !state.active || !state.controlling; });
        this.$('take').hidden = !(state.active || state.unavailable) || state.controlling || !state.canTakeControl;
        this.$('join').hidden = !state.active;
        // Sep 29 2026: Stop sharing and Take over playback disable or hide the button just pressed; keep focus in the player instead of dropping it.
        if (focused && (focused.disabled || focused.hidden)) (this.$('toggle').disabled ? this.$('panel').querySelector('summary') : this.$('toggle')).focus();
      } catch (e) {
        if (generation === this.generation) {
          if (Date.now() - this.lastGood > 10000) this.player.pause();
          this.say('Playback connection lost. ' + e.message);
        }
      } finally { this.polling = false; }
    }
    sync() {
      if (!this.proof || !this.state.active || !this.player.readyState) return;
      // Sep 29 2026: play() on a file that has ended starts it again from the top, so stop at the file's real end
      // even when the room has no stored length (or a longer one) and keeps counting.
      const duration = Number.isFinite(this.player.duration) ? this.player.duration : Infinity;
      const target = Math.min(this.state.end ?? Infinity, duration, this.target + (this.state.playing ? (performance.now() - this.targetAt) / 1000 : 0));
      const finished = target >= (this.state.end ?? Infinity) || target >= duration - (this.player.ended ? .8 : .25);
      if (Math.abs(this.player.currentTime - target) > .8 || (!this.state.playing && Math.abs(this.player.currentTime - target) > .15)) this.player.currentTime = target;
      if (this.state.playing && !finished) {
        this.player.play().catch(() => this.say('Press Rejoin playback to start listening on this device.'));
      } else this.player.pause();
    }
  }
  window.ClubLibraryPlayer = ClubLibraryPlayer;
})();
