'use strict';
(() => {
  const params = new URLSearchParams(location.search),
    projectId = params.get('projectId');
  const el = (id) => document.getElementById(id);
  const base = '/api/projects/' + encodeURIComponent(projectId) + '/context';
  let token,
    row,
    editing,
    last = 0,
    stopped = false,
    busy = false;
  async function request(path, method = 'GET', body, blob = false) {
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
    if (response.status === 401) throw new Error('Sign in, then reopen this project.');
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Could not confirm the change. Reload to check.');
    }
    return blob ? response.blob() : response.json();
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    try {
      await fn();
    } catch (error) {
      el('status').textContent = error.message;
    } finally {
      busy = false;
      document.querySelectorAll('button').forEach((button) => {
        button.disabled = stopped;
      });
    }
  }
  async function download(file, revision) {
    const blob = await request(
      base + '/files/' + encodeURIComponent(file.id) + '/' + revision,
      'GET',
      undefined,
      true,
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.textContent = 'Download ' + file.name + ' version ' + revision;
    el('status').replaceChildren(link);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 300000);
  }
  function render(data) {
    row = data;
    el('instructions').value = row.instructions;
    el('files').replaceChildren();
    for (const file of row.files) {
      const li = document.createElement('li'),
        title = document.createElement('strong');
      title.textContent = file.name + ' (' + file.kind + ')';
      li.append(title);
      const edit = document.createElement('button');
      edit.textContent = 'Revise';
      edit.onclick = () => {
        editing = file.id;
        el('name').value = file.name;
        el('kind').value = file.kind;
        el('content').value = file.content;
        el('editor-heading').textContent = 'Revise ' + file.name;
        el('name').focus();
      };
      li.append(edit);
      for (const version of [...file.versions].reverse()) {
        const button = document.createElement('button');
        button.textContent = 'Download version ' + version.revision;
        button.onclick = () => action(() => download(file, version.revision));
        li.append(button);
      }
      el('files').append(li);
    }
    el('status').textContent = 'Project revision ' + row.revision + ' loaded.';
  }
  el('refresh').onclick = () => action(async () => render(await request(base)));
  el('instructions-form').onsubmit = (event) => {
    event.preventDefault();
    action(async () => {
      render(
        await request(base + '/instructions', 'PUT', {
          instructions: el('instructions').value,
          expectedRevision: row.revision,
        }),
      );
      el('status').textContent = 'Project instructions saved.';
    });
  };
  el('file-form').onsubmit = (event) => {
    event.preventDefault();
    action(async () => {
      render(
        await request(base + '/files', 'POST', {
          id: editing,
          name: el('name').value,
          kind: el('kind').value,
          content: el('content').value,
          expectedRevision: row.revision,
        }),
      );
      el('status').textContent = 'New version saved. Previous versions are still available.';
    });
  };
  el('new').onclick = () => {
    editing = undefined;
    el('file-form').reset();
    el('editor-heading').textContent = 'Add a working file';
  };
  el('upload').onchange = () =>
    action(async () => {
      const file = el('upload').files[0];
      if (!file) return;
      if (file.size > 200000 || !/\.(txt|md|csv|json)$/i.test(file.name))
        throw new Error('Choose a text file of at most 200 KB.');
      const content = await file.text();
      if (content.length > 50000) throw new Error('File exceeds 50,000 characters.');
      editing = undefined;
      el('name').value = file.name;
      el('content').value = content;
      el('status').textContent =
        'Imported for review. Save a new version to keep this file in the project.';
    });
  action(async () => {
    token = (await request('/api/auth/refresh', 'POST')).token;
    if (!token) throw new Error('Sign in, then reopen this project.');
    render(await request(base));
    const file = row.files.find((file) => file.id === params.get('fileId'));
    if (file && /^\d+$/.test(params.get('revision')))
      await download(file, Number(params.get('revision')));
  });
})();
