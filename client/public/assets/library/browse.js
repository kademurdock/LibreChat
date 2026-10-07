(function () {
  'use strict';
  window.setupLibraryBrowse = function (api, say, bookLi, scopeChanged) {
    var get = function (id) {
      return document.getElementById(id);
    };
    var form = get('browseForm'),
      list = get('browseList'),
      more = get('browseMore');
    var next = '',
      run = 0,
      active = null;
    function options(id, rows, label) {
      var select = get(id),
        chosen = select.value;
      select.replaceChildren(new Option(label, ''));
      rows.forEach(function (row) {
        if (!row._id) return;
        var names = {
          book: 'Books',
          newspaper: 'Newspapers',
          yearbook: 'Yearbooks',
          audiobook: 'Audiobooks',
          commercials: 'Commercials',
          radio: 'Radio',
          music: 'Music',
          movie: 'Movies',
          tv: 'Television',
          cassette: 'Cassettes',
          vhs: 'Home video',
          psa: 'Public service announcements',
          other: 'Other',
        };
        select.add(new Option((names[row._id] || row._id) + ' (' + row.count + ')', row._id));
      });
      if (
        chosen &&
        !rows.some(function (row) {
          return row._id === chosen;
        })
      ) {
        select.add(new Option(chosen + ' (0)', chosen));
      }
      select.value = chosen;
    }
    function state() {
      return new URLSearchParams({
        q: get('searchBox').value.trim(),
        scope: get('libraryScope').value,
        kind: get('browseKind').value,
        type: get('browseType').value,
        decade: get('browseDecade').value,
        sort: get('browseSort').value,
        path: get('browsePath').value,
      });
    }
    function remember() {
      try {
        sessionStorage.setItem('library-browse', state().toString());
      } catch (error) {}
    }
    async function load(append) {
      var parameters = state(),
        signature = parameters.toString();
      if (append && !next) return;
      if (active) active.abort();
      active = new AbortController();
      var request = ++run;
      if (append) parameters.set('after', next);
      else {
        next = '';
        list.replaceChildren();
      }
      more.hidden = true;
      get('browseCount').textContent = 'Loading…';
      list.setAttribute('aria-busy', 'true');
      remember();
      try {
        var result = await api('/browse?' + parameters.toString(), { signal: active.signal });
        if (request !== run || signature !== state().toString()) return;
        if (!append) {
          options('browseType', result.types, 'All types');
          options('browseDecade', result.decades, 'All decades');
        }
        var first = list.children.length;
        result.items.forEach(function (item) {
          var li = bookLi(item, 'archive');
          var meta = li.querySelector('.meta');
          var words = [];
          if (item.decade) words.push(item.decade);
          if (item.path)
            words.push(
              item.path
                .split('/')
                .filter(function (part) {
                  return part !== item.decade;
                })
                .join(' · '),
            );
          if (meta && words.length) {
            var placement = document.createElement('span');
            placement.className = 'meta';
            placement.textContent = words.join(' · ');
            li.querySelector('.book').appendChild(placement);
          }
          list.appendChild(li);
        });
        if (!list.children.length) {
          var empty = document.createElement('li');
          empty.textContent = 'Nothing matches these filters. Try another type, decade or search.';
          list.appendChild(empty);
        }
        next = result.next || '';
        more.hidden = !next;
        get('browseCount').textContent =
          result.total +
          ' items' +
          (result.items.length ? ' · ' + list.children.length + ' loaded' : '');
        if (append && list.children[first]) {
          var button = list.children[first].querySelector('button');
          if (button) button.focus();
        }
        say(result.total + ' items match.' + (next ? ' More items are available.' : ''));
      } catch (error) {
        if (request !== run || error.name === 'AbortError') return;
        get('browseCount').textContent = 'The library could not be loaded.';
        say(error.message);
      } finally {
        if (request === run) list.removeAttribute('aria-busy');
      }
    }
    form.onsubmit = function (event) {
      event.preventDefault();
      load(false);
    };
    ['libraryScope', 'browseKind', 'browseType', 'browseDecade', 'browseSort'].forEach(
      function (id) {
        get(id).onchange = function () {
          load(false);
          if (id === 'libraryScope' && scopeChanged) scopeChanged();
        };
      },
    );
    more.onclick = function () {
      load(true);
    };
    get('browseClear').onclick = function () {
      form.reset();
      get('browsePath').value = '';
      get('browseLocation').hidden = true;
      load(false);
    };
    get('browsePathClear').onclick = function () {
      get('browsePath').value = '';
      get('browseLocation').hidden = true;
      load(false);
    };
    get('discoveryLinks').onclick = function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      get('searchBox').value = button.dataset.query || '';
      get('browsePath').value = button.dataset.folder || '';
      get('browseLocation').hidden = !get('browsePath').value;
      get('browseLocationName').textContent = get('browsePath').value.split('/').join(' · ');
      load(false);
    };
    try {
      var saved = new URLSearchParams(sessionStorage.getItem('library-browse') || '');
      ['q', 'scope', 'kind', 'type', 'decade', 'sort', 'path'].forEach(function (key) {
        var id = {
          q: 'searchBox',
          scope: 'libraryScope',
          kind: 'browseKind',
          type: 'browseType',
          decade: 'browseDecade',
          sort: 'browseSort',
          path: 'browsePath',
        }[key];
        var value = saved.get(key);
        if (!value) return;
        if (
          (key === 'type' || key === 'decade') &&
          !Array.from(get(id).options).some(function (option) {
            return option.value === value;
          })
        )
          get(id).add(new Option(value, value));
        get(id).value = value;
      });
    } catch (error) {}
    get('browseLocation').hidden = !get('browsePath').value;
    get('browseLocationName').textContent = get('browsePath').value.split('/').join(' · ');
    load(false);
    return {
      reload: function () {
        load(false);
      },
    };
  };
})();
