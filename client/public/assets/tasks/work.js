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
  const runId = new URLSearchParams(location.search).get('runId');
  const coding = !!runId || new URLSearchParams(location.search).get('kind') === 'harness';
  let jobOffset = 0;
  if (coding) {
    document.getElementById('requests-heading').textContent = runId
      ? 'Your selected coding job'
      : 'Coding jobs';
    refresh.textContent = 'Refresh coding jobs';
    document.querySelector('.intro').textContent =
      'Read the saved result, checks and spending for the exact coding job.';
    document.querySelector('#login a').href =
      '/login?redirect_to=' + encodeURIComponent(location.pathname + location.search);
  }
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
      if (response.status === 404 && (requestId || runId)) {
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
  function jobRow(job) {
    const result = job.result || job;
    const item = document.createElement('li');
    item.dataset.taskId = job.runId;
    const heading = document.createElement('h3');
    heading.tabIndex = -1;
    heading.textContent = job.task || 'Coding job ' + job.runId;
    item.append(heading);
    const add = (text) => {
      const p = document.createElement('p');
      p.textContent = text;
      item.append(p);
    };
    const states = {
      running: 'Working',
      done: 'Checks passed',
      failed: 'Checks failed',
      stopped: 'Stopped',
      interrupted: 'Interrupted',
      error: 'Could not finish',
    };
    add(states[job.state] || 'Status unavailable');
    if (job.needsAttention)
      add('Waiting on you: review the saved result before continuing or publishing.');
    if (result.summary) add(result.summary);
    if (job.error) add(job.error);
    if (result.branch) add('Saved branch: ' + result.branch);
    if (result.baseSha)
      add(
        'Started from commit ' +
          result.baseSha +
          (result.checkedAt ? ', checked ' + new Date(result.checkedAt).toLocaleString() : ''),
      );
    const spending = result.spending || job.spending;
    if (spending) {
      add(
        'Job ceiling: $' +
          spending.limitUsd.toFixed(2) +
          '. Confirmed provider charges: $' +
          spending.confirmedUsd.toFixed(6) +
          '.',
      );
      if (!spending.complete)
        add(
          'Cost is incomplete. Reserved pending reconciliation: $' +
            spending.reservedUsd.toFixed(6) +
            '.',
        );
      for (const entry of spending.entries || []) {
        const u = entry.usage || {};
        add(
          'Model call: ' +
            (entry.actualUsd === null ? 'charge not yet known' : '$' + entry.actualUsd.toFixed(6)) +
            '; input tokens ' +
            (u.prompt_tokens ?? 'unknown') +
            ', cached input ' +
            (u.prompt_tokens_details?.cached_tokens ?? 'unknown') +
            ', output tokens ' +
            (u.completion_tokens ?? 'unknown') +
            ', thinking tokens ' +
            (u.completion_tokens_details?.reasoning_tokens ?? 'unknown') +
            '.',
        );
      }
    } else add('Itemized provider costs are not available for this older job.');
    for (const [title, value] of [
      ['Result', result.answer],
      ['Changes', result.spokenDiff],
      ['Actions performed', result.spokenTrace],
    ]) {
      if (!value) continue;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = title;
      const content = document.createElement('pre');
      content.textContent = value;
      details.append(summary, content);
      item.append(details);
    }
    const link = document.createElement('a');
    link.href = '/agent-work?runId=' + encodeURIComponent(job.runId);
    link.textContent = 'Open this exact job';
    item.append(link);
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
      if (runId && !/^r[a-z0-9]{8,40}$/.test(runId)) throw new Error('This job link is invalid.');
      if (!token) {
        const auth = await request('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        token = auth.token;
        if (!token) throw new Error('Please sign in again, then return to Agent work.');
        const options = await request('/api/kade/work-options', {
          headers: { Authorization: 'Bearer ' + token },
        });
        document.getElementById('coding-link').hidden = !options.codingJobs;
        if (coding && !options.codingJobs) {
          blocked = true;
          throw new Error('Coding job history is not available to this account.');
        }
      }
      if (coding) {
        const offset = older ? jobOffset : 0;
        const data = await request(
          '/api/kade/harness/jobs' +
            (runId ? '/' + encodeURIComponent(runId) : '?offset=' + offset),
          { headers: { Authorization: 'Bearer ' + token } },
        );
        if (runId && data.runId !== runId) throw new Error('The job identifier did not match.');
        const jobs = runId ? [data] : data.jobs;
        if (!Array.isArray(jobs)) throw new Error('Could not read the coding job list.');
        if (!older) list.replaceChildren();
        const rendered = jobs.map(jobRow);
        list.append(...rendered);
        jobOffset = offset + jobs.length;
        more.hidden = !data.hasMore;
        document.getElementById('empty').hidden = list.children.length !== 0;
        login.hidden = true;
        status.textContent = list.children.length + ' coding jobs shown.';
        if (older && rendered.length) rendered[0].querySelector('h3').focus();
        return;
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
