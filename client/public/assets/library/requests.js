(function () {
  'use strict';
  window.setupLibraryRequests = function (api) {
    var root = document.getElementById('libraryRequests');
    var status = document.getElementById('requestStatus');
    var list = document.getElementById('requestList');
    var scope = document.getElementById('requestScope');
    var more = document.getElementById('requestMore');
    var next = null;
    var admin = false;
    var initialized = false;
    var currentId = new URLSearchParams(location.search).get('request');
    function announce(value) {
      status.textContent = value;
    }
    function element(tag, value) {
      var node = document.createElement(tag);
      if (value) node.textContent = value;
      return node;
    }
    function button(label, action) {
      var node = element('button', label);
      node.type = 'button';
      node.className = 'act quiet';
      node.onclick = async function () {
        node.disabled = true;
        try {
          await action();
        } catch (error) {
          announce(error.message);
        } finally {
          node.disabled = false;
        }
      };
      return node;
    }
    function field(parent, label, control) {
      var wrapper = element('label', label);
      wrapper.className = 'field';
      wrapper.appendChild(control);
      parent.appendChild(wrapper);
      return control;
    }
    async function save(row, action, values) {
      var result = await api('/requests', {
        json: Object.assign({ action: action, id: row.id, version: row.version }, values),
      });
      announce('Request saved.');
      if (result.request) renderDetail(result.request);
      await load(false);
    }
    function renderDetail(row) {
      var panel = document.getElementById('requestDetail');
      panel.replaceChildren();
      panel.hidden = false;
      var heading = element('h3', row.title);
      heading.tabIndex = -1;
      panel.appendChild(heading);
      panel.appendChild(
        element(
          'p',
          row.status +
            ' · ' +
            row.media +
            (row.requester ? ' · Requested by ' + row.requester : ''),
        ),
      );
      panel.appendChild(element('p', row.clues));
      if (row.item) {
        var link = element('a', 'Open ' + row.item.title);
        link.href = row.item.url;
        link.className = 'act';
        panel.appendChild(link);
      }
      if (row.availabilityNote) panel.appendChild(element('p', row.availabilityNote));
      var history = element('ol');
      row.history.forEach(function (entry) {
        history.appendChild(
          element(
            'li',
            new Date(entry.at).toLocaleString() +
              ' — ' +
              entry.by +
              ': ' +
              entry.note +
              ' (' +
              entry.status +
              ')',
          ),
        );
      });
      panel.appendChild(history);
      if (row.research) {
        panel.appendChild(
          element('p', 'Research: ' + row.research.state + '. ' + (row.research.note || '')),
        );
        if (row.research.id)
          panel.appendChild(
            button('Check research progress', async function () {
              var result = await api('/requests', {
                json: { action: 'research_status', id: row.id },
              });
              renderDetail(result.request);
              announce('Research status updated.');
            }),
          );
      }
      if (row.notification)
        panel.appendChild(
          element(
            'p',
            row.notification.note ||
              'Phone notification: ' +
                row.notification.state +
                '. This update is saved in your requests.',
          ),
        );
      if (row.unread)
        panel.appendChild(
          button('Mark this update as read', async function () {
            await api('/requests', { json: { action: 'read', id: row.id, version: row.version } });
            row.unread = false;
            renderDetail(row);
            await load(false);
            announce('Update marked as read.');
          }),
        );
      if (['fulfilled', 'unavailable', 'cancelled'].indexOf(row.status) >= 0) return;
      var note = field(panel, 'Add clues or a note', element('textarea'));
      note.rows = 4;
      note.maxLength = 4000;
      panel.appendChild(
        button('Save note', function () {
          return save(row, 'note', { note: note.value });
        }),
      );
      if (row.mine)
        panel.appendChild(
          button('Cancel this request', function () {
            return save(row, 'cancel', { note: note.value });
          }),
        );
      if (!admin) return;
      var state = element('select');
      ['requested', 'searching', 'located', 'fulfilled', 'unavailable'].forEach(function (value) {
        var option = element(
          'option',
          {
            requested: 'Requested',
            searching: 'Searching',
            located: 'Identified or found a source',
            fulfilled: 'Added to the library',
            unavailable: 'Unable to fill',
          }[value],
        );
        option.value = value;
        state.appendChild(option);
      });
      state.value = row.status;
      field(panel, 'Request status', state);
      var item = field(panel, 'Library item link or ID (required when filled)', element('input'));
      item.type = 'text';
      panel.appendChild(
        element(
          'p',
          'Add or share the item first, then paste its Library link here. A web source or an identified title alone does not fill a request.',
        ),
      );
      panel.appendChild(
        button('Save status and notify requester', function () {
          var id = item.value.trim();
          if (id.indexOf('?') >= 0) {
            try {
              id = new URL(id, location.origin).searchParams.get('book') || '';
            } catch (_) {
              id = '';
            }
          }
          return save(row, 'update', { status: state.value, note: note.value, book: id });
        }),
      );
    }
    async function open(id, focus) {
      var result = await api('/requests', { json: { action: 'details', id: id } });
      currentId = id;
      renderDetail(result.request);
      if (focus) document.querySelector('#requestDetail h3').focus();
    }
    async function load(append) {
      var result = await api(
        '/requests?scope=' +
          encodeURIComponent(scope.value) +
          (append && next ? '&before=' + encodeURIComponent(next) : ''),
      );
      admin = result.admin;
      document.getElementById('requestAllOption').hidden = !admin;
      if (!initialized) {
        initialized = true;
        if (admin) {
          scope.value = 'all';
          return load(false);
        }
      }
      if (!append) list.replaceChildren();
      result.requests.forEach(function (row) {
        var entry = element('li');
        entry.appendChild(
          button(
            row.title +
              ' — ' +
              row.status +
              (row.unread ? ' — new update' : '') +
              (row.requester ? ' — ' + row.requester : ''),
            function () {
              return open(row.id, true);
            },
          ),
        );
        list.appendChild(entry);
      });
      if (!list.children.length) list.appendChild(element('li', 'No requests here yet.'));
      next = result.next;
      more.hidden = !next;
      document.getElementById('requestUnread').textContent = result.unread
        ? result.unread + ' request' + (result.unread === 1 ? ' has' : 's have') + ' new updates.'
        : '';
    }
    more.onclick = function () {
      load(true).catch(function (error) {
        announce(error.message);
      });
    };
    scope.onchange = function () {
      load(false).catch(function (error) {
        announce(error.message);
      });
    };
    document.getElementById('requestRefresh').onclick = function () {
      load(false)
        .then(function () {
          return currentId ? open(currentId, false) : null;
        })
        .then(function () {
          announce('Requests refreshed.');
        })
        .catch(function (error) {
          announce(error.message);
        });
    };
    document.getElementById('requestForm').onsubmit = async function (event) {
      event.preventDefault();
      var submit = document.getElementById('requestSubmit');
      submit.disabled = true;
      try {
        var result = await api('/requests', {
          json: {
            action: 'create',
            title: document.getElementById('requestTitle').value,
            media: document.getElementById('requestMedia').value,
            clues: document.getElementById('requestClues').value,
          },
        });
        document.getElementById('requestForm').reset();
        await load(false);
        renderDetail(result.request);
        announce(
          result.duplicate
            ? 'This request is already saved. Your existing request is shown below.'
            : 'Request saved for the library owner to review. You can check for updates here or ask the librarian.',
        );
      } catch (error) {
        announce(error.message);
      } finally {
        submit.disabled = false;
      }
    };
    root.hidden = false;
    return load(false)
      .then(function () {
        if (currentId) return open(currentId, false);
      })
      .catch(function (error) {
        announce(error.message);
      });
  };
})();
