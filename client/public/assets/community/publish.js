(() => {
  const $ = id => document.getElementById(id);
  let token, chosen, page = 0;
  const say = text => { $('status').textContent = text; };
  async function api(path, body, method) {
    const response = await fetch('/api/community/' + path, { method: method || (body ? 'POST' : 'GET'), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || (response.status === 401 ? 'Please sign in again, then reload this page.' : 'Please try again.'));
    return result;
  }
  function button(text, action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { say(e.message); } finally { b.disabled = false; } }; return b; }
  async function search(append = false) {
    if (!append) { page = 0; $('results').replaceChildren(); }
    const data = await api('library?publishing=1&q=' + encodeURIComponent($('search').value) + '&page=' + page);
    data.items.forEach(item => {
      const li = document.createElement('li');
      li.append(button(item.title, async () => {
        const data = await api('tracks/' + item.id); chosen = data.id;
        $('chosen').textContent = data.title; $('title').value = data.title; $('description').value = ''; $('confirm').checked = false;
        $('track').replaceChildren(...data.tracks.map(track => new Option(track.title, track.index)));
        $('publish-form').hidden = false; $('title').focus();
      })); $('results').append(li);
    });
    $('more').hidden = !data.more;
    say(data.items.length ? 'Choose a recording below.' : 'No recordings matched.');
  }
  async function releases() {
    const data = await api('releases'); $('releases').replaceChildren();
    data.releases.forEach(release => {
      const li = document.createElement('li'); const a = document.createElement('a'); a.href = '/watch/' + release._id; a.textContent = release.title;
      li.append(a, document.createTextNode(' '), button('Take down ' + release.title, async () => {
        if (!window.confirm('Take this release off the public website?')) return;
        await api('releases/' + release._id, null, 'DELETE'); await releases(); say('The release has been taken down.');
      })); $('releases').append(li);
    });
  }
  $('search-form').onsubmit = event => { event.preventDefault(); search().catch(e => say(e.message)); };
  $('more').onclick = () => { page++; search(true).catch(e => { page--; say(e.message); }); };
  $('publish-form').onsubmit = async event => {
    event.preventDefault(); $('publish').disabled = true;
    try { const data = await api('releases', { book: chosen, track: Number($('track').value), title: $('title').value, description: $('description').value, confirmPublic: $('confirm').checked });
      $('publish-form').hidden = true; await releases(); say('Published. ' + location.origin + data.url); $('status').tabIndex = -1; $('status').focus();
    } catch (e) { say(e.message); } finally { $('publish').disabled = false; }
  };
  (async () => {
    // Sep 29 2026: signed out, the refresh answers 200 with plain text; send Kade to sign in instead of showing a JSON error.
    const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }); const data = response.ok ? await response.json().catch(() => null) : null; token = data && data.token;
    if (!token) { location.replace('/login?redirect_to=%2Fpublish'); return; }
    await releases(); $('manager').hidden = false; say('Your public releases are ready to manage.');
  })().catch(e => say(e.message));
})();
