'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const conversationId = params.get('conversationId');
  const memoryId = params.get('memoryId');
  const status = document.getElementById('status');
  const toggle = document.getElementById('toggle');
  let token,
    excluded,
    stopped = false,
    last = 0;
  async function request(path, method = 'GET', body) {
    if (stopped) throw new Error('Access was refused. Requests have stopped.');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 8500 - (Date.now() - last))));
    last = Date.now();
    const response = await fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 403) stopped = true;
    if (response.status === 401) throw new Error('Sign in, then reopen this page.');
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || 'Could not confirm the change. Refresh to check.');
    return data;
  }
  const endpoint = '/api/memories/controls';
  function showSetting(data) {
    excluded = data.excluded;
    toggle.textContent = excluded
      ? 'Remembering is off — turn on'
      : 'Don’t remember this conversation';
    toggle.disabled = false;
  }
  toggle.onclick = async () => {
    toggle.disabled = true;
    status.textContent = 'Saving memory setting…';
    try {
      showSetting(
        await request(endpoint + '/conversation/' + encodeURIComponent(conversationId), 'PATCH', {
          excluded: !excluded,
        }),
      );
      status.textContent = excluded
        ? 'Remembering is off for this conversation.'
        : 'Remembering is on for this conversation.';
    } catch (error) {
      status.textContent = error.message;
      toggle.disabled = stopped;
    }
  };
  document.getElementById('correction').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    const ids = [...document.querySelectorAll('#related input:checked')].map(
      (input) => input.value,
    );
    if (!ids.length) {
      status.textContent = 'Choose at least one memory to correct.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Saving corrections…';
    try {
      const result = await request(endpoint + '/correct', 'POST', {
        ids,
        value: document.getElementById('corrected').value,
      });
      status.textContent =
        result.corrected +
        ' memories corrected. Their previous versions are retained. Open the memory panel again to review the new versions.';
    } catch (error) {
      status.textContent = error.message;
      button.disabled = stopped;
    }
  };
  (async () => {
    try {
      token = (await request('/api/auth/refresh', 'POST')).token;
      if (!token) throw new Error('Sign in, then reopen this page.');
      if (conversationId) {
        showSetting(
          await request(endpoint + '/conversation/' + encodeURIComponent(conversationId)),
        );
        document.getElementById('conversation').hidden = false;
        const capabilities = await request(
          '/api/kade/capabilities/' + encodeURIComponent(conversationId),
        );
        const section = document.createElement('section'),
          heading = document.createElement('h2'),
          note = document.createElement('p');
        heading.textContent = 'What agents could do in their latest reply';
        note.textContent = capabilities.note;
        section.append(heading, note);
        for (const agent of capabilities.agents) {
          const title = document.createElement('h3'),
            details = document.createElement('p'),
            deferred = document.createElement('p');
          title.textContent =
            agent.agentId + ' — checked ' + new Date(agent.checkedAt).toLocaleString();
          details.textContent = 'Available: ' + (agent.available.join(', ') || 'No loaded tools');
          deferred.textContent =
            'Requires loading first: ' + (agent.discoverable.join(', ') || 'None recorded');
          section.append(title, details, deferred);
        }
        if (!capabilities.agents.length)
          note.textContent += ' No reply has recorded its tools yet.';
        document.querySelector('main').append(section);
      }
      if (memoryId) {
        const data = await request(endpoint + '/source/' + encodeURIComponent(memoryId));
        document.getElementById('key').textContent = data.memory.key;
        document.getElementById('value').textContent = data.memory.value;
        document.getElementById('protection').textContent = data.memory.correctionLocked
          ? 'This memory is protected by a user correction.'
          : 'This memory can be updated automatically.';
        const list = document.getElementById('sources');
        for (const source of data.sources) {
          const li = document.createElement('li');
          const link = document.createElement('a');
          link.href = '/c/' + encodeURIComponent(source.conversationId);
          link.textContent =
            'Open source conversation' + (source.excluded ? ' (remembering off)' : '');
          li.append(link);
          list.append(li);
        }
        if (!data.sources.length) {
          const li = document.createElement('li');
          li.textContent =
            'No accessible conversation source was recorded for this memory. Older records may have no source evidence.';
          list.append(li);
        }
        for (const row of data.related) {
          const label = document.createElement('label');
          label.style.display = 'block';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.value = row._id;
          input.checked = row._id === memoryId;
          label.append(input, document.createTextNode(' ' + row.key + ' — ' + row.value));
          document.getElementById('related').append(label);
        }
        document.getElementById('corrected').value = data.memory.value;
        document.getElementById('source').hidden = false;
      }
      status.textContent =
        conversationId || memoryId
          ? 'Saved information loaded.'
          : 'Open this page from a conversation or a memory card.';
    } catch (error) {
      status.textContent = error.message;
    }
  })();
})();
