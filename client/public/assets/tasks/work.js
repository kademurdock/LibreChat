'use strict';
(() => {
  const refresh = document.getElementById('refresh');
  const more = document.getElementById('more');
  const status = document.getElementById('status');
  const list = document.getElementById('list');
  const login = document.getElementById('login');
  let token;
  let cursor = null;
  let busy = false;
  let blocked = false;
  let lastRequest = 0;
  const requestId = new URLSearchParams(location.search).get('requestId');
  if (requestId) {
    document.getElementById('requests-heading').textContent = 'Your selected request';
    refresh.textContent = 'Check this request';
    document.querySelector('#login a').href =
      '/login?redirect_to=' +
      encodeURIComponent('/agent-work?requestId=' + encodeURIComponent(requestId));
    const all = document.createElement('a');
    all.href = '/agent-work';
    all.textContent = 'All requests';
    document.querySelector('nav').append(all);
  }
  const labels = {
    starting: 'Starting',
    running: 'Working',
    completed: 'Reply saved',
    stopped: 'Stopped',
    interrupted: 'Interrupted',
    failed: 'Could not finish',
  };
  async function request(path, options = {}) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 8500 - (Date.now() - lastRequest))),
    );
    lastRequest = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.status === 403) {
        blocked = true;
        throw new Error('Access was refused. Requests have stopped. Try again later.');
      }
      if (response.status === 401) {
        token = null;
        login.hidden = false;
        throw new Error('Please sign in again, then return to Agent work.');
      }
      if (response.status === 404 && requestId) {
        throw new Error(
          'This request could not be found for your account. It may have expired or its chat was deleted. Nothing was sent again.',
        );
      }
      if (!response.ok)
        throw new Error(
          'Could not check your requests. Your previous list is still here. Try Refresh.',
        );
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  function row(task) {
    const item = document.createElement('li');
    item.dataset.taskId = task.taskId;
    const heading = document.createElement('h3');
    heading.tabIndex = -1;
    heading.textContent = task.title;
    const state = document.createElement('p');
    state.className = 'state';
    state.textContent = labels[task.status] || 'Status unavailable';
    const date = document.createElement('p');
    date.className = 'date';
    const time = document.createElement('time');
    time.dateTime = task.createdAt;
    time.textContent = new Date(task.createdAt).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    date.append(time);
    item.append(heading, state, date);
    if (task.canOpenConversation) {
      const link = document.createElement('a');
      link.href = '/c/' + encodeURIComponent(task.conversationId);
      link.textContent = 'Open chat';
      link.setAttribute('aria-label', 'Open chat: ' + task.title + ', ' + time.textContent);
      item.append(link);
    } else {
      const note = document.createElement('p');
      note.textContent =
        task.status === 'starting' || task.status === 'running'
          ? 'The chat is not saved yet. Check again in a moment.'
          : 'No saved chat is available for this request.';
      item.append(note);
    }
    return item;
  }
  async function load(older = false) {
    if (busy || blocked) return;
    busy = true;
    refresh.disabled = more.disabled = true;
    status.textContent = older ? 'Loading older requests…' : 'Checking your requests…';
    try {
      if (requestId && !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
        blocked = true;
        throw new Error('This request link is invalid. Use All requests to find your work.');
      }
      if (!token) {
        const auth = await request('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        token = auth.token;
        if (!token) throw new Error('Please sign in again, then return to Agent work.');
      }
      const result = await request(
        '/api/agents/chat/tasks' +
          (requestId
            ? '/' + encodeURIComponent(requestId)
            : older && cursor
              ? '?before=' + encodeURIComponent(cursor)
              : ''),
        {
          headers: { Authorization: 'Bearer ' + token },
        },
      );
      if (requestId) {
        if (result.taskId !== requestId)
          throw new Error('Could not verify this request. Try Refresh.');
        result.tasks = [{ ...result }];
        result.nextCursor = null;
      }
      if (!Array.isArray(result.tasks))
        throw new Error('Could not read the request list. Try Refresh.');
      const existing = older
        ? new Set(Array.from(list.children, (item) => item.dataset.taskId))
        : new Set();
      const items = result.tasks.filter((task) => !existing.has(task.taskId)).map(row);
      if (!older) list.replaceChildren();
      list.append(...items);
      cursor = result.nextCursor;
      more.hidden = !cursor;
      login.hidden = true;
      document.getElementById('empty').hidden = list.children.length !== 0;
      document.getElementById('checked').textContent =
        'Checked ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      status.textContent =
        list.children.length +
        (list.children.length === 1 ? ' request shown.' : ' requests shown.') +
        (cursor ? ' Older requests are available.' : '');
      if (older && items.length) items[0].querySelector('h3').focus();
      else if (older && !cursor) refresh.focus();
    } catch (error) {
      status.textContent =
        error.name === 'AbortError' || error instanceof TypeError
          ? 'Connection lost. Your previous list is still here. Try Refresh when you are online.'
          : error.message;
    } finally {
      busy = false;
      refresh.disabled = more.disabled = blocked;
    }
  }
  refresh.addEventListener('click', () => load());
  more.addEventListener('click', () => load(true));
  load();
})();
