/* Library requests on the Library page (Sep 24 2026).
 * Requesters: make a request, read updates, add details, cancel.
 * The library owner: everyone's requests, status and the item that fills one, owner-paid research.
 * Screen-reader shape: headings for the list and each request, labelled fields, the page's one
 * live region for results, and focus moved to the request heading after every change. */
(function () {
  'use strict';
  window.setupLibraryRequests = function (api, say) {
    var root = document.getElementById('libraryRequests');
    var list = document.getElementById('requestList');
    var scope = document.getElementById('requestScope');
    var more = document.getElementById('requestMore');
    var panel = document.getElementById('requestDetail');
    var next = null;
    var admin = false;
    var initialized = false;
    var membershipLoaded = false;
    var counts = { unread: 0, review: 0 };
    var params = new URLSearchParams(location.search);
    var currentId = params.get('request');
    var statusNames = {
      requested: 'Waiting for review',
      searching: 'Being looked for',
      located: 'Found a possible source, not in the library yet',
      fulfilled: 'Ready in the library',
      unavailable: 'Could not be filled',
    };
    var researchChoices = {
      quick: 'Quick, about 2 minutes',
      standard: 'Standard, about 4 minutes',
      deep: 'Deep, about 8 minutes',
    };
    function announce(value) {
      say(value);
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
    function field(parent, label, control, id) {
      var name = element('label', label);
      name.className = 'field';
      name.htmlFor = id;
      control.id = id;
      parent.appendChild(name);
      parent.appendChild(control);
      return control;
    }
    function when(value) {
      try {
        return new Date(value).toLocaleString(undefined, {
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
      } catch (_) {
        return '';
      }
    }
    function focusHeading() {
      var heading = document.getElementById('requestDetailHeading');
      if (heading) heading.focus();
    }
    async function send(values) {
      return api('/requests', { json: values });
    }
    /* After any change: show the saved request, refresh the list, and put focus on its heading. */
    async function saved(result, message) {
      if (result.request) render(result.request);
      await load(false);
      focusHeading();
      announce(message);
    }

    function render(row) {
      currentId = row.id;
      panel.replaceChildren();
      panel.hidden = false;
      var heading = element('h3', row.title);
      heading.id = 'requestDetailHeading';
      heading.tabIndex = -1;
      panel.appendChild(heading);
      panel.appendChild(element('p', 'Status: ' + row.statusText + '.'));
      if (row.requester && !row.mine)
        panel.appendChild(element('p', 'Requested by ' + row.requester + '.'));
      if (row.requesterNote) panel.appendChild(element('p', row.requesterNote));
      panel.appendChild(element('p', 'Kind of media: ' + row.media + '.'));
      if (row.clues)
        panel.appendChild(
          element('p', (row.mine ? 'What you remember: ' : 'What they remember: ') + row.clues),
        );
      if (row.item) {
        var link = element('a', 'Open ' + row.item.title);
        link.href = row.item.url;
        link.className = 'act primary';
        panel.appendChild(link);
      }
      if (row.availabilityNote) panel.appendChild(element('p', row.availabilityNote));
      if (row.alert) panel.appendChild(element('p', row.alert));
      panel.appendChild(element('h4', 'History'));
      var history = element('ol');
      row.history.forEach(function (entry) {
        history.appendChild(
          element(
            'li',
            when(entry.at) +
              '. ' +
              entry.by +
              ': ' +
              (entry.note ? entry.note + ' ' : '') +
              '(' +
              entry.statusText +
              ')',
          ),
        );
      });
      panel.appendChild(history);
      if (admin) research(row);
      if (row.status === 'cancelled') return;
      var isOpen = ['requested', 'searching', 'located'].indexOf(row.status) >= 0;
      if (row.mine && isOpen) requesterControls(row);
      if (admin) ownerControls(row, isOpen);
    }

    function requesterControls(row) {
      panel.appendChild(element('h4', 'Add details'));
      var note = field(
        panel,
        'New details or a message for the library owner',
        element('textarea'),
        'requestNote',
      );
      note.rows = 3;
      note.maxLength = 4000;
      var row2 = element('div');
      row2.className = 'row';
      row2.appendChild(
        button('Save details', async function () {
          if (!note.value.trim()) {
            note.focus();
            return announce('Write the new details first.');
          }
          await saved(
            await send({ action: 'note', id: row.id, note: note.value }),
            'Details saved.',
          );
        }),
      );
      row2.appendChild(
        button('Cancel this request', async function () {
          if (!window.confirm('Cancel your request for ' + row.title + '?')) return;
          await saved(await send({ action: 'cancel', id: row.id }), 'Request cancelled.');
        }),
      );
      panel.appendChild(row2);
    }

    function ownerControls(row, isOpen) {
      panel.appendChild(element('h4', 'Update this request'));
      var state = element('select');
      (isOpen
        ? ['requested', 'searching', 'located', 'fulfilled', 'unavailable']
        : ['fulfilled', 'unavailable']
      ).forEach(function (value) {
        var option = element('option', statusNames[value]);
        option.value = value;
        state.appendChild(option);
      });
      state.value = row.status;
      field(panel, 'Status', state, 'requestNewStatus');
      var finder = element('div');
      var query = field(
        finder,
        'Library item that fills it: search by title, or paste its Library link',
        element('input'),
        'requestItemSearch',
      );
      query.type = 'text';
      query.autocomplete = 'off';
      if (row.item) query.value = location.origin + row.item.url;
      var picks = element('select');
      var pickWrap = element('div');
      pickWrap.hidden = true;
      field(pickWrap, 'Matching library items', picks, 'requestItemChoice');
      finder.appendChild(
        button('Search the library', async function () {
          var words = query.value.trim();
          if (!words) {
            query.focus();
            return announce('Type part of the title first.');
          }
          var found = await api('/search?q=' + encodeURIComponent(words));
          picks.replaceChildren();
          (found.items || []).slice(0, 50).forEach(function (item) {
            var option = element(
              'option',
              item.title +
                (item.author ? ', ' + item.author : '') +
                (item.path ? ', ' + item.path : '') +
                (item.grownUpsOnly ? ', grown-ups only' : ''),
            );
            option.value = item.id;
            picks.appendChild(option);
          });
          pickWrap.hidden = !picks.options.length;
          if (picks.options.length) picks.focus();
          announce(
            picks.options.length
              ? picks.options.length + ' matching items. Choose one, then save.'
              : 'Nothing in the library matched. Try other words.',
          );
        }),
      );
      finder.appendChild(pickWrap);
      panel.appendChild(finder);
      var showFinder = function () {
        finder.hidden = state.value !== 'fulfilled';
      };
      state.onchange = showFinder;
      showFinder();
      var note = field(
        panel,
        'Note for the requester (optional)',
        element('textarea'),
        'requestOwnerNote',
      );
      note.rows = 3;
      note.maxLength = 4000;
      panel.appendChild(
        button(row.mine ? 'Save' : 'Save and tell the requester', async function () {
          if (state.value === row.status && !note.value.trim() && state.value !== 'fulfilled') {
            note.focus();
            return announce('Choose a new status or write a note first.');
          }
          var book = '';
          if (state.value === 'fulfilled') {
            book = !pickWrap.hidden && picks.value ? picks.value : query.value.trim();
            if (!book) {
              query.focus();
              return announce('Find the library item that fills this request first.');
            }
          }
          var result;
          try {
            result = await send({
              action: 'update',
              id: row.id,
              version: row.version,
              status: state.value,
              note: note.value,
              book: book,
            });
          } catch (error) {
            if (!/^This request changed/.test(error.message)) throw error;
            /* Someone changed it meanwhile: show the new version, keep what she typed. */
            var typed = { status: state.value, note: note.value, item: query.value };
            await open(row.id, false);
            var status = document.getElementById('requestNewStatus');
            var ownerNote = document.getElementById('requestOwnerNote');
            var item = document.getElementById('requestItemSearch');
            if (status && status.querySelector('option[value="' + typed.status + '"]')) {
              status.value = typed.status;
              if (status.onchange) status.onchange();
            }
            if (ownerNote) ownerNote.value = typed.note;
            if (item && typed.item) item.value = typed.item;
            focusHeading();
            return announce(
              'This request changed while you were working. Your note is kept. Check the new status and save again.',
            );
          }
          await saved(
            result,
            row.mine
              ? 'Saved.'
              : 'Saved. ' + (row.requester || 'The requester') + ' will get an alert.',
          );
        }),
      );
    }

    function research(row) {
      var isOpen = ['requested', 'searching', 'located'].indexOf(row.status) >= 0;
      if (!row.research && !isOpen) return;
      panel.appendChild(element('h4', 'Research'));
      var running =
        row.research &&
        ['done', 'failed', 'cancelled', 'unconfirmed', 'missing'].indexOf(row.research.state) < 0;
      if (row.research) {
        var stateLine = element('p', row.research.stateText + '. ' + (row.research.note || ''));
        stateLine.id = 'requestResearchState';
        panel.appendChild(stateLine);
        if (running || row.research.state === 'done')
          panel.appendChild(
            button(running ? 'Check research' : 'Read the research report', async function () {
              var result = await send({ action: 'research_status', id: row.id });
              render(result.request);
              if (result.research && result.research.report) {
                showReport(result.research);
                return;
              }
              focusHeading();
              announce('Research: ' + result.request.research.stateText + '.');
            }),
          );
      }
      if (running || !isOpen) return;
      panel.appendChild(
        element(
          'p',
          'Research looks across the web for this item and where to get it. The platform pays; it never charges the requester, and it never fills the request by itself.',
        ),
      );
      var depth = element('select');
      Object.keys(researchChoices).forEach(function (value) {
        var option = element('option', researchChoices[value]);
        option.value = value;
        depth.appendChild(option);
      });
      field(panel, 'How deep', depth, 'requestResearchDepth');
      panel.appendChild(
        button('Start research', async function () {
          var quote = await send({ action: 'research', id: row.id, depth: depth.value });
          if (!quote.quote)
            return saved(quote, 'Research is already running. Check it in a few minutes.');
          if (!window.confirm(quote.quote.text + ' Start it?'))
            return announce('Research not started.');
          var result = await send({
            action: 'research',
            id: row.id,
            depth: depth.value,
            confirmed: true,
          });
          var started = result.request && result.request.research;
          await saved(
            result,
            started && started.state !== 'failed' && started.state !== 'unconfirmed'
              ? 'Research started. Check it in a few minutes.'
              : (started && started.note) || 'Research did not start.',
          );
        }),
      );
    }

    /* The report goes right under the research status line, and focus goes to its heading. */
    function showReport(result) {
      var box = element('section');
      box.setAttribute('aria-labelledby', 'requestReportHeading');
      var heading = element('h5', 'Research report');
      heading.id = 'requestReportHeading';
      heading.tabIndex = -1;
      box.appendChild(heading);
      box.appendChild(
        element('p', 'These are leads from the web, not proof that the library has it.'),
      );
      result.report.split(/\n{2,}/).forEach(function (part) {
        if (part.trim()) box.appendChild(element('p', part.trim()));
      });
      if (result.sources && result.sources.length) {
        box.appendChild(element('p', 'Sources:'));
        var sources = element('ol');
        result.sources.forEach(function (source) {
          var item = element('li');
          if (/^https?:\/\//i.test(source.url)) {
            var link = element('a', source.title || source.url);
            link.href = source.url;
            link.rel = 'noopener noreferrer';
            link.target = '_blank';
            item.appendChild(link);
          } else item.textContent = source.title;
          sources.appendChild(item);
        });
        box.appendChild(sources);
      }
      var stateLine = document.getElementById('requestResearchState');
      panel.insertBefore(box, stateLine ? stateLine.nextSibling : null);
      heading.focus();
    }

    async function open(id, focus) {
      var result = await send({ action: 'details', id: id });
      render(result.request);
      if (result.request.unread) markRead(result.request);
      if (focus) focusHeading();
    }
    /* Opening a request reads its update: drop "New update." from its list entry and the count,
     * without reloading the list or moving focus. */
    function markRead(row) {
      var pick = list.querySelector('button[data-request="' + row.id + '"]');
      if (pick && pick.textContent.indexOf('New update. ') === 0)
        pick.textContent = pick.textContent.slice('New update. '.length);
      if (row.mine && counts.unread) counts.unread--;
      else if (!row.mine && counts.review) counts.review--;
      summary(counts);
    }
    function summary(result) {
      counts = { unread: result.unread || 0, review: result.review || 0 };
      var parts = [];
      if (result.review)
        parts.push(
          result.review +
            (result.review === 1 ? ' request has' : ' requests have') +
            ' something new for you to review.',
        );
      if (result.unread)
        parts.push(
          result.unread +
            ' of your requests ' +
            (result.unread === 1 ? 'has' : 'have') +
            ' a new update.',
        );
      document.getElementById('requestSummary').textContent = parts.join(' ');
    }
    async function load(append) {
      var result = await api(
        '/requests?scope=' +
          encodeURIComponent(admin ? scope.value : 'mine') +
          (append && next ? '&before=' + encodeURIComponent(next) : ''),
      );
      if (!initialized) {
        initialized = true;
        admin = !!result.admin;
        if (admin) {
          document.getElementById('requestScopeWrap').hidden = false;
          document.getElementById('requestListHeading').textContent = 'Requests';
          addMembership();
          return load(false);
        }
        if (!result.canRequest && !result.requests.length) return false;
        if (!result.canRequest) document.getElementById('requestFormWrap').hidden = true;
      }
      var first = null;
      if (!append) list.replaceChildren();
      result.requests.forEach(function (row) {
        var entry = element('li');
        var name =
          (row.unread ? 'New update. ' : '') +
          row.title +
          '. ' +
          row.statusText +
          (row.requester && !row.mine ? '. From ' + row.requester : '');
        var pick = button(name, function () {
          return open(row.id, true);
        });
        pick.setAttribute('data-request', row.id);
        entry.appendChild(pick);
        list.appendChild(entry);
        first = first || pick;
      });
      if (!list.children.length)
        list.appendChild(
          element('li', admin ? 'No requests here.' : 'You have not made any requests yet.'),
        );
      next = result.next;
      more.hidden = !next;
      summary(result);
      return first || true;
    }
    function addMembership() {
      if (membershipLoaded) return;
      membershipLoaded = true;
      var section = element('details');
      section.appendChild(element('summary', 'Manage family library access'));
      section.appendChild(
        element(
          'p',
          'Current family accounts keep access. New accounts need your approval for the shared shelves. This does not change access to their own uploads or make them administrators.',
        ),
      );
      var users = element('ul');
      section.appendChild(users);
      section.appendChild(
        button('Load accounts', async function () {
          var result = await api('/membership');
          users.replaceChildren();
          result.users.forEach(function (user) {
            var row = element('li');
            row.appendChild(
              element(
                'span',
                user.name + ' — ' + (user.member ? 'family access' : 'own uploads only') + ' ',
              ),
            );
            if (!user.admin)
              row.appendChild(
                button(
                  user.member ? 'Remove access for ' + user.name : 'Grant access to ' + user.name,
                  async function () {
                    await api('/membership', {
                      json: { id: user.id, access: user.member ? 'none' : 'family' },
                    });
                    user.member = !user.member;
                    row.replaceChildren(
                      element(
                        'span',
                        user.name +
                          ': access ' +
                          (user.member ? 'granted' : 'removed') +
                          '. Reload accounts to change again.',
                      ),
                    );
                    announce('Library access saved for ' + user.name + '.');
                  },
                ),
              );
            users.appendChild(row);
          });
        }),
      );
      root.appendChild(section);
    }
    more.onclick = function () {
      load(true)
        .then(function (first) {
          if (first && first !== true) first.focus();
        })
        .catch(function (error) {
          announce(error.message);
        });
    };
    scope.onchange = function () {
      load(false).catch(function (error) {
        announce(error.message);
      });
    };
    document.getElementById('requestForm').onsubmit = async function (event) {
      event.preventDefault();
      var submit = document.getElementById('requestSubmit');
      var title = document.getElementById('requestTitle');
      if (!title.value.trim()) {
        title.focus();
        return announce('Give the request a title or a few words about it.');
      }
      submit.disabled = true;
      try {
        var result = await send({
          action: 'create',
          title: title.value,
          media: document.getElementById('requestMedia').value,
          clues: document.getElementById('requestClues').value,
        });
        if (!result.duplicate) document.getElementById('requestForm').reset();
        await saved(
          result,
          result.duplicate
            ? 'You already asked for this. Your earlier request is shown; add any new details to it.'
            : 'Request saved. You will get an alert when there is news, and it will show here.',
        );
      } catch (error) {
        announce(error.message);
      } finally {
        submit.disabled = false;
      }
    };
    return load(false)
      .then(function (shown) {
        if (shown === false) return; // no access and nothing requested: the section stays out of the way
        root.hidden = false;
        document.getElementById('requestsLink').hidden = false;
        if (currentId)
          return open(currentId, true).catch(function (error) {
            announce(error.message);
          });
        if (location.hash === '#libraryRequests') {
          var heading = document.getElementById('requestsHeading');
          heading.scrollIntoView();
          heading.focus();
        }
      })
      .catch(function () {
        /* Requests are not answering; the rest of the Library still works, so stay quiet. */
      });
  };
})();
